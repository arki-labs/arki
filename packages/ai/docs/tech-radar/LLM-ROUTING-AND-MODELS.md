# LLM Routing & Models — Technology Annex

> **Last verified:** February 2026
> **Parent:** [AI Tech Radar (Wow Factor Edition)](./AI-TECH-RADAR-WOW-FACTOR-2026.md)

---

## 1. Four-Lane Model Routing

The `@arki/ai` ProviderRouter assigns every AI call to one of four lanes based on task complexity, latency requirements, and cost sensitivity. This is the single most impactful cost optimization — hybrid routing reduces AI spend by ~93% compared to using a premium model for everything.

### Lane Assignments

| Lane | Purpose | Primary Model | Fallback | Context | Cost (per 1M input) |
|------|---------|--------------|----------|---------|---------------------|
| **1 — Bulk** | Classification, tagging, light summaries | Haiku 4.5 | Gemini 2.0 Flash | 200K | ~$0.80 |
| **2 — Standard** | Digest synthesis, entity extraction, cluster naming | Sonnet 4.5 | GPT-5.1 Mini | 200K | ~$3.00 |
| **3 — Premium** | Deep research, cross-doc synthesis, contradiction analysis, agentic workflows | Claude Opus 4.6 | GPT-5.1 | 1M | ~$15.00 |
| **4 — Specialist** | TTS, STT, OCR, vision, embeddings | Per-task (see other annexes) | — | Varies | Varies |

### Lane Selection Logic

```
ProviderRouter.route(task) →
  if task.type in [classify, tag, extractKeywords,
                   summarize, extractEntities]          → Lane 1
  if task.type in [synthesizeDigest, nameCluster]       → Lane 2
  if task.type in [synthesize, research,
                   detectContradictions, agenticFlow]   → Lane 3
  if task.type in [tts, stt, ocr, vision, embed]       → Lane 4
  if task.complexity == 'high' && task.type == summarize → Lane 2 (upgrade)
  if task.tokenBudget > 500K                           → Lane 3 (long context)
  default                                              → Lane 2
```

**Note:** Standard single-document summarization and entity extraction are high-volume Lane 1 tasks (see [Cost Model](./COST-MODEL.md) Section 1). Only multi-document digest synthesis (`synthesizeDigest`) and complex summaries are upgraded to Lane 2.

The router lives in `@arki/ai` ProviderRouter and exposes `route()`, `routeWithFallback()`, and `routeWithBudget()` methods.

---

## 2. Frontier Model Landscape (Feb 2026)

### Premium Reasoning Models (Lane 3)

| Model | Provider | Context | Strengths | Weaknesses |
|-------|----------|---------|-----------|------------|
| **Claude Opus 4.6** | Anthropic | 1M tokens | Best instruction-following, citation accuracy, structured output. Extended thinking for complex reasoning. | Highest cost per token. |
| **GPT-5.1** | OpenAI | 256K tokens | Strong tool use, web search integration, broad knowledge. | Smaller context than Opus. |
| **Gemini 3 Pro** | Google | 2M tokens | Largest context window, native multimodal (audio+video+text). | Inconsistent structured output. |
| **Grok 4.1** | xAI | 256K tokens | Fast inference, competitive reasoning, aggressive pricing. | Smaller ecosystem, fewer tools. |

**Recommendation:** Claude Opus 4.6 as primary Lane 3 model. Its 1M context enables feeding 100+ newsletter articles in a single pass for "Boardroom Brief" synthesis — the highest wow-factor feature. GPT-5.1 as fallback for tool-heavy agentic workflows.

### Standard Models (Lane 2)

| Model | Provider | Context | Cost (1M input) | Best For |
|-------|----------|---------|-----------------|----------|
| **Sonnet 4.5** | Anthropic | 200K | ~$3.00 | Digest synthesis, entity extraction |
| **GPT-5.1 Mini** | OpenAI | 128K | ~$2.50 | General-purpose summaries |
| **Gemini 2.5 Flash** | Google | 1M | ~$1.50 | High-throughput with good quality |

**Recommendation:** Sonnet 4.5 as primary Lane 2. Best balance of quality, cost, and structured output reliability for digest generation.

### Bulk Models (Lane 1)

| Model | Provider | Context | Cost (1M input) | Best For |
|-------|----------|---------|-----------------|----------|
| **Haiku 4.5** | Anthropic | 200K | ~$0.80 | Classification, tagging |
| **Gemini 2.0 Flash** | Google | 1M | ~$0.40 | Lightweight extraction |
| **Mistral Small** | Mistral | 128K | ~$0.50 | Multi-language support |

