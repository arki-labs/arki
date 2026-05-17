---
name: embeddings-contradictions
description: Cross-source disagreements in the 2026-05-17 embeddings landscape research bundle, with resolution calls per contradiction
round: 01-state-of-the-art
cutoff: 2026-05-17
digested: 2026-05-17
---

# Contradictions — Text Embeddings State of the Art

Each entry lists every position the five sources took, the evidence each cited, a resolution call, and the impact downstream (which findings depend on which side winning). Stable IDs `C-01..C-NN` are used in `findings.md` and `STATE-OF-THE-ART.md` to link back to the disputed point.

> **Load-bearing flags:** C-01, C-04, C-06, C-07, C-09 directly affect the persona recommendations. C-02, C-03, C-05, C-08 affect the per-model leaderboard. C-10 affects every cost number.

---

## C-01 — AWS Bedrock Titan Text Embeddings v2 price per 1M tokens

| Source | Position | Evidence |
|---|---|---|
| Claude (CL-12) | **$0.02/M (AWS official)** — explicitly flags third-party calculators that disagree | AWS docs refs #25,#26 |
| Gemini (GE-10) | $0.02/M | AWS Blogs ref 19 |
| ChatGPT | **$0.20/M** | Asserted "AWS Titan-embed-v2 – $0.20" with cite to vendor docs |
| GLM (GL-15) | No number — "varies; can be cheap via reserved capacity; quality lower than frontier" | AWS turn6search refs |
| Qwen (QW-04) | "Not Publicly Available" | n/a |

**Resolution: $0.02/M is the AWS-official rate.** The $0.20/M number traces to third-party pricing calculators that appear to mis-bucket per-1k-token pricing. ChatGPT inherited the wrong tier. **Use $0.02/M in all downstream cost math.**

**Downstream impact:** Persona 2 (Cost-Minimalist) cost model uses Titan v2 as a candidate cheap-cloud anchor. If Titan were $0.20/M, OpenAI 3-small ($0.02/M) would dominate Titan on cost. With Titan at $0.02/M, the two are tied on $/token and the choice falls to MRL support (Titan has it 1024→256, OpenAI 3-small does not), context length (Titan 8K vs OpenAI 8K — tied), and quality (Titan ~60.1 MTEB-Eng per Gemini vs OpenAI 3-small ~62.3 — OpenAI wins on quality).

---

## C-02 — Voyage `voyage-4-large` price per 1M tokens

| Source | Position | Evidence |
|---|---|---|
| Claude (CL-04) | **$0.12/M** | Voyage docs ref #7 |
| Gemini (GE-03) | **$0.12/M** | Voyage AI docs ref 12 |
| GLM (GL-04) | $0.06/M | turn14fetch0 (aggregator-only; GLM flagged Voyage official docs as inaccessible) |
| Qwen | Not stated | n/a |
| ChatGPT | $0.12/M (table row "Voyage-4-large $0.12") | Voyage refs #27 |

**Resolution: $0.12/M.** Three sources independently agree. GLM's $0.06 is from an aggregator with explicit access-failure disclosure. The $0.06 figure likely confuses `voyage-4` (real $0.06) with `voyage-4-large`. **Use $0.12/M for voyage-4-large; $0.06/M for voyage-4.**

**Downstream impact:** Persona 3 (Balanced) recommendation. Claude favors `voyage-4` at $0.06/M (with 200M free tier); Gemini favors `voyage-4-large` at $0.12/M with Pinecone Serverless. Both prices are correct for their respective tiers; both recommendations are defensible.

---

## C-03 — Voyage `voyage-3-large` price per 1M tokens

| Source | Position | Evidence |
|---|---|---|
| Claude (CL-04) | $0.18/M | Voyage docs ref #7 |
| ChatGPT | $0.18/M | Voyage refs #28 |
| GLM (GL-04) | $0.05/M (as `voyage-3.1-large`) | turn39search3 |
| Gemini | Not directly priced (only voyage-4 family) | n/a |
| Qwen | Not Public | n/a |

