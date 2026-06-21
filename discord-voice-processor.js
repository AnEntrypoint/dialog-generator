import fs from 'fs'
import * as speakGate from './speak-gate.js'

let voiceReferencePath = null
let voiceReferenceText = null
let characterSystemPrompt = null
let characterName = 'assistant'

export function setCharacterCard(card) {
  const d = card.spec === 'chara_card_v2' ? card.data : card
  const name = d.name || 'the character'
  characterName = name
  const essence = [d.description, d.personality, d.scenario].filter(Boolean).join(' ')
  // Natural persona prompt: be the character, talk like a person. The only hard
  // constraints are the ones the voice pipeline genuinely needs (speak just your
  // own words, no stage directions -- it all goes to text-to-speech). No scripted
  // greet/answer/hook template, no canned fallback lines.
  characterSystemPrompt = [
    `You are ${name}. ${essence}`,
    ``,
    `You're in a live voice call, just talking with whoever's around. Be yourself and respond naturally to what people actually said -- like a real conversation, not a performance. Keep it short and snappy: usually one or two quick sentences, then stop. Don't ramble, don't make lists, don't pad it out -- this is back-and-forth chat, so leave room for them to talk.`,
    ``,
    `Everything you write is spoken aloud, so write only the words you would say -- no names or labels, no narration, nothing in asterisks/parentheses/brackets. Just talk.`,
  ].join('\n')
  console.log(`[processor] ✓ card loaded: ${name} | prompt=${characterSystemPrompt.length}ch`)
  speakGate.setCharacterCardPrompt(characterSystemPrompt)
}

export function getCharacterSystemPrompt() { return characterSystemPrompt }
export function getCharacterName() { return characterName }

function loadRefText(refAudioPath) {
  if (!refAudioPath) return null
  const lower = refAudioPath.toLowerCase()
  const sidecar = lower.endsWith('.wav') ? refAudioPath.slice(0, -4) + '.txt' : refAudioPath + '.txt'
  if (!fs.existsSync(sidecar)) {
    console.warn(`[processor] ⚠ no ref-text sidecar ${sidecar} — voice clone DISABLED`)
    return ''
  }
  const text = fs.readFileSync(sidecar, 'utf8').trim()
  console.log(`[processor] ref-text loaded (${text.length}ch)`)
  return text
}

export function setVoiceEmbedding(refAudioPath) {
  voiceReferencePath = refAudioPath
  voiceReferenceText = loadRefText(refAudioPath)
  console.log(`[processor] voice ref: ${refAudioPath}`)
  speakGate.setRefVoice(voiceReferencePath, voiceReferenceText || null)
}

export function getVoiceReferencePath() { return voiceReferencePath }
export function getVoiceReferenceText() { return voiceReferenceText }
export function clearHistory() { speakGate.clearHistory() }

export default { setVoiceEmbedding, setCharacterCard, getCharacterSystemPrompt, getVoiceReferenceText, getVoiceReferencePath, clearHistory }
