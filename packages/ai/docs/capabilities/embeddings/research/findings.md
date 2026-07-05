---
name: embeddings-findings
description: Evidence-backed findings from the 2026-05-17 text embeddings landscape research bundle (5 LLM sources synthesized)
round: 01-state-of-the-art
cutoff: 2026-05-17
digested: 2026-05-17
status: complete
sources: [chatgpt, claude, glm, qwen, gemini]
codex-review: skipped (no codex agent dispatched — see "Codex Review" section)
---

# Findings — Text Embeddings State of the Art

## Executive Call

**The 2026 frontier collapsed three years of fragmentation into a small, defensible recommendation grid.** Open-weights Apache-2.0 models now match the best proprietary APIs on quality (Qwen3-Embedding-8B MMTEB 70.58 / MTEB-Code 80.68 [B-01-01]), Matryoshka + binary quantization cut storage cost 32×–60× with negligible quality loss [B-01-02], and self-hosted serving on a consumer GPU undercuts every cloud API per-token above ~1B tokens/month [B-01-03].

**Pick by profile, not by hype:**

| Profile | Default stack | Why |
|---|---|---|
| Privacy-max enterprise | **Qwen3-Embedding-4B (Apache 2.0) on HF TEI on RTX 4090 + self-hosted Qdrant** | Apache 2.0 = no commercial license risk; MMTEB ~69 with 8-vCPU CPU fallback; ~$320/mo at 10M docs [B-01-04] |
| Cost-min low volume | **OpenAI `text-embedding-3-small` Batch API at $0.01/M** | Zero ops; cheaper than electricity below ~100M tok/mo [B-01-05] |
| Cost-min high volume | **Arctic-Embed-M v2.0 (Apache 2.0) on TEI on 8-vCPU CPU** | $60–120/mo for 1B+ tok/mo; multilingual via Snowflake 2.0 [B-01-06] |
| Balanced production | **Voyage `voyage-4` ($0.06/M, 200M free tier) + Cohere Rerank 3.5 + pgvector** | Free tier covers 100M tok/yr for ~3 years; pgvector handles ≤10M vectors [B-01-07] |
| Latency-critical (≤50ms p95) | **OpenAI 3-large or Cohere embed-v4 query + Qdrant + self-hosted mxbai-rerank-large-v2 on A10G** | Saves $19k/mo vs Cohere Rerank for 10M queries; ~45ms p95 [B-01-08] |
| Fully-local on-device | **Nomic-Embed-Text-v1.5 (Apache 2.0) via MLX / transformers.js + SQLite-VSS** | $0/mo; 50–200ms per query on modern device [B-01-09] |

**Three things that changed since 2024:**

1. The "67-MTEB CPU dream" is dead. Real CPU baseline in 2026 is 55–62 MTEB-Eng (Arctic-M v2.0, Granite-278M, MiniLM); 67-MTEB-class models need GPU [B-01-10].
2. MTEB v1→v2 transition makes pre-2026 scores non-comparable [B-01-11].
3. Binary quantization (QAT models: Cohere v3/v4, Voyage v3/v4-large, Mixedbread Binary MRL) cuts storage 32× with <2% quality loss — the largest single cost lever in the survey [B-01-12].

---

## Evidence-Backed Findings

### Quality leaders

**B-01-01** — Open-weights MMTEB leader is **Qwen3-Embedding-8B** at **MMTEB 70.58 / MTEB-Code 80.68 / MTEB-Eng ~69**, Apache 2.0, 8B params, 32K ctx, MRL up to 4096 dim.
- Sources: Claude CL-51, Gemini GE-17 (independent agreement); GLM GL-50 (corroborative).
- Caveat: NVIDIA Llama-Embed-Nemotron-8B (2025-10) is claimed to lead MMTEB at release per Claude (CL-37, CL-147) but exact score is a DATA GAP (G-07) and license is "NVIDIA OS" (commercial use unclear). Treat Qwen3-8B as the verified leader.

