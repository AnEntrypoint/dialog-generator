// Remote LLM adapter — talks to chatjimmy.ai (free public endpoint).
// Mirrors the API surface of ./llm-llamacpp.js so it can drop in via ./llm.js dispatcher.

const BASE = process.env.CJ_BASE || 'https://chatjimmy.ai'
const DEFAULT_MODEL = process.env.CJ_MODEL || 'llama3.1-8B'
const PROBE_TIMEOUT_MS = Number(process.env.CJ_PROBE_TIMEOUT_MS || 4000)
const REQUEST_TIMEOUT_MS = Number(process.env.CJ_REQUEST_TIMEOUT_MS || 30000)

const STATS_RE = /<\|stats\|>[\s\S]*?<\|\/stats\|>\s*$/

let availabilityPromise = null

export async function isAvailable() {
  if (availabilityPromise) return availabilityPromise
  availabilityPromise = (async () => {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
      const r = await fetch(`${BASE}/api/models`, { signal: ctrl.signal })
      clearTimeout(t)
      if (!r.ok) return false
      const j = await r.json()
      return Array.isArray(j?.data) && j.data.length > 0
    } catch {
      return false
    }
  })()
  return availabilityPromise
}

export function resetAvailability() { availabilityPromise = null }

// Grammar object is opaque to remote; we stash the constraint string so generate() can post-filter.
export async function buildGrammar(grammarString) {
  return { __remoteGrammar: true, source: grammarString }
}

function applyGrammar(text, grammar) {
  if (!grammar?.__remoteGrammar) return text
  // Support simple alternation grammars like `root ::= "YES" | "NO"`.
  const alts = []
  const re = /"([^"]+)"/g
  let m
  while ((m = re.exec(grammar.source)) !== null) alts.push(m[1])
  if (!alts.length) return text
  const up = text.toUpperCase()
  for (const a of alts) if (up.includes(a.toUpperCase())) return a
  return alts[0]
}

async function* streamChat(messages, model, signal) {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, chatOptions: { selectedModel: model } }),
      signal: ctrl.signal,
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new Error(`chatjimmy ${r.status}: ${t.slice(0, 200)}`)
    }
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let inStats = false
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      while (true) {
        if (inStats) {
          const end = buf.indexOf('<|/stats|>')
          if (end < 0) { buf = ''; break }
          buf = buf.slice(end + '<|/stats|>'.length)
          inStats = false
          continue
        }
        const start = buf.indexOf('<|stats|>')
        if (start >= 0) {
          if (start > 0) yield buf.slice(0, start)
          buf = buf.slice(start + '<|stats|>'.length)
          inStats = true
          continue
        }
        const hold = Math.min(buf.length, 9)
        const safeLen = buf.length - hold
        if (safeLen > 0) { yield buf.slice(0, safeLen); buf = buf.slice(safeLen) }
        break
      }
    }
    buf += dec.decode()
    if (!inStats && buf) yield buf.replace(STATS_RE, '')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

function buildMessages(prompt, system) {
  const msgs = []
  if (system) msgs.push({ role: 'system', content: system })
  msgs.push({ role: 'user', content: prompt })
  return msgs
}

export async function generate(prompt, system = 'You are a helpful assistant. Be concise.', signal, extraOpts = {}) {
  const t0 = Date.now()
  const model = extraOpts.model || DEFAULT_MODEL
  const max = Number(extraOpts.maxTokens) || 0
  let out = ''
  try {
    for await (const chunk of streamChat(buildMessages(prompt, system), model, signal)) {
      out += chunk
      if (max && out.length > max * 8) break
    }
    out = applyGrammar(out.trim(), extraOpts.grammar)
    console.log(`[cj] gen ${Date.now() - t0}ms chars=${out.length}`)
    return out
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }
    throw err
  }
}

export async function* generateTokens(prompt, system = 'You are a helpful assistant. Be concise.', signal) {
  for await (const chunk of streamChat(buildMessages(prompt, system), DEFAULT_MODEL, signal)) {
    yield chunk
  }
}

export async function generateStream(prompt, system = 'You are a helpful assistant. Be concise.') {
  const gen = generateTokens(prompt, system)
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await gen.next()
      if (done) controller.close()
      else controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: value } }) + '\n'))
    },
  })
}

export async function warmup() {
  const t0 = Date.now()
  const ok = await isAvailable()
  console.log(`[cj] warmup ${Date.now() - t0}ms available=${ok}`)
  return ok
}

export default { generate, generateTokens, generateStream, isAvailable, warmup, buildGrammar, resetAvailability }
