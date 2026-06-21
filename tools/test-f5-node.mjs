// End-to-end smoke test: F5-TTS server bridge on real ONNX models via
// onnxruntime-node. Proves setRefVoice -> synthesize produces finite 24kHz audio.
import fs from 'fs'
import { setRefVoice, synthesize, getDebugState } from '../f5-tts-bridge.js'

// short ref slice for speed (full cleetus.txt is a long run-on transcript)
const refText = fs.readFileSync('voices/cleetus.txt', 'utf8').trim().slice(0, 120)
console.log('ref text:', JSON.stringify(refText))

await setRefVoice('voices/cleetus.wav', refText)
console.log('debug:', JSON.stringify(getDebugState()))

const t0 = Date.now()
const out = await synthesize('Hello there, this is a test of the new voice.', null, null, null)
const dt = Date.now() - t0
const finite = out.audio.every((v) => Number.isFinite(v))
let peak = 0
for (const v of out.audio) peak = Math.max(peak, Math.abs(v))
console.log(`audio: ${out.audio.length} samples (${(out.audio.length / out.sampleRate).toFixed(2)}s @ ${out.sampleRate}Hz) in ${dt}ms, finite=${finite}, peak=${peak.toFixed(4)}`)
if (!finite || out.audio.length === 0 || peak === 0) { console.log('FAIL'); process.exit(1) }
console.log('PASS')
