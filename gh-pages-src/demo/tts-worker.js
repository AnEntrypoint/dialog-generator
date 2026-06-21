// F5-TTS demo worker (replaces the Chatterbox worker). Runs the vendored f5-core
// over onnxruntime-web (WebGPU, WASM fallback). The 3 ONNX models load directly
// from the HF repo nsarang/F5-TTS-ONNX (browser-cached); reference audio is a WAV
// fetched and decoded at runtime (workers have no AudioContext). 24kHz output.
import { F5TTS, Tensor } from './f5-core.bundle.js'

const SAMPLE_RATE = 24000
const REPO = 'nsarang/F5-TTS-ONNX'
const NFE_STEPS = 16
const SPEED = 1.0

let model = null
let aborted = false
let refAudioTensor = null
let refText = ''
let activeVoice = null

// Minimal WAV (PCM16 / float32) decoder -> mono Float32 at SAMPLE_RATE.
function decodeWavMono(arrayBuffer) {
  const dv = new DataView(arrayBuffer)
  const sampleRate = dv.getUint32(24, true)
  const channels = dv.getUint16(22, true)
  const bits = dv.getUint16(34, true)
  // find 'data' chunk
  let off = 12
  while (off < dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3))
    const size = dv.getUint32(off + 4, true)
    if (id === 'data') { off += 8; var dataOff = off, dataLen = size; break }
    off += 8 + size
  }
  const n = dataLen / (bits / 8) / channels
  const mono = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * (bits / 8)
      s += bits === 16 ? dv.getInt16(p, true) / 32768 : dv.getFloat32(p, true)
    }
    mono[i] = s / channels
  }
  return resampleMono(mono, sampleRate, SAMPLE_RATE)
}

function resampleMono(audio, from, to) {
  if (from === to) return audio
  const ratio = from / to
  const out = new Float32Array(Math.round(audio.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const idx = i * ratio, lo = Math.floor(idx), hi = Math.min(lo + 1, audio.length - 1)
    out[i] = audio[lo] * (1 - (idx - lo)) + audio[hi] * (idx - lo)
  }
  return out
}

async function loadModel() {
  model = new F5TTS({
    repoName: REPO,
    rootPath: '',
    useFP16: true,
    emit: (_stage, info) => {
      if (info?.message) self.postMessage({ type: 'status', status: info.message })
    },
  })
  await model.initialize()
  return model.useFP16 ? 'webgpu/fp16' : 'wasm/fp32'
}

async function loadVoice(name) {
  const [wavResp, txtResp] = await Promise.all([
    fetch(`./voices/${name}.wav`),
    fetch(`./voices/${name}.txt`).catch(() => null),
  ])
  if (!wavResp.ok) throw new Error(`voice ${name}: ${name}.wav not found`)
  const mono = decodeWavMono(await wavResp.arrayBuffer())
  refAudioTensor = new Tensor('float32', mono, [mono.length])
  refText = txtResp && txtResp.ok ? (await txtResp.text()).trim().slice(0, 300) : ''
  activeVoice = name
}

async function generate(text) {
  if (!model) throw new Error('Model not loaded')
  if (!refAudioTensor) throw new Error('Voice not loaded')
  aborted = false
  const out = await model.inference({
    refAudio: refAudioTensor, refText, genText: text, speed: SPEED, nfeSteps: NFE_STEPS,
  })
  if (aborted) return
  const data = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data)
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  self.postMessage({ type: 'audio_chunk', data: buf }, [buf])
  self.postMessage({ type: 'stream_ended' })
}

self.onmessage = async (e) => {
  const { type } = e.data
  try {
    if (type === 'load') {
      const device = await loadModel()
      self.postMessage({ type: 'status', status: `Model loaded (${device})` })
      const manifest = await fetch('./voices/manifest.json').then((r) => r.json()).catch(() => ['cleetus.wav'])
      const voices = manifest.map((f) => f.replace(/\.wav$/, ''))
      self.postMessage({ type: 'voices_loaded', voices, defaultVoice: voices[0] || 'cleetus' })
    } else if (type === 'load_voice') {
      const name = e.data.voice
      self.postMessage({ type: 'status', status: `Loading voice: ${name}` })
      await loadVoice(name)
      self.postMessage({ type: 'loaded' })
    } else if (type === 'generate') {
      await generate(e.data.data?.text ?? e.data.text)
    } else if (type === 'cancel') {
      aborted = true
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message })
  }
}
