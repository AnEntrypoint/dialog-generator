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

// entry: { role: 'user'|'bot', username, text, ts }
export function appendTurn({ role, username, text, ts }) {
  const t = (text || '').trim()
  if (!t) return
  const s = ensureStream()
  if (!s) return
  const iso = new Date(ts || Date.now()).toISOString()
  const who = role === 'bot' ? `${process.env.BOT_NAME || 'Cleetus'} (bot)` : (username || 'user')
  s.write(`[${iso}] ${who}: ${t}\n`)
}

export function transcriptPath() { return LOG_PATH }