**Recommendation:** Haiku 4.5 as primary Lane 1. Fastest Anthropic model, excellent for the ~80% of tasks that are classification/tagging.

---

## 3. Fine-Tuned SLM Strategy

For tasks executed thousands of times per day (newsletter classification, source categorization, keyword extraction), fine-tuning a Small Language Model (SLM) can reduce per-task cost to ~$0.0001.

### Candidates

| Model | Params | Base Cost | Fine-Tune Cost | Hosting |
|-------|--------|-----------|---------------|---------|
| **Mistral Small 3.1** | 24B | $0.50/1M | ~$50 training | API or self-hosted |
| **Llama 4 Scout** | 17B active (109B MoE) | Free weights | Compute cost | Self-hosted on GPU |
| **Phi-4** | 14B | Free weights | Compute cost | Self-hosted, edge-friendly |

### Fine-Tuning Data Pipeline

1. Collect Lane 1 production calls with inputs + outputs (via `@arki/ai` trace logging)
2. Human-review a subset for quality (200+ golden examples per task type)
3. Fine-tune on task-specific dataset (classification, tagging, keyword extraction)
4. Deploy as dedicated endpoint; route via ProviderRouter `lane1.fineTuned`
5. Continuous eval against golden dataset to detect drift

### Break-Even Analysis

- **Current cost:** Haiku 4.5 at ~$0.80/1M tokens, processing ~500K tokens/day (1K users) for Lane 1 = ~$12/month
- **Fine-tuned SLM:** Self-hosted Mistral Small at ~$0.10/1M tokens = ~$1.50/month inference + ~$150/month GPU hosting + ~$50/month retraining
- **Break-even:** ~25K users. At 10K users self-hosted is still ~$45/month more expensive (hosting dominates). See [Cost Model](./COST-MODEL.md) Section 4 for the full table.
- **Recommendation:** Stay on Haiku 4.5 API until >25K users. Fine-tune as a later cost optimization.

---

## 4. Agentic Framework Assessment

### Current: `@arki/ai` Flow

The existing Flow orchestration provides a state-machine pattern with typed nodes, edges, and context. It powers the content discovery pipeline (scout → curate → score → compliance).

**Strengths:** Lightweight, typed, no external dependency, well-integrated with ProviderRouter.
**Gaps:** No built-in parallel execution, no dynamic tool selection, limited retry/backoff per node.

### Assessment of Alternatives

| Framework | Verdict | Rationale |
|-----------|---------|-----------|
| **LangGraph** | Skip | Similar state-machine capability to Flow, adds heavy LangChain dependency. |
| **CrewAI** | Adopt (limited) | Multi-agent "team" pattern valuable for analyst team features. Role-based agents (Trend, Contradiction, Risk) with delegation. |
| **OpenAI Swarm** | Evaluate | Lightweight agent handoff pattern. Good for parallel analysis (multiple agents working on different sections of a research query). |
| **Mastra** | Watch | TypeScript-native, good DX, but young ecosystem. Revisit in 6 months. |
| **Vercel AI SDK** | Partial adopt | Already used indirectly via `@arki/ai`. Structured output and streaming utilities valuable. |

### Recommended Approach

1. **Keep `@arki/ai` Flow** as the primary orchestration for all features
2. **Enhance Flow** with parallel node execution and conditional routing
3. **Add CrewAI** specifically for the "Analyst Team" product concept (see hub Section 7 "Multi-Agent Teams"):
   - Trend Agent: monitors velocity and emerging patterns
   - Contradiction Agent: cross-references claims across sources
   - Risk Agent: identifies potential impacts to user's watchlists
   - Synthesis Agent: combines findings into "Boardroom Brief"
4. **Evaluate Swarm** for the Autonomous Watchlist Agent (parallel scanning of multiple watchlists)

---

## 5. Embedding Model Upgrade Path

### Current State

`@arki/ai` createEmbeddingProvider currently wraps OpenAI `text-embedding-3-small` (1536 dimensions, ~62.3 MTEB score).

### Upgrade Candidates

