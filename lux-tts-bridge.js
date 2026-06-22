// Server-side LuxTTS (ZipVoice-distill) bridge — drop-in replacement for
// f5-tts-bridge.js. ZipVoice-distill denoises in only 4 flow-matching steps
// (vs F5's 32), so synthesis is near-instant relative to F5 (~5x slower than
// realtime there). Output is 48kHz Float32 (the LinaCodec/Vocos vocoder is a
// 48k codec), NOT F5's 24kHz — see "Resample note" below.
//
// API contract is IDENTICAL to f5-tts-bridge.js so server.js / speak-gate.js
// only change the import path:
//   setRefVoice(wavPath, refText) -> Promise<void>
//   synthesize(text, _unused, _unused, signal) -> { audio: Float32Array, sampleRate: 48000 }
//   synthesizeStream(text, _unused, _unused, onChunk, signal) -> { sampleRate: 48000 }
//   getDebugState() -> {...}
//   getSynthConfig() / setSynthConfig({...})
//
// Pipeline per text chunk (all in lux-core.mjs, sessions from lux-ort-node.mjs):
//   tokens = tokenize(genText)                         (lux-tokenizer.mjs)
//   promptTokens = tokenize(refText)                   (cached on setRefVoice)
//   promptFeatures = vocosFbank(refMono@24k)           (cached on setRefVoice)
//   pred = sample(sessions, {tokens, promptTokens, promptFeatures, ...4 steps})
//   audio = vocodeChunk(sessions, pred, ...)           -> 48kHz Float32
//
// Resample note: F5 emitted 24kHz so speak-gate.js resampled 24k->48k for
// Discord. LuxTTS already emits 48kHz; synthesize() reports sampleRate=48000 so
// speak-gate's resampleAudio(audio, 48000, 48000) is a no-op (ratio 1) — no
// speak-gate change needed. The mel FEATURE rate is 24kHz (VocosFbank config);
// only the vocoder OUTPUT is 48kHz. Do not conflate the two.
import fs from 'fs'
import path from 'path'

import { createNodeSessions } from './lux-ort-node.mjs'
import {
  sample, vocodeChunk, FEAT_DIM, VOCOS_FRAMES, SAMPLES_PER_FRAME, SAMPLE_RATE,
} from './lux-core.mjs'
import * as tokenizer from './lux-tokenizer.mjs'

// Vocoder OUTPUT rate (what callers get). 48kHz LinaCodec/Vocos.
const OUTPUT_RATE = SAMPLE_RATE // 48000 from lux-core
// Mel FEATURE extraction rate (VocosFbank config from YatharthS/LuxTTS).
const FEATURE_RATE = 24000
// VocosFbank mel params (config.json "feature": vocos; ZipVoice utils/feature.py).
const N_FFT = 1024
const HOP = 256
const WIN = 1024
const N_MELS = FEAT_DIM // 100

const MODEL_DIR = process.env.LUX_MODEL_DIR || path.resolve('models/tts/lux')
// fp32 by default: the fm_decoder runs ~2.9x faster on the webgpu EP as fp32
// (synth 4.2s -> 1.4s, RTF 0.40) than int8 on CPU. CPU-only machines should set
// LUX_INT8=1 LUX_FM_EP=cpu (int8-on-CPU; fp32-on-CPU is slow).
const USE_INT8 = process.env.LUX_INT8 === '1'

// Sampler dials (ZipVoice-distill defaults). numStep=4 is the whole point — the
// distilled model is trained for 4-step sampling, so do not raise it expecting
// F5-style quality gains; it just costs latency. Runtime-tunable via setSynthConfig.
let NUM_STEP = Number(process.env.LUX_NUM_STEP || 4)
let T_SHIFT = Number(process.env.LUX_T_SHIFT || 0.9)
let GUIDANCE = Number(process.env.LUX_GUIDANCE || 3.0)
// NB: lux-core multiplies this by 1.3 internally (reference quirk). speed=1.0
// over-compresses short utterances (a full sentence collapsed to ~0.3s). 0.5
// (effective 0.65) yields natural duration at RTF ~1. Tune via LUX_SPEED.
// 0.7 gives natural sentence duration (0.5 over-extended -> every reply hit the
// 768-frame vocos cap = ~8s of audio regardless of length; 0.8 was too rushed).
let SPEED = Number(process.env.LUX_SPEED || 0.7)
let REF_SECONDS = Number(process.env.LUX_REF_SECONDS || 5)
const TARGET_PEAK = Number(process.env.LUX_TARGET_PEAK || 0.85) // normalize output to audible level
let SEED = Number(process.env.LUX_SEED || 666)

