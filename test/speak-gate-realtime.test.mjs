import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../llm.js', () => ({
  generate: vi.fn(async (prompt) => prompt.includes('Decision:') ? 'YES' : 'Howdy partner, what brings ya here?'),
  isAvailable: vi.fn(async () => true),
  buildGrammar: vi.fn(async (g) => ({ __test: true, source: g })),
}))

vi.mock('../chatterbox-tts-bridge.js', () => ({
  synthesizeStream: vi.fn(async (text, refPath, refText, onChunk, signal) => {
    onChunk(new Float32Array(2400), 24000)
    onChunk(new Float32Array(2400), 24000)
  }),
  setRefVoice: vi.fn(async () => {}),
}))

describe('speak-gate realtime', () => {
  it('walks LISTENING → WAITING → GATING → ANSWERING → SPEAKING → LISTENING on a user utterance', async () => {
    const sg = await import('../speak-gate.js')
    const sink = vi.fn()
    sg.setAudioSink(sink)
    sg.setCharacterCardPrompt('test')

    sg.noteWhisperWord({ userId: 'u1', username: 'alice', text: 'hello there bot' })
    expect(sg.getDebugSnapshot().state).toBe('WAITING')

    await new Promise(r => setTimeout(r, 1200))
    await new Promise(r => setTimeout(r, 500))

    const snap = sg.getDebugSnapshot()
    expect(['LISTENING', 'SPEAKING']).toContain(snap.state)
    expect(snap.metrics.gateYes).toBeGreaterThanOrEqual(1)
    expect(sink).toHaveBeenCalled()
  })
})
