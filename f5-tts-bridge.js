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
// NFE is the speed<->quality dial and is RUNTIME-tunable (setSynthConfig / the
// /api/tts/config endpoint) so it can be dialed by ear without a restart. The
// entire synth cost is the NFE loop over (ref + gen) frames (~0.4s/step on the
// webgpu EP); the fixed encoder+decoder cost is only ~0.25s. Measured for 6.1s
// of audio at the 5s ref cap: NFE=8 -> 5.3s synth (RTF 0.88, hiss HF~0.75),
// NFE=16 -> 11s (RTF 1.85, HF~0.36), NFE=32 -> 23s (RTF 3.8, clean HF~0.08).
// Default is NFE=32 (clean): NFE=16 sounds scrambly/under-denoised. There is no
// fast+clean point with F5 -- raise NFE for quality, lower for speed (hissier).
let NFE_STEPS = Number(process.env.F5_NFE_STEPS || 32)
let SPEED = Number(process.env.F5_SPEED || 0.8)
let REF_SECONDS = Number(process.env.F5_REF_SECONDS || 5)
const MAX_CHUNK_CHARS = Number(process.env.F5_CHUNK_CHARS || 200)

export function getSynthConfig() { return { nfeSteps: NFE_STEPS, speed: SPEED, refSeconds: REF_SECONDS } }
export function setSynthConfig({ nfeSteps, speed, refSeconds } = {}) {
  if (Number.isFinite(nfeSteps) && nfeSteps > 0) NFE_STEPS = Math.round(nfeSteps)
  if (Number.isFinite(speed) && speed > 0) SPEED = speed
  if (Number.isFinite(refSeconds) && refSeconds > 0) { REF_SECONDS = refSeconds; applyRefCap() }
  console.log(`[f5-tts] synth config: nfe=${NFE_STEPS} speed=${SPEED} ref=${REF_SECONDS}s`)
  return getSynthConfig()
}

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
  // One chunk per sentence so synthesizeStream emits the FIRST sentence's audio
  // as soon as it's ready (lower perceived latency) instead of synthesizing the
  // whole reply first. Tiny sentences (< 24 chars) merge forward to avoid the
  // per-synth overhead dominating. A single over-long sentence is word-split at
  // MAX_CHUNK_CHARS.
  const chunks = []
  let cur = ''
  for (const s of splitSentences(trimmed)) {
    if (cur && (cur.length < 24 || s.length < 24) && (cur + ' ' + s).length <= MAX_CHUNK_CHARS) {
      cur = cur + ' ' + s; continue
    }
    if (cur) chunks.push(cur)
    cur = s
  }
  if (cur) chunks.push(cur)
  // hard-split any chunk still over the cap (single very long sentence)
  const out = []
  for (const c of chunks) {
    if (c.length <= MAX_CHUNK_CHARS) { out.push(c); continue }
    let w = ''
    for (const word of c.split(/\s+/)) {
      if (w && (w + ' ' + word).length > MAX_CHUNK_CHARS) { out.push(w); w = word }
      else w = w ? w + ' ' + word : word
    }
    if (w) out.push(w)
  }
  return out
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
    // Inject onnxruntime-node via f5-core's PRIVATE symbol (not the shared
    // "onnxruntime") so we don't break @huggingface/transformers/whisper's own
    // ORT device detection in the same process.
    const ortNode = await import('onnxruntime-node')
    const ort = ortNode.default ?? ortNode
    globalThis[Symbol.for('f5tts-onnxruntime')] = ort

    const f5 = await import('./f5-core/f5-tts.js')
    torchMod = await import('./f5-core/tjs/utils/torch.js')

    // Always use the fp32 transformer: onnxruntime-node's native binding cannot
    // consume the fp16 model's Float16Array inputs (errors "got 0"), so fp16 is
    // unusable server-side regardless of EP. fp32 needs no conversion.
    const fp32Path = path.join(MODEL_DIR, 'onnx/transformer_fp32.onnx')
    const fp16Path = path.join(MODEL_DIR, 'onnx/transformer_fp16.onnx')
    // F5_FP16=1 still allowed for experimentation, but fp32 is the supported path.
    const useFP16 = process.env.F5_FP16 === '1' || !fs.existsSync(fp32Path)
    const transformerPath = useFP16 ? fp16Path : fp32Path

    const m = new f5.F5TTS({ useFP16, emit: () => {} })
    // GPU acceleration via the webgpu EP (5x faster: 25s vs 131s CPU on the NFE
    // loop; dml falls back per-node for fp32 and is slower). webgpu -> cpu so a
    // machine without a GPU still works. F5_EP overrides the provider list.
    const eps = process.env.F5_EP
      ? process.env.F5_EP.split(',')
      : ['webgpu', 'cpu']
    const opts = { executionProviders: eps, graphOptimizationLevel: 'all' }
    const cpuOpts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }
    // encoder/decoder are fp32 -> CPU; only the transformer follows `eps`.
    m.sessions.encoder = await ort.InferenceSession.create(path.join(MODEL_DIR, 'onnx/encoder_fp32.onnx'), cpuOpts)
    m.sessions.transformer = await ort.InferenceSession.create(transformerPath, opts)
    m.sessions.decoder = await ort.InferenceSession.create(path.join(MODEL_DIR, 'onnx/decoder_fp32.onnx'), cpuOpts)

    // vocab loading, identical to F5TTS.initialize (line-index ids, blanks skipped)
    const vocabText = fs.readFileSync(path.join(MODEL_DIR, 'vocab.txt'), 'utf8')
    m.vocabMap = {}
    vocabText.split('\n').forEach((char, idx) => { if (char.trim()) m.vocabMap[char.trim()] = idx })

    model = m
    console.log(`[f5-tts] model loaded (transformer ${useFP16 ? 'fp16' : 'fp32'} via ${eps.join('/')})`)
  })()
  return loadPromise
}

