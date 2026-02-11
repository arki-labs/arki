# State of the Art: Text-to-Speech, Speech-to-Text & Audio AI (2024-2026)

## Overview

Audio AI has undergone rapid transformation with neural TTS achieving human-level naturalness, streaming architectures enabling real-time interaction, and multi-speaker synthesis creating new content formats. This document surveys techniques relevant to Avocabo's audio transformation pipeline — from podcast ingestion to voice-first briefings.

## Historical Context

### Evolution Timeline

| Year | Milestone | Key Innovation |
|------|-----------|----------------|
| 2013 | DeepSpeech (Baidu) | End-to-end neural ASR |
| 2016 | WaveNet (DeepMind) | Neural TTS with autoregressive generation |
| 2018 | Tacotron 2 | End-to-end text-to-mel-to-waveform |
| 2020 | Conformer | Convolution-augmented transformer for ASR |
| 2022 | Whisper (OpenAI) | Large-scale multilingual ASR model |
| 2023 | VALL-E (Microsoft) | Neural codec language model for TTS (voice cloning) |
| 2023 | Bark (Suno) | Open-source generative audio with non-speech sounds |
| 2024 | ElevenLabs Turbo v2 | Sub-300ms streaming TTS with emotional control |
| 2024 | NotebookLM Audio | AI-generated podcast-style discussions |
| 2025 | Cartesia Sonic 3 | 40ms TTFB, production streaming TTS |
| 2025 | Deepgram Nova-3 | 53.4% WER reduction over previous gen |
| 2025 | VibeVoice | 4+ speaker multi-voice synthesis |
| 2026 | Interactive audio agents | Interrupt + ask + resume during AI audio |

### Paradigm Shifts

```
Concatenative TTS (splicing recordings, 1990s-2015)
    ↓
Neural TTS (WaveNet, Tacotron, 2016-2022)
    ↓
Codec Language Models (VALL-E, SoundStorm, 2023-2024)
    ↓
Streaming Neural TTS (Cartesia, 2025+)
    ↓
Interactive Audio Agents (interrupt + converse, 2026+)
```

## Current State of TTS

### Provider Landscape (Feb 2026)

| Provider | Model | TTFB | MOS Score | Streaming | Languages | Emotional Control |
|----------|-------|------|-----------|-----------|-----------|-------------------|
| **Cartesia** | Sonic 3 | 40ms | ~4.2 | WebSocket | 17 | Speed + presets |
| **ElevenLabs** | Turbo v3 | ~300ms | ~4.5 | Yes | 32 | Stability + style |
| **OpenAI** | TTS-1-HD | ~500ms | ~4.3 | Yes | 57 | Voice selection |
| **OpenAI** | TTS-1 | ~200ms | ~3.8 | Yes | 57 | Voice selection |
| **Speechmatics** | Flow | ~150ms | ~4.1 | Yes | 50 | Limited |
| **Hume** | Octave 2 | ~200ms | ~4.3 | Yes | 8 | 26 emotions |
| **Google** | Gemini TTS | ~250ms | ~4.0 | Yes | 24 | Voice prompting |
| **Kyutai** | Pocket TTS | ~100ms | ~3.5 | Limited | 5 | None |

**MOS (Mean Opinion Score):** Scale 1-5, where 4.0+ is "indistinguishable from human" for most listeners.

### TTS Architecture Patterns

```
Traditional TTS Pipeline:
  Text → Text Processing → Acoustic Model → Vocoder → Audio
         (phonemes)         (mel spectrogram)  (waveform)

Modern Neural Codec TTS:
  Text → Language Model → Neural Audio Codec → Audio
         (token prediction)  (decode to waveform)

Streaming TTS:
  Text (streaming) → Token-by-token generation → Progressive audio chunks
                      ↓ (40ms first chunk)       ↓ (WebSocket/SSE)
                    Client begins playback immediately
```

## Current State of STT

### Provider Landscape (Feb 2026)

| Provider | Model | WER (en) | Streaming | Diarization | Cost/min |
|----------|-------|----------|-----------|-------------|---------|
| **Deepgram** | Nova-3 | Best | Yes | Yes | $0.0043 |
| **OpenAI** | Whisper v3 | Good | Batch | No | $0.006 |
| **AssemblyAI** | Universal-2 | Very Good | Yes | Yes | $0.0065 |
| **Speechmatics** | Flow | Very Good | Yes | Yes | $0.005 |
| **Google** | Chirp 2 | Very Good | Yes | Yes | $0.006 |

### STT Use Cases for Avocabo