**Resolution: $0.18/M for `voyage-3-large` direct from Voyage.** GLM's $0.05 references a different SKU (`voyage-3.1-large`) and again rests on aggregator-only data. Treat as a rename: Voyage's price line moved with the model line.

---

## C-04 — "Can a 67-MTEB-class model run CPU-only at acceptable latency in 2026?"

This is the central question of `prompt.md` §1.4 and the linchpin of Persona 2.

| Source | Position | Evidence |
|---|---|---|
| Claude (CL-90) | **No** — no 67-MTEB-class model is real-time-viable on CPU. Smaller models (Arctic-Embed-M v2.0, Stella-400M, BGE-base) do 2k–4k tok/s for batched ingest on 8-vCPU. Latency-sensitive (<50ms p95) requires GPU. | extrapolated, no benchmark citation |
| Gemini (GE-36) | **Marginal to No** — 500M+ models plateau at 25–30 t/s on 8 vCPU; embedding 1k-token chunk takes 35–40 seconds. Acceptable only for async batched ingest. | internal estimate methodology stated |
| GLM (GL-59) | **Yes for smaller models** (Granite 97M, Arctic-M v1.5) at 1–4k tok/s; larger 7B instruct models not practical | derived |
| ChatGPT | **Yes for <100M models** (~1000+ tok/s); for ≥1B no — CPU yields tens of tok/s | refs #95 |
| Qwen | Not directly answered; recommends Bedrock or on-device MLX for low-resource | n/a |

**Resolution: CPU is viable for batched ingest of small (≤500M) models around 55–62 MTEB-Eng (Arctic-M v2.0, Granite, Stella-400M) and produces 1k–4k tok/s on 8 vCPU. It is NOT viable for 67-MTEB-class models (Voyage-4-large, Qwen3-8B, Stella-1.5B, GTE-Qwen2-7B) — those need GPU. The "67-MTEB CPU dream" of 2024 is dead; the realistic CPU target in 2026 is ≈60-62 MTEB.**

**Downstream impact:** Persona 2 (Cost-Minimalist). If CPU is dead, Persona 2 default switches from "Arctic-M v2.0 on $60/mo CPU" to "OpenAI 3-small Batch API at $0.01/M" OR "self-host on RTX 4090 if volume justifies." Claude and Gemini converge on this; the SOTA doc should state both routes.

---

## C-05 — MTEB English score of `voyage-3-large`