| Model | Dimensions | MTEB Score | Cost (1M tokens) | Key Feature |
|-------|-----------|------------|-------------------|-------------|
| **OpenAI text-embedding-3-large** | 3072 | ~64.6 | $0.13 | Matryoshka (truncate to 256/512/1024) |
| **Voyage-3** | 1024 | ~67.3 | $0.06 | Best quality/cost ratio on MTEB |
| **Voyage-3-lite** | 512 | ~63.0 | $0.02 | Budget option, competitive quality |
| **Nomic Embed Vision** | 768 | ~62.0 | Free (self-hosted) | Multimodal (text + images) |
| **Jina CLIP v2** | 1024 | ~63.5 | $0.02 | Multimodal, multilingual |
| **Cohere embed-v4** | 1024 | ~67.0 | $0.10 | Binary quantization (32x storage reduction) |

### Recommended Upgrade Path

**Phase 1 (Day 30):** Switch to Voyage-3 for all text embeddings via `@arki/ai` createEmbeddingProvider. +5 MTEB points, 50% cheaper. Requires re-indexing VectorSearchProvider collections (one-time job via `@arki/queue`).

**Phase 2 (Day 60):** Add Nomic Embed Vision as a secondary provider for image/chart embeddings from the Visual Content Pipeline. Stored in a separate VectorSearchProvider collection (`avocabo_visual_embeddings`).

**Phase 3 (Day 90):** Evaluate Matryoshka embeddings (OpenAI or Cohere) for adaptive precision — use full dimensions for search, truncated dimensions for deduplication. Reduces VectorSearchProvider storage by ~4x for dedup collections.

### Re-Indexing Cost Estimate

| User Scale | Chunks | Voyage-3 Cost | Duration |
|-----------|--------|--------------|----------|
| 1K items | 15K | ~$0.02 | ~2 min |
| 10K items | 150K | ~$0.18 | ~20 min |
| 100K items | 1.5M | ~$1.80 | ~3 hours |

Re-indexing runs as a `@arki/queue` background job with progress tracking and automatic resume on failure.

---

## 6. Structured Output Reliability

A critical but often overlooked concern: LLMs generating structured output (JSON matching Zod schemas) can fail in subtle ways — wrong field types, missing required fields, hallucinated enum values.

### Reliability by Provider (Feb 2026)

| Provider | Structured Output | Reliability | Notes |
|----------|------------------|-------------|-------|
| Anthropic | Tool use with Zod schemas | ~99.5% | Best with `@arki/ai` StructuredGenerator |
| OpenAI | JSON mode / function calling | ~99.2% | `response_format: { type: "json_schema" }` |
| Google | Structured output API | ~97% | Occasionally generates invalid JSON for complex schemas |
| Mistral | Function calling | ~98% | Good but less tested at scale |

### Mitigation in `@arki/ai` StructuredGenerator

1. **Zod validation** on every response — reject and retry on parse failure
2. **Max 2 retries** with refined prompt on failure
3. **Fallback to Lane 3** if Lane 1/2 model fails structured output
4. **Schema complexity limits** — no more than 3 nesting levels for Lane 1 models

---

## 7. Integration Points

### With `@arki/ai` ProviderRouter

- Lane configuration stored in `@arki/ai` config, hot-reloadable via `@arki/kv`
- Per-feature lane overrides (e.g., `ai-copilot` always uses Lane 3 for synthesis)
- Automatic fallback chain: primary → fallback → degraded response

### With `@arki/queue`

- Batch processing jobs use Lane 1 for throughput
- Interactive requests use Lane 2/3 with streaming
- Background re-indexing (embeddings) uses dedicated embedding provider

### With Feature Architecture

- `ai-summarization`: Lane 1 (newsletter summaries) + Lane 2 (digest synthesis)
- `ai-copilot`: Lane 3 (reasoning) + Lane 2 (quick answers)
- `semantic-search`: Lane 3 (agentic search) + embeddings (Lane 4)
- `cross-document-intelligence`: Lane 3 (synthesis) + Lane 1 (entity extraction)
- `auto-clustering`: Lane 1 (centroid matching) + Lane 2 (cluster naming)
- `audio-transformation`: Lane 4 (TTS/STT)

---

## Sources

- Anthropic models: <https://docs.anthropic.com/en/docs/models-overview>
- OpenAI models: <https://platform.openai.com/docs/models>
- Google Gemini: <https://ai.google.dev/gemini-api/docs/models>
- Voyage AI embeddings: <https://docs.voyageai.com/docs/embeddings>
- MTEB leaderboard: <https://huggingface.co/spaces/mteb/leaderboard>
- CrewAI: <https://docs.crewai.com/>
- Cohere embeddings: <https://docs.cohere.com/docs/cohere-embed>
- Mistral models: <https://docs.mistral.ai/getting-started/models/>