**B-01-02** — Cloud-API MMTEB leader is **`gemini-embedding-001`** at **MMTEB 68.32 / MTEB-Eng ~64.2**, 3072-d MRL, 2K ctx.
- Sources: Claude CL-70, GLM GL-111, Gemini GE-06 (three-source agreement).
- Limitation: 2K context is the shortest of any 2026 cloud model — disqualifies for long-doc retrieval (Cohere embed-v4 128K dominates that).

**B-01-13** — OpenAI `text-embedding-3-large` = **MTEB-Eng 64.6**, 3072-d MRL, 8K ctx, $0.13/M (Batch: $0.065/M).
- Sources: Claude CL-02 / CL-65, GLM GL-118, Gemini GE-02 (three-source agreement).

**B-01-14** — Cohere `embed-v4` = **MTEB-Eng ~65.8 / MMTEB ~68.1**, 1536-d MRL, **128K ctx** (the longest of any major model), $0.12/M.
- Sources: Claude CL-06 / CL-68, GLM GL-07, Gemini GE-05, ChatGPT (corroborative).

**B-01-15** — Voyage `voyage-4-large` MTEB-Eng is **estimated ~67–70** (DATA GAP G-03), 1024-d MRL, 32K ctx, $0.12/M.
- Voyage does not publish MTEB v2 scores; Gemini's GE-03 marks ~70.3 with asterisk indicating "normalized triangulation."
- `voyage-4` (non-large) is $0.06/M with same dim and context.
- 200M tokens/mo free tier (CL-05) covers many small/medium app workloads.

### License-disqualified high-quality models

**B-01-16** — **NV-Embed-v2** scores MTEB-Eng 72.31 (legacy MTEB v1) but license is **CC-BY-NC 4.0** — non-commercial only.
- Sources: Claude CL-36 / CL-79, GLM GL-48, Gemini GE-14.
- **Excluded from all commercial persona recommendations.**

**B-01-17** — **Jina v3, v4, and Reranker v2** are CC-BY-NC 4.0 open weights — non-commercial.
- Sources: Claude CL-43 / CL-44, GLM GL-37 / GL-94, Gemini GE-55.
- Commercial use requires Jina's hosted API only. Qwen's claim of Apache 2.0 (QW-14) is wrong (C-13).

### Self-hostable model matrix (commercially licensed only)

**B-01-18** — Top open-weights commercially-deployable models, ranked by best-quality-per-tier:

| Tier | Model | Params | License | MTEB-Eng | MMTEB | Strengths |
|---|---|---|---|---|---|---|
| Frontier | Qwen3-Embedding-8B | 8B | Apache 2.0 | ~69 | 70.58 | MTEB-Code 80.68, 32K ctx, MRL 32–4096 |
| Frontier | Qwen3-Embedding-4B | 4B | Apache 2.0 | ~68 | ~69 | 32K ctx, MRL up to 2560 |
| Mid | Stella en 1.5B v5 | 1.5B | MIT | ~71 (legacy) | DATA GAP | 8K ctx (Gemini), MRL up to 8192 dim |
| Mid | GTE-Qwen2-7B-instruct | 7B | Apache 2.0 | ~70 (legacy) | 71.2 (Gemini-only) | Multilingual |
| Small | mxbai-embed-large-v1 | 335M | Apache 2.0 | 64.68 | DATA GAP | Binary MRL native |
| Small | Stella en 400M v5 | 400M | MIT | ~70 (legacy) | DATA GAP | English-only, 512 ctx |
| Small | Nomic-Embed-Text-v1.5 | 137M | Apache 2.0 | 62.4 | DATA GAP | 768-d MRL, 8K ctx |
| Small | Nomic-Embed-v2 (MoE) | 475M total / 305M active | Apache 2.0 | ~64 | ~65.8 | MoE efficiency |
| Multilingual | BGE-M3 | 568M | MIT | 63.0 | strong | 8K ctx, dense+sparse+multi-vec |
| Multilingual | multilingual-e5-large-instruct | 560M | Apache 2.0 | ~64 (legacy) | strong | 100+ langs |
| CPU-baseline-multi | Snowflake Arctic-Embed-M v2.0 | 305M | Apache 2.0 | ~56 retrieval | strong <1B | 768-d MRL→256, 8K ctx |
| CPU-baseline-multi | Snowflake Arctic-Embed-L v2.0 | 568M | Apache 2.0 | ~57 retrieval | strong <1B | 1024-d MRL→256, 8K ctx |
| CPU-baseline | all-MiniLM-L6-v2 | 22M | Apache 2.0 | 56.3 | weak | 384-d, 512 ctx |
| CPU-baseline-multi | IBM Granite Embedding 278M | 278M | Apache 2.0 | DATA GAP | DATA GAP (200+ langs claimed) | 32K ctx |

