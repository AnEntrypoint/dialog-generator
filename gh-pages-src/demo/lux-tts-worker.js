// LuxTTS (ZipVoice-distill) demo worker — browser counterpart of the server-side
// lux-tts-bridge.js. Mirrors the F5 tts-worker.js message protocol EXACTLY so it
// is a drop-in for app-tts.js:
//   in:  load | load_voice{voice} | generate{data:{text,voice}} | cancel
//   out: status{status} | voices_loaded{voices,defaultVoice} | loaded
//        | audio_chunk{data:ArrayBuffer(Float32 mono)} | stream_ended | error{error}
//
// Output is 48000 Hz mono Float32 (lux-core SAMPLE_RATE) — app-tts.js must use
// 48000 in its AudioContext / createBuffer / nextAt (see wiring note in lux-test).
//
// Models: text_encoder_int8.onnx + fm_decoder_int8.onnx + tokens.txt are fetched
// from HF YatharthS/LuxTTS (browser-cached). vocos.onnx + vocos.onnx.data are NOT
// on that HF repo (it ships a torch vocoder), so they are served locally from
// ./model/lux/. The int8 graphs (DynamicQuantizeLinear + MatMulInteger) run on the
// WASM EP — WebGPU has no MatMulInteger — so EP defaults to ['wasm'].
// Local same-origin ort bundle: COOP/COEP (require-corp) blocks the CDN's
// cross-origin dynamic import of the wasm backend glue (.jsep.mjs). Serving ort
// from ./ort/ makes those relative imports same-origin so the WASM EP loads.
import * as ort from './ort/ort.webgpu.bundle.min.mjs'
import { createWebSessions } from './lux-ort-web.mjs'
import { loadTokensUrl, textToTokens } from './lux-tokenizer-web.mjs'
import {
  sample, vocodeChunk, FEAT_DIM, VOCOS_FRAMES, SAMPLES_PER_FRAME, SAMPLE_RATE,
} from './lux-core.mjs'

// ZipVoice-distill sampler dials (match lux-tts-bridge.js defaults).
const NUM_STEP = 4
const T_SHIFT = 0.9
const GUIDANCE = 3.0
const SPEED = 0.7
const SEED = 666
const TARGET_PEAK = 0.85
const OUTPUT_RATE = SAMPLE_RATE // 48000
const FEATURE_RATE = 24000      // mel feature rate (for ref rms only)

const HF = 'https://huggingface.co/YatharthS/LuxTTS/resolve/main'
const LOCAL = './model/lux'
// int8 models source: HF by default; ?models=local serves them from ./model/lux
// (used for the local browser witness; the GitHub Pages deploy uses HF / part files).
const INT8_BASE = (new URL(self.location.href).searchParams.get('models') === 'local') ? LOCAL : HF

let sessions = null
let tokensMap = null
let aborted = false
// reference voice state
let refPromptFeatures = null // Float32Array [Tp*FEAT_DIM] (already * FEAT_SCALE)
let refPromptFramesLen = 0
let refPromptTokens = null
let refRms = 0.05
let activeVoice = null

const post = (m, transfer) => self.postMessage(m, transfer || [])
const status = (s) => post({ type: 'status', status: s })

async function fetchBytes(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

// Minimal WAV (PCM16 / float32) decoder -> mono Float32 @ its native rate, then
// resample to FEATURE_RATE. Used only to compute the reference RMS for the
// vocodeChunk loudness match (the precomputed mel carries no RMS).
function decodeWavMono(arrayBuffer) {
  const dv = new DataView(arrayBuffer)
  const channels = dv.getUint16(22, true)
  const sampleRate = dv.getUint32(24, true)
  const bits = dv.getUint16(34, true)
  let off = 12, dataOff = 44, dataLen = 0
  while (off < dv.byteLength - 8) {
    const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3))
    const size = dv.getUint32(off + 4, true)
    if (id === 'data') { dataOff = off + 8; dataLen = size; break }
    off += 8 + size
  }
  const n = Math.floor(dataLen / (bits / 8) / channels)
  const mono = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * (bits / 8)
      s += bits === 16 ? dv.getInt16(p, true) / 32768 : dv.getFloat32(p, true)
    }
    mono[i] = s / channels
  }
  return resampleMono(mono, sampleRate, FEATURE_RATE)
}

function resampleMono(audio, from, to) {
  if (from === to) return audio
  const ratio = from / to
  const out = new Float32Array(Math.round(audio.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const idx = i * ratio, lo = Math.floor(idx), hi = Math.min(lo + 1, audio.length - 1)
    out[i] = audio[lo] * (1 - (idx - lo)) + audio[hi] * (idx - lo)
  }
  return out
}

function rms(a) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * a[i]
  return Math.sqrt(s / Math.max(1, a.length))
}

