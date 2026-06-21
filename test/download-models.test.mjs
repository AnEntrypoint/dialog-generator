import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('download-models structure', () => {
  it('module exports downloadModels function', async () => {
    const mod = await import('../download-models.js')
    expect(typeof mod.downloadModels).toBe('function')
  })

  it('verifies local models under models/ (LFS-backed)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'download-models.js'), 'utf8')
    expect(src).toContain("'models'")
    expect(src).toContain('git lfs pull')
    expect(src).not.toContain('ipfs')
  })

  it('tts model includes the F5-TTS ONNX files', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'download-models.js'), 'utf8')
    expect(src).toContain('encoder_fp32.onnx')
    expect(src).toContain('decoder_fp32.onnx')
    expect(src).toContain('transformer_fp32.onnx')
    expect(src).toContain('vocab.txt')
  })
})