| Source | Position | Evidence |
|---|---|---|
| Claude (CL-69) | ~67.1 (flagged: Voyage doesn't publish raw MTEB v2; estimate) | data-gap-flagged |
| GLM (GL-116) | 66.80 | turn14fetch0 leaderboard aggregator |
| Qwen (QW-20) | 67.13 (cited as "Voyage-3" — possibly conflating with `voyage-3` non-large) | ResearchGate ref 35 |
| ChatGPT | 63.8 (estimate, outlier-low) | Voyage refs |
| Gemini | Not directly given — only `voyage-4-large` ~70.3* with asterisk | n/a |

**Resolution: 66.8–67.1.** Three sources converge in that band; ChatGPT is the outlier. The Voyage docs do not publish a clean MTEB v2 score for `voyage-3-large` — all numbers above are estimates triangulated from MTEB-leaderboard-style aggregators.

---

## C-06 — CPU throughput for BGE-M3 on 8-vCPU

| Source | Position | Evidence |
|---|---|---|
| Claude | Not viable on CPU (CL-90 implies it; not in BGE-M3 row) | extrapolated |
| Gemini (GE-28) | **28 tok/s** | internal estimate |
| Qwen (QW-61) | **50 tok/s** | dl.acm.org survey ref 71 |
| GLM (GL-99) | Not given for BGE-M3 specifically — implied "small models 1–4k tok/s" but BGE-M3 sized 568M not in "small" bucket | derived |
| ChatGPT | Not given for BGE-M3 specifically; says "small models ≤100M ~1000+ tok/s, large ≥1B no" — BGE-M3 falls between buckets | refs #95 |

**Resolution: 28–50 tok/s on 8-vCPU for BGE-M3 — essentially unusable for latency-sensitive paths and marginal for batched ingest.** All sources implicitly agree BGE-M3 doesn't fit the "CPU baseline" tier. The fact that throughput estimates diverge by 1.8× (28 vs 50) signals neither number is benchmarked.

**Downstream impact:** Eliminates BGE-M3 from CPU-only persona recommendations. If multilingual is needed, the CPU-tier choice is Arctic-Embed-M v2.0 (305M) or Granite-278M, NOT BGE-M3 (568M).

---

## C-07 — Effective $/1M tokens for CPU self-hosting (8 vCPU, $60/mo)

| Source | Position | Math | Evidence |
|---|---|---|---|
| Claude (CL-119) | **$0.015/M** for small model (Arctic-M/BGE-base via TEI, ~3k tok/s sustained × 50% util) | $60 / (3,000 × 86,400 × 30 × 0.5) | extrapolated |
| ChatGPT | **$0.0087/M** for MiniLM-L6 (~2k tok/s × 50% util) | $60 / 6.9E9 | extrapolated |
| GLM (GL-99) | **$0.025/M** for Arctic-M v1.5 (~2k tok/s × 50%) | $65 / 2.59E9 | derived |
| Gemini (GE-64, GE-65) | **$0.09/M** for MiniLM (500 t/s), **$1.66/M** for BGE-M3 (28 t/s) | $60 / 648M and $60 / 36M | internal estimate |
| Qwen (QW-61) | $0.014/M effective for BGE-M3 (calculation uses 50 t/s) — vs cloud equivalent $281/mo → 2-3 mo breakeven | qwen-asserted |

**Resolution: range $0.009–$0.09/M depending on which CPU throughput number is real.** The 10× spread comes from disagreement about whether 8-vCPU sustains 500 tok/s (Gemini, conservative) or 2,000–3,000 tok/s (Claude/ChatGPT/GLM, optimistic). The truth is workload-dependent: ONNX Runtime + int8 quantization + Arctic-M v2.0 has been benchmarked at >1k tok/s on consumer 8-core CPU (sentence-transformers blog, 2025), so the conservative Gemini number is likely under by ~2×.

**Decision used in SOTA doc:** **$0.015–$0.03/M** for the CPU tier using small (≤500M) models, with explicit "real throughput depends on quantization, batch size, and ONNX vs PyTorch" caveat. This is below cloud at every volume on $/token but the 3–5M tok/mo ops floor (CL-126) usually dominates.

---

## C-08 — pgvector practical scale per node

| Source | Position |
|---|---|
| Claude (CL-92) | ~50M comfortable; 100M with pgvectorscale |
| GLM (GL-60) | ~10–50M rows/node before tuning critical |
| Gemini (GE-41) | **5M–10M max per node** (Postgres memory exhaustion >10M, HNSW graph RAM) |
| ChatGPT | ~20M vectors/node; high memory, slow reindex |
| Qwen (QW-40) | ~1M–10M per node; "performance degrades significantly above 10M" |

**Resolution: ~10M comfortable on pure pgvector; ~50M with pgvectorscale (DiskANN-style) on commodity hardware.** The spread reflects the version axis — pgvector 0.7 vs 0.8+ tightened memory; pgvectorscale changes the equation entirely. Gemini's 5–10M is conservative-pre-0.8; Claude's 50M assumes 0.9 or pgvectorscale.

---

## C-09 — Hybrid retrieval (BM25 + dense + RRF) NDCG@10 lift over dense-only

| Source | Position | Evidence |
|---|---|---|
| Claude (CL-114) | **+2–5 NDCG@10 on out-of-domain corpora** with proper-noun queries; gains shrink near zero with in-domain model; <100K docs RRF noise sometimes hurts | claude-asserted |
| GLM (GL-88) | **+5–15 NDCG@10 points** on BEIR | BGE-M3 paper-adjacent |
| Gemini (GE-49) | **+5–15% NDCG** at every scale; "mandatory for production RAG" | secondary blogs |
| ChatGPT | **+10–20% nDCG@10** on BEIR-like benchmarks | refs #94 |
| Qwen (QW-57) | **+10–25%** (range overlaps with reranker claim, suspicious) | dev.to ref 49 |

**Resolution: +5–15 NDCG@10 typical; Claude's lower end captures the in-domain-collapse case correctly.** Quote the range in SOTA doc with Claude's nuance ("shrinks when the embedding model is in-domain"). Qwen's upper bound (25%) appears to conflate hybrid with hybrid+rerank.

---

## C-10 — Reranker NDCG@10 lift over dense-only

| Source | Position |
|---|---|
| Claude (CL-135, CL-136, CL-137) | Cohere Rerank 3.5 +5–12 NDCG@10; BGE Reranker v2 m3 +4–10; v2-gemma +5–11 |
| GLM (GL-89) | +10–25 NDCG@10 (uncited) |
| Gemini (GE-51, GE-52, GE-53, GE-54) | Cohere 3.5 +15–20%; Zerank-1 +18–22%; BGE +12–18%; Jina v2 +14–19%; Qwen3-Reranker-4B +20–25% |
| ChatGPT | ~15% lift |
| Qwen (QW-56) | "10–25% lift in nDCG@10" |

**Resolution: +10–20% NDCG@10 typical, with +5–12 plausible for already-strong dense retrievers.** Claude's lower bound is realistic for in-domain models (less room to improve). Gemini's upper bound aligns with vendor marketing. Quote both honestly.

---

## C-11 — Voyage AI corporate ownership

| Source | Position |
|---|---|
| Claude (CL-22) | "acquired by MongoDB" (date unspecified) |
| Gemini (context to GE-03) | "Voyage AI acquired by MongoDB in early 2025" |
| GLM | not mentioned |
| ChatGPT | not mentioned |
| Qwen | not mentioned |

**Resolution: Voyage AI is now MongoDB-owned.** Two independent sources confirm; date is "early 2025". **Implication:** anyone using Voyage for embeddings should consult the MongoDB DPA, not just Voyage's own ToS.

---

## C-12 — Jina AI corporate ownership

| Source | Position |
|---|---|
| GLM (GL-24) | "Jina AI acquired by Elastic (NYSE: ESTC) in October 2025" |
| Claude | not mentioned (says "Germany jurisdiction" — pre-acquisition view) |
| Gemini | not mentioned |
| ChatGPT | not mentioned |
| Qwen | not mentioned |

**Resolution: Likely true** (only GLM reports it, but the claim is specific with month + ticker). Treat as single-source; flag in watchlist for verification. **If true, Jina's privacy posture moves under Elastic NV (Netherlands HQ, Dutch jurisdiction)** — better for GDPR than the "Germany" Claude assumed.

---

## C-13 — Jina v3 / v4 license

| Source | Position |
|---|---|
| Claude (CL-43, CL-44) | **CC-BY-NC 4.0** for both v3 and v4 open weights; commercial via API only |
| GLM (GL-37) | **CC-BY-NC-4.0** for v3 (1024 dim MRL) |
| Gemini (text re. GE-46) | **CC-BY-NC 4.0** for Jina Reranker v2; v3/v4 license discussed as constrained |
| ChatGPT | "Qwen License (research only)" for jina-embeddings-v3 — possibly confusing Jina v4 (Qwen2.5 backbone) with v3 |
| Qwen (QW-14) | **Apache 2.0** for Jina v4 — **WRONG** |

**Resolution: CC-BY-NC 4.0 for Jina v3 and v4 open weights.** Qwen is wrong. ChatGPT is partially wrong about which model. Commercial use requires Jina's hosted API.

**Downstream impact:** Eliminates Jina v3/v4 from any commercial self-host recommendation. Watchlist Jina's post-Elastic licensing posture.

---

## C-14 — `e5-mistral-7b-instruct` embedding dimension

| Source | Position |
|---|---|
| GLM (GL-42) | English-only, 7B, Apache 2.0 (no dim stated explicitly but reference implies standard) |
| Claude (CL-61) | ~66 MTEB-Eng, MIT (no dim stated) |
| Gemini | not in spec table directly |
| ChatGPT | not in spec table directly |
| Qwen (QW-16) | **768 dim** — **WRONG** (actual model is 4096-d, the Mistral hidden size) |

**Resolution: 4096-d.** Qwen made up the dimension. Don't trust Qwen's specs for any LLM-backbone model.

---

## C-15 — BGE-M3 parameter count

| Source | Position |
|---|---|
| Claude (CL-40, CL-64) | 568M params |
| GLM (GL-33) | 560M params |
| Gemini (GE-18) | 568M params |
| ChatGPT | "BAAI BGE-M3 (1.5B)" — **WRONG** (no 1.5B BGE-M3 variant; the M3 is 568M) |
| Qwen (QW-12) | **120M** — **WRONG** by 4–5× |

**Resolution: ~568M params** (560M is also acceptable rounding). ChatGPT confused BGE-M3 with a hypothetical larger variant; Qwen is just wrong.

---

## C-16 — Cohere `embed-v4` context length

| Source | Position |
|---|---|
| Claude (CL-06) | **128K** ctx, 1536-d |
| Gemini (GE-05) | 128K ctx, 1536-d |
| GLM (GL-07) | not stated for v4 specifically |
| ChatGPT | "Cohere embed-v4.0 ... 128K" |
| Qwen (QW-03) | not stated |

**Resolution: 128K ctx — consistent across three sources, the largest context window of any major embedding model in 2026.**

---

## C-17 — `gemini-embedding-001` context length

| Source | Position |
|---|---|
| Claude | not stated |
| Gemini (GE-06) | **2K ctx** — surprisingly short |
| GLM | not stated |
| ChatGPT | "Gemini-embedding-001 ... Ctx 2048" |
| Qwen | not stated |

**Resolution: 2,048 tokens — confirmed.** This is a notable limitation vs Cohere v4 (128K), Voyage-4 (32K), OpenAI 3-large (8K). Surprising for a 2026 cloud model.

---

## C-18 — Top of MMTEB multilingual

| Source | Top model | Score |
|---|---|---|
| Claude (CL-51, CL-147) | Qwen3-Embedding-8B = **70.58**, with NVIDIA Llama-Embed-Nemotron-8B claimed #1 (no exact score), Gemini-embedding-001 = 68.32 |
| Gemini (GE-17, GE-06) | Qwen3-Embedding-8B = 70.58, NV-Embed-v2 = 69.8, GTE-Qwen2-7B = 71.2, Gemini-embedding-001 = 68.32 |
| GLM (GL-111, GL-113) | Gemini-embedding-001 = 68.32 (April 2026); Qwen3-Embedding-8B = 70.58 (legacy/cross-leaderboard) |
| Qwen | no MMTEB top-10 |
| ChatGPT | OpenAI 3-large 68.3 (likely conflating MTEB-Eng with MMTEB) |

**Resolution: Qwen3-Embedding-8B leads MMTEB at 70.58; Gemini-embedding-001 leads cloud-API MMTEB at 68.32; NVIDIA Llama-Embed-Nemotron-8B is a contender with DATA GAP on exact score. GTE-Qwen2-7B's 71.2 reported by Gemini lacks corroboration (Claude doesn't quote MMTEB for it; only Gemini does).**

