# Voice & Audio Stack — Technology Annex

> **Last verified:** February 2026
> **Parent:** [AI Tech Radar (Wow Factor Edition)](./AI-TECH-RADAR-WOW-FACTOR-2026.md)

---

## 1. Text-to-Speech (TTS) Provider Landscape

### Provider Comparison

| Provider | Model | Latency (TTFB) | Quality | Cost | Streaming | Languages | Key Feature |
|----------|-------|----------------|---------|------|-----------|-----------|-------------|
| **Cartesia** | Sonic 3 | **40ms** | Very Good | ~$0.015/1K chars | Yes (WebSocket) | 17 | Ultra-low latency, voice cloning |
| **ElevenLabs** | Turbo v3 | ~300ms | **Best** | $0.30/1K chars | Yes | 32 | Best expressiveness, BYOK voices |
| **OpenAI** | TTS-1-HD | ~500ms | Excellent | $0.030/1K chars | Yes | 57 | Wide language support, consistent |
| **OpenAI** | TTS-1 | ~200ms | Good | $0.015/1K chars | Yes | 57 | Fast, good enough for previews |
| **Speechmatics** | Flow | ~150ms | Very Good | $0.011/1K chars | Yes | 50 | Best price/quality, real-time |
| **Hume** | Octave 2 | ~200ms | Excellent | $7.60/1M chars | Yes | 8 | **Emotional expression**, tone control |
| **Google** | Gemini TTS | ~250ms | Very Good | Pay-per-use | Yes | 24 | Native Gemini integration |
| **Kyutai** | Pocket TTS | ~100ms | Good | **Free** (open-source) | Limited | 5 | CPU inference, self-hosted |

### Recommended Stack for Avocabo

**Primary (daily briefings):** Cartesia Sonic 3
- 40ms TTFB enables the "Interactive Audio Digest" concept (interrupt and resume)
- Progressive streaming: audio starts playing before full generation completes
- Voice cloning API: users can create personalized briefing voices

**Quality tier (premium features):** OpenAI TTS-1-HD
- Best multi-language support (57 languages)
- Consistent quality across long-form content (10+ minute briefings)
- Fallback when Cartesia is unavailable

**Experimental (wow factor):** Hume Octave 2
- Emotional expression: detect tone of newsletter content, match voice affect
- "Excited" tone for breaking news, "analytical" for financial reports
- Higher cost limits this to premium users or highlight segments

---

## 2. Speech-to-Text (STT) Comparison

| Provider | Model | WER | Cost | Streaming | Key Feature |
|----------|-------|-----|------|-----------|-------------|
| **Deepgram** | Nova-3 | **Best** (53.4% WER reduction vs. prev gen) | $0.0043/min | Yes | Best accuracy, topic detection |
| **OpenAI** | Whisper v3 | Good | $0.006/min | Batch only | Wide language support |
| **AssemblyAI** | Universal-2 | Very Good | $0.0065/min | Yes | Speaker diarization built-in |
| **Speechmatics** | Flow | Very Good | $0.005/min | Yes | Custom vocabulary |

**Recommendation:** Deepgram Nova-3 for all STT needs.
- Podcast transcript ingestion: batch mode at $0.0043/min
- Interactive audio digest interrupts: streaming mode for real-time user speech
- Topic/entity detection enriches transcripts for downstream `@arki/ai` processing

---

## 3. Multi-Speaker Conversational Audio

This is the highest wow-factor audio capability — transforming newsletter summaries into multi-speaker discussions.

### Approaches

| Approach | Provider/Tool | Speakers | Duration | Cost | Maturity |
|----------|--------------|----------|----------|------|----------|
| **VibeVoice** | VibeVoice API | 4+ speakers | Up to 30min | API pricing | Production |
| **NotebookLM-style** | Custom (script → multi-TTS) | 2 speakers | Unlimited | TTS cost × 2 | Build yourself |
| **Dia** | Nari Labs (open-source) | 2 speakers | ~5min | Free (self-hosted) | Beta |
| **MoonCast** | Open-source | 2 speakers | ~5min | Free (self-hosted) | Experimental |

### Implementation Architecture

```
Newsletter content
  → @arki/ai StructuredGenerator (Lane 2): generate conversational script
    { speakers: ["Host", "Analyst"], turns: [...] }
  → TTS provider per speaker (different voice profiles)
  → Audio stitcher: merge segments with natural pauses
  → Progressive streaming to client
```

**Recommended approach for Avocabo:**

1. **V1 (Day 60):** Single-speaker daily briefing with Cartesia Sonic 3
2. **V2 (Day 90):** Dual-speaker "podcast-style" using script generation + Cartesia multi-voice
3. **V3 (future):** VibeVoice integration for 4+ speaker "panel discussion" format
4. **V3+ (future):** Interactive mode — user interrupts, system pauses, answers, resumes

---

