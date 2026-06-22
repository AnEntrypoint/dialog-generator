// onnxruntime-web session factory for LuxTTS — browser counterpart of
// lux-ort-node.mjs. Wraps the three ONNX models as the runtime-agnostic callbacks
// lux-core.mjs expects ({ data: Float32Array, dims: number[] } in/out).
//
// I/O is IDENTICAL to lux-ort-node.mjs (lux-core injects runTextEncoder /
// runFmDecoder / runVocos); only the Tensor/session construction differs:
//   - onnxruntime-web (ort.webgpu.bundle still ships the wasm EP)
//   - the int8 models use DynamicQuantizeLinear + MatMulInteger, which ort-web
//     implements only on the WASM EP (WebGPU has no MatMulInteger and falls back
//     per-node). So the int8 graphs effectively run on WASM regardless of EP. We
//     therefore default the int8 sessions to ['wasm']; pass ep:['webgpu','wasm']
//     to attempt GPU (it will silently fall back for the quantized ops).
//   - vocos.onnx references EXTERNAL weights (vocos.onnx.data); ort-web does not
//     auto-fetch the sibling .data by URL, so the caller fetches it and passes the
//     bytes via the session `externalData` option.
//
// The ort module is injected (so the caller controls the CDN/bundle + wasmPaths)
// and model sources are passed as either a URL string or pre-fetched bytes
// (Uint8Array/ArrayBuffer). This keeps the factory free of fetch/CDN policy.
import { FEAT_DIM } from './lux-core.mjs'

function asBytes(x) {
  if (x instanceof Uint8Array) return x
  if (x instanceof ArrayBuffer) return new Uint8Array(x)
  return x // URL string — ort.InferenceSession.create accepts it directly
}

// sources: {
//   ort: the onnxruntime-web module namespace (import * as ort from '<cdn>'),
//   textEncoder: URL|bytes, fmDecoder: URL|bytes,
//   vocos: URL|bytes, vocosData: bytes (REQUIRED — external weights for vocos.onnx),
//   ep: executionProviders list (default ['wasm']),
//   onStatus: optional (msg) => void progress callback,
// }
export async function createWebSessions(sources) {
  const ort = sources.ort
  if (!ort) throw new Error('createWebSessions: sources.ort (onnxruntime-web module) required')
  const ep = sources.ep || ['wasm']
  const status = (m) => { try { sources.onStatus && sources.onStatus(m) } catch {} }

  const scalarF32 = (v) => new ort.Tensor('float32', Float32Array.from([v]), [])
  const scalarI64 = (v) => new ort.Tensor('int64', BigInt64Array.from([BigInt(v)]), [])

  const baseOpt = { executionProviders: ep, graphOptimizationLevel: 'all' }

  status('loading text encoder')
  const textEncoder = await ort.InferenceSession.create(asBytes(sources.textEncoder), baseOpt)

  status('loading fm decoder')
  const fmDecoder = await ort.InferenceSession.create(asBytes(sources.fmDecoder), baseOpt)

  status('loading vocoder')
  if (!sources.vocosData) throw new Error('createWebSessions: sources.vocosData (vocos.onnx.data bytes) required')
  const vocos = await ort.InferenceSession.create(asBytes(sources.vocos), {
    ...baseOpt,
    // path MUST match the external-data reference stored in vocos.onnx ('vocos.onnx.data').
    externalData: [{ path: 'vocos.onnx.data', data: asBytes(sources.vocosData) }],
  })

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
