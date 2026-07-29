import { generate as generateLLM } from './llm.js'
import { synthesizeStream, setRefVoice as _setRefVoice } from './lux-tts-bridge.js'
import { appendTurn as appendTranscript } from './transcript-logger.mjs'
import { resampleAudio } from './server-utils.mjs'

const SAMPLE_RATE_DISCORD = 48000
const SAMPLE_RATE_TTS_FALLBACK = 24000

const STAGE_TIMEOUT = {
  ANSWERING: Number(process.env.GATE_TIMEOUT_ANSWER_MS || 45000),
  SPEAKING: Number(process.env.GATE_TIMEOUT_SPEAKING_MS || 30000),
}
const MAX_RESPONSE_CHARS = Number(process.env.GATE_MAX_RESPONSE_CHARS || 600)
const INTERRUPT_FRESH_MS = Number(process.env.GATE_INTERRUPT_FRESH_MS || 15000)

// chatjimmy ignores max_tokens/stop/temperature (all witnessed), so the ONLY way to
// bound its rambling is client-side. Cap to maxChars but at a CLEAN boundary: prefer
// the last sentence ender within the cap, else the last whole word -- never mid-word.
function capAtSentence(text, maxChars) {
  const t = (text || '').trim()
  if (t.length <= maxChars) return t
  const head = t.slice(0, maxChars)
  const sent = head.match(/[\s\S]*[.!?](?=\s|$)/)
  if (sent && sent[0].trim().length > maxChars * 0.4) return sent[0].trim()
  const sp = head.lastIndexOf(' ')
  return (sp > 0 ? head.slice(0, sp) : head).trim()
}

const ANSWER_MAX_TOKENS = Number(process.env.GATE_ANSWER_MAX_TOKENS || 90)

function waitAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); resolve() }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

const MAX_HISTORY = 12

const state = {
  name: 'LISTENING', enteredAt: Date.now(), abort: null,
  lastWhisperAt: 0,
  audioSink: null, refPath: null, refText: null, characterPrompt: null,
  history: [], activeSpeakers: new Map(),
  metrics: {
    abortsByStage: { ANSWERING: 0, SPEAKING: 0 },
    timeouts: 0, spoken: 0, lastAnswerMs: null, lastTtsFirstChunkMs: null,
  },
}

function setState(next, reason = '') {
  console.log(`[gate] ${state.name} → ${next}${reason ? ` (${reason})` : ''}`)
  state.name = next; state.enteredAt = Date.now()
  if (next !== 'SPEAKING') state._chunksPlayed = 0
}

function abortCurrent(reason) {
  if (!state.abort) return
  state.metrics.abortsByStage[state.name] = (state.metrics.abortsByStage[state.name] || 0) + 1
  try { state.abort.abort(reason) } catch {}
  state.abort = null
}

function logTurn(h) {
  if (!h || h._logged) return
  h._logged = true
  try { appendTranscript({ role: h.role, username: h.username, text: h.text, ts: h.timestamp, meta: h._meta }) } catch {}
}

function snapHistory(role, text, username = null, meta = null) {
  if (!text) return
  const entry = { role, username, text, timestamp: (meta && meta._ts) || Date.now(), _meta: meta }
  state.history.push(entry)
  if (role === 'bot') logTurn(entry)
  for (let i = 0; i < state.history.length - 1; i++) logTurn(state.history[i])
  if (state.history.length > MAX_HISTORY) {
    const removed = state.history.splice(0, state.history.length - MAX_HISTORY)
    for (const h of removed) logTurn(h)
  }
}

function buildContext() {
  return state.history.slice(-MAX_HISTORY).map(h =>
    h.role === 'user' ? `${h.username || 'user'}: "${h.text}"` : `bot: "${h.text}"`
  ).join('\n')
}

// Whisper word during ANSWERING: abort the in-flight LLM call and restart with the
// new words. The user changed their mind or added more — the old answer is stale.
// During SPEAKING: barge-in only if audio has actually played (chunksPlayed > 0).
const transitions = {
  LISTENING: { onWhisperWord: () => runStage('ANSWERING') },
  ANSWERING: { onWhisperWord: () => { abortCurrent('whisper-mid-answer'); runStage('ANSWERING') } },
  SPEAKING:  {
    onWhisperWord: () => {
      if (!state._chunksPlayed) return // no audio yet — let the first chunk play
      abortCurrent('whisper-mid-speak')
      // Compute partial spoken text for the interrupt hint, then restart
      const text = state._speakingText || ''
      const words = text.split(/\s+/)
      const cp = state._chunksPlayed
      state._interrupted = {
        spoken: words.slice(0, Math.max(1, Math.floor(words.length * (cp / (cp + 2))))).join(' '),
        intended: text,
        at: Date.now(),
      }
      console.log(`[gate] BARGE-IN cut after "${state._interrupted.spoken.slice(0, 40)}"`)
      runStage('ANSWERING')
    },
  },
}