// Each chunk must fit the vocos fixed length (VOCOS_FRAMES=768 mel frames ~ 8.2s
// @48k). The prompt is PREPENDED inside the sampler (numFrames = prompt + gen),
// and vocos only sees the GEN portion (sample() strips the prompt prefix before
// vocodeChunk), so the gen text alone must stay under 768 frames. Frames scale
// roughly with characters; cap conservatively so prompt + gen never overflows.
// Empirically ~10 chars/frame is far too generous; ZipVoice gen frames ~ phoneme
// count. We cap by chars and clamp gen frames at vocode time as a hard backstop.
const MAX_CHUNK_CHARS = Number(process.env.LUX_CHUNK_CHARS || 240)
// Streaming chunks: a SMALL first chunk so the first fm pass finishes fast (the fm
// can't stream a single pass, but a short first chunk's pass is quick -> first audio
// ~1s instead of the whole-reply fm). Later chunks are larger (fewer fm passes =
// less repeated reference-frame cost). Split at clause boundaries (natural pauses).
// Gap-free streaming constraint: each chunk's SYNTH must finish before the PREVIOUS
// chunk finishes PLAYING, else the pump underruns (audible skip). Per-chunk synth is
// ref-overhead-dominated (~0.85s fixed) + ~0.3x its own duration, so a chunk must be
// big enough that its playback exceeds the next chunk's synth. Live (under pump +
// Discord contention) that floor is ~50 chars; the old 40-then-160 sizing made a
// chunk's synth exceed the prior chunk's playback -> gaps. Keep them uniform + above
// the floor; first chunk a touch smaller for a fast start that still covers chunk 2.
const STREAM_FIRST_CHARS = Number(process.env.LUX_STREAM_FIRST_CHARS || 60)
const STREAM_CHUNK_CHARS = Number(process.env.LUX_STREAM_CHUNK_CHARS || 100)
function chunkForStreaming(text) {
  const t = (text || '').trim()
  if (!t) return []
  const pieces = t.split(/(?<=[.!?,;:])\s+/).filter((p) => p.trim())
  const out = []
  let cur = ''
  for (const p of pieces) {
    const cap = out.length === 0 ? STREAM_FIRST_CHARS : STREAM_CHUNK_CHARS
    if (cur && (cur + ' ' + p).length > cap) { out.push(cur); cur = p }
    else cur = cur ? cur + ' ' + p : p
  }
  if (cur) out.push(cur)
  return out
}

export function getSynthConfig() {
  return { numStep: NUM_STEP, tShift: T_SHIFT, guidanceScale: GUIDANCE, speed: SPEED, refSeconds: REF_SECONDS }
}
export function setSynthConfig({ numStep, tShift, guidanceScale, speed, refSeconds, seed } = {}) {
  if (Number.isFinite(numStep) && numStep > 0) NUM_STEP = Math.round(numStep)
  if (Number.isFinite(tShift) && tShift > 0 && tShift <= 1) T_SHIFT = tShift
  if (Number.isFinite(guidanceScale) && guidanceScale >= 0) GUIDANCE = guidanceScale
  if (Number.isFinite(speed) && speed > 0) SPEED = speed
  if (Number.isFinite(seed)) SEED = seed >>> 0
  if (Number.isFinite(refSeconds) && refSeconds > 0) { REF_SECONDS = refSeconds; applyRefCap().catch(e => console.error('[lux-tts] applyRefCap', e)) }
  console.log(`[lux-tts] synth config: numStep=${NUM_STEP} tShift=${T_SHIFT} guidance=${GUIDANCE} speed=${SPEED} ref=${REF_SECONDS}s`)
  return getSynthConfig()
}

