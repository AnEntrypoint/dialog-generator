// Fast multi-provider LLM chain. Iterates PROVIDER_ORDER and uses the first
// provider that (a) has a config here, (b) has a non-empty API key in the env,
// and (c) actually answers. groq/cerebras/sambanova are sub-1s OpenAI-compatible
// endpoints -> much more fluid than chatjimmy (~1.3s). Providers without a key
// or without a config are skipped; chatjimmy + local llama.cpp remain the tail
// fallbacks in llm.js. No key for ANY provider -> this backend reports
// unavailable and llm.js falls through to chatjimmy.
//
// All configured providers speak the OpenAI /chat/completions shape. Models are
// small/fast instruct models (the gate does YES/NO + one-sentence replies).

const P = (base, model, keyEnv, extra = {}) => ({ base, model, keyEnv, ...extra })

// base URL is the OpenAI-compatible root; we POST `${base}/chat/completions`.
const CONFIGS = {
  groq: P('https://api.groq.com/openai/v1', 'llama-3.1-8b-instant', 'GROQ_API_KEY'),
  cerebras: P('https://api.cerebras.ai/v1', 'llama3.1-8b', 'CEREBRAS_API_KEY'),
  sambanova: P('https://api.sambanova.ai/v1', 'Meta-Llama-3.1-8B-Instruct', 'SAMBANOVA_API_KEY'),
  mistral: P('https://api.mistral.ai/v1', 'mistral-small-latest', 'MISTRAL_API_KEY'),
  codestral: P('https://codestral.mistral.ai/v1', 'codestral-latest', 'CODESTRAL_API_KEY'),
  qwen: P('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen-turbo', 'QWEN_API_KEY'),
  zai: P('https://api.z.ai/api/paas/v4', 'glm-4-flash', 'ZAI_API_KEY'),
  nvidia: P('https://integrate.api.nvidia.com/v1', 'meta/llama-3.1-8b-instruct', 'NVIDIA_API_KEY'),
  gemini: P('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.0-flash', 'GOOGLE_API_KEY'),
  openrouter: P('https://openrouter.ai/api/v1', 'meta-llama/llama-3.1-8b-instruct', 'OPENROUTER_API_KEY'),
  // cloudflare needs an account id (CLOUDFLARE_ACCOUNT_ID); configured only if present
  cloudflare: P('', '@cf/meta/llama-3.1-8b-instruct', 'CLOUDFLARE_API_KEY', {
    resolveBase: () => process.env.CLOUDFLARE_ACCOUNT_ID
      ? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1` : null,
  }),
  // ollama: local OpenAI-compatible server; no key, only if reachable
  ollama: P(process.env.OLLAMA_BASE || 'http://localhost:11434/v1', process.env.OLLAMA_MODEL || 'llama3.1:8b', null, { noKey: true }),
}

const REQUEST_TIMEOUT_MS = Number(process.env.LLM_PROVIDER_TIMEOUT_MS || 12000)
const PROBE_TIMEOUT_MS = Number(process.env.LLM_PROVIDER_PROBE_MS || 4000)

function orderedProviders() {
  const order = (process.env.PROVIDER_ORDER || '').split(',').map((s) => s.trim()).filter(Boolean)
  const out = []
  for (const name of order) {
    const cfg = CONFIGS[name]
    if (!cfg) continue // unknown / ACP-wrapper / not configured here -> skip
    const base = cfg.resolveBase ? cfg.resolveBase() : cfg.base
    if (!base) continue
    const key = cfg.noKey ? '' : (process.env[cfg.keyEnv] || '').trim()
    if (!cfg.noKey && !key) continue // no key -> skip
    out.push({ name, base, model: cfg.model, key, noKey: cfg.noKey })
  }
  return out
}

function buildMessages(prompt, system) {
  const msgs = []
  if (system) msgs.push({ role: 'system', content: system })
  msgs.push({ role: 'user', content: prompt })
  return msgs
}

async function chatCompletion(p, messages, signal, maxTokens) {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort, { once: true }) }
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (!p.noKey) headers.Authorization = `Bearer ${p.key}`
    const body = { model: p.model, messages, stream: false }
    if (maxTokens) body.max_tokens = maxTokens
    const r = await fetch(`${p.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
    if (!r.ok) throw new Error(`${p.name} HTTP ${r.status}`)
    const j = await r.json()
    const text = j?.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error(`${p.name} malformed response`)
    return text.trim()
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

// Grammar is unsupported upstream; mirror chatjimmy: opaque token, post-processed.
export function buildGrammar(grammarString) { return { _alts: extractAlternation(grammarString) } }
function extractAlternation(g) {
  const m = String(g || '').match(/"([^"]+)"/g)
  return m ? m.map((s) => s.replace(/"/g, '')) : null
}
function applyGrammar(text, grammar) {
  const alts = grammar?._alts
  if (!alts || !alts.length) return text
  const up = text.toUpperCase()
  let best = null, bestIdx = Infinity
  for (const a of alts) { const i = up.indexOf(a.toUpperCase()); if (i !== -1 && i < bestIdx) { best = a; bestIdx = i } }
  return best ?? alts[0]
}

let cached = null // {name, ...provider}
export function resetAvailability() { cached = null }

export function listProviders() { return orderedProviders().map((p) => p.name) }

export async function isAvailable() {
  const providers = orderedProviders()
  if (!providers.length) return false
  // probe the first; if it answers, the chain is live. (generate() still falls
  // through the rest on a per-call failure.)
  for (const p of providers) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
      try {
        await chatCompletion(p, buildMessages('hi', 'Reply with one word.'), ctrl.signal, 4)
        cached = p
        return true
      } finally { clearTimeout(t) }
    } catch { /* try next */ }
  }
  return false
}

export async function generate(prompt, system = 'You are a helpful assistant. Be concise.', signal, extraOpts = {}) {
  const providers = orderedProviders()
  if (!providers.length) throw new Error('no provider with a key configured')
  // try cached first, then the rest in order
  const ordered = cached ? [cached, ...providers.filter((p) => p.name !== cached.name)] : providers
  let lastErr
  for (const p of ordered) {
    if (signal?.aborted) throw new Error('aborted')
    try {
      const text = await chatCompletion(p, buildMessages(prompt, system), signal, extraOpts.maxTokens)
      cached = p
      return extraOpts.grammar ? applyGrammar(text, extraOpts.grammar) : text
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err
      lastErr = err
      console.warn(`[llm-providers] ${p.name} failed (${err.message}); next`)
    }
  }
  throw new Error(`all providers failed: ${lastErr?.message}`)
}

export async function* generateTokens(prompt, system, signal) {
  // non-streaming providers: yield the whole reply once
  yield await generate(prompt, system, signal)
}

export async function warmup() { try { await isAvailable() } catch {} }

export default { isAvailable, generate, buildGrammar, generateTokens, warmup, resetAvailability, listProviders }
