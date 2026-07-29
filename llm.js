// LLM dispatcher — chatjimmy.ai (free public endpoint).
// Simplified from the three-tier chain (provider chain → chatjimmy → local llama.cpp)
// to chatjimmy-only, since the free endpoint is fast enough and always available.

import * as remote from './llm-remote.js'

export async function isAvailable() {
  return remote.isAvailable()
}

export async function generate(prompt, system, signal, extraOpts = {}) {
  return remote.generate(prompt, system, signal, extraOpts)
}

export { generate as default }