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
  // Implicit by omission: rather than enumerate rules (be brief, no narration, vary
  // openers, don't ramble), frame the SITUATION so those fall out naturally. A
  // quick word with someone at the counter is inherently short, spoken, and to the
  // point -- describing the scene accomplishes what a rule list only describes.
  characterSystemPrompt = [
    `You are ${name}. ${essence}`,
    ``,
    `Someone at the counter just said something to you. Say the next thing back.`,
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
