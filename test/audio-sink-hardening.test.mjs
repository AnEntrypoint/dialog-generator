// Audio-sink hardening: drop frames when voice connection isn't ready,
// validate frame shape, surface drop reasons via getAudioOutStats.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('dispipe/voice', () => ({
  pushAudioFrame: vi.fn(),
  initVoicePlayer: vi.fn(),
}))
vi.mock('../whisper-stream.js', () => ({ pushFrame: vi.fn(), onPartial: vi.fn(), onStable: vi.fn() }))
vi.mock('../speak-gate.js', () => ({ setAudioSink: vi.fn(fn => { globalThis.__capturedSink = fn }), noteWhisperWord: vi.fn() }))

describe('audio-sink hardening', () => {
  beforeEach(() => { globalThis.__capturedSink = null })

  it('drops frames when voice connection is not ready', async () => {
    const vad = await import('../discord-vad.js')
    vad.setVoiceConnectionGetter(() => ({ state: { status: 'connecting' } }))
    vad.init([], { value: null })
    const sink = globalThis.__capturedSink
    expect(sink).toBeTruthy()

    sink(new Float32Array(480), 'hi')
    sink(new Float32Array(480), 'hi')

    const stats = vad.getAudioOutStats()
    expect(stats.sinkInvocations).toBe(0)
    expect(stats.droppedNotReady).toBe(2)
    expect(stats.lastDropReason).toBe('voice-not-ready')
  })

  it('drops frames with invalid shape', async () => {
    const vad = await import('../discord-vad.js')
    vad.setVoiceConnectionGetter(() => ({ state: { status: 'ready' } }))
    vad.init([], { value: null })
    const sink = globalThis.__capturedSink

    sink(null, 'hi')
    sink(new Float32Array(0), 'hi')
    sink([1, 2, 3], 'hi') // not Float32Array

    const stats = vad.getAudioOutStats()
    expect(stats.droppedInvalidShape).toBeGreaterThanOrEqual(3)
    expect(stats.sinkInvocations).toBe(0)
  })

  it('passes through and clips when voice is ready', async () => {
    const { pushAudioFrame } = await import('dispipe/voice')
    const vad = await import('../discord-vad.js')
    vad.setVoiceConnectionGetter(() => ({ state: { status: 'ready' } }))
    vad.init([], { value: null })
    const sink = globalThis.__capturedSink

    const mono = new Float32Array([0.5, -0.5, 1.5, -1.5]) // last two should clip
    sink(mono, 'hi')

    const stats = vad.getAudioOutStats()
    expect(stats.sinkInvocations).toBe(1)
    expect(stats.totalSamples).toBe(4)
    expect(pushAudioFrame).toHaveBeenCalled()
    const lastCall = pushAudioFrame.mock.calls[pushAudioFrame.mock.calls.length - 1][0]
    expect(lastCall).toBeInstanceOf(Float32Array)
    expect(lastCall.length).toBe(8) // stereo
    expect(lastCall[4]).toBe(1)   // clipped from 1.5
    expect(lastCall[6]).toBe(-1)  // clipped from -1.5
  })

  it('defaults to ready when no getter is set (legacy)', async () => {
    const vad = await import('../discord-vad.js')
    vad.setVoiceConnectionGetter(null)
    vad.init([], { value: null })
    const sink = globalThis.__capturedSink

    sink(new Float32Array([0.1, 0.2]), 'hi')
    const stats = vad.getAudioOutStats()
    expect(stats.sinkInvocations).toBeGreaterThanOrEqual(1)
  })
})
