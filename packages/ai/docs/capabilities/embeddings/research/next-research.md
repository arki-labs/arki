---
name: embeddings-next-research
description: Prioritized roadmap of follow-up research items after the 2026-05-17 state-of-the-art embeddings digest
generated-from-rounds: [01-state-of-the-art]
cutoff: 2026-05-17
last-updated: 2026-05-17
---

# Next Research — Text Embeddings

Items rooted in `research/gaps.md` (`G-NN`), `research/sparks.md` (`S-NN`), and the disconfirming-evidence audit in `research/findings.md`. Each item has an ID `NR-NN`, status, what's unknown, what it blocks, suggested approach, effort, type, and dependencies.

The research-first principle (per `deep-research-digest` skill) applies: when a feature workload commits to embeddings, surface follow-up research even when the spec says "no research needed."

---

## CRITICAL — blocks production decisions

### NR-01 — Romanian / per-language MTEB leaderboard pull

- **Status:** open
- **Rooted in:** G-01 [CRITICAL]
- **What we don't know:** Top-5 embedding models per language for Romanian, Polish, Japanese, Korean, Arabic, Chinese (C-MTEB), French, German, Spanish, Italian
- **Blocks:** Any non-English workload in this workspace — most concretely Romanian Novelette stories, any internationalized search in ekuation, hyphenate, structurize
- **Approach:** Pull MMTEB leaderboard from `huggingface.co/spaces/mteb/leaderboard` with per-language filter; cross-check with C-MTEB (Chinese), MIRACL (multilingual retrieval), XNLI (multilingual NLI), BUCC (cross-lingual sentence retrieval). Where Romanian has no native eval data, document which Romance/Slavic proxy gets used.
- **Type:** desk-research
- **Effort:** small (1–2 days)
- **Depends on:** —
- **Unblocks:** ~3 future per-language workloads

### NR-02 — Neutral vector-DB benchmark (pgvectorscale vs Qdrant vs Milvus at 10M–100M)

- **Status:** open
- **Rooted in:** G-11 [HIGH]; S-04 (pgvectorscale 471 vs 41 QPS claim)
- **What we don't know:** Whether pgvectorscale really beats Qdrant by 11× at 50M @ 99% recall, or whether the Timescale-published number is an artifact of a particular index configuration / workload
- **Blocks:** Vector DB default for 10–100M scale (Persona 2 and Persona 4)
- **Approach:** Extend `erikbern/ann-benchmarks` with payload-filtering + hybrid-query workloads. Run on identical hardware: pgvector, pgvectorscale, Qdrant, Milvus on 10M, 50M, 100M synthetic + 1 real corpus (BEIR-MSMARCO).
- **Type:** engineering-spike
- **Effort:** medium (1 week)
- **Depends on:** NR-04 (need throughput numbers first)
- **Unblocks:** Persona 2 sub-option 2b cost model; Persona 4 architecture default

### NR-03 — Voyage v3↔v4 embedding-space compatibility verification

- **Status:** open
- **Rooted in:** G-14, S-03 (single-source claim from Voyage docs)
- **What we don't know:** Whether `voyage-3-large` corpus embeddings can be queried by `voyage-4-large` queries (or vice versa) without quality loss
- **Blocks:** Confidence in Voyage as a Persona 3 buying criterion based on "no re-embed on upgrade" moat
- **Approach:** Embed 1k docs under both models; check cosine similarity of paired embeddings (should be very high if compatible); run NDCG@10 with query-from-A, corpus-from-B and vice versa; compare to within-model NDCG@10.
- **Type:** engineering-spike (or quick-experiment)
- **Effort:** small (1 day with Voyage API access)
- **Depends on:** Voyage API access
- **Unblocks:** Voyage moat decision; Persona 3 commitment

### NR-04 — Measured tokens/sec on RTX 4090 / A100 / H100 / 8-vCPU CPU for top-8 embedding models

