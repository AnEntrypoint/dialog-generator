// End-to-end validation that the bot actually talks back: real chatjimmy LLM
// call + mocked TTS (chatterbox load is too slow for CI). Asserts the audio
// sink receives at least one resampled chunk and the bot turn lands in history.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../chatterbox-tts-bridge.js', () => ({
  synthesizeStream: vi.fn(async (text, refPath, refText, onChunk, signal) => {
    // Simulate a TTS that takes ~200ms to start, then emits 3 chunks
    await new Promise(r => setTimeout(r, 200))
    if (signal?.aborted) return
    onChunk(new Float32Array(4800), 24000) // 200ms @ 24kHz
    await new Promise(r => setTimeout(r, 80))
    if (signal?.aborted) return
    onChunk(new Float32Array(4800), 24000)
    await new Promise(r => setTimeout(r, 80))
    if (signal?.aborted) return
    onChunk(new Float32Array(4800), 24000)
  }),
  setRefVoice: vi.fn(async () => {}),
}))

describe('bot talks back end-to-end', () => {
  it('runs LLM gate+answer via chatjimmy and pushes audio chunks to sink', async () => {
    const sg = await import('../speak-gate.js')

    const sinkCalls = []
    sg.setAudioSink((mono, text) => { sinkCalls.push({ samples: mono.length, text }) })
    sg.setCharacterCardPrompt('You are a friendly bot.')

    sg.noteWhisperWord({ userId: 'u1', username: 'tester', text: 'hello bot how are you' })

    // Wait for full pipeline: DEBOUNCE + GATING + ANSWERING + TTS + SPEAKING completion
    const start = Date.now()
    while (Date.now() - start < 20000) {
      const snap = sg.getDebugSnapshot()
      if (snap.metrics.spoken >= 1) break
      await new Promise(r => setTimeout(r, 200))
    }

    const snap = sg.getDebugSnapshot()
    console.log('[test] final snap:', JSON.stringify({
      state: snap.state, metrics: snap.metrics, history: snap.history.length, sinkCalls: sinkCalls.length
    }))

    expect(snap.metrics.gateYes + snap.metrics.gateNo).toBeGreaterThanOrEqual(1)
    expect(sinkCalls.length).toBeGreaterThanOrEqual(1)
    // The mono chunk should be resampled from 24kHz to 48kHz (2x samples)
    expect(sinkCalls[0].samples).toBe(9600)
    // Bot turn should land in history
    const botTurns = snap.history.filter(h => h.role === 'bot')
    expect(botTurns.length).toBeGreaterThanOrEqual(1)
    expect(botTurns[0].text.length).toBeGreaterThan(0)
  }, 30000)
})
