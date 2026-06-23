import { generate as generateLLM, isAvailable as isLLMAvailable } from './llm.js'
// LuxTTS (ZipVoice-distill, 4-step) replaces F5 — ~3x faster, already 48kHz so
// the resampleAudio(audio, 48000, 48000) below is a no-op (ratio 1).
import { synthesizeStream, setRefVoice as _setRefVoice } from './lux-tts-bridge.js'
import { appendTurn as appendTranscript } from './transcript-logger.mjs'
import { resampleAudio } from './server-utils.mjs'

const SAMPLE_RATE_DISCORD = 48000
const SAMPLE_RATE_TTS_FALLBACK = 24000
// whisper-stream already fires ONCE per utterance (after its own 550ms end-of-
// speech silence), so this gate debounce only needs to coalesce near-simultaneous
// utterances, not wait out the pause again -- 1100ms here was ~1s of pure latency.
// Pause tolerance lives in WHISPER_UTTERANCE_END_MS, not here.
// 0 = no debounce wait: whisper already fires ONCE per utterance at its own
// end-of-speech silence, so the gate triggers on the next tick. (Set >0 only to
// re-coalesce if a source ever emits multiple fires per utterance again.)
const DEBOUNCE_MS = Number(process.env.GATE_DEBOUNCE_MS || 0)
// Skip the LLM gate call for messages that are clearly worth a reply — saves
// ~1s round-trip per turn. The gate prompt says "YES by default" anyway.
// Above this many chars the gate skips the LLM YES/NO call and just replies
// (fast path). Default 1 = effectively always fast-path: the wordless/sentinel +
// confidence filters already drop noise, and the LLM gate added up to ~2.8s of
// latency. Raise it only if the bot over-responds to filler.
const STAGE_TIMEOUT = {
  GATING: Number(process.env.GATE_TIMEOUT_GATING_MS || 5000),
  ANSWERING: Number(process.env.GATE_TIMEOUT_ANSWER_MS || 45000), // spans stream + synth + playback
  SPEAKING: Number(process.env.GATE_TIMEOUT_SPEAKING_MS || 30000),
}
const MAX_RESPONSE_CHARS = Number(process.env.GATE_MAX_RESPONSE_CHARS || 600)
// Token budget for the spoken reply. 50 cut responses off mid-sentence; allow a
// normal sentence-or-two reply. TTS streams per sentence so length != huge delay.
// Replies no longer truncate (the synth vocodes in windows), so allow a complete
// natural turn; keep it modest for snappiness.
const ANSWER_MAX_TOKENS = Number(process.env.GATE_ANSWER_MAX_TOKENS || 60)
// Resolve after ms, or immediately when the signal aborts (so a barge-in still
// interrupts the wait-for-playback in SPEAKING).
function waitAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); resolve() }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
// Whisper confidence floor. Below this the transcription is likely noise/cross-talk
// garbled into real-looking words -> drop it rather than feed the LLM garbage.
const MAX_HISTORY = 12

// Stage-1 system prompt: the LLM reads a noisy speech-to-text line, recovers the
// real words, and gates in one shot. Few-shot examples make a small model emit the
// RESPOND:/IGNORE marker reliably (a plain instruction made it ramble/restate).
const STAGE1_SYS = [
  'You clean up a noisy speech-to-text feed for a gas-station attendant. Each "mic:" line is what a microphone THOUGHT it heard -- often garbled, clipped, or mishearing words. Reply with exactly one of:',
  'RESPOND: <the real words, cleaned up> -- when it is genuine speech a person aimed at the attendant',
  'IGNORE -- when it is only noise, a broken half-fragment, or the attendant\'s own previous line echoing back',
  'Never explain, never add anything else.',
  '',
  'mic: "[BLANK_AUDIO]"',
  'IGNORE',
  'mic: "wzzt krr mmh the"',
  'IGNORE',
  'mic: "hey you got any cold pop in there"',
  'RESPOND: hey, you got any cold pop in there?',
  'mic: "Zedadimani Reesana cooler"',
  'IGNORE',
  'mic: "howmuch fer the premium"',
  'RESPOND: how much for the premium?',
].join('\n')
const STAGE1_TEMP = Number(process.env.GATE_STAGE1_TEMP || 0)

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

function logTurn(h) {
  if (!h || h._logged) return
  h._logged = true
  try { appendTranscript({ role: h.role, username: h.username, text: h.text, ts: h.timestamp, meta: h._meta }) } catch {}
}

