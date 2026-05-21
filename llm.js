// LLM dispatcher: prefers free remote endpoint (chatjimmy via llm-remote.js),
// falls back to lazy-loaded local llama.cpp (llm-llamacpp.js) on remote failure.
//
// The local backend is imported lazily so processes that successfully use the
// remote endpoint never pay node-llama-cpp's GPU init cost or load the GGUF.

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

let backendPromise = null
async function pickBackend() {
  if (backendPromise) return backendPromise
  backendPromise = (async () => {
    if (FORCE_LOCAL) {
      console.log('[llm] LLM_FORCE_LOCAL=1 — using local backend')
      return await getLocal()
    }
    if (await remote.isAvailable()) {
      console.log('[llm] using remote backend (chatjimmy)')
      return remote
    }
    if (FORCE_REMOTE) throw new Error('LLM_FORCE_REMOTE=1 but remote endpoint unreachable')
    console.log('[llm] remote unavailable — falling back to local')
    return await getLocal()
  })()
  return backendPromise
}

function isRemote(backend) { return backend === remote }

async function withFallback(fn) {
  let backend = await pickBackend()
  try {
    return await fn(backend)
  } catch (err) {
    if (err?.name === 'AbortError' || err?.message?.includes('aborted')) throw err
    if (isRemote(backend) && !FORCE_REMOTE) {
      console.warn(`[llm] remote call failed (${err?.message || err}); switching to local`)
      remote.resetAvailability()
      backendPromise = null
      const local = await getLocal()
      backendPromise = Promise.resolve(local)
      return await fn(local)
    }
    throw err
  }
}

export async function isAvailable() {
  try {
    const b = await pickBackend()
    if (typeof b.isAvailable === 'function') {
      const ok = await b.isAvailable()
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