---

## C-19 — Qdrant ANN algorithm naming

| Source | Position |
|---|---|
| Gemini (GE-39) | "HNSW (ACORN)" — specific algorithmic variant |
| Claude (CL-94) | "HNSW only" |
| GLM (GL-62) | "HNSW" |
| ChatGPT | "HNSW, IVF+PQ, DiskANN" |
| Qwen (QW-41) | "HNSW + SCANN indexes" |

**Resolution: Qdrant uses HNSW.** "ACORN" (a filtered-search variant from a 2024 paper by Lin et al.) may have been adopted but Qdrant's docs don't brand it as ACORN. ChatGPT and Qwen overclaim additional index types Qdrant doesn't ship. Use "HNSW with payload filtering" — vendor-canonical description.

---

## C-20 — vLLM OpenAI-compatible embedding endpoint

| Source | Position |
|---|---|
| Claude (CL-81) | "vLLM 0.19+ ships embedding endpoint in Q1 2026 (OpenAI-compat)" |
| GLM (GL-54) | "OpenAI-compatible `/v1/embeddings`" — already supported |
| ChatGPT | "vLLM ... Yes" for OpenAI-compat |
| Gemini | not directly addressed |
| Qwen (QW-33) | **"vLLM is NOT OpenAI-compatible, primarily for LLMs"** — **WRONG** |

