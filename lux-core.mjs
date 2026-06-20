// LuxTTS (ZipVoice-distill) inference core — runtime-agnostic.
//
// Pure JS port of the reference ONNX inference (zipvoice/onnx_modeling.py:sample
// + generate_cpu). The ONNX sessions are injected so the same code runs under
// onnxruntime-node (server) and onnxruntime-web (browser): callers provide
// `runTextEncoder` / `runFmDecoder` / `runVocos` that take and return plain
// { data: Float32Array, dims: number[] } tensors.
//
// Shapes follow the reference: feat_dim = 100, batch = 1.

export const FEAT_DIM = 100
export const FEAT_SCALE = 0.1
// vocos.onnx is exported at a fixed mel length (see tools/export-vocos.py).
export const VOCOS_FRAMES = 768
// upsample(2) * hop(256) = 512 output samples per mel frame.
export const SAMPLES_PER_FRAME = 512
export const SAMPLE_RATE = 48000

// get_time_steps: shifted linspace, t_shift in (0,1]. (models/modules/solver.py)
export function getTimeSteps(numStep, tShift) {
  const ts = new Float64Array(numStep + 1)
  for (let i = 0; i <= numStep; i++) {
    const t = i / numStep
    ts[i] = (tShift * t) / (1 + (tShift - 1) * t)
  }
  return ts
}

// Deterministic, seedable PRNG (mulberry32) + Box-Muller for randn. Parity with
// torch.randn is not required (it is the flow-matching noise seed); determinism
// is, for reproducible/testable output.
export function makePrng(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randn(n, prng) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 2) {
    let u1 = prng(), u2 = prng()
    if (u1 < 1e-12) u1 = 1e-12
    const r = Math.sqrt(-2 * Math.log(u1))
    const th = 2 * Math.PI * u2
    out[i] = r * Math.cos(th)
    if (i + 1 < n) out[i + 1] = r * Math.sin(th)
  }
  return out
}

// pad prompt_features [1,Tp,F] to [1,numFrames,F] with trailing zeros -> speech_condition
function padSpeechCondition(promptFeatures, Tp, numFrames, F) {
  const out = new Float32Array(numFrames * F)
  out.set(promptFeatures.subarray(0, Math.min(Tp, numFrames) * F))
  return out
}

// Anchor-based flow-matching sampler. sessions: { runTextEncoder, runFmDecoder }.
// inputs: { tokens:int[], promptTokens:int[], promptFeatures:Float32Array[1,Tp,F],
//           promptFramesLen:int, speed, tShift, guidanceScale, numStep, seed }
// returns { data: Float32Array, frames } of predicted features [frames, F] (prompt stripped).
export async function sample(sessions, inp) {
  const F = FEAT_DIM
  const speed = inp.speed * 1.3 // reference: default too slow
  const tc = await sessions.runTextEncoder(
    inp.tokens, inp.promptTokens, inp.promptFramesLen, speed
  ) // { data, dims:[1, numFrames, F] }
  const numFrames = tc.dims[1]
  const N = numFrames * F
  let x = randn(N, makePrng(inp.seed >>> 0))
  const speechCond = padSpeechCondition(inp.promptFeatures, inp.promptFramesLen, numFrames, F)
  const steps = getTimeSteps(inp.numStep, inp.tShift)

  for (let s = 0; s < inp.numStep; s++) {
    const tCur = steps[s], tNext = steps[s + 1]
    const v = await sessions.runFmDecoder(tCur, x, numFrames, tc.data, speechCond, inp.guidanceScale)
    const next = new Float32Array(N)
    const last = s === inp.numStep - 1
    for (let i = 0; i < N; i++) {
      const x1 = x[i] + (1 - tCur) * v[i] // predicted clean data
      if (last) { next[i] = x1; continue }
      const x0 = x[i] - tCur * v[i]       // predicted noise
      next[i] = (1 - tNext) * x0 + tNext * x1
    }
    x = next
  }

  // strip the prompt prefix: x[:, promptFramesLen:, :]
  const frames = numFrames - inp.promptFramesLen
  const out = new Float32Array(frames * F)
  out.set(x.subarray(inp.promptFramesLen * F))
  return { data: out, frames }
}

// pred_features [frames,F] -> mel for vocos [1,F,VOCOS_FRAMES] (permute + /feat_scale,
// zero-pad time to the fixed vocoder length). Returns { mel, frames }.
export function featuresToVocosMel(pred, frames) {
  const F = FEAT_DIM
  const mel = new Float32Array(F * VOCOS_FRAMES)
  const t = Math.min(frames, VOCOS_FRAMES)
  for (let f = 0; f < F; f++) {
    for (let i = 0; i < t; i++) {
      mel[f * VOCOS_FRAMES + i] = pred[i * F + f] / FEAT_SCALE
    }
  }
  return { mel, frames: t }
}

// run vocos on padded mel and trim to the true sample count. promptRms<targetRms
// -> scale down (reference volume match). sessions.runVocos(mel[1,F,VOCOS_FRAMES]).
export async function vocodeChunk(sessions, pred, frames, promptRms, targetRms = 0.1) {
  const { mel, frames: t } = featuresToVocosMel(pred, frames)
  const audioFull = await sessions.runVocos(mel) // Float32Array[VOCOS_FRAMES*SAMPLES_PER_FRAME]
  const nSamples = t * SAMPLES_PER_FRAME
  let audio = audioFull.subarray(0, nSamples)
  if (promptRms < targetRms) {
    const g = promptRms / targetRms
    const scaled = new Float32Array(audio.length)
    for (let i = 0; i < audio.length; i++) scaled[i] = Math.max(-1, Math.min(1, audio[i] * g))
    return scaled
  }
  const clamped = new Float32Array(audio.length)
  for (let i = 0; i < audio.length; i++) clamped[i] = Math.max(-1, Math.min(1, audio[i]))
  return clamped
}