| Use Case | Provider | Mode | Feature |
|----------|----------|------|---------|
| Podcast transcript ingestion | Deepgram Nova-3 | Batch | `podcast-support` |
| YouTube transcript enrichment | Deepgram Nova-3 | Batch | `youtube-integration` |
| Interactive audio interrupts | Deepgram Nova-3 | Streaming | `audio-transformation` |
| Voice commands in mobile | Deepgram Nova-3 | Streaming | `mobile-app` |

## Architecture Patterns

### Daily Audio Briefing Pipeline

```
Digest content (5-10 items)
  → Script generation (Lane 2, Sonnet 4.5):
      { intro, sections[{ headline, summary, transition }], outro }
  → TTS conversion (Cartesia Sonic 3, streaming):
      Each section → audio chunk → buffer
  → Audio assembly:
      Intro + sections with natural pauses + outro
  → Delivery:
      Progressive streaming (play while generating)
      or pre-generated (background job via @arki/queue)
```

### Multi-Speaker Conversational Audio

```
Content (newsletter summaries)
  → Conversational script generation (Lane 2):
      {
        speakers: ["Host", "Analyst"],
        turns: [
          { speaker: "Host", text: "So the big news this week...", tone: "curious" },
          { speaker: "Analyst", text: "Right, there are three key aspects...", tone: "authoritative" }
        ]
      }
  → Per-speaker TTS (different voice profiles):
      Host → Cartesia voice_id_1 (warm, conversational)
      Analyst → Cartesia voice_id_2 (professional, measured)
  → Audio stitching:
      Merge segments with natural turn-taking pauses (200-400ms)
  → Final audio file or streaming output
```

### Interactive Audio (Interrupt + Resume)

```
Audio briefing playing → Section 3 of 8
  ↓
User interrupts: "Wait, what about the funding numbers?"
  ↓
System:
  1. Pause audio playback
  2. STT: transcribe user speech (Deepgram streaming, ~200ms)
  3. Retrieve context: current section + user question
  4. Generate answer (Lane 3, Claude Opus): ~2s
  5. TTS answer (Cartesia streaming): 40ms TTFB
  6. Play answer audio
  7. Resume original briefing from interruption point
  ↓
Total interrupt-to-answer latency: ~2.5s
```

## Key Technologies

### Voice Cloning and Personalization

| Provider | Cloning | Quality | Input Required | Privacy |
|----------|---------|---------|---------------|---------|
| ElevenLabs | Professional Voice Cloning | Best | 30min audio | Cloud-processed |
| Cartesia | Voice Creation API | Very Good | 15s audio | Cloud-processed |
| OpenAI | No custom voices | N/A | N/A | N/A |
| Coqui (open-source) | XTTS-v2 | Good | 6s audio | Self-hosted |

**Relevance for Avocabo:** Optional feature — users create a personalized briefing voice. Privacy-sensitive (voice data stored per user, deletable).

### Audio Quality Enhancement

| Technique | Description | When to Apply |
|-----------|-------------|---------------|
| Noise reduction | Remove background noise from podcast transcripts | Ingestion (STT pre-processing) |
| Speaker separation | Isolate speakers in multi-person content | Podcast transcript enrichment |
| Audio normalization | Consistent volume across briefing segments | TTS post-processing |
| SSML markup | Control pauses, emphasis, pronunciation | Script-to-TTS conversion |

### Streaming Architecture

```
Server (Bun runtime):
  WebSocket connection ←→ Client
  ├── TTS provider WebSocket (Cartesia)
  ├── Audio buffer manager (3-5 second lookahead)
  └── State manager (@arki/kv: position, section, paused)

Client (TanStack Start):
  ├── Audio player (Web Audio API / HTMLAudioElement)
  ├── Buffer queue (receive chunks, maintain playback buffer)
  ├── UI controls (play, pause, skip, interrupt)
  └── STT (for interrupt mode — browser MediaRecorder → Deepgram WebSocket)
```

## Advanced Techniques (2025-2026)

### Emotional and Contextual TTS

Match voice expression to content tone:

```
Newsletter section about breaking news:
  → Tone: "urgent"
  → TTS parameters: faster pace, slight pitch increase, more energy

Newsletter section about financial analysis:
  → Tone: "analytical"
  → TTS parameters: measured pace, neutral pitch, calm energy

Newsletter section about product launch:
  → Tone: "excited"
  → TTS parameters: varied pitch, upbeat energy, slightly faster
```

**Implementation:** Lane 1 classifier detects content tone → map to TTS parameter presets.