function tensorToFloat32(t) {
  // torch.js Tensor -> Float32Array of its data
  const d = t.data ?? t.ort?.cpuData ?? t.ort?.data
  return d instanceof Float32Array ? d : Float32Array.from(d)
}

let _fullRefMono = null, _fullRefText = ''

// Cap the reference clip to REF_SECONDS: F5's transformer processes (ref + gen)
// frames on EVERY NFE step, so a long reference dominates latency (full 14.6s
// cleetus -> 39s/short-reply; 5s -> ~12s). Trim the transcript by the same
// fraction so the duration ratio stays consistent. Re-runnable when REF_SECONDS
// changes via setSynthConfig.
function applyRefCap() {
  if (!_fullRefMono) return
  let mono = _fullRefMono, txt = _fullRefText
  const capSamples = Math.floor(REF_SECONDS * SAMPLE_RATE)
  if (mono.length > capSamples) {
    const frac = capSamples / mono.length
    mono = mono.slice(0, capSamples)
    if (txt) { const w = txt.split(/\s+/); txt = w.slice(0, Math.max(1, Math.round(w.length * frac))).join(' ') }
  }
  refAudioTensor = new torchMod.Tensor('float32', mono, [mono.length])
  refText = txt
  console.log(`[f5-tts] ref voice set: ${refSource} (${mono.length} samples / ${(mono.length / SAMPLE_RATE).toFixed(1)}s, refText ${refText.length} chars)`)
}

export async function setRefVoice(wavPath, text) {
  await ensureModel()
  const { audio, sampleRate } = readWavMono(wavPath)
  _fullRefMono = resampleMono(audio, sampleRate, SAMPLE_RATE)
  _fullRefText = (text || '').trim()
  refSource = path.basename(wavPath)
  applyRefCap()
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
    config: getSynthConfig(),
  }
}
