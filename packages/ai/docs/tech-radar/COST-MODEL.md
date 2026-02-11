# Cost Model — Technology Annex

> **Last verified:** February 2026
> **Parent:** [AI Tech Radar (Wow Factor Edition)](./AI-TECH-RADAR-WOW-FACTOR-2026.md)

---

## 1. Per-Feature Monthly Cost Estimates

All costs are AI/ML processing costs only (excludes infrastructure, storage, bandwidth).

### At 1K Users

| Feature | Primary AI Cost | Monthly Total | Per User |
|---------|----------------|---------------|----------|
| **ai-summarization** | Lane 1 (Haiku): classification + summaries | $120 | $0.12 |
| **daily-digest** | Lane 2 (Sonnet): synthesis | $300 | $0.30 |
| **semantic-search** | Embeddings + reranking | $200 | $0.20 |
| **ai-copilot** | Lane 3 (Opus): reasoning + synthesis | $500 | $0.50 |
| **auto-clustering** | Lane 1 (centroid) + Lane 2 (naming) | $80 | $0.08 |
| **cross-document-intelligence** | Lane 3 (synthesis) + Lane 1 (entities) | $400 | $0.40 |
| **audio-transformation** | Lane 4 (TTS): Cartesia | $3,600 | $3.60 |
| **content-deduplication** | Embeddings only | $20 | $0.02 |
| **relevance-scoring** | Lane 1 (Haiku): scoring | $60 | $0.06 |
| **Total** | | **$5,280** | **$5.28** |

### Scaling Table

| Scale | Monthly AI Cost | Per User | Notes |
|-------|----------------|----------|-------|
| 1K users | $5,280 | $5.28 | Full feature set |
| 10K users | $42,000 | $4.20 | Volume discounts kick in |
| 100K users | $280,000 | $2.80 | Fine-tuned SLM for Lane 1, aggressive caching |

**Key insight:** Audio is 68% of per-user AI cost. The second most expensive is the copilot at $0.50/user. Without audio, per-user cost drops to ~$1.68/month — very manageable.

---

## 2. Model Routing ROI

### All-Premium vs. Hybrid Routing

If we used Claude Opus 4.6 (Lane 3 pricing) for everything:

| Scenario | Monthly Cost (1K users) | Per User |
|----------|----------------------|----------|
| **All Opus 4.6** | ~$75,000 | $75.00 |
| **Hybrid 4-lane routing** | ~$5,280 | $5.28 |
| **Savings** | **93%** | **$69.72** |

The four-lane routing strategy (see [LLM Routing](./LLM-ROUTING-AND-MODELS.md)) is not optional — it's the difference between a viable business and one that burns cash on inference.

### Lane Distribution (Typical User)

| Lane | % of Calls | % of Cost | Notes |
|------|-----------|-----------|-------|
| Lane 1 (Bulk) | 65% | 8% | Classification, tagging, scoring |
| Lane 2 (Standard) | 20% | 18% | Digests, cluster naming, entity extraction |
| Lane 3 (Premium) | 5% | 42% | Research, synthesis, copilot reasoning |
| Lane 4 (Specialist) | 10% | 32% | TTS, STT, embeddings, OCR |

---

## 3. Audio Briefing Cost Deep Dive

Audio is the most expensive feature per user. Provider choice dramatically impacts unit economics:

### Daily 6-Minute Briefing (~8,000 characters)

| Provider | Daily/User | Monthly/User | At 10K Users | Quality |
|----------|-----------|-------------|-------------|---------|
| **Cartesia Sonic 3** | $0.12 | $3.60 | $36,000 | Very Good |
| **OpenAI TTS-1** | $0.12 | $3.60 | $36,000 | Good |
| **OpenAI TTS-1-HD** | $0.24 | $7.20 | $72,000 | Excellent |
| **Speechmatics** | $0.088 | $2.64 | $26,400 | Very Good |
| **ElevenLabs** | $2.40 | $72.00 | $720,000 | Best |

### Cost Reduction Strategies

| Strategy | Savings | Trade-off |
|----------|---------|-----------|
| Generate only for active listeners | 40-60% | Need engagement tracking |
| Cache intro/outro segments | ~15% | Slightly less fresh |
| Adaptive quality (TTS-1 default, HD for highlights) | ~30% | Mixed quality experience |
| Open-source fallback (Kyutai) for low-priority | ~50% on subset | Lower quality |
| User BYOK (ElevenLabs key) | 100% for those users | User pays directly |

**Recommendation:** Cartesia Sonic 3 as default (streaming + cost balance). Offer OpenAI TTS-1-HD as premium tier. Support ElevenLabs BYOK for audiophile users.

---

## 4. Fine-Tuned SLM Break-Even

For Lane 1 tasks (classification, tagging, keyword extraction) running thousands of times daily:

### Current: Haiku 4.5 API

- Cost: ~$0.80/1M tokens
- Volume at 10K users: ~5M tokens/day Lane 1 → ~$4/day → $120/month

### Alternative: Self-Hosted Mistral Small (Fine-Tuned)

