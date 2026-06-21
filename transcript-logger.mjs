// Continuous conversation transcript logger. Appends each finalized turn (user
// sentence or bot response) to a file, in conversation order. Append-only, never
// blocks the voice path. Path: TRANSCRIPT_LOG (default logs/transcript.log).
import fs from 'fs'
import path from 'path'

const LOG_PATH = process.env.TRANSCRIPT_LOG || path.join('logs', 'transcript.log')
let stream = null

function ensureStream() {
  if (stream) return stream
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    stream = fs.createWriteStream(LOG_PATH, { flags: 'a' })
    stream.on('error', (e) => { console.error('[transcript] write error:', e.message); stream = null })
    stream.write(`\n=== session start ${new Date().toISOString()} ===\n`)
  } catch (e) {
    console.error('[transcript] open failed:', e.message)
    stream = null
  }
  return stream
}

// entry: { role: 'user'|'bot', username, text, ts, meta }
// meta (bot turns): { gate, gateMs, answerMs, firstAudioMs, sinceHeardMs, aborted }
export function appendTurn({ role, username, text, ts, meta }) {
  const t = (text || '').trim()
  if (!t) return
  const s = ensureStream()
  if (!s) return
  const iso = new Date(ts || Date.now()).toISOString()
  const who = role === 'bot' ? `${process.env.BOT_NAME || 'Cleetus'} (bot)` : (username || 'user')
  let timing = ''
  if (meta) {
    const parts = []
    if (meta.replyMs != null) parts.push(`reply=${meta.replyMs}ms`)   // heard -> first sound (the real lag)
    if (meta.gate) parts.push(`gate=${meta.gate}${meta.gateMs != null ? `/${meta.gateMs}ms` : ''}`)
    if (meta.answerMs != null) parts.push(`llm=${meta.answerMs}ms`)
    if (meta.firstAudioMs != null) parts.push(`synth=${meta.firstAudioMs}ms`)
    if (meta.spokeForMs != null) parts.push(`spoke=${meta.spokeForMs}ms`)
    if (meta.aborted) parts.push('aborted')
    if (parts.length) timing = `   {${parts.join(' ')}}`
  }
  s.write(`[${iso}] ${who}: ${t}${timing}\n`)
}

export function transcriptPath() { return LOG_PATH }
