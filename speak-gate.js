import { generate as generateLLM, isAvailable as isLLMAvailable, buildGrammar } from './llm.js'
import { synthesizeStream, setRefVoice as _setRefVoice } from './f5-tts-bridge.js'
import { resampleAudio } from './server-utils.mjs'

const SAMPLE_RATE_DISCORD = 48000
const SAMPLE_RATE_TTS_FALLBACK = 24000
const DEBOUNCE_MS = Number(process.env.GATE_DEBOUNCE_MS || 600)
// Skip the LLM gate call for messages that are clearly worth a reply — saves
// ~1s round-trip per turn. The gate prompt says "YES by default" anyway.
const GATE_LLM_THRESHOLD_CHARS = Number(process.env.GATE_LLM_THRESHOLD_CHARS || 8)
const STAGE_TIMEOUT = {
  GATING: Number(process.env.GATE_TIMEOUT_GATING_MS || 5000),
  ANSWERING: Number(process.env.GATE_TIMEOUT_ANSWER_MS || 15000),
  SPEAKING: Number(process.env.GATE_TIMEOUT_SPEAKING_MS || 30000),
}
const MAX_RESPONSE_CHARS = 280
const MAX_HISTORY = 12

const GATE_PROMPT = [
  'You decide whether the bot should speak now. Read the recent conversation. The user just stopped talking.',
  'Reply YES by default — the bot is conversational and should join in. Lean YES whenever the user said anything substantive, asked a question, addressed the bot, used the bot\'s name, or made a remark worth reacting to.',
  'Reply NO only when the user clearly addressed someone else by name, was obviously mid-sentence with no pause, said something trivial like a single filler word, or the bot already replied to this exact thing.',
  'Output only YES or NO.',
].join('\n')

let yesNoGrammar = null
async function getYesNoGrammar() {
  if (yesNoGrammar) return yesNoGrammar
  yesNoGrammar = await buildGrammar('root ::= "YES" | "NO"')
  return yesNoGrammar
}

