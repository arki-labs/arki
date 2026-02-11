# Avocabo AI Tech Radar (Wow Factor Edition)

**Date:** February 2026
**Purpose:** Identify high-upside AI + adjacent technologies we can adopt to create a clear "wow" experience and outcompete incumbents.

> **Detailed technology annexes:** Each annex in this directory provides benchmarks, pricing, provider comparisons, and integration paths.

---

## 1. What Is New And High-Potential Right Now

### A. Agentic research and search (very high potential)

- Deep-research style agents are now productized across major vendors.
- The pattern is converging: `plan -> search -> read -> iterate -> synthesize` instead of one-shot QA.
- This is directly aligned with Avocabo's "feel informed in minutes" promise.

**Why it matters for us:**
Newsletter overload is exactly the problem these systems solve when adapted to personal information streams.

**Recommended stack:** Claude Opus 4.6 (1M context, best reasoning) for synthesis. Agentic RAG via `@arki/ai` Flow with 2-5 retrieval steps per query. Cohere Rerank 3.5 for retrieval quality.
See [Retrieval Stack annex](./RETRIEVAL-STACK.md) and [LLM Routing annex](./LLM-ROUTING-AND-MODELS.md).

### B. Tool-using AI agents and computer-use agents (high potential)

- Major APIs now expose native tool orchestration and browser/computer control loops.
- This unlocks "do, not just tell" experiences.

**Why it matters for us:**
Can automate user setup tasks (source setup, triage flows, watchlist building) and reduce onboarding friction to near zero.

**Recommended stack:** Keep `@arki/ai` Flow for orchestration. Add CrewAI for multi-agent "analyst teams" (Trend + Contradiction + Risk agents). Evaluate OpenAI Swarm for parallel watchlist scanning.
See [LLM Routing annex](./LLM-ROUTING-AND-MODELS.md) Section 4.

### C. Voice-native agents and expressive TTS (very high wow potential)

- Native audio models now support low-latency, affective voice behavior and multi-speaker TTS.
- Voice quality gap has narrowed enough for premium-feeling daily briefings.

**Why it matters for us:**
Audio-first briefings can become a signature Avocabo surface (commute mode, walk mode, "one tap brief me").

**Recommended stack:** Cartesia Sonic 3 (40ms TTFB, streaming) for daily briefings. Deepgram Nova-3 for STT. VibeVoice or custom script+multi-TTS for conversational audio. Hume Octave 2 for emotional expression (premium).
See [Voice & Audio Stack annex](./VOICE-AND-AUDIO-STACK.md).

### D. Multimodal document intelligence (high practical potential)

- PDF/image/document understanding is now first-class across leading model APIs.
- End-to-end VLMs replace traditional OCR pipelines — understand charts, tables, and figures directly.

**Why it matters for us:**
Our ingestion shouldn't be limited to clean email HTML; we can treat PDFs, slides, charts, screenshots, and transcripts as first-class.

**Recommended stack:** Mistral OCR (structured JSON, $0.001/page) for document extraction. Gemini 2.5 Pro for chart/figure interpretation and video understanding. DeepSeek-OCR 3B as free fallback.
See [Visual Language Models annex](./VISUAL-LANGUAGE-MODELS.md).

### E. Long-context frontier models + cheaper small models (very high leverage)

- Frontier context windows are now large enough for multi-document synthesis workflows (1M-2M tokens).
- Cheap fast models are now good enough for high-volume summarization and classification lanes.

**Why it matters for us:**
Model routing can massively improve quality/cost: cheap model for 80% of tasks, premium model only when synthesis complexity requires it. **93% cost reduction** vs. using premium for everything.

**Recommended stack:** Four-lane routing in `@arki/ai` ProviderRouter — Haiku 4.5 (bulk), Sonnet 4.5 (standard), Claude Opus 4.6 (premium), per-task specialists. Voyage-3 embeddings (+5 MTEB points, -50% cost vs. current).
See [LLM Routing annex](./LLM-ROUTING-AND-MODELS.md) and [Cost Model annex](./COST-MODEL.md).

### F. MCP as the integration protocol layer (high platform potential)

- MCP has 50M+ downloads, 5,800+ servers, 300+ clients. OAuth 2.1 auth is production-ready.
- Avocabo as MCP server: "Search my library" from Claude Desktop, Cursor, or any AI assistant.

**Why it matters for us:**
Lets Avocabo expose and consume integrations without building one-off connectors for every tool/system. Users get Avocabo intelligence **everywhere AI lives**.