### AI Podcast Generation (NotebookLM-Style)

Transform newsletter content into a full podcast episode:

| Aspect | NotebookLM | Avocabo Approach |
|--------|-----------|-----------------|
| Input | Documents uploaded by user | User's content library (auto-curated) |
| Format | 2-speaker discussion | 2-speaker (V2) → 4+ speaker panel (V3) |
| Length | 10-15 min | 6 min (daily) → 15 min (weekly deep dive) |
| Interactivity | None (pre-generated) | Interrupt + ask (V3) |
| Personalization | Generic | Personalized to user's interests and reading history |

### Audio Summarization (Audio-to-Audio)

For podcast and video content, skip text entirely:

```
Podcast episode (60 min)
  → STT: full transcript (Deepgram, ~$0.26)
  → Summarization (Lane 2): key points, timestamps
  → TTS: audio summary (5 min, Cartesia, ~$0.05)
  → Output: "5-minute audio summary of [podcast name]"
```

**Cost per episode:** ~$0.31 total. Enables "listen to the highlight reel" for time-pressed users.

## Evaluation Metrics

### TTS Quality

| Metric | Description | Target |
|--------|-------------|--------|
| MOS (Mean Opinion Score) | Human quality rating (1-5) | >4.0 |
| TTFB (Time to First Byte) | Latency before audio starts | <100ms (streaming) |
| Naturalness | Does it sound human? | Subjective, A/B tested |
| Intelligibility | Can all words be understood? | >98% word accuracy |
| Consistency | Same voice across sessions | Perceptual test |

### STT Quality

| Metric | Description | Target |
|--------|-------------|--------|
| WER (Word Error Rate) | % words incorrectly transcribed | <10% |
| Real-time factor | Processing time / audio duration | <0.1 (10x real-time) |
| Speaker diarization accuracy | Correct speaker attribution | >90% |
| Timestamp accuracy | Word-level timestamp precision | ±100ms |

### User Experience

| Metric | Description |
|--------|-------------|
| Listen-through rate | % of briefing completed |
| Skip rate | How often users skip sections |
| Interrupt frequency | How often users ask questions during playback |
| Preferred format | Single-voice vs. multi-voice preference |
| Time-of-day usage | When users listen (commute patterns) |

## Challenges and Limitations

1. **Streaming reliability:** WebSocket connections can drop on mobile. Need reconnection + resume-from-position.
2. **Multi-language TTS quality:** Quality varies significantly by language. English is best; less common languages lag.
3. **Cost at scale:** TTS is the most expensive AI feature per user ($3.60/month with Cartesia). Must optimize.
4. **Voice uncanny valley:** Almost-human voices can feel unsettling. Pure quality metrics don't capture this.
5. **Bandwidth:** Audio streaming requires stable connectivity. Offline pre-generation helps but delays freshness.
6. **Content appropriateness:** Not all newsletter content works well as audio. Dense data tables, code snippets, and formula-heavy content need alternative presentation.

## Best Practices for Avocabo

1. **Start with single-speaker** (Cartesia Sonic 3) — fastest path to "wow."
2. **Pre-generate for active listeners** — background job generates briefing at 6 AM for users with recent listen history (7-day window). First-time or infrequent users get on-demand generation (Cartesia 40ms TTFB keeps latency acceptable). This avoids burning TTS budget on non-listeners while giving regulars instant playback.
3. **Segment by section** — each digest section is a separate audio segment. Enables skip, replay, interrupt.
4. **Offer text fallback** — always show text alongside audio. Some users prefer reading.
5. **Sentence-boundary alignment** — TTS chunks must end at sentence boundaries, never mid-word.

## References

1. van den Oord, A., et al. (2016). "WaveNet: A Generative Model for Raw Audio"
2. Shen, J., et al. (2018). "Natural TTS Synthesis by Conditioning WaveNet on Mel Spectrogram Predictions (Tacotron 2)"
3. Radford, A., et al. (2022). "Robust Speech Recognition via Large-Scale Weak Supervision (Whisper)"
4. Wang, C., et al. (2023). "Neural Codec Language Models are Zero-Shot Text to Speech Synthesizers (VALL-E)"
5. Défossez, A., et al. (2022). "High Fidelity Neural Audio Compression (EnCodec)"
6. Zhang, D., et al. (2023). "SpeechTokenizer: Unified Speech Tokenizer for Speech Large Language Models"
7. Borsos, Z., et al. (2023). "SoundStorm: Efficient Parallel Audio Generation"