// ---------------------------------------------------------------------------
// Text chunking (ported verbatim from f5-tts-bridge.js — sentence-aware,
// merges tiny sentences, hard-splits over-long ones at MAX_CHUNK_CHARS).
// ---------------------------------------------------------------------------
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
// Pack the WHOLE reply into as few chunks as fit the 768-frame vocos window. lux's
// per-synth cost is a ~fixed floor (the reference frames are processed every fm
// step + the vocos is fixed 768), so splitting into clauses pays that floor N
// times and the later chunks can't keep up -> stutter/stops. One synth per reply
// pays the floor ONCE and pushes contiguously -> no breakup. A reply over the
// window splits at a sentence boundary; an over-long sentence word-splits.
function splitTextIntoChunks(text) {
  const trimmed = text.trim()
  if (!trimmed) return []
  const chunks = []
  let cur = ''
  const flush = () => { if (cur) { chunks.push(cur); cur = '' } }
  for (const s of splitSentences(trimmed)) {
    if (s.length > MAX_CHUNK_CHARS) {
      flush()
      let w = ''
      for (const word of s.split(/\s+/)) {
        if (w && (w + ' ' + word).length > MAX_CHUNK_CHARS) { chunks.push(w); w = word }
        else w = w ? w + ' ' + word : word
      }
      cur = w
      continue
    }
    if (cur && (cur + ' ' + s).length > MAX_CHUNK_CHARS) flush()
    cur = cur ? cur + ' ' + s : s
  }
  flush()
  return chunks
}

// ---------------------------------------------------------------------------
// WAV decode + resample (mono Float32). Ported from f5-tts-bridge.js.
// ---------------------------------------------------------------------------
function readWavMono(wavPath) {
  const buf = fs.readFileSync(wavPath)
  const channels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
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
function rms(a) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * a[i]
  return Math.sqrt(s / Math.max(1, a.length))
}

// ---------------------------------------------------------------------------
// VocosFbank mel extraction (JS port of ZipVoice utils/feature.py:VocosFbank).
// 24kHz mono -> log-mel [T, 100]. n_fft=1024, hop=256, win=1024 (Hann),
// power=1 (magnitude, not power), mel.clamp(min=1e-7).log(). Slaney-norm mel
// filterbank matching torchaudio MelSpectrogram defaults (htk=False).
//
// This is the prompt feature extractor. ZipVoice feeds raw prompt mel features
// (NOT re-encoded) into the FM decoder as speech_condition, so parity here is
// important for voice similarity. See GAPS in the bridge return notes.
// ---------------------------------------------------------------------------
let _melFb = null // [N_MELS][N_FFT/2+1]
let _hann = null  // [WIN]

function hzToMelSlaney(hz) { return 3.0 * hz / 200.0 <= 1 ? hz / (200.0 / 3.0) : 0 } // unused placeholder
// Slaney mel (matches librosa/torchaudio htk=False)
function hzToMel(f) {
  const fSp = 200.0 / 3.0
  const minLogHz = 1000.0
  const minLogMel = minLogHz / fSp
  const logstep = Math.log(6.4) / 27.0
  return f < minLogHz ? f / fSp : minLogMel + Math.log(f / minLogHz) / logstep
}
function melToHz(m) {
  const fSp = 200.0 / 3.0
  const minLogHz = 1000.0
  const minLogMel = minLogHz / fSp
  const logstep = Math.log(6.4) / 27.0
  return m < minLogMel ? fSp * m : minLogHz * Math.exp(logstep * (m - minLogMel))
}
function buildMelFilterbank() {
  if (_melFb) return
  const nFreqs = N_FFT / 2 + 1
  const fMin = 0, fMax = FEATURE_RATE / 2
  const mMin = hzToMel(fMin), mMax = hzToMel(fMax)
  const mPts = new Float64Array(N_MELS + 2)
  for (let i = 0; i < N_MELS + 2; i++) mPts[i] = mMin + (mMax - mMin) * i / (N_MELS + 1)
  const fPts = Array.from(mPts, melToHz)
  // bin center frequencies
  const binHz = new Float64Array(nFreqs)
  for (let k = 0; k < nFreqs; k++) binHz[k] = k * FEATURE_RATE / N_FFT
  _melFb = []
  for (let m = 0; m < N_MELS; m++) {
    const lo = fPts[m], ce = fPts[m + 1], hi = fPts[m + 2]
    const row = new Float32Array(nFreqs)
    for (let k = 0; k < nFreqs; k++) {
      const f = binHz[k]
      let w = 0
      if (f >= lo && f <= ce) w = (f - lo) / (ce - lo)
      else if (f > ce && f <= hi) w = (hi - f) / (hi - ce)
      // Slaney normalization: divide by mel-band width
      const enorm = 2.0 / (hi - lo)
      row[k] = Math.max(0, w) * enorm
    }
    _melFb.push(row)
  }
  _hann = new Float32Array(WIN)
  for (let i = 0; i < WIN; i++) _hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN)
}