async function runStage(stage) {
  setState(stage)
  const abort = new AbortController()
  state.abort = abort
  const timer = setTimeout(() => { state.metrics.timeouts++; try { abort.abort('stage-timeout') } catch {} }, STAGE_TIMEOUT[stage])
  try {
    const handler = stageHandlers[stage]
    await handler(abort)
  } catch (err) {
    if (err?.name !== 'AbortError') console.error(`[gate] ${stage} error:`, err.message)
    if (state.name === stage) setState('LISTENING', `${stage}-err:${err?.name || 'x'}`)
  } finally {
    clearTimeout(timer)
    if (state.abort === abort) state.abort = null
  }
}

const stageHandlers = {
  ANSWERING: async (abort) => {
    const t0 = Date.now()
    const now = Date.now()
    const recent = [...state.activeSpeakers.values()].filter(s => now - s.lastWordAt < 5000)
    const multiHint = recent.length >= 2
      ? `\n\nMultiple people just spoke at the same time: ${recent.map(s => s.username).join(' and ')}. Address both in your one reply.`
      : ''
    // If a barge-in just cut the bot off, hand the LLM both halves so it segues
    // naturally.
    const intr = (state._interrupted && now - state._interrupted.at < INTERRUPT_FRESH_MS) ? state._interrupted : null
    state._interrupted = null
    const interruptHint = intr
      ? `\n\nYou got cut off mid-sentence -- you'd just said: "${intr.spoken}". They talked over you (their words are the last line above). If they were asking you to repeat or finish that, pick it right back up; if it's something new, go with that. Either way lead in like you were interrupted (a quick "oh-" / "right, so-" / "anyway-"), don't restart cold.`
      : ''
    const lastUser = [...state.history].reverse().find(h => h.role === 'user')
    if (lastUser) state._triggerHeardAt = lastUser.timestamp
    const raw = await generateLLM(`${buildContext()}${multiHint}${interruptHint}`, state.characterPrompt || undefined, abort.signal, { maxTokens: ANSWER_MAX_TOKENS })
    if (state.abort !== abort) return
    state.metrics.lastAnswerMs = Date.now() - t0
    let text = (raw || '').trim()
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('"') && text.endsWith('"'))) {
      text = text.slice(1, -1).trim()
    }
    text = capAtSentence(text, MAX_RESPONSE_CHARS)
    console.log(`[gate] answer ${state.metrics.lastAnswerMs}ms chars=${text.length} "${text.slice(0, 40)}"`)
    if (!text) { setState('LISTENING', 'empty answer'); return }
    state._pendingResponse = text
    runStage('SPEAKING')
  },
  SPEAKING: async (abort) => {
    const text = state._pendingResponse || ''
    state._pendingResponse = null
    if (!text) { setState('LISTENING', 'no text'); return }
    state._speakingText = text
    let chunksPlayed = 0
    state._chunksPlayed = 0
    const speakStart = Date.now()
    const onChunk = (audio, sr) => {
      if (abort.signal.aborted || !state.audioSink) return
      const durMs = (audio.length / (sr || SAMPLE_RATE_TTS_FALLBACK)) * 1000
      if (chunksPlayed === 0) {
        state._firstAudioAt = Date.now()
        state.metrics.lastTtsFirstChunkMs = state._firstAudioAt - speakStart
        console.log(`[gate] tts first-chunk ${state.metrics.lastTtsFirstChunkMs}ms`)
      }
      const out = resampleAudio(audio, sr || SAMPLE_RATE_TTS_FALLBACK, SAMPLE_RATE_DISCORD)
      const TTS_GAIN = Number(process.env.TTS_GAIN || 1.0)
      if (TTS_GAIN !== 1) for (let i = 0; i < out.length; i++) out[i] *= TTS_GAIN
      state.audioSink(out, text)
      pushedSamples += out.length
      chunksPlayed++
      state._chunksPlayed = chunksPlayed
    }
    let pushedSamples = 0
    try {
      await synthesizeStream(text, state.refPath, state.refText, onChunk, abort.signal)
      if (!abort.signal.aborted && pushedSamples > 0 && state._firstAudioAt) {
        const playMs = (pushedSamples / SAMPLE_RATE_DISCORD) * 1000
        const remain = playMs - (Date.now() - state._firstAudioAt)
        if (remain > 0) await waitAbortable(remain, abort.signal)
      }
    } finally {
      if (chunksPlayed > 0) {
        const words = text.split(/\s+/)
        const partial = abort.signal.aborted ? words.slice(0, Math.max(1, Math.floor(words.length * (chunksPlayed / (chunksPlayed + 2))))).join(' ') : text
        snapHistory('bot', partial, null, {
          answerMs: state.metrics.lastAnswerMs,
          firstAudioMs: state.metrics.lastTtsFirstChunkMs,
          replyMs: (state._firstAudioAt && state._triggerHeardAt) ? state._firstAudioAt - state._triggerHeardAt : null,
          spokeForMs: state._firstAudioAt ? Date.now() - state._firstAudioAt : null,
          aborted: abort.signal.aborted,
          _ts: state._firstAudioAt || undefined,
        })
        if (!abort.signal.aborted) state.metrics.spoken++
      }
      if (state.name === 'SPEAKING') setState('LISTENING', `done chunks=${chunksPlayed}`)
    }
  },
}