async function loadModel() {
  status('loading tokenizer')
  tokensMap = await loadTokensUrl('./tokens.txt')

  status('downloading models (q4 ~81 MB, first run)')
  // q4 (MatMulNBits) HAS a WebGPU impl (unlike int8's MatMulInteger), so it is both
  // smaller AND GPU-accelerated. Served as local Pages blobs (each < 99MB).
  const [teBytes, fmBytes, vocosBytes, vocosData] = await Promise.all([
    fetchBytes(`${LOCAL}/text_encoder_q4.onnx`),
    fetchBytes(`${LOCAL}/fm_decoder_q4.onnx`),
    fetchBytes(`${LOCAL}/vocos.onnx`),
    fetchBytes(`${LOCAL}/vocos.onnx.data`),
  ])

  status('initializing onnx sessions (webgpu)')
  // ort bundle + its wasm glue are co-located in ./ort/ (we import the bundle from
  // there), so the bundle loads the glue relative to itself -- no wasmPaths override
  // (setting './ort/' here double-prefixed it to ./ort/ort/).
  sessions = await createWebSessions({
    ort,
    textEncoder: teBytes,
    fmDecoder: fmBytes,
    vocos: vocosBytes,
    vocosData,
    ep: ['webgpu', 'wasm'], // q4 MatMulNBits runs on webgpu; wasm fallback
    onStatus: status,
  })
  return 'webgpu/q4'
}

async function loadVoice(name) {
  // Precomputed reference mel (already log-mel * FEAT_SCALE 0.1) — preferred over
  // in-browser mel extraction (the JS vocosFbank parity is imperfect).
  const melBuf = await fetch(`./voices/${name}.luxmel.f32`).then((r) => {
    if (!r.ok) throw new Error(`${name}.luxmel.f32 not found (${r.status})`)
    return r.arrayBuffer()
  })
  refPromptFeatures = new Float32Array(melBuf)
  refPromptFramesLen = Math.floor(refPromptFeatures.length / FEAT_DIM)

  const refText = await fetch(`./voices/${name}.txt`).then((r) => (r.ok ? r.text() : '')).then((t) => t.trim())
  refPromptTokens = await textToTokens(refText, tokensMap)

  // RMS for the loudness match: decode the WAV if present, else fall back.
  refRms = 0.05
  try {
    const wav = await fetch(`./voices/${name}.wav`)
    if (wav.ok) refRms = rms(decodeWavMono(await wav.arrayBuffer()))
  } catch {}
  activeVoice = name
}

async function generate(text) {
  if (!sessions) throw new Error('model not loaded')
  if (!refPromptFeatures) throw new Error('voice not loaded')
  aborted = false

  const tokens = await textToTokens(text, tokensMap)
  if (!tokens.length) { post({ type: 'stream_ended' }); return }

  const pred = await sample(sessions, {
    tokens,
    promptTokens: refPromptTokens,
    promptFeatures: refPromptFeatures,
    promptFramesLen: refPromptFramesLen,
    speed: SPEED,
    tShift: T_SHIFT,
    guidanceScale: GUIDANCE,
    numStep: NUM_STEP,
    seed: SEED,
  })
  if (aborted) { post({ type: 'stream_ended' }); return }

  // Vocode in fixed 768-frame windows and stitch (lux-tts-bridge.generateChunk).
  let raw
  if (pred.frames <= VOCOS_FRAMES) {
    raw = await vocodeChunk(sessions, pred.data, pred.frames, refRms, 0.1)
  } else {
    const parts = []
    for (let off = 0; off < pred.frames; off += VOCOS_FRAMES) {
      if (aborted) { post({ type: 'stream_ended' }); return }
      const n = Math.min(VOCOS_FRAMES, pred.frames - off)
      const windowPred = pred.data.subarray(off * FEAT_DIM, (off + n) * FEAT_DIM)
      parts.push(await vocodeChunk(sessions, windowPred, n, refRms, 0.1))
    }
    const total = parts.reduce((s, a) => s + a.length, 0)
    raw = new Float32Array(total)
    let o = 0
    for (const p of parts) { raw.set(p, o); o += p.length }
  }
  if (aborted) { post({ type: 'stream_ended' }); return }

  // Normalize to an audible peak (cleetus ref is very quiet).
  let peak = 0
  for (let i = 0; i < raw.length; i++) { const a = raw[i] < 0 ? -raw[i] : raw[i]; if (a > peak) peak = a }
  let audio = raw
  if (peak >= 1e-5) {
    const g = TARGET_PEAK / peak
    audio = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) { const v = raw[i] * g; audio[i] = v > 1 ? 1 : v < -1 ? -1 : v }
  }

  const out = audio instanceof Float32Array ? audio : Float32Array.from(audio)
  const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  post({ type: 'audio_chunk', data: buf }, [buf])
  post({ type: 'stream_ended' })
}

self.onmessage = async (e) => {
  const { type } = e.data
  try {
    if (type === 'load') {
      const device = await loadModel()
      status(`Model loaded (${device})`)
      const manifest = await fetch('./voices/manifest.json').then((r) => r.json()).catch(() => ['cleetus.wav'])
      // Only voices with a precomputed .luxmel.f32 are usable by Lux.
      const voices = manifest.map((f) => f.replace(/\.wav$/, ''))
      const usable = []
      for (const v of voices) {
        try { const r = await fetch(`./voices/${v}.luxmel.f32`, { method: 'HEAD' }); if (r.ok) usable.push(v) } catch {}
      }
      const list = usable.length ? usable : ['cleetus']
      post({ type: 'voices_loaded', voices: list, defaultVoice: list[0] })
    } else if (type === 'load_voice') {
      const name = e.data.voice
      status(`Loading voice: ${name}`)
      await loadVoice(name)
      post({ type: 'loaded' })
    } else if (type === 'generate') {
      await generate(e.data.data?.text ?? e.data.text)
    } else if (type === 'cancel') {
      aborted = true
    }
  } catch (err) {
    post({ type: 'error', error: err && err.message ? err.message : String(err) })
  }
}
