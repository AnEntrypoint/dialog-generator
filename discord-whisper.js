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

export async function transcribe(pcmBuffer, sampleRate = 48000) {
  if (!pcmBuffer || typeof pcmBuffer !== 'object') throw new Error('transcribe: pcmBuffer must be a Buffer or Uint8Array')
  if (typeof sampleRate !== 'number' || sampleRate < 8000 || sampleRate > 48000) throw new Error(`transcribe: sampleRate must be between 8000-48000, got ${sampleRate}`)

  const asr = await initPipeline()

  const pcmArray = new Int16Array(
    pcmBuffer.buffer || pcmBuffer,
    pcmBuffer.byteOffset || 0,
    pcmBuffer.byteLength ? pcmBuffer.byteLength / 2 : pcmBuffer.length
  )

  const audioData = new Float32Array(pcmArray.length)
  for (let i = 0; i < pcmArray.length; i++) audioData[i] = pcmArray[i] / 32768.0

  const targetRate = 16000
  const resampleRatio = targetRate / sampleRate
  const resampledLength = Math.floor(audioData.length * resampleRatio)
  const resampled = new Float32Array(resampledLength)

  for (let i = 0; i < resampledLength; i++) {
    const srcIdx = i / resampleRatio
    const srcIdxFloor = Math.floor(srcIdx)
    const srcIdxCeil = Math.min(srcIdxFloor + 1, audioData.length - 1)
    const fraction = srcIdx - srcIdxFloor
    resampled[i] = audioData[srcIdxFloor] * (1 - fraction) + audioData[srcIdxCeil] * fraction
  }

  try {
    const result = await asr(resampled, {
      language: 'english',
      task: 'transcribe',
      // Default 0.6 — lower values reject too aggressively and let through
      // hallucinations on near-silent input. Our VAD already filters silence
      // upstream so we can trust Whisper's own no-speech detection.
      no_speech_threshold: 0.6,
      condition_on_previous_text: false,
      // initial_prompt was biased to a specific character (cleetus); for a
      // conversational bot this caused vocabulary drift / "you/Thank you"
      // hallucinations. Leave Whisper neutral.
    })
    const confidence = Math.min(1.0, result.text.length / 100.0)
    return { text: result.text || '[no speech detected]', confidence: Math.max(0, Math.min(1, confidence)) }
  } catch (err) {
    throw new Error(`Whisper transcription failed: ${err.message}`)
  }
}

export default { transcribe }
