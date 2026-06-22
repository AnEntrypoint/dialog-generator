// Browser LuxTTS tokenizer — fetch-based port of lux-tokenizer.mjs.
//
// Same pipeline (text --espeak-ng IPA--> codepoint stream --tokens.txt--> ids),
// two browser swaps vs the Node version:
//   1. tokens.txt is loaded via fetch() instead of fs.readFileSync.
//   2. `phonemize` is imported from the phonemizer CDN ESM (espeak-ng compiled to
//      wasm with the data inlined as base64). phonemizer.js detects worker context
//      (`typeof importScripts === 'function'`) and runs in a module worker as-is.
//
// textToTokens / BLANK_ID / SPACE_ID are byte-for-byte the Node logic.
import { phonemize } from 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js'

export const BLANK_ID = 0 // "_" (pad / OOV fallback)
export const SPACE_ID = 3 // " "

export async function loadTokensUrl(url) {
  const text = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`tokens.txt fetch ${r.status}`)
    return r.text()
  })
  const map = new Map()
  for (const raw of text.split('\n')) {
    if (raw === '') continue
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') continue
    const tab = line.lastIndexOf('\t')
    if (tab < 0) continue
    const sym = line.slice(0, tab)
    const id = Number.parseInt(line.slice(tab + 1), 10)
    if (Number.isFinite(id)) map.set(sym, id)
  }
  return map
}

export async function textToTokens(text, tokensMap, { lang = 'en-us' } = {}) {
  const clean = String(text || '').trim()
  if (!clean) return []
  const words = await phonemize(clean, lang)
  const ipa = words.join(' ').replace(/\s+/g, ' ').trim()

  const ids = []
  let prevSpace = false
  for (const ch of ipa) {
    if (ch === ' ') {
      if (prevSpace) continue
      ids.push(SPACE_ID)
      prevSpace = true
      continue
    }
    prevSpace = false
    const id = tokensMap.get(ch)
    ids.push(id === undefined ? BLANK_ID : id)
  }
  return ids
}