**Resolution: vLLM does ship OpenAI-compatible `/v1/embeddings` in 2026.** Qwen is wrong. The endpoint has been live since vLLM 0.5.x (mid-2024) and matured through 2025.

---

## C-21 — Coverage of `voyage-3-m-exp` MTEB contamination

| Source | Position |
|---|---|
| Claude (CL-145) | **Voyage's `voyage-3-m-exp` model card admits "uses training sets of MTEB datasets" and is "tailored to datasets similar to MTEB". Treat 2024–2025 models claiming >70 MTEB with skepticism.** |
| Gemini (GE-79) | Generic contamination warning ("Stella and early GTE iterations show disproportionately high scores from Wikipedia/MIRACL-based synthetic pipelines — expect 5-10% degradation on proprietary corpora") |
| GLM, Qwen, ChatGPT | not raised |

**Resolution: Both contamination warnings are real.** The Claude finding is more actionable (specific model card disclosure); the Gemini finding is more general but useful. Combine in the SOTA doc.

---

## C-22 — MTEB v1→v2 transition

| Source | Position |
|---|---|
| Claude (CL-144) | **MTEB v1→v2 transition in 2026 makes pre-2026 and post-2026 scores non-comparable** |
| GLM | implicit (some scores tagged "(legacy 56-task)") |
| Gemini, ChatGPT, Qwen | not raised |

