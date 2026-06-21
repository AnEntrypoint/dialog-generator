// LuxTTS (ZipVoice-distill) tokenizer — English text -> phoneme token ids.
//
// Port of the ZipVoice/LuxTTS phone tokenizer. The pipeline is:
//   text --espeak-ng IPA--> per-word IPA strings (phonemizer npm, espeak-ng wasm)
//        --join with " "--> a single IPA codepoint stream
//        --[...str] split--> one token per Unicode codepoint
//        --tokens.txt--> integer id per codepoint.
//
// `models/tts/lux/tokens.txt` is the espeak en-us IPA inventory shipped with the
// HF repo `YatharthS/LuxTTS` (360 lines, `<symbol>\t<id>`). Layout:
//   0  "_"  (blank / pad)         3  " " (space)        4..13  punctuation
//   14.. single-codepoint IPA symbols (a, b, ... ə, ɹ, ˈ, ˌ, ː, oʊ-as-o+ʊ ...)
// The multi-char entries (a1/ang1/ch0/ve4 and the trailing raw-UTF-8 rows) are
// Chinese pinyin and are never produced by the en-us espeak path — English text
// always tokenizes to single Unicode codepoints, each of which is present here
// (verified: zero OOV over a representative English sentence set).
//
// The matching JS phonemizer (`phonemize(text,'en-us')`) emits clean IPA WITHOUT
// espeak's `--ipa=1` `_` codepoint separators, e.g. "həlˈoʊ ðˈɛɹ" — exactly the
// per-codepoint stream this tokenizer indexes.

import { readFileSync } from 'node:fs'
import { phonemize } from 'phonemizer'

export const BLANK_ID = 0   // "_"  (pad / OOV fallback)
export const SPACE_ID = 3   // " "

// Parse tokens.txt (`<symbol>\t<id>` per line) into a symbol->id Map.
// Tab-separated and the symbol may itself be a space, so we split on the LAST
// tab. Blank trailing line is ignored. (No id is derived from line index — the
// explicit id column is authoritative.)
export function loadTokens(path) {
  const text = readFileSync(path, 'utf8')
  const map = new Map()
  for (const raw of text.split('\n')) {
    if (raw === '' ) continue
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

// Convert English text -> Int array of phoneme token ids.
// tokensMap: the Map from loadTokens(). Returns ids ready for the text_encoder
// `tokens` / `prompt_tokens` int64 inputs (lux-ort-node wraps them as BigInt64).
//
// Steps: phonemize each chunk to IPA, join words with a single space, walk the
// resulting string codepoint-by-codepoint, map each via tokensMap (OOV -> BLANK).
// Adjacent collapsing of whitespace prevents double-space tokens.
export async function textToTokens(text, tokensMap, { lang = 'en-us' } = {}) {
  const clean = String(text || '').trim()
  if (!clean) return []
  // phonemize returns one IPA string per input "line" (word group); join the
  // words it produced with a space (espeak already drops most punctuation, but
  // we keep whatever survives so its punctuation token ids are emitted).
  const words = await phonemize(clean, lang)
  const ipa = words.join(' ').replace(/\s+/g, ' ').trim()

  const ids = []
  let prevSpace = false
  for (const ch of ipa) {            // codepoint iteration (handles surrogate-free IPA)
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

// ---------------------------------------------------------------------------
// Stateful convenience wrapper used by lux-tts-bridge.js: load the vocab once
// into module state, then call textToTokensLoaded(text) with a single arg.
// ---------------------------------------------------------------------------
let _vocab = null

export async function loadVocab(path) {
  _vocab = loadTokens(path)
  return _vocab
}

// Single-arg, returns Promise<int[]>. Requires loadVocab() to have run.
export async function textToTokensLoaded(text, opts = {}) {
  if (!_vocab) throw new Error('call loadVocab() before textToTokensLoaded()')
  return textToTokens(text, _vocab, opts)
}

// Diagnostic: which codepoints in `text` have no token (should be empty for
// English). Useful when validating a new voice transcript / unusual punctuation.
export async function findOov(text, tokensMap, { lang = 'en-us' } = {}) {
  const words = await phonemize(String(text || ''), lang)
  const ipa = words.join(' ')
  const oov = new Set()
  for (const ch of ipa) {
    if (ch === ' ') continue
    if (!tokensMap.has(ch)) oov.add(ch)
  }
  return [...oov]
}
