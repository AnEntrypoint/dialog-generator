// E2E: real ref-voice -> synthesize -> measure RTF + audio sanity.
import fs from 'fs'
import { setRefVoice, synthesize } from '../lux-tts-bridge.js'

const refText = fs.readFileSync('voices/cleetus.txt', 'utf8').trim()
console.log('ref text:', JSON.stringify(refText.slice(0, 80)))

const t0 = Date.now()
await setRefVoice('voices/cleetus.wav', refText)
console.log(`setRefVoice: ${Date.now() - t0}ms`)

const text = 'Hey there friend, how is it going today?'
const t1 = Date.now()
const out = await synthesize(text)
const synthMs = Date.now() - t1

if (!out || !out.audio) { console.log('FAIL: no audio'); process.exit(1) }
const { audio, sampleRate } = out
const durS = audio.length / sampleRate
const finite = audio.every((v) => Number.isFinite(v))
const peak = audio.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
const rtf = (synthMs / 1000) / durS

console.log(`synth: ${synthMs}ms, audio ${audio.length} samples = ${durS.toFixed(2)}s @ ${sampleRate}Hz`)
console.log(`finite=${finite} peak=${peak.toFixed(4)}`)
console.log(`RTF (synth_time / audio_dur) = ${rtf.toFixed(3)}  (lower is faster; <1 = faster than realtime)`)
console.log(`F5 was ~3.8 (slower than realtime); lux faster=${rtf < 3.8}`)

if (!finite || peak === 0 || sampleRate !== 48000) { console.log('FAIL'); process.exit(1) }
console.log('PASS')