**Recommended stack:** MCP server in TanStack Start (search, summarize, analyze endpoints). MCP client connections to web search (Exa/Tavily), Notion, Linear for expanded capabilities.
See [MCP Strategy annex](./MCP-STRATEGY.md).

### G. RAG 2.0 stack: hybrid retrieval + reranking + multimodal embeddings (high quality potential)

- Search quality gains increasingly come from retrieval architecture, not only better LLM prompts.
- Reranking adds 15-25% relevance improvement on top of existing hybrid search.
- GraphRAG enables relationship-aware retrieval ("find all companies Sam Altman invested in").

**Why it matters for us:**
Digest, copilot, and semantic search quality can all improve with one shared retrieval backbone.

**Recommended stack:** Add Cohere Rerank 3.5 after RRF merge (Phase 1). GraphRAG via entity relationship graph (Phase 2). Agentic RAG for multi-turn research (Phase 3).
See [Retrieval Stack annex](./RETRIEVAL-STACK.md).

---

## 2. Wow-Factor Priority Matrix

| Bet | Wow Factor | Differentiation | Build Risk | Time-to-Value | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Agentic "Why this matters this week" reports | Very High | High | Medium | 4-8 weeks | **Ship early** |
| Daily audio brief with expressive multi-speaker mode | Very High | High | Medium | 4-6 weeks | **Ship early** |
| Visual insight cards (charts/figures/tables from source docs) | High | High | Medium | 6-10 weeks | **Ship early** |
| Personal research copilot with citations + follow-up actions | High | High | Medium | 8-12 weeks | **Ship early** |
| MCP server ("Your knowledge, anywhere AI lives") | High | Very High | Low | 4-6 weeks | **Ship early** |
| Interactive audio digest (interrupt + ask questions) | Very High | Very High | Medium | 8-12 weeks | **Phase 2** |
| Computer-use assistant for setup/triage automations | Very High | Medium | High | 10-16 weeks | **Pilot only** |
| Multi-agent "analyst team" (trend, contradiction, risk) | High | High | High | 12-20 weeks | **Phase 2** |
| Personalized memory graph + proactive resurfacing | High | High | Medium | 8-14 weeks | **Phase 2** |
| Auto-generated short video briefings | Very High | Medium | High | 12-20 weeks | **Experimental** |
| Live collaborative team briefing agent | High | Medium | High | 12-24 weeks | **Phase 3** |

---

## 3. Specific Product Concepts We Should Explore

### 3.1 "Boardroom Brief" (agentic deep research over your sources)

- User asks: "What changed this week in AI infra that affects my startup?"
- Agent gathers from newsletters + podcasts + YouTube transcripts + saved docs.
- Output:
  - 5 key shifts
  - confidence and citations
  - contradiction table ("source A vs source B")
  - 3 recommended actions

**Wow hook:** feels like having a research analyst on demand.
**Cost:** ~$1.35 per report. See [Cost Model](./COST-MODEL.md) Section 6.

### 3.2 "Morning in 6 Minutes" (voice-first personalized brief)

- Auto-generated audio episode daily:
  - top stories
  - "what changed since yesterday"
  - "relevance to your focus areas"
- Optional dual-voice conversational style for premium feel.

**Wow hook:** world-class briefing while walking/commuting, no reading required.
**Cost:** ~$0.12/day (Cartesia) to ~$0.24/day (OpenAI HD). See [Voice & Audio Stack](./VOICE-AND-AUDIO-STACK.md) Section 6.

### 3.3 "Explain this chart to me" (visual understanding in context)

- User uploads screenshot/PDF/slide.
- Avocabo explains the chart, links to related prior content, and highlights implications.

**Wow hook:** users get insight from visuals instantly, not just text summaries.
**Cost:** ~$0.005 per chart (Gemini VLM). See [Visual Language Models](./VISUAL-LANGUAGE-MODELS.md) Section 5.

### 3.4 "Autonomous Watchlist Agent"

- User defines strategic watchlists (companies, tech stacks, regulations, competitors).
- Agent continuously scans, deduplicates, and alerts only on meaningful changes.

**Wow hook:** proactive intelligence instead of passive reading queues.

### 3.5 "Setup Copilot That Actually Does Setup"

- Computer-use agent helps users configure forwarding, add feeds, set filtering rules, and tune goals.

**Wow hook:** zero-config onboarding becomes truly zero-effort.

### 3.6 "Interactive Audio Digests"

- User interrupts the audio briefing mid-playback: "Wait — what about the funding numbers?"
- System pauses, re-generates an answer segment on-demand, then resumes the briefing.
- Requires streaming TTS (Cartesia 40ms TTFB) + streaming STT (Deepgram Nova-3).