// real DFT magnitude of a windowed frame, length N_FFT -> nFreqs magnitudes.
function rfftMag(frame) {
  const N = N_FFT
  const nFreqs = N / 2 + 1
  const mag = new Float32Array(nFreqs)
  for (let k = 0; k < nFreqs; k++) {
    let re = 0, im = 0
    const w = (-2 * Math.PI * k) / N
    for (let n = 0; n < N; n++) {
      const a = w * n
      re += frame[n] * Math.cos(a)
      im += frame[n] * Math.sin(a)
    }
    mag[k] = Math.sqrt(re * re + im * im) // power=1 (magnitude)
  }
  return mag
}

// Naive O(T * nFreqs * N) DFT — only ever run on the (capped) reference clip
// ONCE at setRefVoice, not in the hot path. ~5s ref @24k -> ~460 frames -> a few
// hundred ms. Acceptable for a one-time ref encode. (A radix-2 FFT could replace
// rfftMag if this ever moves into the synth loop.)
function vocosFbank(mono24k) {
  buildMelFilterbank()
  // center=True padding (reflect) like torchaudio: pad N_FFT/2 each side.
  const pad = Math.floor(N_FFT / 2)
  const padded = new Float32Array(mono24k.length + 2 * pad)
  for (let i = 0; i < pad; i++) {
    padded[pad - 1 - i] = mono24k[Math.min(i + 1, mono24k.length - 1)] // reflect
    padded[pad + mono24k.length + i] = mono24k[Math.max(mono24k.length - 2 - i, 0)]
  }
  padded.set(mono24k, pad)
  const nFrames = 1 + Math.floor((padded.length - N_FFT) / HOP)
  const nFreqs = N_FFT / 2 + 1
  const out = new Float32Array(Math.max(0, nFrames) * N_MELS)
  const frame = new Float32Array(N_FFT)
  for (let t = 0; t < nFrames; t++) {
    const start = t * HOP
    for (let i = 0; i < N_FFT; i++) frame[i] = (padded[start + i] || 0) * (i < WIN ? _hann[i] : 0)
    const mag = rfftMag(frame)
    for (let m = 0; m < N_MELS; m++) {
      const fb = _melFb[m]
      let acc = 0
      for (let k = 0; k < nFreqs; k++) acc += fb[k] * mag[k]
      out[t * N_MELS + m] = Math.log(Math.max(acc, 1e-7)) // clamp(min=1e-7).log()
    }
  }
  return { features: out, frames: Math.max(0, nFrames) }
}

// ---------------------------------------------------------------------------
// Model / reference state
// ---------------------------------------------------------------------------
let sessions = null
let loadPromise = null
let refPromptTokens = null      // int[]
let refPromptFeatures = null    // Float32Array [Tp * FEAT_DIM] (scaled by FEAT_SCALE)
let refPromptFramesLen = 0
let refRms = 0.05
let refText = ''
let refSource = null

let _fullRefMono = null, _fullRefText = ''