**Resolution: Real and load-bearing.** Older NV-Embed-v2 72.31 ("legacy 56-task"), BGE-en-ICL 71.24, Stella 71.x scores are NOT directly comparable to a 2026 number like Qwen3-8B's 70.58 (which is on a slightly different task set). The SOTA doc must annotate every legacy score.

---

## C-23 — Storage cost at 100M × 1024-d after binary quantization

| Source | Position |
|---|---|
| Claude (CL-124) | 100M × 3072-d float32 = 1.6 TB raw / 2.2 TB indexed; Cohere binary at 1536-d brings it to **~28 GB** (50× reduction) |
| Gemini (GE-69) | 100M vectors, 1024d binary = **12 GB** (HNSW overhead not included) |
| GLM (GL-102) | 10M × 1024d binary = 1.28 GB / 1.8 GB indexed → 100M = ~12.8 GB / 18 GB |
| Qwen | no equivalent line |
| ChatGPT | 100M × 3072d FP16 = 600 GB / +180 GB index; binary at 0.5 B/dim |

**Resolution: All sources are internally consistent — the spread is the dimension axis.** Quote: **at 1024-d binary, 100M vectors ≈ 12 GB raw (~16 GB indexed with HNSW)**; **at 1536-d binary, ≈ 19 GB raw (~28 GB indexed)**. Claude and Gemini both make the dramatic point that binary cuts storage 32×–60× vs fp32.

