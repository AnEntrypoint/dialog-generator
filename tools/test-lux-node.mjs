// Smoke test: run the full LuxTTS JS inference core against the real ONNX models
// under onnxruntime-node. Uses dummy tokens + random prompt features — proves the
// pipeline (text_encoder -> flow-matching sampler -> vocos) runs end-to-end and
// produces finite 48kHz audio. Not a quality test.
import { createNodeSessions } from '../lux-ort-node.mjs'
import { sample, vocodeChunk, FEAT_DIM, SAMPLE_RATE } from '../lux-core.mjs'

const dir = 'models/tts/lux'
const sessions = await createNodeSessions(dir, { int8: true })

// dummy prompt: 12 phoneme tokens, 40 prompt mel frames
const promptTokens = [14, 20, 25, 30, 33, 18, 22, 27, 14, 19, 24, 29]
const promptFramesLen = 40
const promptFeatures = new Float32Array(promptFramesLen * FEAT_DIM)
for (let i = 0; i < promptFeatures.length; i++) promptFeatures[i] = (Math.sin(i * 0.013) - 6) * 0.1
const tokens = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 14, 15, 16]

const t0 = Date.now()
const pred = await sample(sessions, {
  tokens, promptTokens, promptFramesLen, promptFeatures,
  speed: 1.0, tShift: 0.9, guidanceScale: 3.0, numStep: 4, seed: 666,
})
console.log(`sampler: ${pred.frames} frames in ${Date.now() - t0}ms`)
const audio = await vocodeChunk(sessions, pred.data, pred.frames, 0.05, 0.1)
const finite = audio.every((v) => Number.isFinite(v))
const peak = audio.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
console.log(`audio: ${audio.length} samples (${(audio.length / SAMPLE_RATE).toFixed(2)}s @ ${SAMPLE_RATE}Hz), finite=${finite}, peak=${peak.toFixed(4)}`)
const expected = pred.frames * 512
console.log(`expected ${expected} samples, match=${audio.length === expected}`)
if (!finite || audio.length !== expected || peak === 0) { console.log('FAIL'); process.exit(1) }
console.log('PASS')
