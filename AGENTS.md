# AGENTS.md — Non-Obvious Caveats

## Dependencies

- **dispipe is on npm** (`dispipe@^1.0.2`). Do NOT downgrade to `file:../dispipe` — under bun that silently produces an empty `node_modules/dispipe` directory with EPERM, and the only surface symptom is `Cannot find module 'dispipe/client'` at `discord-handler.js` import time. No install error is printed.

## Architecture

- **LLM**: chatjimmy.ai only (free public endpoint, `llama3.1-8B`). No local fallback, no provider chain.
- **TTS**: LuxTTS (ZipVoice-distill, 4-step flow matching). 48kHz output. Models in `models/tts/lux/`.
- **STT**: Whisper via @huggingface/transformers. whisper-small q8 on CPU by default.
- **Voice gate**: 3-state machine (LISTENING → ANSWERING → SPEAKING). No GATING stage — every utterance triggers a reply. ANSWERING is abortable by new whisper words.
- **Whisper-stream**: fires on every frame (no silence debounce). Per-session generation counter invalidates stale transcriptions. `clearAll()` called on barge-in.

## Learning audit

- 2026-04-28: initial creation; 0 items checked, 0 removed, 0 refined.
- 2026-07-25: simplified — removed Rust crates, F5-TTS, provider chain, local llama.cpp. Collapsed speak-gate to 3 states. Chatjimmy-only LLM, LuxTTS-only, abortable whisper + ANSWERING. Removed automated tests — manual debugging only.

@.gm/next-step.md