async function ensureModel() {
  if (sessions) return
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    await tokenizer.loadVocab(path.join(MODEL_DIR, 'tokens.txt'))
    // q4 by default: q4-on-webgpu synth ~931ms (RTF 0.31) vs fp32 ~1449ms, and 78MB
    // vs 455MB. LUX_PREC=fp32 (quality fallback) or int8 (CPU) overrides.
    const PREC = process.env.LUX_PREC || (USE_INT8 ? 'int8' : 'q4')
    sessions = await createNodeSessions(MODEL_DIR, { int8: USE_INT8, prec: PREC })
    console.log(`[lux-tts] model loaded (${PREC} sessions from ${MODEL_DIR})`)
  })()
  return loadPromise
}

// FEAT_SCALE applied here so speech_condition matches the model's training-space
// features. lux-core.featuresToVocosMel divides predicted features BACK by
// FEAT_SCALE before vocos; the speech_condition fed to the FM decoder must live
// in the SAME scaled space as the model's internal features (mel * FEAT_SCALE).
const FEAT_SCALE = 0.1

// Cap the reference to REF_SECONDS: prompt frames are prepended to gen frames in
// the sampler and processed every FM step, and they consume part of the fixed
// VOCOS_FRAMES budget — a long ref both slows synthesis and shrinks the room for
// gen text. Trim transcript by the same fraction so duration ratio stays sane.
async function applyRefCap() {
  if (!_fullRefMono) return
  let mono = _fullRefMono, txt = _fullRefText
  const capSamples = Math.floor(REF_SECONDS * FEATURE_RATE)
  if (mono.length > capSamples) {
    const frac = capSamples / mono.length
    mono = mono.slice(0, capSamples)
    if (txt) { const w = txt.split(/\s+/); txt = w.slice(0, Math.max(1, Math.round(w.length * frac))).join(' ') }
  }
  // Prefer a precomputed reference mel (`<wav>.luxmel.f32`) extracted by the REAL
  // vocos MelSpectrogramFeatures (tools/.../extract-lux-ref.py). The JS vocosFbank
  // is a reimplementation whose mel-scale/center-pad did not exactly match vocos,
  // which made the cloned voice robotic. The precomputed file is already in model
  // feature space (log-mel * FEAT_SCALE).
  let scaled, frames
  if (_refMelPath && fs.existsSync(_refMelPath)) {
    const buf = fs.readFileSync(_refMelPath)
    scaled = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
    frames = Math.floor(scaled.length / FEAT_DIM)
    console.log(`[lux-tts] using precomputed ref mel ${path.basename(_refMelPath)} (${frames} frames)`)
  } else {
    const r = vocosFbank(mono)
    frames = r.frames
    scaled = new Float32Array(r.features.length)
    for (let i = 0; i < r.features.length; i++) scaled[i] = r.features[i] * FEAT_SCALE
  }
  refPromptFeatures = scaled
  refPromptFramesLen = frames
  refRms = rms(mono)
  refText = txt
  refPromptTokens = await tokenizer.textToTokensLoaded(txt)
  console.log(`[lux-tts] ref voice set: ${refSource} (${mono.length} samples / ${(mono.length / FEATURE_RATE).toFixed(1)}s, ${frames} mel frames, ${refPromptTokens.length} prompt tokens)`)
}