**Wow hook:** "Like talking to your morning briefing."
See [Voice & Audio Stack](./VOICE-AND-AUDIO-STACK.md) Section 5.

### 3.7 "Visual Content Pipeline"

- Newsletter images, charts, and PDF figures automatically detected during ingestion.
- VLM extracts data points, describes visuals, generates insight cards.
- "See chart on page 3 showing Q4 revenue growth of 25%" — without the user ever opening the PDF.

**Wow hook:** "Understand the chart without reading the report."
See [Visual Language Models](./VISUAL-LANGUAGE-MODELS.md) Section 6.

### 3.8 "MCP-Powered Agent OS"

- Avocabo as both MCP server and MCP client.
- Claude Desktop users query their Avocabo library naturally: "What have I read about distributed systems this month?"
- Any MCP-compatible AI assistant becomes a window into the user's curated knowledge.

**Wow hook:** "Your knowledge, anywhere AI lives."
See [MCP Strategy](./MCP-STRATEGY.md).

---

## 4. Recommended AI Architecture Pattern For Avocabo

### 4.1 Four-lane model routing

| Lane | Purpose | Primary Model | Fallback |
|------|---------|--------------|----------|
| **Lane 1** (high-volume cheap) | Classification, light summaries, tagging, entity extraction | Haiku 4.5 ($0.80/1M) | Gemini 2.0 Flash |
| **Lane 2** (mid-tier) | Digest synthesis, cluster naming | Sonnet 4.5 ($3/1M) | GPT-5.1 Mini |
| **Lane 3** (premium reasoning) | Deep research, cross-doc synthesis, agentic | Claude Opus 4.6 ($15/1M, 1M ctx) | GPT-5.1 |
| **Lane 4** (specialist) | TTS, STT, OCR, vision, embeddings | Per-task (see annexes) | — |

This should be implemented in `@arki/ai` ProviderRouter with hot-reloadable lane configuration via `@arki/kv`.
See [LLM Routing annex](./LLM-ROUTING-AND-MODELS.md) for full model comparison and routing logic.

### 4.2 One retrieval backbone for all intelligence surfaces

- Shared SemanticSearchService powers digest, copilot, semantic search, and alerts.
- **Phase 1:** Add Cohere Rerank 3.5 after RRF merge (+15-25% relevance).
- **Phase 2:** GraphRAG for relationship-aware retrieval.
- **Phase 3:** Agentic RAG for multi-turn research queries.

See [Retrieval Stack annex](./RETRIEVAL-STACK.md).

### 4.3 Mandatory citation contract

- Every non-trivial claim from copilot/synthesis must map to source evidence.
- UI should expose "show evidence" in one click everywhere.
- Anti-hallucination pipeline: citation attachment → source verification → confidence scoring.

See [AI Observability annex](./AI-OBSERVABILITY.md) Section 6.

### 4.4 Evaluation and quality gates

- Build recurring eval suites for:
  - factuality/citation validity
  - relevance quality
  - hallucination regression
  - style consistency and anti-guilt UX
- 850 golden test cases across all features, automated regression on every prompt change.

See [AI Observability annex](./AI-OBSERVABILITY.md).

### 4.5 AI observability and evaluation pipeline

- **Eval framework:** Braintrust (Day 30, fast setup) → Langfuse (Day 90, self-hosted for data sovereignty).
- **LLM-as-judge:** Haiku 4.5 evaluates production outputs for factuality, coherence, and citation accuracy.
- **Golden dataset regression:** 850 curated test cases, automated run on every prompt or model change (~$1.70/run, ~15 min).
- **Production monitoring:** Trace instrumentation on every `@arki/ai` call — traceId, feature, lane, tokens, latency, quality score.
- **Alerting:** Quality regression (>5% drop for 24h), cost spikes (2x average), provider outages (>5% errors for 10min).

### 4.6 Fine-tuned SLM strategy

For high-volume Lane 1 tasks (classification, tagging, keyword extraction):

- **Candidates:** Mistral Small 3.1 (24B), Llama 4 Scout (17B active), Phi-4 (14B).
- **Break-even:** Self-hosted SLM saves money only at >25K users. Stay on Haiku 4.5 API until then.
- **Training data:** Collect production Lane 1 calls via `@arki/ai` trace logging → human-review 200+ golden examples → fine-tune.

See [LLM Routing annex](./LLM-ROUTING-AND-MODELS.md) Section 3.

---

## 5. Non-AI Tech With High Upside

### A. MCP-first integration strategy

- Use MCP for both internal tools and external connectors.
- Avocabo as MCP server (6 endpoints) + MCP client (web search, Notion, Linear, calendar).
- Avoid bespoke one-off connector implementations where MCP can standardize.

