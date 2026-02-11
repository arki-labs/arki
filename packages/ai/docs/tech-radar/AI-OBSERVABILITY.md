# AI Observability — Technology Annex

> **Last verified:** February 2026
> **Parent:** [AI Tech Radar (Wow Factor Edition)](./AI-TECH-RADAR-WOW-FACTOR-2026.md)

---

## 1. Why AI Observability Is Product Infrastructure

Traditional observability (logs, metrics, traces) tells you "the server responded in 200ms." AI observability tells you "the summary was factually accurate, cited the right sources, and matched the user's tone preferences." Without it, AI features degrade silently — the system "works" but produces bad output.

For Avocabo, where every AI feature touches user-facing content (digests, summaries, copilot answers, audio briefings), quality regression is directly visible. A hallucinated citation in a Boardroom Brief erodes trust faster than any bug.

---

## 2. Eval Framework Comparison

| Platform | Type | Strengths | Weaknesses | Cost |
|----------|------|-----------|------------|------|
| **Braintrust** | Hosted | Fast setup, prompt playground, side-by-side comparison | Vendor lock-in, limited custom metrics | Free tier → $100+/mo |
| **Langfuse** | Open-source (self-hosted) | Full control, no data leaves infra, LLM-as-judge | Operational overhead, slower iteration | Free (hosting cost) |
| **Arize Phoenix** | Open-source | Good tracing, embeddings visualization | Less mature eval framework | Free (hosting cost) |
| **OpenTelemetry + custom** | DIY | Maximum flexibility | Significant build effort | Hosting cost |

### Recommendation

**Phase 1 (Day 30):** Start with **Braintrust** — fastest path to eval dashboards. Its prompt playground enables rapid iteration on summary prompts, copilot system prompts, and synthesis instructions.

**Phase 2 (Day 90):** Evaluate **Langfuse** migration for cost control and data sovereignty. Self-hosted Langfuse eliminates per-eval pricing and keeps all user content within our infrastructure.

**Long-term:** Build toward a hybrid — Braintrust for interactive prompt development, Langfuse for production monitoring and automated regression.

---

## 3. Quality Gates Per Feature

Each AI feature needs specific quality metrics. These are evaluated on every production run (sampled at 5-10%) and on every prompt/model change (100% of golden dataset).

### Feature Quality Metrics

| Feature | Metric | Target | How Measured |
|---------|--------|--------|-------------|
| **ai-summarization** | Factuality | >95% claims verifiable | LLM-as-judge against source text |
| **ai-summarization** | Completeness | >90% key points covered | LLM-as-judge with key point checklist |
| **ai-summarization** | Conciseness | <150 words for standard summary | Word count + readability score |
| **daily-digest** | Relevance | >85% items rated relevant by user | Implicit feedback (click-through, archive) |
| **daily-digest** | Style consistency | Matches Avocabo tone | LLM-as-judge with style rubric |
| **semantic-search** | NDCG@10 | >0.65 | Manual relevance judgments (quarterly) |
| **semantic-search** | Zero-result rate | <5% of queries | Automated tracking |
| **ai-copilot** | Citation accuracy | >98% citations map to real sources | Automated source verification |
| **ai-copilot** | Hallucination rate | <2% claims unsupported | LLM-as-judge + source matching |
| **cross-document-intelligence** | Entity accuracy | >92% entities correctly identified | NER benchmark dataset |
| **cross-document-intelligence** | Synthesis coherence | >90% rated coherent | LLM-as-judge |
| **auto-clustering** | Cluster purity | >85% items correctly clustered | Manual labeling (quarterly) |
| **audio-transformation** | Transcript accuracy | WER <10% | Deepgram benchmarks |
| **audio-transformation** | Audio naturalness | MOS >4.0 (out of 5) | User feedback sampling |

### LLM-as-Judge Pattern

Most quality metrics use "LLM-as-judge" — a separate LLM call that evaluates the output of the primary LLM:

```
Primary call (Lane 2): Summarize this newsletter → output
Judge call (Lane 1): Rate this summary for factuality, completeness, tone
  Input: { source_text, summary, rubric }
  Output: { factuality: 0.95, completeness: 0.88, tone: "matches" }
```

**Cost:** Judge calls use Lane 1 (Haiku 4.5) at ~$0.001 per evaluation. Sampling at 10% of production calls adds ~$12/month at 1K users.

---

## 4. Golden Dataset Strategy

A golden dataset is a curated set of inputs with known-good outputs, used for regression testing every prompt or model change.

### Dataset Design

| Feature | Test Cases | Input Type | Expected Output |
|---------|-----------|------------|----------------|
| **ai-summarization** | 200 | Newsletter articles (diverse sources) | Human-written summaries + key points |
| **daily-digest** | 100 | Sets of 5-10 items | Human-curated digest sections |
| **semantic-search** | 200 | Query + relevant/irrelevant docs | Relevance labels per doc |
| **ai-copilot** | 150 | Questions + source library | Expected answers with citations |
| **cross-document-intelligence** | 100 | Multi-source input sets | Entity lists, relationships, synthesis |
| **auto-clustering** | 100 | Item sets | Expected cluster assignments |
| **Total** | **850** | | |