let _refMelPath = null
export async function setRefVoice(wavPath, text) {
  await ensureModel()
  const { audio, sampleRate } = readWavMono(wavPath)
  _fullRefMono = resampleMono(audio, sampleRate, FEATURE_RATE) // mel features are @24k
  _fullRefText = (text || '').trim()
  refSource = path.basename(wavPath)
  _refMelPath = wavPath.replace(/\.wav$/i, '.luxmel.f32')
  await applyRefCap()
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------
async function generateChunk(genText, signal) {
  if (signal?.aborted) return null
  if (!refPromptFeatures) throw new Error('call setRefVoice() before synthesize')
  const tokens = await tokenizer.textToTokensLoaded(genText)
  if (!tokens.length) return null
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
  if (signal?.aborted) return null
  // The vocos input is a fixed 768-frame window, but the fm_decoder produces the
  // WHOLE utterance's frames in one pass. Vocode in 768-frame windows and stitch
  // -> the full reply renders with no truncation, and the TEXT is never chunked.
  let raw
  if (pred.frames <= VOCOS_FRAMES) {
    raw = await vocodeChunk(sessions, pred.data, pred.frames, refRms, 0.1)
  } else {
    const parts = []
    for (let off = 0; off < pred.frames; off += VOCOS_FRAMES) {
      if (signal?.aborted) return null
      const n = Math.min(VOCOS_FRAMES, pred.frames - off)
      const windowPred = pred.data.subarray(off * FEAT_DIM, (off + n) * FEAT_DIM)
      parts.push(await vocodeChunk(sessions, windowPred, n, refRms, 0.1))
    }
    const total = parts.reduce((s, a) => s + a.length, 0)
    raw = new Float32Array(total)
    let o = 0
    for (const p of parts) { raw.set(p, o); o += p.length }
  }
  if (signal?.aborted) return null
  // vocodeChunk matches the reference clip's loudness, which for cleetus is very
  // quiet (peak ~0.035) -> inaudible in Discord. Normalize each chunk to an
  // audible target peak. LUX_TARGET_PEAK tunes it.
  let peak = 0
  for (let i = 0; i < raw.length; i++) { const a = raw[i] < 0 ? -raw[i] : raw[i]; if (a > peak) peak = a }
  if (peak < 1e-5) return raw
  const g = TARGET_PEAK / peak
  const audio = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) { const v = raw[i] * g; audio[i] = v > 1 ? 1 : v < -1 ? -1 : v }
  return audio
}

// No chunker: synthesize the WHOLE reply in one pass (lux reads up to the 768-frame
// vocos window ~8s; fp32-on-webgpu makes that ~1.4s). One synth -> one contiguous
// push -> the dispipe pump streams it. (generateChunk clamps gen frames to the
// window, so an unusually long reply trims rather than splitting.)
export async function synthesize(text, _refPath, _refText, signal) {
  if (!text) throw new Error('text required')
  await ensureModel()
  if (signal?.aborted) return null
  const audio = await generateChunk(text, signal)
  if (!audio) return null
  return { audio, sampleRate: OUTPUT_RATE }
}

// One fm pass over the WHOLE reply (no text chunking, coherent prosody), then
// stream the vocoder's 768-frame audio windows as each is produced. The fm is
// non-causal so its frames are all ready at once (that latency is fixed); the
// vocoder is the part that streams -> for a reply over one window (~8s) the first
// window plays while later windows vocode.
function normalizePeak(raw) {
  let peak = 0
  for (let i = 0; i < raw.length; i++) { const a = raw[i] < 0 ? -raw[i] : raw[i]; if (a > peak) peak = a }
  if (peak < 1e-5) return raw
  const g = TARGET_PEAK / peak
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) { const v = raw[i] * g; out[i] = v > 1 ? 1 : v < -1 ? -1 : v }
  return out
}

export async function synthesizeStream(text, _refPath, _refText, onChunk, signal) {
  if (!text) throw new Error('text required')
  if (typeof onChunk !== 'function') throw new Error('onChunk required')
  await ensureModel()
  if (signal?.aborted) return { sampleRate: OUTPUT_RATE }
  // Stream per meaningful chunk: each chunk is its own fm pass ('epoch'). The first
  // chunk is short so its pass finishes fast (~1s) and audio starts immediately;
  // q4-webgpu (RTF ~0.3) synthesizes chunk N+1 before chunk N finishes playing, so
  // the dispipe pump streams them as one continuous voice. (The fm is non-causal so
  // a single whole-reply pass can't stream -- chunking is what unlocks the fast start.)
  for (const chunk of chunkForStreaming(text)) {
    if (signal?.aborted) break
    const audio = await generateChunk(chunk, signal)
    if (audio && !signal?.aborted) onChunk(audio, OUTPUT_RATE)
  }
  return { sampleRate: OUTPUT_RATE }
}

export function getDebugState() {
  return {
    modelLoaded: Boolean(sessions),
    speakerEncoded: Boolean(refPromptFeatures),
    speakerSource: refSource,
    loading: Boolean(loadPromise && !sessions),
    config: getSynthConfig(),
    refFrames: refPromptFramesLen,
    refTokens: refPromptTokens?.length || 0,
  }
}