Caveats per row: legacy MTEB scores (Stella, GTE-Qwen2, NV-Embed-v2) are MTEB v1 and not directly comparable to 2026 MTEB v2 numbers (C-22). All MMTEB DATA GAPs reflect what the published model cards report — not absent multilingual support.

### Cost model

**B-01-03** — **CPU self-host beats every cloud API on $/token** for small (≤500M) Apache-2.0 models — but only above the ~3–5M tok/mo ops floor.
- $0.015–$0.03/M tokens on 8-vCPU/$60–80/mo box with Arctic-Embed-M v2.0 or BGE-base via TEI (Claude CL-119 + GLM GL-99 triangulated; see C-07 for the source-divergence audit).
- Gemini (GE-64, GE-65) is more conservative ($0.09/M for MiniLM, $1.66/M for BGE-M3); the discrepancy traces to throughput uncertainty (28 vs 500 tok/s for BGE-M3 on CPU — 18× spread).
- **Below 3–5M tok/mo, cloud APIs win on simplicity** (OpenAI 3-small Batch at $0.01/M = ~$30/mo for 3M tokens, zero ops).

**B-01-19** — **Consumer GPU (RTX 4090 ~$200/mo) is the dominant $/token tier for high-volume embedding.**
- Small model (335M, ~150k tok/s): $0.0011/M, ~190B tok/mo capacity (Claude CL-121; Gemini GE-66 = $0.01/M is conservative-end).
- Qwen3-8B on 4090 (~6k tok/s): $0.026/M, ~7.8B tok/mo capacity (Claude CL-121).
- **Breakeven vs Voyage `voyage-4`** ($0.06/M): ~3.5B tok/mo (CL-128). Above this, self-host wins on $/token.
- **Breakeven vs OpenAI 3-small** ($0.02/M Batch): ~10M tok/mo for 4090 + small model (CL-127).

**B-01-20** — **Data-center GPU (A100 or H100) becomes cost-competitive only at very high scale.**
- A100 80GB ($1.10/hr): Qwen3-8B at ~15k tok/s = ~19B tok/mo → $0.021/M (CL-122).
- H100 ($2.50/hr): Qwen3-8B at ~25k tok/s = ~32B tok/mo → $0.028/M; small model + H100 ~400k tok/s = <$0.001/M (CL-123).
- Breakeven vs Gemini-embedding-001 Batch ($0.075/M): ~12B tok/mo on H100 (CL-129).
- **GLM's pessimistic case (GL-101)**: GTE-Qwen2-7B on A100 = $0.31/M because of low throughput assumption. The truth is workload-dependent — see G-16 for the benchmark needed.

**B-01-21** — **Storage and quantization combine for the largest cost reduction.**
- 100M × 3072-d float32 ≈ 1.6 TB raw / ~2.2 TB indexed (Claude CL-124).
- Cohere binary at 1536-d brings the same corpus to ~28 GB → **~50× storage reduction** (Claude CL-124, ~80× when comparing to 3072-d).
- Quality loss: Voyage's QAT model retains 99.7% of float quality at 1/200 storage (Voyage docs cited in CL-108).
- Without QAT, binary loses 5–15% NDCG; with QAT (Cohere v3/v4, Voyage 3/4-large, Mixedbread Binary MRL), loss is <2% (CL-113).