## 4. Expressive and Emotional TTS

### Tone Detection Pipeline

```
Newsletter chunk
  → @arki/ai StructuredGenerator (Lane 1): classify tone
    { tone: "urgent" | "analytical" | "exciting" | "neutral" | "cautionary" }
  → Map tone to TTS voice parameters
    urgent    → faster pace, higher energy
    analytical → measured pace, lower pitch
    exciting  → varied pitch, upbeat
    cautionary → slower pace, serious tone
```

### Provider Support for Expressiveness

| Provider | Emotion Control | Method |
|----------|----------------|--------|
| **Hume Octave 2** | Full spectrum (26 emotions) | Emotion tags in prompt |
| **ElevenLabs** | Style control (stability, similarity, style) | Numeric sliders per request |
| **Cartesia** | Speed and emotion presets | Voice configuration object |
| **OpenAI TTS** | Limited (voice selection only) | Choose between 6 voice profiles |

---

## 5. Streaming Architecture

### Progressive Playback Pattern

The key to "Interactive Audio Digest" is that audio starts playing **immediately** — before the full briefing is generated. This requires a streaming architecture:

```
Client requests briefing
  → Server begins LLM synthesis (Lane 2, streaming)
  → First paragraph complete → TTS streaming begins (Cartesia, 40ms TTFB)
  → Audio chunks sent to client via WebSocket / Server-Sent Events
  → Client begins playback at ~240ms (40ms TTS + 200ms buffer)
  → Subsequent paragraphs synthesized and converted in parallel pipeline

User interrupts ("What about the funding numbers?")
  → Client sends interrupt event + speech-to-text (Deepgram streaming)
  → Server pauses synthesis pipeline
  → LLM generates answer using current context + user question (Lane 3)
  → Answer TTS streamed to client
  → Original briefing resumes from interruption point
```

### Technical Requirements

- **WebSocket connection** between client and TTS service (via `@arki/queue` for job orchestration)
- **Audio buffer management** on client: pre-buffer 3-5 seconds for smooth playback
- **State persistence**: briefing position stored in `@arki/kv` for resume-after-close
- **Chunk boundary alignment**: TTS chunks aligned to sentence boundaries (not mid-word)

---

## 6. Cost Analysis Per User

### Daily Audio Briefing (6 minutes, ~8,000 characters)

| Provider | Daily Cost/User | Monthly Cost/User | At 10K Users |
|----------|----------------|-------------------|-------------|
| **Cartesia Sonic 3** | ~$0.12 | ~$3.60 | $36,000/mo |
| **OpenAI TTS-1** | ~$0.12 | ~$3.60 | $36,000/mo |
| **OpenAI TTS-1-HD** | ~$0.24 | ~$7.20 | $72,000/mo |
| **Speechmatics** | ~$0.088 | ~$2.64 | $26,400/mo |
| **ElevenLabs** | ~$2.40 | ~$72.00 | $720,000/mo |

**Note:** ElevenLabs BYOK (Bring Your Own Key) shifts cost to the user. For premium voice quality without platform cost, offer BYOK as an option.

### Cost Optimization Strategies

1. **Cache common segments**: intro/outro, section transitions (saves ~15% of TTS calls)
2. **Adaptive quality**: Use TTS-1 (fast) for normal content, TTS-1-HD only for highlighted stories
3. **Smart generation**: Pre-generate for active listeners (7-day listen history); on-demand for first-time/infrequent users
4. **Open-source fallback**: Kyutai Pocket TTS for preview/low-priority audio (free, CPU-only)

---

## 7. Integration with `audio-transformation` Feature

The `audio-transformation` feature ARCHITECTURE.md defines the processing pipeline. This annex informs provider selection:

| Pipeline Stage | Provider | Lane |
|---------------|----------|------|
| Podcast/video transcript ingestion | Deepgram Nova-3 (STT) | Lane 4 |
| Transcript cleaning and structuring | Haiku 4.5 | Lane 1 |
| Audio briefing script generation | Sonnet 4.5 | Lane 2 |
| Text-to-speech conversion | Cartesia Sonic 3 | Lane 4 |
| Interactive Q&A during playback | Claude Opus 4.6 | Lane 3 |
| Multi-speaker script generation | Sonnet 4.5 | Lane 2 |

---

## Sources

- Cartesia Sonic: <https://cartesia.ai/sonic>
- ElevenLabs: <https://elevenlabs.io/docs>
- OpenAI TTS: <https://platform.openai.com/docs/guides/text-to-speech>
- Deepgram Nova-3: <https://deepgram.com/product/nova-3>
- Hume Octave: <https://www.hume.ai/products>
- Speechmatics: <https://www.speechmatics.com/product>
- VibeVoice: <https://vibevoice.com>
- Dia (Nari Labs): <https://github.com/nari-labs/dia>
- Kyutai: <https://kyutai.org/>
