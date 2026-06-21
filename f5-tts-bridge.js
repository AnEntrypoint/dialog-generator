// Server-side F5-TTS bridge (replaces chatterbox-tts-bridge.js).
//
// Wraps the vendored nsarang F5-TTS core (f5-core/) over onnxruntime-node. The
// 3 ONNX models (encoder/transformer/decoder) bundle mel extraction + flow
// matching + vocoder, so this bridge only loads reference audio + text and runs
// F5TTS.inference per text chunk. Output is 24kHz Float32 (same rate as the old
// Chatterbox bridge, so the 24k->48k upmix at the Discord sink is unchanged).
//
// API contract is identical to chatterbox-tts-bridge.js:
//   setRefVoice(wavPath, refText) -> Promise<void>
//   synthesize(text, _unused, _unused, signal) -> { audio: Float32Array, sampleRate }
//   synthesizeStream(text, _unused, _unused, onChunk, signal) -> { sampleRate }
//   getDebugState() -> {...}
import fs from 'fs'
import path from 'path'

const SAMPLE_RATE = 24000
const MODEL_DIR = process.env.F5_MODEL_DIR || path.resolve('models/tts/f5')
const NFE_STEPS = Number(process.env.F5_NFE_STEPS || 16)
const SPEED = Number(process.env.F5_SPEED || 1.0)
const MAX_CHUNK_CHARS = Number(process.env.F5_CHUNK_CHARS || 200)

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd', 'co',
])

function splitSentences(text) {
  const chunks = []
  let buf = ''
  for (let i = 0; i < text.length; i++) {
    buf += text[i]
    if ('.!?'.includes(text[i]) && (text[i + 1] === ' ' || i === text.length - 1)) {
      const word = buf.split(/\s+/).at(-1)?.replace(/[^a-z]/gi, '').toLowerCase()
      if (!ABBREVIATIONS.has(word)) { chunks.push(buf.trim()); buf = '' }
    }
  }
  if (buf.trim()) chunks.push(buf.trim())
  return chunks.length ? chunks : [text]
}

function splitTextIntoChunks(text) {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= MAX_CHUNK_CHARS) return [trimmed]
  const chunks = []
  let cur = ''
  for (const s of splitSentences(trimmed)) {
    if (cur && (cur + ' ' + s).length > MAX_CHUNK_CHARS) { chunks.push(cur); cur = s }
    else cur = cur ? cur + ' ' + s : s
  }
  if (cur) chunks.push(cur)
  return chunks
}

function readWavMono(wavPath) {
  const buf = fs.readFileSync(wavPath)
  const sampleRate = buf.readUInt32LE(24)
  const channels = buf.readUInt16LE(22)
  const bitsPerSample = buf.readUInt16LE(34)
  let dataOffset = 44
  if (buf.slice(36, 40).toString('ascii') !== 'data') dataOffset = buf.indexOf('data', 12) + 8
  const dataLen = buf.readUInt32LE(dataOffset - 4)
  const numSamples = dataLen / (bitsPerSample / 8) / channels
  const mono = new Float32Array(numSamples)
  if (bitsPerSample === 16) {
    for (let i = 0; i < numSamples; i++) {
      let s = 0
      for (let c = 0; c < channels; c++) s += buf.readInt16LE(dataOffset + (i * channels + c) * 2)
      mono[i] = (s / channels) / 32768
    }
  } else if (bitsPerSample === 32) {
    for (let i = 0; i < numSamples; i++) {
      let s = 0
      for (let c = 0; c < channels; c++) s += buf.readFloatLE(dataOffset + (i * channels + c) * 4)
      mono[i] = s / channels
    }
  }
  return { audio: mono, sampleRate }
}

function resampleMono(audio, fromRate, toRate) {
  if (fromRate === toRate) return audio
  const ratio = fromRate / toRate
  const newLen = Math.round(audio.length / ratio)
  const out = new Float32Array(newLen)
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio
    const lo = Math.floor(idx)
    const hi = Math.min(lo + 1, audio.length - 1)
    out[i] = audio[lo] * (1 - (idx - lo)) + audio[hi] * (idx - lo)
  }
  return out
}

let model = null
let torchMod = null
let refAudioTensor = null
let refText = ''
let refSource = null
let loadPromise = null