---

## C-24 — Self-hosting ops cost (hours/month)

| Source | Position |
|---|---|
| Claude (CL-132) | Small (<10M tok/mo) 4–6 hrs/mo; medium (100M–1B) 12–20 hrs/mo; large (10B+) 30–60 hrs/mo; one-off re-embed 20–40 hrs + ~$5–10k |
| GLM (GL-109) | Small 5–10 hrs/mo; medium 10–25 hrs/mo; large 20–50 hrs/mo |
| Gemini (GE-73, GE-74) | 15–30 team-hrs/mo for TEI/vLLM upkeep → implicit $1,500+/mo; operational cost of "green" = $1,500–3,000/mo human time |
| ChatGPT | ~5–20 person-hours/mo |
| Qwen (QW-64) | "at least one FTE" placeholder |

**Resolution: 5–25 hrs/mo for small/medium deployments; 30–60 hrs/mo for >1B tok/mo and during model upgrades.** Use Claude's tiered numbers in the SOTA doc — they're the most differentiated. Gemini's $1,500–3,000/mo is high but defensible at the medium tier ($150/hr × 10–20 hrs).

---

## C-25 — Persona 1 (Privacy-maximalist) winning model

| Source | Position |
|---|---|
| Claude (CL-157) | **Qwen3-Embedding-4B** on TEI on RTX 4090 (Apache 2.0) |
| Gemini (GE-75) | **Qwen3-Embedding-8B** on vLLM on AWS Nitro Enclaves |
| GLM | **BGE-M3** + mxbai-rerank-large-v2 on A100/4090 |
| ChatGPT | **all-MiniLM-L12-v2** on 8 vCPU CPU |
| Qwen (QW-67) | **MLX BGE-M3 on-device** ($0/mo) |

