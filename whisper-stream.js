import { transcribe } from './discord-whisper.js'

const SAMPLE_RATE = 48000
// Time of no speech frames before we consider the utterance ended and fire
// Whisper on the accumulated audio. Discord PCM arrives in 20ms frames; the
// VAD drops sub-threshold frames. So "no frame for N ms" == "user paused N ms".
const UTTERANCE_END_SILENCE_MS = Number(process.env.WHISPER_UTTERANCE_END_MS || 700)
// Minimum speech samples to bother transcribing. Below this it's a click or
// throat-clear; Whisper hallucinates filler words on these.
const MIN_UTTERANCE_SAMPLES = SAMPLE_RATE * Number(process.env.WHISPER_MIN_SECONDS || 0.4)
// Maximum utterance length before forcing a transcribe even without silence.
// Prevents unbounded buffering during a long monologue.
const MAX_UTTERANCE_SECONDS = Number(process.env.WHISPER_MAX_SECONDS || 20)
// Pad the start/end of an utterance with silence — Whisper was trained on
// audio with natural silence around speech; concatenating pure-speech segments
// confuses it and triggers hallucinated end-of-sentence tokens.
const SILENCE_PAD_MS = Number(process.env.WHISPER_SILENCE_PAD_MS || 200)
const MIN_WORDS_TO_FIRE = Number(process.env.WHISPER_MIN_WORDS || 1)

const sessions = new Map()

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      chunks: [],
      totalSamples: 0,
      lastFrameAt: 0,
      inFlight: false,
      endTimer: null,
      latestText: '',
      latestConf: 0,
      listeners: [],
      stableListeners: [],
      lastFiredText: '',
    })
  }
  return sessions.get(userId)
}

function isSentinel(text) {
  if (!text) return true
  const t = text.trim()
  if (t.length === 0) return true
  let i = 0
  while (i < t.length) {
    while (i < t.length && t.charAt(i) === ' ') i++
    if (i >= t.length) break
    const open = t.charAt(i)
    if (open !== '[' && open !== '*' && open !== '(') return false
    const close = open === '[' ? ']' : open === '(' ? ')' : '*'
    const end = t.indexOf(close, i + 1)
    if (end < 0) return false
    i = end + 1
  }
  return true
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function scheduleUtteranceEnd(userId) {
  const s = sessions.get(userId)
  if (!s) return
  if (s.endTimer) clearTimeout(s.endTimer)
  s.endTimer = setTimeout(() => endUtterance(userId), UTTERANCE_END_SILENCE_MS)
}

async function endUtterance(userId) {
  const s = sessions.get(userId)
  if (!s) return
  s.endTimer = null
  if (s.inFlight) return                              // already transcribing this user
  if (s.totalSamples < MIN_UTTERANCE_SAMPLES) {       // too short — discard
    if (s.totalSamples > 0) {
      console.log(`[stream] uid=${userId} discarding short utterance (${s.totalSamples} samples)`)
    }
    s.chunks = []; s.totalSamples = 0
    return
  }
  s.inFlight = true
  const samples = s.totalSamples
  // Merge speech frames + add silence padding so Whisper sees natural audio
  const padSamples = Math.floor((SILENCE_PAD_MS / 1000) * SAMPLE_RATE)
  const merged = new Float32Array(padSamples + samples + padSamples)
  let off = padSamples
  for (const c of s.chunks) { merged.set(c, off); off += c.length }
  s.chunks = []; s.totalSamples = 0
  const t0 = Date.now()
  try {
    const result = await transcribe(merged, SAMPLE_RATE)
    const text = (result.text || '').trim()
    s.latestText = text
    s.latestConf = result.confidence
    const tookMs = Date.now() - t0
    if (!text || isSentinel(text)) {
      console.log(`[stream] uid=${userId} STT ${tookMs}ms samples=${samples} → (no speech, conf=${result.confidence.toFixed(2)})`)
    } else if (wordCount(text) < MIN_WORDS_TO_FIRE) {
      console.log(`[stream] uid=${userId} STT ${tookMs}ms samples=${samples} → too short: "${text}"`)
    } else if (text === s.lastFiredText) {
      console.log(`[stream] uid=${userId} STT ${tookMs}ms → duplicate of last fire: "${text}"`)
    } else {
      s.lastFiredText = text
      console.log(`[stream] uid=${userId} STT ${tookMs}ms samples=${samples} ⚡ "${text.slice(0,80)}" conf=${result.confidence.toFixed(2)}`)
      for (const fn of s.stableListeners) try { fn(text, result.confidence) } catch (e) { console.error('[stream] stable listener err:', e.message) }
      for (const fn of s.listeners) try { fn(text, result.confidence, '') } catch {}
    }
  } catch (err) {
    console.error(`[stream] uid=${userId} transcribe error:`, err.message)
  } finally {
    s.inFlight = false
  }
}

export function pushFrame(userId, f32Frame) {
  const s = getSession(userId)
  s.chunks.push(f32Frame)
  s.totalSamples += f32Frame.length
  s.lastFrameAt = Date.now()
  // If utterance is getting too long, force a transcribe even without silence
  if (s.totalSamples >= MAX_UTTERANCE_SECONDS * SAMPLE_RATE) {
    if (s.endTimer) { clearTimeout(s.endTimer); s.endTimer = null }
    endUtterance(userId)
    return
  }
  scheduleUtteranceEnd(userId)
}

export function getLatest(userId) {
  const s = sessions.get(userId)
  if (!s) return { text: '', confidence: 0, samples: 0 }
  return { text: s.latestText, confidence: s.latestConf, samples: s.totalSamples }
}

export function clear(userId) {
  const s = sessions.get(userId)
  if (!s) return
  s.chunks = []
  s.totalSamples = 0
  s.latestText = ''
  s.latestConf = 0
  if (s.endTimer) { clearTimeout(s.endTimer); s.endTimer = null }
}

export function onPartial(userId, fn) {
  const s = getSession(userId)
  s.listeners.push(fn)
}

export function onStable(userId, fn) {
  const s = getSession(userId)
  s.stableListeners.push(fn)
}