See [MCP Strategy annex](./MCP-STRATEGY.md).

### B. Offline-first sync architecture

- Keep hybrid model:
  - ElectricSQL for server → client read replication
  - outbox pattern for client → server user-intent writes

### C. AI observability and trace grading

- Treat traces/evals as product infra, not optional tooling.
- Required for stable agent behavior and safe rapid iteration.

See [AI Observability annex](./AI-OBSERVABILITY.md).

### D. Feature-level cost control

- Per-feature token/tool budgets, dynamic quality downgrades, and circuit breakers.
- Auto-degradation: 80% budget → warn, 90% → degrade to cheaper lane, 100% → cached results only.
- This protects margins while scaling premium features.

See [Cost Model annex](./COST-MODEL.md) Section 5.

---

## 6. 30/60/90 "Wow" Execution Plan

| Day | Deliverable | Annex |
|-----|-------------|-------|
| **30** | Agentic weekly brief (Boardroom Brief MVP) with Claude Opus 4.6 | [LLM Routing](./LLM-ROUTING-AND-MODELS.md) |
| **30** | Four-lane model routing in `@arki/ai` ProviderRouter | [LLM Routing](./LLM-ROUTING-AND-MODELS.md) |
| **30** | Cohere Rerank 3.5 in SemanticSearchService | [Retrieval Stack](./RETRIEVAL-STACK.md) |
| **30** | Voyage-3 embedding migration | [LLM Routing](./LLM-ROUTING-AND-MODELS.md) |
| **30** | Eval dashboard v1 (Braintrust) | [AI Observability](./AI-OBSERVABILITY.md) |
| **60** | Audio digest with Cartesia streaming TTS | [Voice & Audio](./VOICE-AND-AUDIO-STACK.md) |
| **60** | Visual doc insight cards (Mistral OCR + VLM) | [Visual Language Models](./VISUAL-LANGUAGE-MODELS.md) |
| **60** | MCP server skeleton (search + summarize endpoints) | [MCP Strategy](./MCP-STRATEGY.md) |
| **60** | GraphRAG for entity-aware retrieval | [Retrieval Stack](./RETRIEVAL-STACK.md) |
| **90** | Interactive audio digest (interrupt + regenerate) | [Voice & Audio](./VOICE-AND-AUDIO-STACK.md) |
| **90** | Autonomous Watchlist Agent (multi-agent pattern) | [LLM Routing](./LLM-ROUTING-AND-MODELS.md) |
| **90** | Cost monitoring per-feature with auto-degradation | [Cost Model](./COST-MODEL.md) |
| **90** | Agentic RAG via `@arki/ai` Flow | [Retrieval Stack](./RETRIEVAL-STACK.md) |
| **90** | Full MCP ecosystem (analyze, insights, client integrations) | [MCP Strategy](./MCP-STRATEGY.md) |

---

## 7. Advanced AI Patterns

These techniques represent the cutting edge of retrieval and synthesis. Each is detailed in the relevant annex.

### GraphRAG — Knowledge Graph + Retrieval

Traditional vector search finds "similar" documents. GraphRAG follows **relationships**: "Sam Altman" → invested_in → Company A → competitor_of → Company B. Enables questions like "Find all funding announcements for AI companies I follow" — traversing the entity graph built by `cross-document-intelligence`.

See [Retrieval Stack](./RETRIEVAL-STACK.md) Section 3.

### Agentic RAG — Multi-Turn Research

Instead of one search → one answer, the agent **plans** what to search, **evaluates** results, identifies **gaps**, and searches again. 2-5 retrieval iterations per query. Powers the Boardroom Brief and deep copilot research.

See [Retrieval Stack](./RETRIEVAL-STACK.md) Section 4.

### Late Chunking — Dynamic Passage Extraction

Store full articles instead of pre-chunked fragments. At query time, extract the most relevant passages dynamically. Better context preservation for complex questions, at the cost of higher query-time compute.

See [Retrieval Stack](./RETRIEVAL-STACK.md) Section 5.

### ColBERT v2 — Per-Token Embeddings

Creates per-token embeddings for both query and document, enabling multi-aspect matching. "AI companies doing open-source LLMs with good documentation" matches all three facets simultaneously. Storage-expensive but powerful for research queries.

See [Retrieval Stack](./RETRIEVAL-STACK.md) Section 5.

### Multi-Agent Teams — Specialized Analysis

CrewAI-style multi-agent architecture where specialized agents (Trend Agent, Contradiction Agent, Risk Agent, Synthesis Agent) collaborate on complex analysis tasks. Each agent has a defined role, tools, and delegation patterns.