### Golden Dataset Pipeline

1. **Collection:** Sample real production inputs. **All inputs must be fully anonymized or replaced with synthetic equivalents before use** — strip PII, user identifiers, and verbatim user content. Never use raw production data directly.
2. **Annotation:** Domain expert labels expected outputs (2 annotators for inter-rater reliability)
3. **Storage:** Golden datasets stored in a private artifact store (e.g., S3 bucket with access controls), **not in the git repository**. A `.gitignored` `fixtures/` directory can hold a local cache pulled during CI. Schema definitions and dataset metadata (counts, feature coverage) may be version-controlled.
4. **Execution:** `@arki/queue` job runs eval suite on: (a) every prompt change, (b) every model upgrade, (c) weekly scheduled regression
5. **Reporting:** Results posted to eval dashboard (Braintrust/Langfuse) with pass/fail per metric
6. **Alerting:** If any metric drops below threshold, block deployment + alert team

### Regression Testing Workflow

```
Prompt change committed
  → CI triggers eval job
  → Golden dataset run (850 cases × 2 judge calls = ~1,700 LLM calls)
  → Results compared to baseline
  → If regression detected: block merge, show diff
  → If improvement or neutral: allow merge, update baseline
  → Total cost per run: ~$1.70 (Lane 1 judge calls at ~$0.001/eval)
  → Total time: ~15 minutes
```

---

## 5. Production Monitoring

### Trace Instrumentation

Every `@arki/ai` provider call is instrumented with:

| Field | Description |
|-------|-------------|
| `traceId` | Unique per user-facing request |
| `feature` | Which feature initiated the call (e.g., `ai-summarization`) |
| `lane` | Which ProviderRouter lane was used |
| `model` | Specific model name and version |
| `tokensIn` / `tokensOut` | Token counts for cost tracking |
| `latencyMs` | End-to-end latency |
| `cached` | Whether result was served from `@arki/kv` cache |
| `quality` | Judge score (if sampled for eval) |

### Dashboards

| Dashboard | Metrics | Audience |
|-----------|---------|----------|
| **Cost dashboard** | Per-feature spend, per-lane utilization, budget burn rate | Engineering, Product |
| **Quality dashboard** | Factuality, citation accuracy, hallucination rate trends | Engineering, QA |
| **Latency dashboard** | P50/P95/P99 per feature, streaming start times | Engineering |
| **User satisfaction** | Click-through rates, feedback scores, retention | Product |

### Alerting Rules

| Alert | Condition | Action |
|-------|-----------|--------|
| Quality regression | Any metric drops >5% below baseline for 24h | Page on-call, pause feature rollout |
| Cost spike | Per-feature daily cost exceeds 2x average | Notify team, investigate query patterns |
| Latency degradation | P95 latency exceeds 5s for interactive features | Auto-failover to fallback model |
| Budget exhaustion | Feature budget >90% consumed | Auto-degrade (see [Cost Model](./COST-MODEL.md)) |
| Provider outage | >5% error rate from any provider for 10min | Auto-switch to fallback provider |

---

## 6. Anti-Hallucination Pipeline

Hallucination is the #1 trust risk for Avocabo. Every claim in copilot answers and synthesis outputs must be verifiable.

### Verification Steps

1. **Citation attachment:** Every claim must include `[source_id]` reference
2. **Source verification:** For each citation, check if the source actually contains supporting text (automated via embedding similarity between claim and cited passage)
3. **Unsupported claim detection:** Claims without citations flagged for LLM-as-judge review
4. **Confidence scoring:** Each claim gets a confidence score (0-1) based on source support strength
5. **User-facing indicators:** Low-confidence claims shown with visual indicator in UI

### Cost: ~$0.002 per verified response (Lane 1 verification calls)

---

## 7. Integration Points

### With `@arki/ai`

- All provider calls auto-instrumented via ProviderRouter middleware
- Trace data sent to eval platform (Braintrust/Langfuse) via async export
- BudgetManager reads quality metrics to adjust routing (poor quality → try higher lane)

### With `@arki/queue`

- `eval:golden-dataset` — weekly regression test execution
- `eval:production-sample` — continuous production quality sampling
- `eval:cost-summary` — daily cost aggregation and alerting
- `eval:quality-report` — weekly quality trend report generation

### With `@arki/kv`

- Real-time token counters per feature/user/lane
- Quality metric caches for dashboard rendering
- Alert state tracking (debounce repeated alerts)

---

## Sources

- Braintrust: <https://www.braintrust.dev/>
- Langfuse: <https://langfuse.com/>
- Arize Phoenix: <https://docs.arize.com/phoenix>
- OpenTelemetry for LLMs: <https://opentelemetry.io/docs/specs/semconv/gen-ai/>
- LLM-as-judge pattern: <https://arxiv.org/abs/2306.05685>