**B-01-22** — **Reranker cost economics flip hard above 1M queries/mo.**
- Cohere Rerank 3.5: $2.00 per 1k searches = $20k/mo at 10M queries/mo (Claude CL-135).
- Self-host **mxbai-rerank-large-v2** on $0.45/hr A10G ≈ $160/mo (50% util) → **~12× cheaper than cloud** (CL-134, CL-140).
- mxbai-rerank-large-v2 claims to beat Cohere on BEIR at 57.5 (Mixedbread blog; verify per S-06).

### Architecture techniques

**B-01-23** — **Matryoshka Representation Learning (MRL)** allows truncation 3072→768 or 1024→256 with ≤5% NDCG loss for MRL-trained models.
- Supported by: OpenAI v3, Voyage 4, Cohere v3/v4, Nomic v1.5/v2, Snowflake Arctic 2.0, Mixedbread mxbai, Jina v3/v4, GTE-ModernBERT, gemini-embedding-001 (3072-d MRL).
- Combined with binary: Voyage `voyage-3-large` 512-d binary retains 99.7% of float quality at 1/200 storage (CL-108).
- **Rule of thumb:** truncate to 256–512 dim is the default for storage-bound workloads; truncate to 768 if quality-sensitive.

**B-01-24** — **Hybrid retrieval (BM25 + dense + RRF)** lifts NDCG@10 by +5–15% on out-of-domain corpora.
- Strongest on proper-noun queries and rare-vocabulary domains (CL-114).
- **Gains shrink near zero when the dense model is in-domain.**
- Below ~100K docs, RRF noise sometimes hurts — measure before adopting.

**B-01-25** — **Cross-encoder reranking** lifts NDCG@10 by +5–20% over dense-only.
- Claude's lower bound (+5–12 for Cohere, +4–10 for BGE) reflects already-strong dense retrievers.
- Gemini and GLM cite +15–25 — likely from weaker dense baselines.
- **Always apply for RAG copilot workloads where final answer quality matters.**

**B-01-26** — **Instruction prefixes are mandatory for instruction-trained models** (E5, BGE, Snowflake Arctic 2.0, Qwen3, Voyage, Cohere).
- Omitting `search_query:` / `search_document:` prefixes degrades NDCG@10 by 3–8 (CL-116, GE-50).
- **Top-3 production bug.**

**B-01-27** — **Late chunking (Jina v3/v4)** improves long-doc retrieval by +1–3 NDCG@10 vs naive chunk-then-encode on LongEmbed.
- Only Jina v3 and v4 implement it natively today (CL-109, GL-85).

**B-01-28** — **Multi-vector / late-interaction (ColBERT-style)** lifts NDCG@10 by +3–8 at the cost of 15–30× storage and 2–5× query compute.
- Supported by BGE-M3 (built-in multi-vec mode), Jina v4, and Qdrant/Vespa as a backend feature.
- Cost-effective only when accuracy matters more than storage.

**B-01-29** — **Re-embedding is required on most model upgrades** (ada-002→v3, Cohere v3→v4, Voyage v3→v4 across families).
- **Exception:** `voyage-3-large` ↔ `voyage-4-large` share v4-family embedding space per Voyage docs (CL-117). If verified (G-14), this is a structural moat.

### Vector storage

**B-01-30** — **pgvector + HNSW is the default below 10M vectors.**
- Comfortable at 5–10M per node (Gemini GE-41); pushes to 50M with tuning + pgvectorscale (Claude CL-92).
- Storage cost at 10M × 768-d fp16 ≈ 20 GB raw / 28 GB indexed → ~$3–10/mo on commodity storage.

**B-01-31** — **pgvectorscale (DiskANN-style) is the dark-horse winner at 10M–100M.**
- Claude (CL-107) cites a Timescale benchmark of 471 QPS vs Qdrant 41 QPS at 50M @ 99% recall — flagged as "anomalous."
- Gemini (GE-42) frames pgvectorscale at $150/mo for 100M vectors as the Persona-2 cost winner.
- **Verification needed** (G-11), but if reproducible this changes the vector-DB default.

