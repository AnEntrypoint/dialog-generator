# diagen

Real-time AI voice bot for Discord. Listens to users in voice channels, transcribes speech (Whisper), generates responses (chatjimmy.ai LLM), synthesizes speech (LuxTTS), and plays back in the channel.

## Architecture

```
Discord voice → dispipe/client → discord-vad.js → Whisper STT → chatjimmy LLM → LuxTTS → dispipe/voice → Discord
```

**Modules:**
- `discord-handler.js` — bot lifecycle, voice channel join, message commands
- `discord-vad.js` — RMS VAD, barge-in detection, mono→stereo upmix for dispipe
- `discord-voice-processor.js` — voice config, character card loading
- `discord-whisper.js` — Whisper STT via @huggingface/transformers
- `whisper-stream.js` — per-user utterance buffering, abortable transcription
- `speak-gate.js` — 3-state voice orchestration (LISTENING → ANSWERING → SPEAKING)
- `llm.js` / `llm-remote.js` — chatjimmy.ai free LLM endpoint
- `lux-tts-bridge.js` / `lux-core.mjs` — LuxTTS (ZipVoice-distill, 4-step flow matching)

## Setup

```bash
git clone https://github.com/AnEntrypoint/diagen.git
cd diagen
npm install
cp .env.example .env
# Edit .env: DISCORD_TOKEN, GUILD_ID, CHANNEL_ID
node server.js
```

## Models

TTS models (Lux) under `models/tts/lux/` (~125 MB, gitignored). Regenerate with `bash tools/regen-lux-models.sh`.

Whisper model auto-downloads from HuggingFace on first use.

| Dir | Contents |
|---|---|
| `models/tts/lux/` | LuxTTS ONNX models (text_encoder, fm_decoder, vocos) |
| `models/whisper/` | HuggingFace cache for whisper models |
| `models/audio2afan/` | ONNX + NPZ blendshape model |

## Environment

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Discord bot token |
| `GUILD_ID` | Guild ID to auto-join |
| `CHANNEL_ID` | Voice channel ID to auto-join |
| `PORT` | HTTP server port (default 8080) |
| `WARMUP_TTS` | Set to `false` to skip TTS warmup |
| `CJ_MODEL` | chatjimmy model (default `llama3.1-8B`) |

## HTTP API

| Endpoint | Method | Description |
|---|---|---|
| `/api/generate` | POST | Text → audio + blendshape animation |
| `/api/chat` | POST | Text → LLM response |
| `/api/discord/voice/connect` | POST | Join voice channel |
| `/api/discord/voice/disconnect` | POST | Leave voice channel |
| `/api/discord/message` | POST | Send text message |
| `/debug/discord` | GET | Bot state inspection |
| `/debug/speak-gate` | GET | Gate state machine snapshot |

## Discord Commands

- `!join <channel-id>` — join a voice channel
- `!diagen <prompt>` — text chat with the bot