function snapHistory(role, text, username = null, meta = null) {
  if (!text) return
  const entry = { role, username, text, timestamp: (meta && meta._ts) || Date.now(), _meta: meta }
  state.history.push(entry)
  if (role === 'bot') logTurn(entry)                       // bot turns are final on write
  // earlier turns are now superseded (final). The last entry may still be a
  // user turn growing in place (noteWhisperWord), so leave it until superseded.
  for (let i = 0; i < state.history.length - 1; i++) logTurn(state.history[i])
  if (state.history.length > MAX_HISTORY) {
    const removed = state.history.splice(0, state.history.length - MAX_HISTORY)
    for (const h of removed) logTurn(h)                     // never drop an unlogged turn
  }
}

function buildContext() {
  return state.history.slice(-MAX_HISTORY).map(h =>
    h.role === 'user' ? `${h.username || 'user'}: "${h.text}"` : `bot: "${h.text}"`
  ).join('\n')
}

function armDebounce() {
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null
    // The user just finished a sentence (silence past the debounce) -> log it now,
    // in time order, so it precedes the bot's reply in the transcript.
    const last = state.history[state.history.length - 1]
    if (last && last.role === 'user') logTurn(last)
    if (state.name === 'WAITING') runStage('GATING')
  }, DEBOUNCE_MS)
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
  ANSWERING: { onWhisperWord: () => {} }, // committed during LLM gen (no audio yet)
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
    state._triggerHeardAt = last.timestamp
    const ageMs = Date.now() - last.timestamp
    if (ageMs > STALE_USER_TURN_MS) {
      console.log(`[gate] last user turn is stale (${ageMs}ms) — skipping`)
      setState('LISTENING', 'stale-user-turn')
      return
    }

    // Stage 1: hand the LLM the noisy STT line + recent context. It recovers the
    // real words AND gates in one call -- RESPOND:<cleaned> to reply, IGNORE for
    // noise/echo/not-for-you. This subsumes the old fastpath + YES/NO gate + the
    // confidence + self-echo filters: garbled input is corrected, echoes ignored.
    const raw = (last.text || '').trim()
    // NO conversation context in stage-1: any prior text (even the bot's own last
    // line as an "echo hint") anchors the small model and it cleans the mic line
    // TOWARD that text -- "what's on special" became "we'll get a new Honda" after a
    // car-talk turn. The user turn is exactly `mic: "X"` to match the few-shot, and
    // echo is handled upstream by the discord-vad bot-speaking mask.
    const t0 = Date.now()
    const out = (await generateLLM(
      `mic: "${raw}"`,
      STAGE1_SYS, abort.signal, { maxTokens: 50, temperature: STAGE1_TEMP },
    ) || '').trim()
    if (state.abort !== abort) return
    const latencyMs = Date.now() - t0
    const ignore = /^\s*ignore\b/i.test(out) || /\bignore\s*$/i.test(out)
    const decision = ignore ? 'NO' : 'YES'
    state.lastDecision = { decision, at: Date.now(), source: 'interpret', latencyMs }
    state.metrics[decision === 'YES' ? 'gateYes' : 'gateNo']++
    console.log(`[gate] interpret=${decision} (${latencyMs}ms) "${out.slice(0, 50)}"`)
    if (ignore) { setState('LISTENING', 'interpret=IGNORE'); return }
    // The gate decision (RESPOND vs IGNORE) is the reliable part of stage-1 and that
    // is what we use -- the bot answers the RAW words. Applying stage-1's CLEANED text
    // is OFF by default (GATE_USE_CLEANED=1): on chatjimmy it is right ~80% but
    // hallucinates plausible-but-wrong corrections ~20% (carrying the RESPOND marker,
    // so undetectable), which would regress the common clear-input case. With a
    // stronger keyed LLM the cleaning is safe to enable.
    if (process.env.GATE_USE_CLEANED === '1') {
      const m = out.match(/respond:\s*([\s\S]+)/i)
      const cleaned = m ? m[1].trim().replace(/^["'“]|["'”]$/g, '').trim() : ''
      if (cleaned) { last.text = cleaned; console.log(`[gate] cleaned="${cleaned.slice(0, 50)}"`) }
    }
    runStage('ANSWERING')
  },
  ANSWERING: async (abort) => {
    const t0 = Date.now()
    const now = Date.now()
    const recent = [...state.activeSpeakers.values()].filter(s => now - s.lastWordAt < 5000)
    const multiHint = recent.length >= 2
      ? `\n\nMultiple people just spoke at the same time: ${recent.map(s => s.username).join(' and ')}. Address both in your one reply.`
      : ''
    const raw = await generateLLM(`${buildContext()}${multiHint}`, state.characterPrompt || undefined, abort.signal, { maxTokens: ANSWER_MAX_TOKENS })
    if (state.abort !== abort) return
    state.metrics.lastAnswerMs = Date.now() - t0
    let text = (raw || '').trim()
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”'))) {
      text = text.slice(1, -1).trim()
    }
    text = text.slice(0, MAX_RESPONSE_CHARS)
    console.log(`[gate] answer ${state.metrics.lastAnswerMs}ms chars=${text.length} "${text.slice(0, 40)}"`)
    if (!text) { setState('LISTENING', 'empty answer'); return }
    state._pendingResponse = text
    runStage('SPEAKING')
  },
  SPEAKING: async (abort) => {
    const text = state._pendingResponse || ''
    state._pendingResponse = null
    if (!text) { setState('LISTENING', 'no text'); return }
    state._botSpeechWords = wordSet(text)        // for the self-echo content filter
    let chunksPlayed = 0
    state._chunksPlayed = 0
    const speakStart = Date.now()
    const onChunk = (audio, sr) => {
      if (abort.signal.aborted || !state.audioSink) return
      // keep the echo window alive while the bot's audio is actually playing
      const durMs = (audio.length / (sr || SAMPLE_RATE_TTS_FALLBACK)) * 1000
      state._echoActiveUntil = Date.now() + durMs + ECHO_TAIL_MS
      if (chunksPlayed === 0) {
        state._firstAudioAt = Date.now()
        state.metrics.lastTtsFirstChunkMs = state._firstAudioAt - speakStart
        console.log(`[gate] tts first-chunk ${state.metrics.lastTtsFirstChunkMs}ms`)
      }
      // Chatterbox occasionally produces peaks > 1.0; hard-clipping in the
      // sink causes audible distortion. Soft-attenuate before resample so the
      // entire chain stays inside [-1, 1] without losing dynamics.
      const out = resampleAudio(audio, sr || SAMPLE_RATE_TTS_FALLBACK, SAMPLE_RATE_DISCORD)
      const TTS_GAIN = Number(process.env.TTS_GAIN || 1.0) // lux is already normalized + clamped
      if (TTS_GAIN !== 1) for (let i = 0; i < out.length; i++) out[i] *= TTS_GAIN
      state.audioSink(out, text)
      pushedSamples += out.length
      chunksPlayed++
      state._chunksPlayed = chunksPlayed
    }
    let pushedSamples = 0
    try {
      await synthesizeStream(text, state.refPath, state.refText, onChunk, abort.signal)
      // The audio is pushed instantly but STREAMS from the pump in real time after
      // synth returns. Stay in SPEAKING until it has actually finished playing,
      // otherwise the bot goes idle mid-playback and the tail gets cut. Abortable
      // so a real barge-in still interrupts.
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
          gate: state.lastDecision?.source,
          gateMs: state.lastDecision?.latencyMs,
          answerMs: state.metrics.lastAnswerMs,
          firstAudioMs: state.metrics.lastTtsFirstChunkMs,
          // the real responsiveness: heard -> first sound out
          replyMs: (state._firstAudioAt && state._triggerHeardAt) ? state._firstAudioAt - state._triggerHeardAt : null,
          spokeForMs: state._firstAudioAt ? Date.now() - state._firstAudioAt : null,
          aborted: abort.signal.aborted,
          _ts: state._firstAudioAt || undefined, // log the turn at when the bot started speaking
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

// Self-echo content filter: while the bot's audio is playing (+ a tail), drop any
// inbound transcription whose words mostly overlap what the bot is saying -- that
// is the bot's own voice coming back through open speakers, not a new utterance.
// Stops the bot replying to itself AND stops it aborting its own sentence.
const ECHO_TAIL_MS = Number(process.env.GATE_ECHO_TAIL_MS || 2500)
function wordSet(text) { return new Set((text || '').toLowerCase().match(/[a-z0-9']+/g) || []) }
export function noteWhisperWord({ userId, username, text }) {
  if (isWordlessOrSentinel(text)) return
  // No confidence floor or echo filter here anymore: stage-1 of the gate reads the
  // raw (lossy) line + context and IGNOREs garble/echo/not-for-you itself, while the
  // discord-vad bot-speaking mask already drops most acoustic loopback upstream.
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
