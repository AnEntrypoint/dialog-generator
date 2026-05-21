import { pipeline, env } from '@huggingface/transformers'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
env.cacheDir = path.join(__dirname, 'models', 'whisper')
env.localModelPath = path.join(__dirname, 'models', 'whisper')
env.allowRemoteModels = true

// Model & device. We default to whisper-small q8 on CPU after testing every
// GPU path available to onnxruntime-node 1.24.1 on Windows x64:
//
//   - DirectML (`dml`): model LOADS fine on DML but generation produces
//     "token_ids must be a non-empty array of integers" — transformers.js
//     decoder path is broken on the DML EP for every dtype we tried (q8,
//     q4f16, fp16, fp32). Witnessed 2026-05-21. Not fixable client-side.
//   - WebGPU (`webgpu`): loads but produces garbage output ("the" for any
//     5s clip). Same decoder issue surfaces differently.
//   - CUDA (`cuda`): not bundled in onnxruntime-node — only dml/webgpu/cpu.
//   - q4f16 dtype: ORT graph init fails ("InsertedPrecisionFreeCast_...") —
//     bug in the q4f16 ONNX model files themselves.
//
// So CPU is the only working path right now. whisper-small q8 takes ~1.7s
// for 1s of audio (vs whisper-base ~1.5s) but transcribes substantially
// better — full sentences instead of fragments.
//
// To override (e.g. when transformers.js/ORT fixes the DML decoder):
//   WHISPER_MODEL=onnx-community/whisper-large-v3-turbo WHISPER_DTYPE=fp16 WHISPER_DEVICE=dml
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'onnx-community/whisper-small'
const WHISPER_DTYPE = process.env.WHISPER_DTYPE || 'q8'
const WHISPER_DEVICE = process.env.WHISPER_DEVICE || 'cpu'

let whisperPipeline = null
let pipelineInitPromise = null
let pipelineActualDevice = null

async function initPipeline() {
  if (whisperPipeline) return whisperPipeline
  if (pipelineInitPromise) return pipelineInitPromise

  pipelineInitPromise = (async () => {
    const t0 = Date.now()
    const attempt = async (model, dtype, device) => {
      console.log(`[whisper] loading ${model} dtype=${dtype} device=${device}...`)
      const p = await pipeline('automatic-speech-recognition', model, { dtype, device })
      console.log(`[whisper] loaded in ${Date.now() - t0}ms (${model} ${dtype} ${device})`)
      pipelineActualDevice = device
      return p
    }
    try {
      whisperPipeline = await attempt(WHISPER_MODEL, WHISPER_DTYPE, WHISPER_DEVICE)
      return whisperPipeline
    } catch (err) {
      console.warn(`[whisper] primary load failed (${err.message}); falling back to CPU/whisper-base/q8`)
      try {
        whisperPipeline = await attempt('Xenova/whisper-base', 'q8', 'cpu')
        return whisperPipeline
      } catch (err2) {
        pipelineInitPromise = null
        throw new Error(`Whisper pipeline initialization failed: ${err2.message}`)
      }
    }
  })()

  return pipelineInitPromise
}

export function getWhisperInfo() {
  return { model: WHISPER_MODEL, dtype: WHISPER_DTYPE, device: pipelineActualDevice, loaded: Boolean(whisperPipeline) }
}

export async function transcribe(pcm, sampleRate = 48000) {
  if (!pcm) throw new Error('transcribe: pcm input required')
  if (typeof sampleRate !== 'number' || sampleRate < 8000 || sampleRate > 48000) {
    throw new Error(`transcribe: sampleRate must be between 8000-48000, got ${sampleRate}`)
  }

  const asr = await initPipeline()

  // Accept either Float32Array (preferred — no precision loss) or Int16
  // PCM in a Buffer / Uint8Array (back-compat for old callers).
  let audioData
  if (pcm instanceof Float32Array) {
    audioData = pcm
  } else {
    const i16 = new Int16Array(
      pcm.buffer || pcm,
      pcm.byteOffset || 0,
      pcm.byteLength ? pcm.byteLength / 2 : pcm.length
    )
    audioData = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) audioData[i] = i16[i] / 32768.0
  }

  // Resample to Whisper's native 16kHz with a tiny low-pass via 4-tap
  // averaging — better than a single linear interp for anti-alias on the 3×
  // downsample from 48kHz. Cheap (we run this once per utterance).
  const targetRate = 16000
  let resampled
  if (sampleRate === targetRate) {
    resampled = audioData
  } else {
    const ratio = sampleRate / targetRate
    const outLen = Math.floor(audioData.length / ratio)
    resampled = new Float32Array(outLen)
    const halfWindow = Math.max(1, Math.floor(ratio / 2))
    for (let i = 0; i < outLen; i++) {
      const center = i * ratio
      const lo = Math.max(0, Math.floor(center) - halfWindow)
      const hi = Math.min(audioData.length - 1, Math.floor(center) + halfWindow)
      let sum = 0, n = 0
      for (let j = lo; j <= hi; j++) { sum += audioData[j]; n++ }
      resampled[i] = sum / n
    }
  }

  try {
    const result = await asr(resampled, {
      language: 'en',
      task: 'transcribe',
      // Trust Whisper's own no-speech detection (default 0.6). Our VAD already
      // filters out frames below ACTIVE_RMS so most input is real speech.
      no_speech_threshold: 0.6,
      // Each utterance is independent — don't condition on prior text.
      condition_on_previous_text: false,
      // Slight temperature beats 0.0 when audio is borderline; falls back
      // through this list on no_speech / repeats.
      temperature: [0.0, 0.2, 0.4],
      // Reject hallucinations on quiet/garbled inputs.
      compression_ratio_threshold: 2.4,
      logprob_threshold: -1.0,
    })
    const text = (result?.text || '').trim()
    // result may include chunks[] with per-chunk no_speech_prob if available;
    // fall back to text-length heuristic if not.
    let confidence = 0.5
    if (result?.chunks && result.chunks.length) {
      const probs = result.chunks.map(c => 1 - (c.no_speech_prob ?? 0.5)).filter(Boolean)
      if (probs.length) confidence = probs.reduce((a, b) => a + b, 0) / probs.length
    } else if (text) {
      confidence = Math.min(1.0, 0.3 + text.length / 200)
    }
    return { text: text || '[no speech detected]', confidence: Math.max(0, Math.min(1, confidence)) }
  } catch (err) {
    throw new Error(`Whisper transcription failed: ${err.message}`)
  }
}

export default { transcribe }