async function ensureModel() {
  if (model) return
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    // Inject onnxruntime-node BEFORE importing f5-core (its onnx.js reads the
    // ORT global symbol at module-load time).
    const ortNode = await import('onnxruntime-node')
    const ort = ortNode.default ?? ortNode
    globalThis[Symbol.for('onnxruntime')] = ort

    const f5 = await import('./f5-core/f5-tts.js')
    torchMod = await import('./f5-core/tjs/utils/torch.js')

    // Prefer fp32 transformer on CPU (onnxruntime-node); fall back to fp16 if
    // that is the only weight present. F5_FP16=1 forces fp16.
    const fp32Path = path.join(MODEL_DIR, 'onnx/transformer_fp32.onnx')
    const fp16Path = path.join(MODEL_DIR, 'onnx/transformer_fp16.onnx')
    const useFP16 = process.env.F5_FP16 === '1' || !fs.existsSync(fp32Path)
    const transformerPath = useFP16 ? fp16Path : fp32Path

    const m = new f5.F5TTS({ useFP16 })
    const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }
    m.sessions.encoder = await ort.InferenceSession.create(path.join(MODEL_DIR, 'onnx/encoder_fp32.onnx'), opts)
    m.sessions.transformer = await ort.InferenceSession.create(transformerPath, opts)
    m.sessions.decoder = await ort.InferenceSession.create(path.join(MODEL_DIR, 'onnx/decoder_fp32.onnx'), opts)

    // vocab loading, identical to F5TTS.initialize (line-index ids, blanks skipped)
    const vocabText = fs.readFileSync(path.join(MODEL_DIR, 'vocab.txt'), 'utf8')
    m.vocabMap = {}
    vocabText.split('\n').forEach((char, idx) => { if (char.trim()) m.vocabMap[char.trim()] = idx })

    model = m
    console.log('[f5-tts] model loaded (onnxruntime-node, fp32)')
  })()
  return loadPromise
}

function tensorToFloat32(t) {
  // torch.js Tensor -> Float32Array of its data
  const d = t.data ?? t.ort?.cpuData ?? t.ort?.data
  return d instanceof Float32Array ? d : Float32Array.from(d)
}

export async function setRefVoice(wavPath, text) {
  await ensureModel()
  const { audio, sampleRate } = readWavMono(wavPath)
  const mono = resampleMono(audio, sampleRate, SAMPLE_RATE)
  refAudioTensor = new torchMod.Tensor('float32', mono, [mono.length])
  refText = (text || '').trim()
  refSource = path.basename(wavPath)
  console.log(`[f5-tts] ref voice set: ${refSource} (${mono.length} samples, refText ${refText.length} chars)`)
}

async function generateChunk(genText, signal) {
  if (signal?.aborted) return null
  if (!refAudioTensor) throw new Error('call setRefVoice() before synthesize')
  const out = await model.inference({
    refAudio: refAudioTensor, refText, genText, speed: SPEED, nfeSteps: NFE_STEPS,
  })
  if (signal?.aborted) return null
  return tensorToFloat32(out)
}

export async function synthesize(text, _refPath, _refText, signal) {
  if (!text) throw new Error('text required')
  await ensureModel()
  if (signal?.aborted) return null
  const parts = []
  for (const chunk of splitTextIntoChunks(text)) {
    if (signal?.aborted) break
    const audio = await generateChunk(chunk, signal)
    if (audio) parts.push(audio)
  }
  if (!parts.length) return null
  const total = parts.reduce((s, a) => s + a.length, 0)
  const audio = new Float32Array(total)
  let off = 0
  for (const p of parts) { audio.set(p, off); off += p.length }
  return { audio, sampleRate: SAMPLE_RATE }
}

export async function synthesizeStream(text, _refPath, _refText, onChunk, signal) {
  if (!text) throw new Error('text required')
  if (typeof onChunk !== 'function') throw new Error('onChunk required')
  await ensureModel()
  for (const chunk of splitTextIntoChunks(text)) {
    if (signal?.aborted) break
    const audio = await generateChunk(chunk, signal)
    if (audio && !signal?.aborted) onChunk(audio, SAMPLE_RATE)
  }
  return { sampleRate: SAMPLE_RATE }
}

export function getDebugState() {
  return {
    modelLoaded: Boolean(model),
    speakerEncoded: Boolean(refAudioTensor),
    speakerSource: refSource,
    loading: Boolean(loadPromise && !model),
  }
}