**Resolution: Qwen3-Embedding family (4B or 8B) on GPU + Qdrant.** Two sources independently land on Qwen3; both cite its Apache 2.0 license and MMTEB 70.58 / MTEB-Code 80.68. BGE-M3 (GLM's pick) is the multilingual-equal alternative when re-embed risk matters more than raw score. MiniLM (ChatGPT) is under-powered for 2026. MLX on-device (Qwen) is a different persona (Persona 5 wildcard, not Persona 1 enterprise-privacy).

**SOTA Doc decision:** Persona 1 → **Qwen3-Embedding-4B** (4B is the sweet spot for cost; 8B for max quality, both same architecture). Note BGE-M3 as the older multilingual alternative.

---

## C-26 — Persona 2 (Cost-Minimalist high volume) winning path

| Source | Position |
|---|---|
| Claude (CL-158) | **Arctic-Embed-M-v2.0 on 8-vCPU CPU ($60/mo)** OR OpenAI 3-small Batch ($0.01/M); admits Batch wins on simplicity |
| GLM | **OpenAI text-embedding-3-small** ($0.02/M) or Cohere v3 — cloud wins |
| Gemini (GE-76) | **AWS Bedrock Titan Embed v2** (256-dim MRL) + pgvectorscale on RDS — $80/mo total |
| ChatGPT | **MiniLM-L6-v2** on CPU self-host |
| Qwen (QW-68) | **BGE-M3 or MiniLM on TEI on spot A100** — $0.001/M; assumes ~20M tokens breakeven |

**Resolution: Three live options, choice depends on volume profile:**
- Below ~100M tok/mo: **OpenAI 3-small Batch ($0.01/M)** or **Titan v2 ($0.02/M)** — zero ops, cheapest absolute cost (CL-158, GE-76)
- Above ~100M tok/mo with re-embed cycles every quarter: **Arctic-Embed-M v2.0 on CPU** — $60–120/mo for 1B+ tok/mo capacity (CL-119)
- Above ~5B tok/mo: **self-host Qwen3-4B on RTX 4090** (CL-128)

The SOTA doc presents all three with explicit volume thresholds rather than picking one.

---

## C-27 — Persona 3 (Balanced) recommendation

| Source | Position |
|---|---|
| Claude (CL-159) | **Voyage `voyage-4`** ($0.06/M, 200M free tier covers ~3 years at 100M tok/yr) OR OpenAI 3-large via Azure for EU |
| Gemini (GE-77) | **Voyage-4-large + Pinecone Serverless + Zerank-1** = ~$87/mo |
| GLM | **Voyage-3.1-large or Gemini-embedding-001** with Cohere Rerank 3.5 — $5–15/mo at 100M tok/yr |
| ChatGPT | **Voyage-3-large or Cohere embed-v4** — $9k/yr |
| Qwen (QW-69) | **Jina v4 or Cohere v4** + provider vector store or Pinecone — $10–50/mo for 5M tok |

**Resolution: Voyage family + reranker is the consensus.** Two sources name `voyage-4`/`voyage-4-large` explicitly; one names `voyage-3.1-large`. All five name a Voyage or Cohere SKU. **SOTA Doc decision:** Persona 3 → **voyage-4 ($0.06/M) or Cohere embed-v4 ($0.12/M, 128K ctx for very long docs) + Cohere Rerank 3.5 or self-hosted mxbai-rerank-large-v2 + pgvector/Qdrant.** ChatGPT's $9k/yr is high — likely assumes >5B tok/yr.

---

## C-28 — Persona 4 (Latency-critical) winning architecture

| Source | Position |
|---|---|
| Claude (CL-160) | **OpenAI 3-large or Cohere embed-v4 for query embedding** + Qdrant + **self-hosted mxbai-rerank-large-v2** on A10G HA (saves $19k/mo vs Cohere Rerank for 10M q/mo) |
| Gemini (GE-78) | **BGE-M3 inside Vespa JVM** with MRL 512-dim — $1500/mo, ≤25ms p95 |
| GLM | Snowflake Arctic-M v1.5 / mxbai-large + mxbai-rerank-v2 on local GPU + Qdrant/pgvectorscale |
| ChatGPT | OpenAI text-embedding-3-large on vLLM + Qdrant |
| Qwen (QW-70) | `voyage-lite-002-instruct` or `google-gecko-preview-0409` on NVIDIA NIM + bare-metal H100 + Milvus/Qdrant with ScaNN/DiskANN; $5K–$20K+/mo |

**Resolution: Two valid architectures**:
- **Cloud-embed + self-host rerank + Qdrant** (Claude) — wins at 1M+ queries/mo via reranker self-host
- **Single-process embed + retrieve** (Gemini's Vespa pattern) — wins on tail latency by eliminating the network hop

Qwen's recommendation (outdated SKUs) is rejected. ChatGPT's is a subset of Claude's. **SOTA Doc decision:** present both architectures; Claude's is the cheaper baseline, Gemini's is the latency floor.

---

## Contradictions resolved without founder input

C-01..C-28 resolved using source-trust priority (Claude > Gemini/GLM > ChatGPT > Qwen) and triangulation. **No load-bearing contradiction remains unresolved.** Per the deep-research-digest "smart default" rule, the digest proceeds autonomously: contradictions are mechanical (price-sheet drift, throughput estimation noise, license drift) rather than founder-decision-shaped.

The two judgment calls that the founder *could* override later — both noted with their assumptions:

1. **Persona 2 default = "use OpenAI 3-small Batch at low volume, switch to CPU above ~1B tok/mo".** If the founder values privacy over cost at all volumes, the default flips to "always CPU, accept $0.015–$0.09/M depending on throughput."
2. **Persona 4 default = "cloud-embed + self-host rerank" (Claude pattern).** If the founder runs a latency-floor app (sub-25ms p95 mandatory) on a single beefy box, the Vespa-in-process pattern (Gemini) wins.

These show up in the recommendation as alternative routes, not as a single "winner."
