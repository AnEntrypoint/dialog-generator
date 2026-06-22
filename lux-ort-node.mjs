// onnxruntime-node session factory for LuxTTS. Wraps the three ONNX models as
// the runtime-agnostic callbacks lux-core.mjs expects. (Browser uses an
// equivalent factory over onnxruntime-web.)
import * as ort from 'onnxruntime-node'
import path from 'path'
import { FEAT_DIM } from './lux-core.mjs'

function scalarF32(v) { return new ort.Tensor('float32', Float32Array.from([v]), []) }
function scalarI64(v) { return new ort.Tensor('int64', BigInt64Array.from([BigInt(v)]), []) }

export async function createNodeSessions(dir, { int8 = true, prec } = {}) {
  // prec: 'fp32' | 'int8' | 'q4'. q4 (MatMulNBits) is webgpu-capable + small.
  const suffix = prec === 'q4' ? '_q4' : prec === 'fp32' ? '' : (prec === 'int8' || int8) ? '_int8' : ''
  const te = `text_encoder${suffix}.onnx`
  const fm = `fm_decoder${suffix}.onnx`
  const cpuOpts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }
  // fm_decoder is the bottleneck (4 NFE steps over the gen frames); LUX_FM_EP can
  // route it to a GPU EP (webgpu/dml) when that is faster. Encoder + vocos stay CPU.
  const fmEps = (process.env.LUX_FM_EP || 'webgpu,cpu').split(',')
  const fmOpts = { executionProviders: fmEps, graphOptimizationLevel: 'all' }
  const textEncoder = await ort.InferenceSession.create(path.join(dir, te), cpuOpts)
  const fmDecoder = await ort.InferenceSession.create(path.join(dir, fm), fmOpts)
  const vocos = await ort.InferenceSession.create(path.join(dir, 'vocos.onnx'), cpuOpts)

  async function runTextEncoder(tokens, promptTokens, promptFramesLen, speed) {
    const feeds = {
      tokens: new ort.Tensor('int64', BigInt64Array.from(tokens, (x) => BigInt(x)), [1, tokens.length]),
      prompt_tokens: new ort.Tensor('int64', BigInt64Array.from(promptTokens, (x) => BigInt(x)), [1, promptTokens.length]),
      prompt_features_len: scalarI64(promptFramesLen),
      speed: scalarF32(speed),
    }
    const out = await textEncoder.run(feeds)
    const tc = out.text_condition
    return { data: tc.data, dims: tc.dims }
  }

  async function runFmDecoder(t, x, numFrames, textCond, speechCond, guidanceScale) {
    const dims = [1, numFrames, FEAT_DIM]
    const feeds = {
      t: scalarF32(t),
      x: new ort.Tensor('float32', x, dims),
      text_condition: new ort.Tensor('float32', textCond, dims),
      speech_condition: new ort.Tensor('float32', speechCond, dims),
      guidance_scale: scalarF32(guidanceScale),
    }
    const out = await fmDecoder.run(feeds)
    return out.v.data
  }

  async function runVocos(mel) {
    const feeds = { mel: new ort.Tensor('float32', mel, [1, FEAT_DIM, mel.length / FEAT_DIM]) }
    const out = await vocos.run(feeds)
    return out.audio.data
  }

  return { runTextEncoder, runFmDecoder, runVocos }
}