const state = {
  name: 'LISTENING', enteredAt: Date.now(), debounceTimer: null, abort: null,
  lastWhisperAt: 0, lastDecision: null,
  audioSink: null, refPath: null, refText: null, characterPrompt: null,
  history: [], activeSpeakers: new Map(),
  metrics: {
    gateYes: 0, gateNo: 0, abortsByStage: { GATING: 0, ANSWERING: 0, SPEAKING: 0 },
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

function snapHistory(role, text, username = null) {
  if (!text) return
  state.history.push({ role, username, text, timestamp: Date.now() })
  if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY)
}

function buildContext() {
  return state.history.slice(-MAX_HISTORY).map(h =>
    h.role === 'user' ? `${h.username || 'user'}: "${h.text}"` : `bot: "${h.text}"`
  ).join('\n')
}

function armDebounce() {
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.debounceTimer = setTimeout(() => { state.debounceTimer = null; if (state.name === 'WAITING') runStage('GATING') }, DEBOUNCE_MS)
}

const onWhisperAbort = (reason) => () => { abortCurrent(reason); setState('WAITING', 'aborted by whisper'); armDebounce() }

// Protect SPEAKING until the bot has actually produced audio. Aborting during
// synthesis (before ANY audio) is pure waste -- the bot isn't speaking yet, so
// there's nothing to "interrupt"; in a busy channel that left the bot never
// completing a turn (spoken=0). F5 first chunk is ~9s, so the cap must cover the
// synth; once audio is playing, barge-in interrupts normally. The cap is only a
// stuck-TTS safety net.
const SPEAKING_PROTECT_MAX_MS = Number(process.env.GATE_SPEAKING_PROTECT_MAX_MS || 12000)
const onSpeakingWhisper = () => {
  if (!state._chunksPlayed && Date.now() - state.enteredAt < SPEAKING_PROTECT_MAX_MS) return
  onWhisperAbort('whisper-mid-speak')()
}

const transitions = {
  LISTENING: { onWhisperWord: () => { setState('WAITING', 'first whisper word'); armDebounce() } },
  WAITING:   { onWhisperWord: () => armDebounce() },
  GATING:    { onWhisperWord: onWhisperAbort('whisper-mid-gate') },
  // ANSWERING is committed + pre-audio: the gate already decided YES and the bot
  // isn't speaking yet, so new words don't abort (they're recorded for the next
  // turn). Without this, continuous channel chatter aborted every answer and the
  // bot never spoke. Barge-in resumes once SPEAKING emits audio.
  ANSWERING: { onWhisperWord: () => {} },
  SPEAKING:  { onWhisperWord: onSpeakingWhisper },
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

const STALE_USER_TURN_MS = Number(process.env.GATE_STALE_USER_TURN_MS || 20000)

const stageHandlers = {
  GATING: async (abort) => {
    if (!(await isLLMAvailable())) { setState('LISTENING', 'LLM offline'); return }

    const last = state.history[state.history.length - 1]
    if (!last || last.role !== 'user') { setState('LISTENING', 'no user turn'); return }
    const ageMs = Date.now() - last.timestamp
    if (ageMs > STALE_USER_TURN_MS) {
      console.log(`[gate] last user turn is stale (${ageMs}ms) — skipping`)
      setState('LISTENING', 'stale-user-turn')
      return
    }

    // Fast-path: skip the LLM gate call for clearly substantive messages.
    // The gate prompt itself says "YES by default" — a separate ~1s round-trip
    // per turn just to confirm that is wasteful. Only ask the LLM when the
    // message is short enough to be plausibly a filler ("yeah", "hm", "ok").
    const lastUserText = (last.text || '').trim()
    if (lastUserText.length >= GATE_LLM_THRESHOLD_CHARS) {
      const t = Date.now() - state.enteredAt
      state.lastDecision = { decision: 'YES', at: Date.now(), source: 'fastpath', latencyMs: t }
      state.metrics.gateYes++
      console.log(`[gate] decision=YES (fastpath, chars=${lastUserText.length}, ${t}ms)`)
      runStage('ANSWERING')
      return
    }

    const t0 = Date.now()
    const grammar = await getYesNoGrammar()
    const raw = await generateLLM(`${buildContext()}\n\n${GATE_PROMPT}\n\nDecision:`, state.characterPrompt || undefined, abort.signal, { grammar, maxTokens: 4 })
    if (state.abort !== abort) return
    const latencyMs = Date.now() - t0
    const decision = (raw || '').trim().toUpperCase().startsWith('Y') ? 'YES' : 'NO'
    state.lastDecision = { decision, at: Date.now(), source: 'llm', latencyMs }
    state.metrics[decision === 'YES' ? 'gateYes' : 'gateNo']++
    console.log(`[gate] decision=${decision} (llm ${latencyMs}ms) raw="${(raw || '').slice(0, 20)}"`)
    if (decision === 'YES') runStage('ANSWERING')
    else setState('LISTENING', 'gate=NO')
  },
  ANSWERING: async (abort) => {
    const t0 = Date.now()
    const now = Date.now()
    const recent = [...state.activeSpeakers.values()].filter(s => now - s.lastWordAt < 5000)
    const multiHint = recent.length >= 2
      ? `\n\nMultiple people just spoke at the same time: ${recent.map(s => s.username).join(' and ')}. Address both in your one reply.`
      : ''
    const raw = await generateLLM(`${buildContext()}${multiHint}\n\nReply with the bot's next spoken turn. Keep it conversational and short.`, state.characterPrompt || undefined, abort.signal, { maxTokens: 50 })
    if (state.abort !== abort) return
    const latencyMs = Date.now() - t0
    state.metrics.lastAnswerMs = latencyMs
    const text = (raw || '').trim().slice(0, MAX_RESPONSE_CHARS)
    console.log(`[gate] answer ${latencyMs}ms chars=${text.length} "${text.slice(0,40)}"`)
    if (!text) { setState('LISTENING', 'empty answer'); return }
    state._pendingResponse = text
    runStage('SPEAKING')
  },
  SPEAKING: async (abort) => {
    const text = state._pendingResponse || ''
    state._pendingResponse = null
    if (!text) { setState('LISTENING', 'no text'); return }
    let chunksPlayed = 0
    state._chunksPlayed = 0
    const speakStart = Date.now()
    const onChunk = (audio, sr) => {
      if (abort.signal.aborted || !state.audioSink) return
      if (chunksPlayed === 0) {
        state.metrics.lastTtsFirstChunkMs = Date.now() - speakStart
        console.log(`[gate] tts first-chunk ${state.metrics.lastTtsFirstChunkMs}ms`)
      }
      // Chatterbox occasionally produces peaks > 1.0; hard-clipping in the
      // sink causes audible distortion. Soft-attenuate before resample so the
      // entire chain stays inside [-1, 1] without losing dynamics.
      const out = resampleAudio(audio, sr || SAMPLE_RATE_TTS_FALLBACK, SAMPLE_RATE_DISCORD)
      const TTS_GAIN = Number(process.env.TTS_GAIN || 0.8)
      if (TTS_GAIN !== 1) for (let i = 0; i < out.length; i++) out[i] *= TTS_GAIN
      state.audioSink(out, text)
      chunksPlayed++
      state._chunksPlayed = chunksPlayed
    }
    try {
      await synthesizeStream(text, state.refPath, state.refText, onChunk, abort.signal)
    } finally {
      if (chunksPlayed > 0) {
        const words = text.split(/\s+/)
        const partial = abort.signal.aborted ? words.slice(0, Math.max(1, Math.floor(words.length * (chunksPlayed / (chunksPlayed + 2))))).join(' ') : text
        snapHistory('bot', partial)
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
  // Pass the transcript: the F5 bridge uses its internally-set refText (its
  // synthesize ignores the per-call _refText arg). Without it, refText='' makes
  // the F5 duration formula divide by ~0 -> out-of-range token index.
  if (refPath) _setRefVoice(refPath, refText).catch(err => console.error('[gate] setRefVoice failed:', err.message))
}
export function setCharacterCardPrompt(prompt) { state.characterPrompt = prompt }
export function setAudioSink(fn) { state.audioSink = fn }
export function clearHistory() { state.history.length = 0; console.log('[gate] history cleared') }

// Directly synthesize `text` (F5-TTS) and push it through the active audio sink
// -- the same resample (24k->48k) + sink path the SPEAKING stage uses. Lets the
// bot speak an arbitrary phrase without a human utterance (ops + Discord testing).
// Returns the number of audio chunks pushed.
export async function speak(text) {
  if (!text || !state.audioSink) return { chunks: 0, hasSink: Boolean(state.audioSink) }
  let chunks = 0
  const gain = Number(process.env.TTS_GAIN || 0.8)
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
    debounceArmed: Boolean(state.debounceTimer),
    msUntilTick: state.debounceTimer ? Math.max(0, DEBOUNCE_MS - (Date.now() - state.lastWhisperAt)) : null,
    activeAbortReason: state.abort ? 'in-flight' : null,
    lastDecision: state.lastDecision,
    history: state.history.slice(-10),
    activeSpeakers: [...state.activeSpeakers.entries()].map(([uid, v]) => ({ userId: uid, ...v })),
    metrics: state.metrics,
  }
}

export default { noteWhisperWord, setRefVoice, setCharacterCardPrompt, setAudioSink, clearHistory, getDebugSnapshot }