const MIN_WORD_CHARS = Number(process.env.GATE_MIN_WORD_CHARS || 3)

function stripSentinels(text) {
  return text.replace(/\[[^\]]*\]|\*[^*]*\*|\([^)]*\)/g, ' ').trim()
}

function isWordlessOrSentinel(text) {
  if (!text) return true
  const stripped = stripSentinels(text.trim())
  const alphanumCount = (stripped.match(/[a-zA-Z0-9]/g) || []).length
  return alphanumCount < MIN_WORD_CHARS
}

export function noteWhisperWord({ userId, username, text }) {
  if (isWordlessOrSentinel(text)) return
  state.lastWhisperAt = Date.now()
  state.activeSpeakers.set(userId, { username, lastWordAt: state.lastWhisperAt, lastText: text })
  const last = state.history[state.history.length - 1]
  if (last && last.role === 'user' && last.username === username) {
    last.text = text
    last.timestamp = state.lastWhisperAt
  } else snapHistory('user', text, username)
  transitions[state.name]?.onWhisperWord?.()
}

export function setRefVoice(refPath, refText) {
  state.refPath = refPath; state.refText = refText
  if (refPath) _setRefVoice(refPath, refText).catch(err => console.error('[gate] setRefVoice failed:', err.message))
}
export function setCharacterCardPrompt(prompt) { state.characterPrompt = prompt }
export function setAudioSink(fn) { state.audioSink = fn }

// Barge-in from discord-vad (RMS-based): the listener started talking over the bot.
// Only fires if audio was actually playing (chunksPlayed > 0).
export function bargeIn() {
  if (state.name !== 'SPEAKING' || !state._chunksPlayed) return false
  const text = state._speakingText || ''
  const words = text.split(/\s+/)
  const cp = state._chunksPlayed
  const spoken = words.slice(0, Math.max(1, Math.floor(words.length * (cp / (cp + 2))))).join(' ')
  state._interrupted = { spoken, intended: text, at: Date.now() }
  console.log(`[gate] BARGE-IN cut after "${spoken.slice(0, 40)}"`)
  abortCurrent('barge-in')
  return true
}
export function clearHistory() { state.history.length = 0; console.log('[gate] history cleared') }

export async function speak(text) {
  if (!text || !state.audioSink) return { chunks: 0, hasSink: Boolean(state.audioSink) }
  let chunks = 0
  const gain = Number(process.env.TTS_GAIN || 1.0)
  const onChunk = (audio, sr) => {
    if (!state.audioSink) return
    const out = resampleAudio(audio, sr || SAMPLE_RATE_TTS_FALLBACK, SAMPLE_RATE_DISCORD)
    if (gain !== 1) for (let i = 0; i < out.length; i++) out[i] *= gain
    state.audioSink(out, text)
    chunks++
  }
  await synthesizeStream(text, state.refPath, state.refText, onChunk)
  if (chunks > 0) snapHistory('bot', text)
  return { chunks }
}

export function getDebugSnapshot() {
  return {
    state: state.name,
    msInState: Date.now() - state.enteredAt,
    activeAbortReason: state.abort ? 'in-flight' : null,
    history: state.history.slice(-10),
    activeSpeakers: [...state.activeSpeakers.entries()].map(([uid, v]) => ({ userId: uid, ...v })),
    metrics: state.metrics,
  }
}

export default { noteWhisperWord, setRefVoice, setCharacterCardPrompt, setAudioSink, bargeIn, clearHistory, getDebugSnapshot }