- **Status:** open
- **Rooted in:** G-16, C-07 (CPU throughput 5× spread across LLM sources)
- **What we don't know:** Actual (not extrapolated) throughput for Qwen3-8B, Qwen3-4B, Stella-1.5B, GTE-Qwen2-7B, BGE-M3, mxbai-large, Arctic-Embed-M v2.0, MiniLM-L6 on each hardware tier with sequence length 512, batch size 32, fp16 and int8
- **Blocks:** Tight $/M-token claims (currently 2×–5× uncertainty)
- **Approach:** Run sentence-transformers benchmark suite OR HF TEI benchmark on standardized hardware. Publish single table.
- **Type:** engineering-spike
- **Effort:** medium (1 week including hardware setup)
- **Depends on:** GPU access (RTX 4090, A100, H100 rentals)
- **Unblocks:** All cost-per-token claims; NR-02 (vector DB benchmark also needs throughput baseline)

---

## HIGH — would change strategy

### NR-05 — NVIDIA Llama-Embed-Nemotron-8B license + exact MMTEB

- **Status:** open
- **Rooted in:** G-07, S-18
- **What we don't know:** Whether NVIDIA's "NVIDIA OS license" allows commercial deployment, and the exact MMTEB score
- **Blocks:** Potential Qwen3-8B displacement as Persona 1 default
- **Approach:** Visit NVIDIA HF model card; read license text; pull MMTEB leaderboard entry if listed.
- **Type:** desk-research
- **Effort:** trivial (30 minutes)
- **Depends on:** —
- **Unblocks:** Persona 1 model choice

### NR-06 — Zerank-1 BEIR head-to-head vs Cohere Rerank 3.5 and mxbai-rerank-large-v2

