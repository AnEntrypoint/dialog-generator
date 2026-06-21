// LLM dispatcher: prefers free remote endpoint (chatjimmy via llm-remote.js),
// falls back to lazy-loaded local llama.cpp (llm-llamacpp.js) on remote failure.
//
// The local backend is imported lazily so processes that successfully use the
// remote endpoint never pay node-llama-cpp's GPU init cost or load the GGUF.

import * as providers from './llm-providers.js'
import * as remote from './llm-remote.js'

const FORCE_LOCAL = process.env.LLM_FORCE_LOCAL === '1'
const FORCE_REMOTE = process.env.LLM_FORCE_REMOTE === '1'

let localPromise = null
async function getLocal() {
  if (!localPromise) {
    console.log('[llm] lazy-loading local llama.cpp backend')
    localPromise = import('./llm-llamacpp.js')
  }
  return localPromise
}

// Tiers tried in order: the fast multi-provider chain (groq/cerebras/... from
// PROVIDER_ORDER), then chatjimmy, then local llama.cpp. providers.isAvailable()
// is false when no API key is configured, so an empty .env transparently uses
// chatjimmy until keys are added.
const TIER_NAME = (b) => (b === providers ? 'provider-chain' : b === remote ? 'chatjimmy' : 'local')

let backendPromise = null
async function pickBackend() {
  if (backendPromise) return backendPromise
  backendPromise = (async () => {
    if (FORCE_LOCAL) { console.log('[llm] LLM_FORCE_LOCAL=1 — local backend'); return await getLocal() }
    for (const tier of [providers, remote]) {
      try {
        if (await tier.isAvailable()) {
          const extra = tier === providers ? ` (${providers.listProviders().join(',') || 'none'})` : ''
          console.log(`[llm] using ${TIER_NAME(tier)}${extra}`)
          return tier
        }
      } catch (err) { console.warn(`[llm] ${TIER_NAME(tier)} probe failed: ${err?.message}`) }
    }
    if (FORCE_REMOTE) throw new Error('LLM_FORCE_REMOTE=1 but no remote tier reachable')
    console.log('[llm] no remote tier available — local fallback')
    return await getLocal()
  })()
  return backendPromise
}

async function withFallback(fn) {
  const backend = await pickBackend()
  try {
    return await fn(backend)
  } catch (err) {
    if (err?.name === 'AbortError' || err?.message?.includes('aborted')) throw err
    // The picked tier failed at call time -> reset and re-pick the next live
    // tier (re-probes from the top, so a recovered provider is re-selected).
    if ((backend === providers || backend === remote) && !FORCE_REMOTE) {
      console.warn(`[llm] ${TIER_NAME(backend)} call failed (${err?.message || err}); re-picking`)
      providers.resetAvailability(); remote.resetAvailability(); backendPromise = null
      const next = await pickBackend()
      return await fn(next)
    }
    throw err
  }
}

export async function isAvailable() {
  try {
    const b = await pickBackend()
    if (typeof b.isAvailable === 'function') {
      const ok = await b.isAvailable()
      // The picked backend is cached. If the remote endpoint reads unavailable
      // AFTER being selected (chatjimmy flakiness / a transient network blip),
      // re-decide: clear the cache and re-probe. pickBackend re-tests remote
      // (so a recovered endpoint is re-selected) and only falls to local if it
      // is genuinely still down. Without this, one transient outage left the
      // cached-remote backend muting the bot until restart.
      if (!ok && (b === providers || b === remote) && !FORCE_REMOTE) {
        console.warn('[llm] tier unavailable — re-probing (recovery or next tier)')
        providers.resetAvailability(); remote.resetAvailability()
        backendPromise = null
        const b2 = await pickBackend()
        return typeof b2.isAvailable === 'function' ? await b2.isAvailable() : true
      }
      if (!ok) console.warn('[llm] backend isAvailable returned false')
      return ok
    }
    return true
  } catch (err) {
    console.warn('[llm] isAvailable threw:', err?.message)
    return false
  }
}

export async function generate(prompt, system, signal, extraOpts = {}) {
  return withFallback(b => b.generate(prompt, system, signal, extraOpts))
}

export async function buildGrammar(grammarString) {
  const b = await pickBackend()
  return b.buildGrammar(grammarString)
}

export async function* generateTokens(prompt, system, signal) {
  const b = await pickBackend()
  yield* b.generateTokens(prompt, system, signal)
}

export async function generateStream(prompt, system) {
  const b = await pickBackend()
  return b.generateStream(prompt, system)
}

export async function warmup(systemPrompt) {
  const b = await pickBackend()
  if (typeof b.warmup === 'function') return b.warmup(systemPrompt)
}

export default { isAvailable, generate, buildGrammar, generateTokens, generateStream, warmup }