- Inference cost: ~$0.10/1M tokens
- Volume: 5M tokens/day → ~$0.50/day → $15/month
- GPU hosting: ~$150/month (A10G spot instance)
- Fine-tuning: ~$50 one-time + $50/month retraining

### Break-Even Analysis

| Scale | Haiku API | Self-Hosted SLM | Savings |
|-------|----------|----------------|---------|
| 1K users | $12/mo | $165/mo (hosting dominates) | **-$153** (worse) |
| 10K users | $120/mo | $165/mo | **-$45** (still worse) |
| 50K users | $600/mo | $175/mo | **+$425** (profitable) |
| 100K users | $1,200/mo | $200/mo | **+$1,000** (clear win) |

**Break-even: ~25K users** for Lane 1 self-hosted SLM. Stay on Haiku API until then.

---

## 5. Per-Feature Token Budgets

Each feature has a token budget enforced by `@arki/ai` ProviderRouter. When a feature hits its budget, it auto-degrades to a cheaper lane or returns cached results.

### Budget Configuration

| Feature | Monthly Token Budget | Auto-Degrade Behavior |
|---------|--------------------|-----------------------|
| **ai-summarization** | 50M tokens (Lane 1) | Skip classification, use heuristics |
| **daily-digest** | 20M tokens (Lane 2) | Shorter digests, fewer sections |
| **semantic-search** | 10M tokens (Lane 2-3) | Disable agentic, use simple search |
| **ai-copilot** | 30M tokens (Lane 3) | Switch Lane 3 → Lane 2, shorter responses |
| **cross-document-intelligence** | 15M tokens (Lane 3) | Reduce synthesis frequency, cache longer |
| **auto-clustering** | 5M tokens (Lane 1-2) | Batch-only (no real-time assignment) |
| **audio-transformation** | Character-based limit | Shorter briefings, skip low-priority |

### Auto-Degradation Triggers

```
Budget usage hits 80% → Log warning, notify admin
Budget usage hits 90% → Degrade to cheaper lane where possible
Budget usage hits 100% → Return cached results only, queue for next period
Budget resets monthly per user (or daily for high-volume features)
```

### Integration with `@arki/ai` BudgetManager

The BudgetManager tracks token consumption per feature, per user, per lane:

1. Every `@arki/ai` call reports tokens consumed to BudgetManager
2. BudgetManager increments counters in `@arki/kv` (Redis INCRBY, fast)
3. ProviderRouter checks BudgetManager before routing — if over budget, applies degradation
4. Daily summary job (`@arki/queue`) generates cost analytics per feature

---

## 6. Cost Per Agentic Query

Agentic features (Boardroom Brief, copilot deep research, agentic search) are the most expensive single interactions. Budget control is essential.

### Boardroom Brief (Agentic Weekly Report)

| Step | Model | Tokens | Cost |
|------|-------|--------|------|
| Gather sources (5 search calls) | Embeddings + Rerank | ~2K | $0.01 |
| Plan research structure | Opus 4.6 | ~5K in + 2K out | $0.10 |
| Cross-doc synthesis | Opus 4.6 | ~50K in + 5K out | $0.85 |
| Contradiction detection | Opus 4.6 | ~20K in + 2K out | $0.35 |
| Final formatting | Sonnet 4.5 | ~10K in + 3K out | $0.04 |
| **Total per report** | | | **~$1.35** |

At weekly frequency: $1.35 × 4 = **$5.40/user/month** for Boardroom Brief.

### Cost Ceiling Strategy

- Set per-query cost ceiling at **$2.00** for Boardroom Brief
- Set per-query cost ceiling at **$0.10** for agentic search
- If ceiling approached mid-query, switch remaining steps to Lane 2
- Track per-user monthly agentic spend, alert at $10 threshold

---

## 7. Infrastructure Cost (Non-AI)

For completeness, major infrastructure costs alongside AI:

| Service | Purpose | Monthly (1K users) | Monthly (10K users) |
|---------|---------|-------------------|---------------------|
| VectorSearchProvider hosting | Embeddings storage + search | $50-200 | $200-500 |
| PostgreSQL (managed) | Primary database | $50-100 | $200-400 |
| Redis / `@arki/kv` | Caching, rate limits, budgets | $30-50 | $50-100 |
| ElectricSQL | Offline sync | $50-100 | $200-400 |
| `@arki/queue` (BullMQ + Redis) | Background jobs | $30-50 | $50-100 |
| TanStack Start hosting | Application server | $50-100 | $200-400 |
| **Infrastructure total** | | **~$310** | **~$1,500** |

**AI cost is 17x infrastructure cost at 1K users** — AI optimization has far more impact than infrastructure optimization.

---

## Sources

- Anthropic pricing: <https://docs.anthropic.com/en/docs/models-overview>
- OpenAI pricing: <https://platform.openai.com/pricing>
- Google pricing: <https://ai.google.dev/gemini-api/docs/pricing>
- Cartesia pricing: <https://cartesia.ai/pricing>
- Cohere pricing: <https://cohere.com/pricing>
- Voyage AI pricing: <https://docs.voyageai.com/docs/pricing>