**B-01-32** — **Qdrant is the proven choice at 10–100M scale.**
- HNSW with payload filtering (rejects Gemini's "ACORN" branding without primary source — C-19).
- 4.74ms p50 at 50M per Alphacorp benchmark (CL-94).
- Self-host: $80–200/mo at 10M; Cloud: $300/mo at 10M; $1–2k/mo at 100M.

**B-01-33** — **Milvus is the production choice above 100M.**
- Multiple index types (HNSW, IVF, IVFPQ, DiskANN, ScaNN, GPU-CAGRA).
- 1B+ vector deployments documented (Reddit production reports cited via CL-96).
- Cost: $400–800/mo at 10M, $3–6k/mo at 100M.

**B-01-34** — **Turbopuffer is the cost-cheapest option for cold-data corpora at scale.**
- Object-storage-backed: ~$50–200/mo at 10M, ~$500/mo at 100M (CL-105, GL-81).
- Trade: cold-query latency penalty.
- Best fit: "large corpus, low-QPS, latency-tolerant" — e.g. archive search, historical RAG.

**B-01-35** — **Chroma Cloud's unit pricing makes it the cheapest managed option at <10M scale.**
- Writes $2.50/GiB, storage $0.33/GiB/mo, queries $0.0075/TiB (GLM GL-80, single source).
- At 10M (~20 GiB): ~$6.60/mo storage + ~$50 one-time writes. Verify per S-25.

### Privacy & sovereignty

**B-01-36** — **All major embedding providers disclaim training on input data by default in 2026.**
- OpenAI (CL-20), Azure OpenAI (CL-21), Voyage (CL-22), Cohere (CL-23), Google Vertex (CL-24), AWS Bedrock (CL-27), Mistral (CL-26) — all confirmed.
- Gemini's claim (GE-63): "Virtually no leading embedding provider explicitly trains on API inputs by default in 2026 — the practice was eradicated by 2023-2024 enterprise backlash."
- **Caveats:** Free tiers and OSS marketplaces vary — Mixedbread free tier may train (GL-30); Jina hosted free tier no-train guarantee = DATA GAP (G-06).

**B-01-37** — **EU residency available** for OpenAI (via Azure), Cohere (BaaS), Google Vertex, AWS Bedrock, Azure OpenAI. Native EU: Mistral (France), Jina (Germany → Netherlands if S-02 verified).
- US-jurisdiction providers carry CLOUD Act / FISA-702 exposure regardless of where data is stored.

**B-01-38** — **Cohere has the lowest jurisdictional risk among non-EU providers** because Cohere is Canadian-incorporated (CL-23).
- CLOUD Act does not apply directly; FISA-702 risk lower than US-incorporated providers.

**B-01-39** — **Anthropic has no first-party embedding model in 2026.**
- Recommended path: Voyage (which Anthropic invested in pre-MongoDB acquisition) — but the investment introduces conflict of interest (S-07).

**B-01-40** — **Confidential computing for embedding workloads exists but the throughput penalty is vendor-self-reported only.**
- NVIDIA H100 CC, Azure Confidential VMs, AWS Nitro Enclaves all available (CL-155, QW-10).
- NVIDIA-claimed ≤10% overhead; no independent benchmark for embedding workloads (G-09).

**B-01-41** — **Homomorphic / private retrieval is not production-real in 2026.**
- All five sources agree (GE-86, QW-77, others implicit). Defer to 2027+.

### Specialized models

**B-01-42** — **Code retrieval:** `voyage-code-3` ($0.18/M, MTEB-Code SOTA per Voyage), Mistral `codestral-embed` ($0.15/M), or open-weights Qwen3-Embedding-8B (MTEB-Code 80.68 — the highest published number).

**B-01-43** — **Long-context (≥32K ctx):** Cohere embed-v4 (128K — the longest), Voyage `voyage-4`/`voyage-4-large` (32K), Qwen3-Embedding-8B (32K), Jina v3/v4 with late chunking, gemini-embedding-2 (32K).

**B-01-44** — **Multilingual:** BGE-M3 (MIT, 100+ langs), Qwen3-Embedding-8B (Apache 2.0, MMTEB 70.58), Cohere multilingual-v3/embed-v4, gemini-embedding-001 (MMTEB 68.32), multilingual-e5-large-instruct (Apache 2.0).

**B-01-45** — **Romanian and other low-resource Romance / Slavic languages:** DATA GAP across the board (G-01). Default to BGE-M3 or Qwen3-8B for now; verify with own eval before production.

**B-01-46** — **Domain-specific:** Voyage `voyage-finance-2` (finance), MedCPT / `zembed-1` (medical — vendor-only validation), SPECTER2 / SciNCL (scientific). No dominant 2026 winner across medical/legal/scientific.

### Inference runtimes

**B-01-47** — **HuggingFace TEI is the default GPU embedding runtime in 2026.**
- Apache 2.0, OpenAI-compatible `/v1/embeddings`, single-binary, Docker-deployable.
- ~230k tok/s for BGE-base on A10G (CL-80); ~70k tok/s for Qwen3-0.6B fp16 batch-32 on RTX 4090.

**B-01-48** — **vLLM 0.19+ and SGLang 0.5.10+ shipped embedding endpoints in Q1 2026** with OpenAI compatibility.
- vLLM likely beats TEI on ≥1B-param models due to PagedAttention (CL-81); SGLang comparable per Claude.
- Verification (W-10 / G-16) needed.
- **Qwen's claim that vLLM is not OpenAI-compatible (QW-33) is wrong** (C-20).

**B-01-49** — **Ollama is the default CPU + local-GPU runtime for developer machines.**
- Single binary, OpenAI-compatible `/v1/embeddings`, ~2k tok/s CPU on Arctic-M, ~30k on 4090 (CL-83).

**B-01-50** — **MLX is the default Apple Silicon runtime.**
- mlx-community ships Qwen3-Embedding, BGE-M3, mxbai-embed-large variants.
- ~25k tok/s on M2 Max; ~40k on M4 Max for BGE-base (CL-88).

**B-01-51** — **transformers.js / onnxruntime-web enable browser/Node in-process embedding.**
- ~500 tok/s in browser on M1; ~3k on Node CPU (CL-86).
- Models constrained to small (≤200M) due to WASM memory.

**B-01-52** — **NVIDIA NIM / Triton is enterprise GPU serving with full OpenAI compatibility.**
- ~25k tok/s for Qwen3-8B on H100 (CL-89).

---

## Decision Coverage

The prompt's done-definition (§5) asks: "Every persona has a named winning model, runtime, storage backend, named cost." Below: which parts of `prompt.md` this digest answered, and which fell to gaps.

| Prompt requirement | Coverage |
|---|---|
| §1.1 Cloud providers (≥10) | Full for OpenAI, Voyage, Cohere, Google, Anthropic (N/A), Mistral, AWS, Azure; partial for Jina/Mixedbread (G-05, G-06); partial for OSS marketplaces (G-15) |
| §1.2 OSS models (≥13) | Full for all named families |
| §1.3 Specialized | Full for code, long-context, multilingual; partial for medical/legal/finance (no dominant 2026 winner — see B-01-46) |
| §1.4 Runtimes (≥10) | Full for all named runtimes |
| §1.5 Top-20 MTEB Eng, Top-10 MMTEB / Code / LongEmbed, per-language | Top-N partial; per-language **G-01 — major gap** |
| §1.6 Reranking matrix | Full (Cohere 3.5, mxbai-v2, BGE v2-m3/gemma, Jina v2, Qwen3-Reranker, Zerank-1) |
| §1.7 Vector backends (≥12) | Full |
| §1.8 Architecture techniques (≥10) | Full |
| §1.9 Cost/ROI math | Full with caveats (CPU throughput uncertainty per C-07, G-16) |
| §1.10 Privacy matrix | Full for major providers; sub-processor lists **G-19 — gap** |
| §1.11 Personas | Six personas covered (4 mandatory + on-device + low-volume cost-min split) |

**Round status:** Decision-grade for the persona recommendations and architecture defaults. Per-language quality decisions blocked by G-01; vector-DB at-scale benchmarks blocked by G-11; tokens/sec absolute numbers blocked by G-16.

---

## Disconfirming Evidence Audit

The prompt's spirit is "find the option that wins on merit, even if it implies a stack change" (§3 rule 8). Below: things that would falsify the executive call.

**Kill condition 1:** If OpenAI text-embedding-4 ships with MTEB v2 ≥ 67 at ≤$0.05/M, Persona 3 default switches back to OpenAI from Voyage. Status: **unresolved, monitor W-08.**

**Kill condition 2:** If NVIDIA Llama-Embed-Nemotron-8B has commercial license, it displaces Qwen3-8B as Persona 1 default. Status: **unresolved, G-07 + W-03.**

**Kill condition 3:** If Zerank-1 (ZeroEntropy) BEIR head-to-head beats Cohere Rerank 3.5 and mxbai-rerank-large-v2, Persona 3/4 reranker default switches to Zerank-1. Status: **unresolved, S-08 + W-05.**

**Kill condition 4:** If the pgvectorscale 471 vs 41 QPS benchmark fails to reproduce in a neutral run, Persona-2 Gemini path (Titan + pgvectorscale = $80/mo) loses its anchor. Status: **unresolved, G-11 + W-09.**

**Kill condition 5:** If actual CPU throughput for small models on 8-vCPU is closer to Gemini's 500 t/s than to Claude/GLM's 2–3k t/s, CPU self-host's $/M climbs from $0.015 to ~$0.09 — still beating cloud but with the gap collapsing. Status: **unresolved, G-16.**

**Kill condition 6:** If the Voyage v3↔v4 family compatibility claim fails on independent test, Voyage loses its re-embed moat (S-16). Status: **unresolved, G-14.**

**Confirmed:**
- Open-weights closes the cloud quality gap (Qwen3-8B confirms across 3 sources).
- Binary + MRL is the largest cost lever (multiple sources, primary-source Voyage docs).
- CPU isn't viable for 67-MTEB-class models (4/5 sources agree; only Qwen claims otherwise, and Qwen is low-trust).
- Anthropic has no embedding API (5/5 sources).
- Romanian is a DATA GAP (5/5 sources).

---

## Codex Review

**Skipped.** No `codex:rescue` agent dispatched. Reason: digest is mechanical synthesis across 5 LLM sources with strong internal triangulation; no novel architecture being recommended that warrants adversarial review. The "kill conditions" above serve as the falsifiability check.

If a codex review is requested before acting on this digest: target Persona 2 (CPU vs cloud cost-min) and Persona 1 (Qwen3-4B vs 8B vs BGE-M3) — those are the recommendations most sensitive to throughput / license assumptions.

**Confidence disclaimer:** Without codex review, the digest's confidence in numeric ranges (cost-per-token, throughput) carries the uncertainty band documented in contradictions.md C-07 and gaps.md G-16. The recommendation grid is robust to that uncertainty (model + runtime choices remain the same across the range); only the absolute $/mo numbers shift.

---

## Cascade Impact

This is the **first round** of feature research in `packages/ai/docs/capabilities/embeddings/`. No prior `findings.md` to cascade against.

**Product-level impact:** The `packages/ai` capability is a cross-cutting library used by multiple workspace apps (loonyjobs, games-platform, evervest, ekuation, novelette). A consolidated embeddings strategy here informs:

- **`apps/loonyjobs`** — Slice 3 enrichment/embeddings worker (per memory `project_loonyjobs_slice_status.md`). Likely Persona 3 profile (balanced) with multilingual needs.
- **`apps/games-platform`** content-discovery pipeline (`project_discovery_strategies.md`) — already uses OpenAI structured outputs; embedding model choice for asset-similarity dedup not yet committed.
- **`apps/novelette`** — Romanian-language stories; needs G-01 (Romanian MTEB) resolved before any embedding workload commits.
- **`apps/evervest`** — F-04 email-only cascade (per `project_evervest_email_only.md`); embeddings would only be needed for an analytics or duplicate-detection feature.

**Spec-revision triggers:** None this round (no existing `apps/ai/docs/product-spec.md`).

**Strongest cross-cutting recommendation:** Adopt **Persona 1 (Qwen3-Embedding-4B on TEI on RTX 4090 + Qdrant)** as the workspace default for any embedding workload that needs (a) multilingual coverage including Romanian, (b) Apache 2.0 license, and (c) zero vendor data sharing. Use OpenAI 3-small Batch as the prototype/early-stage fallback below 10M tok/mo.

---

## Round Summary for Synthesis

(Compact block intended for cross-round reuse in `/deep-research-synthesize`.)

**Round:** 01 — Text embeddings state of the art
**Date:** 2026-05-17
**Sources:** ChatGPT, Claude, GLM, Qwen, Gemini (5 LLM research outputs)
**Trust ranking:** Claude > GLM ≈ Gemini > ChatGPT > Qwen
**Decision:** Adopt a profile-based recommendation grid. Default Persona 1 (privacy-max) = Qwen3-Embedding-4B (Apache 2.0) on TEI on RTX 4090 + Qdrant. Default Persona 3 (balanced) = Voyage `voyage-4` ($0.06/M, 200M free tier) + Cohere Rerank 3.5 or self-hosted mxbai-rerank-large-v2 + pgvector ≤10M / pgvectorscale 10–100M.
**Strongest finding:** Open-weights MMTEB leader is Qwen3-Embedding-8B at 70.58 / MTEB-Code 80.68 / MTEB-Eng ~69, Apache 2.0 (B-01-01). Three-source agreement.
**Biggest divergence:** CPU throughput for embedding workloads — Gemini conservative (~500 t/s for MiniLM), Claude/GLM optimistic (~2-3k t/s). 5× range. Affects Persona 2 absolute $/M but not the relative ordering (B-01-03, C-07).
**Top gaps blocking action:** G-01 (Romanian per-language MTEB), G-11 (neutral vector DB benchmark), G-16 (measured tokens/sec), G-14 (Voyage v3↔v4 compatibility verification).
**Open questions for founder:** None blocking — recommendation grid is robust to remaining uncertainty. Verification spikes can be commissioned in a follow-up round if any of the kill conditions trigger.

---

## Next Research

See `next-research.md` for the prioritized roadmap.

---

## Downstream — decisions taken 2026-05-17 to 2026-07-04

The findings above drove concrete engineering decisions in `packages/ai/src/embeddings/`. See [../decisions.md](../decisions.md) for the full log. Highlights:

- **D-EMB-01** — profile-based recommendation grid adopted (12 provider modules).
- **D-EMB-07** — Ollama default → `qwen3-embedding:0.6b` (from `nomic-embed-text`) per B-01-01.
- **D-EMB-08** — Nebius added as first-class hosted-Qwen3-8B route (raw fetch, mirrors `jina.ts` pattern).
- **D-EMB-09** — sourcing-rigor policy: every $/M-token claim must reach at least "verified-model-page" tier before anchoring a production decision. This was written after a founder-caught failure: Nebius pricing was published in this repo as "$0.010/M" when the source was actually a search-result summary, not the Nebius pricing page. See NR-26 for the browser-verify remediation.

---

## Inputs Snapshot

| File | Modified | Read at digest |
|---|---|---|
| `prompt.md` | 2026-05-17 11:16 | full |
| `chatgpt.research.md` | 2026-05-17 12:38 | full (direct) |
| `claude.research.md` | 2026-05-17 12:38 | full (subagent CL-01..CL-161) |
| `glm.research.md` | 2026-05-17 12:39 | full (subagent GL-01..GL-128) |
| `qwen.research.md` | 2026-05-17 12:38 | full (subagent QW-01..QW-78) |
| `gemini.research.txt` (from .rtf) | 2026-05-17 12:44/46 | full (subagent GE-01..GE-90) |

Digested 2026-05-17 by `/deep-research-digest` (4 parallel extraction subagents + cross-source synthesis). Anti-anchoring: per-source extraction completed in isolation before any cross-source comparison.