- **Status:** open
- **Rooted in:** S-08 (single-source vendor claim of +18–22% lift at $0.025/M)
- **What we don't know:** Whether Zerank-1's quality really matches Cohere/mxbai (it'd be a category disruptor if true)
- **Blocks:** Persona 3 and Persona 4 reranker default
- **Approach:** Get ZeroEntropy API access; run BEIR subset (NQ, MS-MARCO, HotpotQA) with same dense retriever, compare nDCG@10 across the three rerankers.
- **Type:** quick-experiment
- **Effort:** small (1–2 days)
- **Depends on:** ZeroEntropy API access
- **Unblocks:** Reranker default for cost-sensitive cloud rerank

### NR-07 — Cohere embed-v4 PDF-direct vs OCR→text→embed comparison

- **Status:** open
- **Rooted in:** S-09 (single-source vendor claim)
- **What we don't know:** Whether Cohere v4's visual-feature pathway really outperforms OCR-then-embed for document RAG
- **Blocks:** Document-RAG architecture choice (with-OCR vs without)
- **Approach:** 100-page PDF corpus; embed via (a) Cohere v4 page images, (b) OCR→text→Cohere v4. Run 50 representative queries; compare NDCG@10.
- **Type:** quick-experiment
- **Effort:** small (1–2 days)
- **Depends on:** Cohere v4 API access (image input)
- **Unblocks:** PDF-heavy RAG features (e.g. legal, finance, research-paper search)

### NR-08 — vLLM 0.19+ vs HF TEI throughput on Qwen3-8B

- **Status:** open
- **Rooted in:** S-12, W-10
- **What we don't know:** Whether vLLM's PagedAttention advantage translates to embedding workloads above 1B-param models
- **Blocks:** Default GPU runtime choice for ≥1B-param models
- **Approach:** Same hardware, same model (Qwen3-8B), same batch/seq config — measure throughput and p99 latency for vLLM 0.19+ vs HF TEI 1.5+.
- **Type:** quick-experiment
- **Effort:** small (1 day)
- **Depends on:** NR-04 hardware setup
- **Unblocks:** GPU serving runtime recommendation for frontier OSS models

### NR-09 — Per-model pricing grid for OSS marketplaces

- **Status:** open
- **Rooted in:** G-15
- **What we don't know:** Current per-model pricing on DeepInfra, Together, Fireworks, Replicate, OpenRouter for: BGE-M3, mxbai-embed-large, Qwen3-Embedding-8B, Snowflake Arctic-Embed-L v2.0
- **Blocks:** Hosted-OSS persona slot (a third path between self-host and cloud-vendor API)
- **Approach:** Visit each marketplace pricing page; build comparison table.
- **Type:** desk-research
- **Effort:** trivial (1 hour)
- **Depends on:** —
- **Unblocks:** Cost-conscious recommendations that don't want vendor lock-in

---

## MEDIUM — would refine recommendations

### NR-10 — IBM Granite Embedding 278M independent MTEB on multilingual corpus

- **Status:** open
- **Rooted in:** G-08
- **What we don't know:** Whether IBM Granite Embedding actually delivers competitive multilingual quality at 278M params
- **Blocks:** CPU multilingual baseline choice (Granite vs Arctic-M v2.0 vs BGE-small)
- **Approach:** Pull Granite-278M from HF; run on 1k-query MIRACL slice + BUCC; compare to Arctic-M v2.0 and BGE-M3.
- **Type:** quick-experiment
- **Effort:** small (1 day)

### NR-11 — Gemini-embedding-001 / 2 MTEB-Code

- **Status:** open
- **Rooted in:** G-10
- **What we don't know:** Whether Gemini embeddings work for code retrieval (Google publishes only aggregate MTEB-Multi)
- **Blocks:** Gemini as a code-retrieval default
- **Approach:** Run CodeSearchNet against Gemini API; compare to Voyage `voyage-code-3` and Qwen3-Embedding-8B.
- **Type:** quick-experiment
- **Effort:** small (1 day)

### NR-12 — Sub-processor lists per cloud provider

- **Status:** open
- **Rooted in:** G-19
- **What we don't know:** Each provider's published sub-processor list + notification policy on change
- **Blocks:** Production launch in any GDPR-strict B2B context
- **Approach:** Visit each provider's Trust Center page (`openai.com/trust`, `cohere.com/trust`, `mongodb.com/legal` (Voyage post-acq), `vertex.google.com`, `aws.amazon.com/compliance`, `azure.microsoft.com/compliance`, `mistral.ai`, `jina.ai`, `mixedbread.com`). Capture with access date.
- **Type:** desk-research
- **Effort:** small (3–4 hours)

### NR-13 — Pinecone Serverless realistic cost model

- **Status:** open
- **Rooted in:** G-18
- **What we don't know:** Pinecone Serverless monthly cost under realistic {storage GB, QPS, ingest TPS} scenarios
- **Blocks:** Precise Persona 3 cost statement
- **Approach:** Build spreadsheet using Pinecone's published unit pricing ($0.07/M reads + $0.33/GB stored + writes) across 4 scenario points (1M-5M-20M-100M vectors × low/medium/high QPS).
- **Type:** desk-research
- **Effort:** trivial (2 hours)

### NR-14 — Chroma Cloud at 10M scale latency profile

- **Status:** open
- **Rooted in:** S-25 (single-source unit-pricing claim of $6.60/mo at 10M)
- **What we don't know:** Whether Chroma Cloud actually delivers production-grade latency at 10M scale (Chroma has been positioned as dev-tier)
- **Blocks:** "Default vector DB at prototype scale" recommendation if Chroma can grow into production
- **Approach:** Provision Chroma Cloud at 10M; measure p50/p95/p99 latency at 10 QPS and 100 QPS.
- **Type:** quick-experiment
- **Effort:** small (1 day)

### NR-15 — Turbopuffer p95 cold-query latency at 100M scale

- **Status:** open
- **Rooted in:** S-22, W-27
- **What we don't know:** Whether the object-storage-backed architecture is acceptable for latency-tolerant workloads at 100M+ scale
- **Blocks:** "Large corpus, low-QPS" vector DB choice
- **Approach:** Use Turbopuffer's calculator; provision a 100M test workload; measure p95 cold-query.
- **Type:** quick-experiment
- **Effort:** small (1–2 days)

### NR-16 — Anthropic embedding API release monitoring

- **Status:** open
- **Rooted in:** G-02, W-02
- **What we don't know:** Whether and when Anthropic ships a first-party embedding model
- **Blocks:** Multi-vendor architecture decision (currently forced for Anthropic shops)
- **Approach:** Monitor `anthropic.com/news` monthly; check for embedding model announcement.
- **Type:** monitoring
- **Effort:** ongoing (5 min/mo)

---

## LOW — nice to know

### NR-17 — Voyage AI MTEB v2 official submission (when published)

- **Status:** open
- **Rooted in:** G-03
- **Type:** monitoring (W-18)

### NR-18 — AWS Bedrock Titan v2 MTEB-Code

- **Status:** open
- **Rooted in:** G-04
- **Type:** desk-research

### NR-19 — Mixedbread hosted pricing transparency

- **Status:** open
- **Rooted in:** G-05
- **Type:** monitoring (W-13)

### NR-20 — Jina hosted "no-train" guarantee post-Elastic acquisition

- **Status:** open
- **Rooted in:** G-06, S-02, W-07
- **Type:** desk-research after Elastic acquisition closes

### NR-21 — Confidential-computing H100 throughput penalty (independent benchmark)

- **Status:** open
- **Rooted in:** G-09
- **Type:** monitoring (W-15)

### NR-22 — Long-term self-host operational cost (collect own data)

- **Status:** open
- **Rooted in:** G-12
- **Type:** monitoring during own deployment

### NR-23 — Embedding semantic cache hit-rate at scale

- **Status:** open
- **Rooted in:** G-20
- **Type:** monitoring during own deployment

### NR-24 — Qdrant ACORN / filtered-HNSW confirmation

- **Status:** open
- **Rooted in:** S-10, W-12
- **Type:** desk-research (check Qdrant changelog 2024-2026)

### NR-25 — MoE embedding scaling (Nomic v2 path)

- **Status:** open
- **Rooted in:** W-20
- **Type:** monitoring; quick-experiment if a new MoE entrant appears

---

## Recommended execution order (next 4–6 weeks of research budget)

| Order | Item | Effort | Why first |
|---|---|---|---|
| 1 | NR-05 (Nemotron license) | 30 min | Cheap; could change Persona 1 default |
| 2 | NR-09 (OSS marketplace pricing) | 1 hr | Cheap; opens cost-optimization paths |
| 3 | NR-12 (sub-processor lists) | 3–4 hr | Cheap; required for any B2B EU deployment |
| 4 | NR-13 (Pinecone Serverless model) | 2 hr | Cheap; tightens Persona 3 cost claim |
| 5 | NR-18 (Titan v2 MTEB-Code) | 1–2 hr | Cheap; closes Persona 2 code-workload gap |
| 6 | NR-01 (per-language MTEB) | 1–2 days | CRITICAL for Romanian workloads in this workspace |
| 7 | NR-03 (Voyage v3↔v4 compat) | 1 day | Verifies Voyage moat — affects Persona 3 long-term |
| 8 | NR-06 (Zerank-1 BEIR) | 1–2 days | Verifies a potential category-disruptor reranker |
| 9 | NR-10 (Granite-278M MTEB) | 1 day | Settles CPU multilingual baseline |
| 10 | NR-04 (measured tokens/sec) | 1 week | Foundation for all cost claims; requires GPU rentals |
| 11 | NR-02 (vector DB benchmark) | 1 week | Requires NR-04; settles pgvectorscale claim |
| 12 | NR-07 (Cohere PDF-direct) | 1–2 days | If a document-RAG feature is on the roadmap |
| 13 | NR-08 (vLLM vs TEI) | 1 day | If a self-host GPU deployment is on the roadmap |

Items 14–25 are deferred or monitoring-only; revisit when a kill condition triggers or when a specific feature commits to embeddings.

---

## Update log

- **2026-05-17** — Generated from `/deep-research-digest` round 01 (5-source synthesis: ChatGPT, Claude, GLM, Qwen, Gemini). Created 25 items (NR-01..NR-25). Recommended execution order favors cheap-and-quick desk research first, then engineering spikes that unblock multiple downstream items.
