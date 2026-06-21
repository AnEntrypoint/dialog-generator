// Download the F5-TTS ONNX models (nsarang/F5-TTS-ONNX) into models/tts/f5/.
// Pure Node, resumable (HTTP Range) + size-validated so flaky connections don't
// leave a corrupt file. ~1.4 GB total (encoder 66M, decoder 60M, transformer
// fp32 1.3G) + vocab. Set HF_TOKEN for a higher anonymous rate limit.
//
//   node tools/download-f5-models.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'models', 'tts', 'f5')
const BASE = 'https://huggingface.co/nsarang/F5-TTS-ONNX/resolve/main'
const FILES = ['onnx/encoder_fp32.onnx', 'onnx/decoder_fp32.onnx', 'onnx/transformer_fp32.onnx', 'vocab.txt']
const token = process.env.HF_TOKEN
const headers = token ? { Authorization: `Bearer ${token}` } : {}

async function expectedSize(url) {
  const r = await fetch(url, { method: 'HEAD', headers, redirect: 'follow' })
  const n = Number(r.headers.get('content-length') || r.headers.get('x-linked-size'))
  return Number.isFinite(n) && n > 0 ? n : null
}

async function downloadResumable(url, dest) {
  const total = await expectedSize(url)
  for (let attempt = 0; attempt < 50; attempt++) {
    let have = fs.existsSync(dest) ? fs.statSync(dest).size : 0
    if (total && have === total) return total
    if (total && have > total) { fs.rmSync(dest); have = 0 }
    const res = await fetch(url, {
      headers: have ? { ...headers, Range: `bytes=${have}-` } : headers,
      redirect: 'follow',
    }).catch((e) => ({ ok: false, _err: e }))
    if (!res.ok && res.status !== 206 && res.status !== 200) {
      await new Promise((r) => setTimeout(r, 2000)); continue
    }
    const ws = fs.createWriteStream(dest, { flags: have ? 'a' : 'w' })
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        ws.write(Buffer.from(value))
      }
      await new Promise((r) => ws.end(r))
    } catch {
      await new Promise((r) => ws.end(r))
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    const now = fs.statSync(dest).size
    if (!total || now === total) return now
    process.stdout.write(`\r  ${path.basename(dest)} ${(now / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB, resuming...`)
  }
  throw new Error(`failed to fully download ${url}`)
}

fs.mkdirSync(path.join(OUT, 'onnx'), { recursive: true })
for (const f of FILES) {
  const dest = path.join(OUT, f)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  process.stdout.write(`downloading ${f} ...\n`)
  const n = await downloadResumable(`${BASE}/${f}`, dest)
  console.log(`  done ${f} (${(n / 1e6).toFixed(1)} MB)`)
}
console.log('All F5-TTS models downloaded to models/tts/f5/.')