See [LLM Routing](./LLM-ROUTING-AND-MODELS.md) Section 4.

---

## 8. Sources (Official / Primary)

### OpenAI

- Deep research announcement: <https://openai.com/index/introducing-deep-research/>
- Tools in Responses API (web search, file search, MCP): <https://platform.openai.com/docs/guides/tools/file-search>
- Computer use tool: <https://platform.openai.com/docs/guides/tools-computer-use>
- Pricing (tools, audio): <https://platform.openai.com/pricing>
- GPT-5.1 model: <https://platform.openai.com/docs/models/gpt-5.1>
- Realtime + voice guides: <https://platform.openai.com/docs/guides/voice-agents>

### Google Gemini

- Gemini API changelog: <https://ai.google.dev/gemini-api/docs/changelog>
- Deep Research Agent: <https://ai.google.dev/gemini-api/docs/deep-research>
- Computer Use: <https://ai.google.dev/gemini-api/docs/computer-use>
- Speech generation (TTS): <https://ai.google.dev/gemini-api/docs/speech-generation>
- Document understanding (PDF): <https://ai.google.dev/gemini-api/docs/document-processing>
- Pricing: <https://ai.google.dev/gemini-api/docs/pricing>

### Anthropic

- Models overview and context windows: <https://docs.anthropic.com/en/docs/models-overview>
- 1M context window details: <https://docs.anthropic.com/en/docs/build-with-claude/context-windows>
- PDF support: <https://docs.anthropic.com/en/docs/build-with-claude/pdf-support>
- MCP connector: <https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector>
- API release notes: <https://docs.anthropic.com/en/release-notes/api>

### Mistral

- Agents API: <https://mistral.ai/news/agents-api>
- Agents & Conversations docs: <https://docs.mistral.ai/agents/agents>
- Document AI / OCR: <https://docs.mistral.ai/capabilities/document_ai>
- OCR endpoint: <https://docs.mistral.ai/api/endpoint/ocr>
- Audio transcription capabilities: <https://docs.mistral.ai/capabilities/audio_transcription>
- Vision capabilities: <https://docs.mistral.ai/capabilities/vision>

### xAI

- API models and pricing: <https://x.ai/api/>
- Grok 4.1 fast and agent tools: <https://x.ai/news/grok-4-1-fast/>
- Voice Agent API docs: <https://docs.x.ai/developers/model-capabilities/audio/voice-agent>
- Grok Imagine API: <https://x.ai/news/grok-imagine-api>

### MCP

- MCP overview: <https://modelcontextprotocol.io/>
- MCP architecture/spec: <https://modelcontextprotocol.io/specification/2025-06-18/basic/index>

### Retrieval / Search stack

- Exa API docs: <https://docs.exa.ai/>
- Perplexity API docs: <https://docs.perplexity.ai/>
- Tavily API overview: <https://help.tavily.com/articles/4840311948-tavily-search-api>
- Cohere Rerank: <https://docs.cohere.com/docs/reranking>
- Voyage reranker and embeddings: <https://docs.voyageai.com/docs/reranker>
- ColBERT v2: <https://github.com/stanford-futuredata/ColBERT>
- GraphRAG: <https://github.com/microsoft/graphrag>
- MTEB leaderboard: <https://huggingface.co/spaces/mteb/leaderboard>

### Voice / Audio

- Cartesia Sonic: <https://cartesia.ai/sonic>
- Deepgram Nova-3: <https://deepgram.com/product/nova-3>
- ElevenLabs: <https://elevenlabs.io/docs>
- Hume Octave: <https://www.hume.ai/products>
- VibeVoice: <https://vibevoice.com>

### Visual / OCR

- Mistral OCR: <https://docs.mistral.ai/capabilities/document_ai>
- DeepSeek VL: <https://github.com/deepseek-ai/DeepSeek-VL>
- Docling: <https://github.com/DS4SD/docling>

### AI Observability

- Braintrust: <https://www.braintrust.dev/>
- Langfuse: <https://langfuse.com/>
- Arize Phoenix: <https://docs.arize.com/phoenix>

### Competitor signals

- Readwise Ghostreader docs: <https://docs.readwise.io/reader/guides/ghostreader/overview>
- Readwise changelog: <https://docs.readwise.io/changelog>
- Meco features/docs: <https://docs.meco.app/docs/get-to-know-meco/features>
- Matter updates hub: <https://hq.getmatter.com/updates>

> **Detailed benchmarks, pricing, and integration paths** are in the technology annexes alongside this document. Each annex includes a "Last verified" date for freshness tracking.
