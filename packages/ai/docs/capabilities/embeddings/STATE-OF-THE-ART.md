# State of the Art: Text Embeddings (2024–2026)

> **Cutoff:** 2026-05-17. All claims marked **(legacy MTEB v1)** are NOT directly comparable to 2026 MTEB v2 numbers — see Caveats. Any number marked **DATA GAP** has no authoritative public source as of the cutoff; see [Open Questions](#open-questions--data-gaps).
> **Synthesis basis:** five LLM research outputs (ChatGPT, Claude, GLM, Qwen, Gemini Deep Research) commissioned against `research/prompt.md`. Stable claim IDs `B-01-XX` reference [`research/findings.md`](research/findings.md); contradictions `C-XX`, gaps `G-XX`, and sparks `S-XX` live in their respective files in `research/`.

---

## Overview

The 2026 embedding landscape collapsed three years of fragmentation into a small, defensible recommendation grid:

1. **Open-weights matches proprietary on quality.** Qwen3-Embedding-8B (Apache 2.0) leads public MMTEB at **70.58** and MTEB-Code at **80.68**, beating every cloud API on both axes [B-01-01]. The "you need OpenAI/Cohere/Voyage for SOTA" assumption from 2024 no longer holds.
2. **Cloud-API quality leader is `gemini-embedding-001`** at MMTEB 68.32, but its 2K context disqualifies it for long-doc retrieval — that crown belongs to **Cohere embed-v4** (128K ctx, MTEB-Eng ~65.8) [B-01-02, B-01-14].
3. **Cost minimum has shifted.** Self-hosted on a consumer GPU (RTX 4090, ~$200/mo) reaches ~$0.001–$0.03/M tokens depending on model size, undercutting every cloud API per-token above ~1B tokens/month [B-01-19]. Below that threshold, cloud APIs win on simplicity.
4. **Binary quantization + Matryoshka is the largest cost lever in the survey** — Cohere binary at 1536-d cuts a 100M × 3072-d corpus from 1.6 TB to ~28 GB (≈50× reduction) with <2% NDCG loss on QAT-trained models [B-01-12, B-01-21].
5. **The "CPU runs 67-MTEB-class models" dream is dead.** Realistic 2026 CPU baseline is 55–62 MTEB-Eng (Snowflake Arctic-Embed-M v2.0, BGE-base, MiniLM); 67-MTEB-class models need GPU [B-01-10].

The central trade-offs remain **cost × quality × privacy × latency**, but with sharper Pareto frontiers and fewer "you must pick this vendor" lock-in points.

---

## Historical Context

### Evolution Timeline

| Year | Milestone | Key innovation |
|---|---|---|
| 2018 | BERT, SBERT (Reimers & Gurevych) | Bi-encoder semantic embeddings for retrieval |
| 2021 | SimCSE | Contrastive learning from raw text |
| 2022 | OpenAI `text-embedding-ada-002` | First widely-used commercial embedding API (1536-d, 8K ctx) |
| 2023-Q1 | E5, BGE | Instruction-prefix-trained open models reach MTEB ~62 |
| 2023-Q4 | OpenAI `text-embedding-3-small/large` | Matryoshka truncation in mainstream API (1536/3072 dim) |
| 2024-Q1 | Voyage AI launch, Mixedbread mxbai | Open-source pulls within 1–3 MTEB of proprietary |
| 2024-Q2 | NV-Embed, BGE-en-ICL, Stella v5 | LLM-backbone embedders hit MTEB 71–72 (legacy v1) but most under CC-BY-NC |
| 2024-Q3 | Cohere Embed v3 binary + int8 | Quantization-aware-training (QAT) models ship binary embeddings with <2% quality loss |
| 2024-Q4 | Jina v3 with late-chunking | Long-document handling without multi-call overhead |
| 2025-Q1 | Voyage `voyage-3-large`, Cohere embed-v4 | Context length jumps to 32K (Voyage) / 128K (Cohere) |
| 2025-Q2 | Google `gemini-embedding-001` | Cloud-API MMTEB leader at 68.32; pgvectorscale + DiskANN ships |
| 2025-Q3 | Qwen3-Embedding-{0.6,4,8}B (Apache 2.0) | First open-weights model to lead MMTEB at 70.58 [B-01-01] |
| 2025-Q4 | Voyage AI acquired by MongoDB [S-01]; Jina AI acquired by Elastic [S-02] | Major embedding labs absorbed by DB vendors |
| 2026-Q1 | vLLM 0.19 + SGLang 0.5.10 ship OpenAI-compatible embedding endpoints [B-01-48] | GPU serving runtime diversifies beyond HF TEI |
| 2026-Q1 | MTEB v2 transition (`B-01-11`) | New task suite breaks comparability with all prior scores |
| 2026-Q1 | NVIDIA Llama-Embed-Nemotron-8B (claimed #1 MMTEB at release) | License ambiguity — see [G-07](research/gaps.md) |
| 2026-Q2 | Voyage `voyage-4` family launches | Claims `voyage-3-large` ↔ `voyage-4-large` embedding-space compatibility [S-03] |

### Paradigm Shifts

```
[BM25 only]
    ↓
[Dense bi-encoder embeddings, single-vector]            2018-2021
    ↓
[Instruction-prefix-trained, Matryoshka]                2023-2024
    ↓
[QAT binary + multi-vector + late chunking]             2024-2025
    ↓
[Open-weights ≥ proprietary; embeddings move to GPU]    2025-2026
    ↓
[Multimodal unified latent space; embeddings co-located 2026+
 with vector DB to eliminate network hops]
```

---

## Current State

### Approach Comparison

| Approach | Quality (MTEB-Eng) | $/1M tok | Latency p95 (embed) | Privacy | Multilingual |
|---|---|---|---|---|---|
| **Frontier cloud API** (OpenAI 3-large, Cohere v4, Gemini-001) | 64–68 | $0.02–$0.20 | 50–150 ms | Enterprise tier ZDR available; US/EU residency varies | Strong (Gemini-001 best at MMTEB 68.32) |
| **Quality-leader cloud API** (Voyage v4-large) | ~67–70 (estimate, G-03) | $0.06–$0.18 | 80–150 ms | Voyage SOC 2 II; now MongoDB-owned (S-01) | Strong |
| **Open-weights frontier on GPU** (Qwen3-Embedding-8B) | ~69; MMTEB 70.58 | $0.026 (self-host on 4090) | 5–15 ms (4090) | Maximal (no vendor) | Excellent (Apache 2.0, MMTEB SOTA) |
| **Open-weights mid on GPU** (BGE-M3, Stella-1.5B, mxbai-large) | 63–71 (some legacy) | $0.004–$0.01 (4090) | 3–10 ms | Maximal | BGE-M3 strongest |
| **Open-weights small on CPU** (Arctic-M v2.0, MiniLM, Granite-278M) | 56–62 | $0.015–$0.09 | 100–250 ms | Maximal | Arctic 2.0 / Granite multilingual |
| **On-device** (MLX, transformers.js) | 56–62 (MiniLM) | $0 | 50–200 ms (per-device) | Maximal | Limited (small models) |

Quality column uses MTEB-Eng where published; **MTEB v1→v2 transition (2026) makes scores from different leaderboard generations non-comparable** [B-01-11]. Privacy column collapses ZDR / training-opt-out / data residency / jurisdiction into a single tier — see [Privacy & Sovereignty](#privacy--sovereignty) for the matrix.

### Embedding Model Leaderboard (2026, top 20)

Mixed MTEB-Eng + MMTEB ranking; each row tagged with which leaderboard the score comes from. Sources annotated; dates reflect last published score, not necessarily current quality.

| Rank | Model | MTEB-Eng | MMTEB | MTEB-Code | LongDoc | Dim | Ctx | $/1M tok (hosted) | License | Self-host? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **NV-Embed-v2** (NVIDIA) | 72.31 (legacy v1) | 69.8 | DATA GAP | – | 4096 | 32K | – | **CC-BY-NC** | research-only |
| 2 | **GTE-Qwen2-7B-instruct** (Alibaba) | 72.05 (legacy v1) | 71.2 (Gemini-only, unverified) | 75.4 | – | 3584 | 32K | $0.01–0.05 (DeepInfra/Together) | Apache 2.0 | Yes |
| 3 | **Stella en 1.5B v5** | ~71.5 (legacy) | DATA GAP | DATA GAP | – | 1024 (MRL up to 8192) | 8K | – | MIT | Yes |
| 4 | **BGE-en-ICL** | 71.24 (legacy v1) | – | – | – | 4096 | 32K | – | Apache 2.0 | Yes |
| 5 | **Qwen3-Embedding-8B** | ~69 | **70.58** | **80.68** | – | 4096 (MRL 32–4096) | 32K | ~$0.05 (SiliconFlow) | Apache 2.0 | Yes |
| 6 | **Voyage `voyage-4-large`** | ~70.3* (Gemini "triangulated") | ~69.1* | >70.0* | – | 1024 (MRL) | 32K | $0.12 | Proprietary | API only |
| 7 | **Google `gemini-embedding-001`** | 64.2 | **68.32** | DATA GAP (G-10) | – | 3072 (MRL) | **2K** | $0.15 (Batch $0.075) | Proprietary | API only |
| 8 | **Voyage `voyage-3-large`** | 66.8–67.1 (G-03) | – | – | – | 1024 | 32K | $0.18 | Proprietary | API only |
| 9 | **Qwen3-Embedding-4B** | ~68 | ~69 | ~78 | – | 2560 (MRL) | 32K | ~$0.03 | Apache 2.0 | Yes |
| 10 | **Stella en 400M v5** | ~70 (legacy) | – | – | – | 1024 | 512 | – | MIT | Yes |
| 11 | **Linq-Embed-Mistral** | ~68 (self-reported) | – | strong | – | 4096 | 32K | – | Apache 2.0 (subject to Mistral base) | Yes |
| 12 | **Cohere `embed-v4`** | 65.2–65.8 | 68.1 | – | SOTA LongDoc | 1536 (MRL) | **128K** | $0.12 (image $0.47) | Proprietary | API only |
| 13 | **Jina `jina-embeddings-v3`** | 65.5 | 64.4 | – | – | 1024 (MRL 64–1024) | 8K | $0.018 hosted | **CC-BY-NC** (open weights) | hosted only |
| 14 | **GTE-large-en-v1.5** | 65.4 (legacy) | – | – | – | – | – | – | Apache 2.0 | Yes |
| 15 | **OpenAI `text-embedding-3-large`** | 64.6 | – | – | – | 3072 (MRL) | 8K | $0.13 (Batch $0.065) | Proprietary | API only |
| 16 | **mxbai-embed-large-v1** | 64.68 | – | – | – | 1024 | – | $20/mo Scale plan (G-05) | Apache 2.0 | Yes |
| 17 | **Nomic-Embed-v2 (MoE)** | ~64 | ~65.8 | – | – | 768 (MRL) | 512 | – | Apache 2.0 | Yes |
| 18 | **GTE-Qwen2-1.5B-instruct** | ~67 | strong | – | – | – | 32K | – | Apache 2.0 | Yes |
| 19 | **BGE-M3** | 63.0 | strong (MMTEB row DATA GAP) | – | – | 1024 | 8K | $0.01 (DeepInfra) | MIT | Yes |
| 20 | **OpenAI `text-embedding-3-small`** | 62.3 | – | – | – | 1536 (MRL) | 8K | $0.02 (Batch $0.01) | Proprietary | API only |

**Numbers marked `*`** (Voyage-4-large, Gemini-2) are Gemini's "normalized triangulated" estimates — Voyage and Google have not submitted official MTEB v2 scores. Treat them as ±2 MTEB points uncertain (see G-03, C-21).

**MTEB Code top-5 (where published):**
1. Qwen3-Embedding-8B: 80.68 [B-01-01]
2. Voyage `voyage-code-3`: claimed SOTA by Voyage; no public MTEB-Code number
3. GTE-Qwen2-7B-instruct: 75.4 (legacy)
4. Mistral `codestral-embed`: claimed code-specific; benchmark DATA GAP
5. `jina-code-v2`: legacy entry

**MTEB LongDoc top:** Cohere embed-v4 (128K ctx), Jina v3/v4 with late-chunking. Independent LongEmbed leaderboard scores not separately enumerated in source bundle.

**Per-language leaderboards (Chinese, French, German, Spanish, Italian, Polish, Japanese, Korean, Arabic, Romanian):** **DATA GAP — G-01 [CRITICAL].** All five LLM sources silently skipped this; only Claude and Gemini flagged Romanian explicitly. For non-English-primary workloads, default to BGE-M3, multilingual-e5-large-instruct, Qwen3-Embedding-8B, or Cohere multilingual-v3 and verify with own eval.

### Self-Hostable Model Matrix (commercially-licensed)

Throughput numbers below are **synthesized estimates** from the source bundle — not measured. Each row carries 1.5×–3× uncertainty until verified per [G-16](research/gaps.md).

| Model | Params | VRAM fp16 | VRAM int8 | CPU viable (8 vCPU)? | Tokens/sec CPU | Tokens/sec 4090 | Tokens/sec A100 | Ollama tag | License |
|---|---|---|---|---|---|---|---|---|---|
| Qwen3-Embedding-8B | 8B | ~16 GB | ~8 GB | No | ~1.5 | ~6,000–7,000 | ~15,000 | `qwen3-embedding:8b` | Apache 2.0 |
| Qwen3-Embedding-4B | 4B | ~8 GB | ~4 GB | No | ~3 | ~10,000 | ~22,000 | `qwen3-embedding:4b` | Apache 2.0 |
| GTE-Qwen2-7B-instruct | 7B | ~14 GB | ~7 GB | No | ~2 | ~850 (Gemini est.) | ~5,000 | – | Apache 2.0 |
| Stella en 1.5B v5 | 1.5B | ~3 GB | ~1.6 GB | Marginal | ~15 | ~2,400 | ~8,000 | – | MIT |
| BGE-M3 | 568M | ~1.2 GB | ~600 MB | No (28–50 t/s, see C-06) | 28–50 | ~3,800 | ~15,000 | `bge-m3` | MIT |
| mxbai-embed-large-v1 | 335M | ~700 MB | ~350 MB | Marginal | ~100 | ~20,000 (GLM est.) | – | `mxbai-embed-large` | Apache 2.0 |
| Snowflake Arctic-Embed-L v2.0 | 568M | ~1.1 GB | ~570 MB | Marginal | ~50 | ~3,500 | – | `snowflake-arctic-embed2` | Apache 2.0 |
| Snowflake Arctic-Embed-M v2.0 | 305M | ~610 MB | ~310 MB | Yes (batched) | ~150 (Gemini), ~2,000 (Claude/GLM) | ~9,500 | – | `snowflake-arctic-embed2` | Apache 2.0 |
| Nomic-Embed-v2 (MoE) | 475M total / 305M active | ~1.0 GB | ~500 MB | Yes (batched) | ~42 | ~4,500 | – | – | Apache 2.0 |
| Nomic-Embed-Text-v1.5 | 137M | ~270 MB | ~140 MB | Yes | ~300–500 | ~200,000 | – | `nomic-embed-text` | Apache 2.0 |
| IBM Granite Embedding 278M | 278M | ~600 MB | ~300 MB | Yes | ~75–1,500 (range) | ~180,000 | – | `granite-embedding:278m` | Apache 2.0 |
| GTE-ModernBERT-base | 149M | ~320 MB | ~160 MB | Yes | ~110–2,000 | ~150,000 | – | – | Apache 2.0 |
| BGE-small-en-v1.5 | 33M | ~70 MB | ~35 MB | Yes | ~3,000 | – | – | – | MIT |
| all-MiniLM-L6-v2 | 22M | ~50 MB | ~25 MB | Yes | ~500–2,000 | ~100,000 | – | – | Apache 2.0 |

**CPU column reads:** *Yes* = batched ingest viable; *Marginal* = batched ingest only with int8 + ONNX; *No* = GPU mandatory. **CPU is dead for 67-MTEB-class models** [B-01-10, C-04]; realistic CPU baseline in 2026 is Arctic-Embed-M v2.0 or Granite-278M (55–62 MTEB-Eng).

**Throughput discrepancies in the table** (e.g. Arctic-M v2.0 CPU = 150 t/s Gemini vs 2,000 t/s Claude/GLM, a 13× range) reflect unbenchmarked extrapolations. The truth depends on ONNX vs PyTorch, int8 vs fp16, batch size, and sequence length. Plan for the conservative number; budget upside.

### Specialized Models

| Domain | Best model(s) | Why it wins | License |
|---|---|---|---|
| **Code retrieval** | Voyage `voyage-code-3` ($0.18/M, 32K ctx); Qwen3-Embedding-8B (MTEB-Code 80.68, Apache 2.0); Mistral `codestral-embed` ($0.15/M) | Trained on code; Voyage publishes code-specific win-rates; Qwen3 leads public MTEB-Code | Mixed |
| **Long-context** | Cohere embed-v4 (128K ctx); Voyage `voyage-4`/`voyage-4-large` (32K); Jina v3/v4 with late-chunking (8K + chunk-merging); Qwen3-8B (32K) | Cohere context window is 4× competitors; Jina late-chunking gives near-32K effective context | Mixed |
| **Multilingual-first** | BGE-M3 (MIT, 100+ langs); multilingual-e5-large-instruct (Apache 2.0); Qwen3-Embedding-8B (MMTEB 70.58); Cohere multilingual-v3/embed-v4 | BGE-M3 covers 100+ langs with dense+sparse+multi-vec; Qwen3 is the open-weights MMTEB leader | Mixed |
| **Finance** | Voyage `voyage-finance-2` (proprietary) | Only domain-specific finance model with vendor-published benchmarks | Proprietary |
| **Medical/biomedical** | MedCPT (contrastive on PubMed); `zembed-1` (ZeroEntropy, vendor-validated only) | MedCPT is academic-released; `zembed-1` claims medical SOTA | CC-BY for MedCPT; Proprietary for zembed-1 |
| **Scientific** | SPECTER2; SciNCL (AllenAI) | Trained on paper abstracts; multi-task adaptable | Apache 2.0 |
| **Visual document RAG** | Cohere embed-v4 image input ($0.47/M image tokens) | Embeds page screenshots directly — eliminates OCR pipeline (S-09) | Proprietary |

**No dominant 2026 winner across all of medical/legal/finance.** For medical/legal, fine-tune BGE-M3 or Qwen3-8B on domain corpus before defaulting to vendor-specific models.

### Cloud Provider Privacy & Sovereignty Matrix

| Provider | Trains on input? | EU residency | GDPR DPA | Default retention | SOC 2 II / ISO 27001 / HIPAA | Jurisdiction | Verdict |
|---|---|---|---|---|---|---|---|
| **OpenAI** (direct) | No (since 2023-03); opt-in only | via Azure regions | Yes | 30 days (ZDR available on Enterprise) | All three; FedRAMP via Azure | US (CLOUD Act / FISA-702) | Strong with Enterprise ZDR |
| **Azure OpenAI** | No | Yes (Sweden/France/Switzerland) | Yes | 30 days (configurable to 0) | All three + FedRAMP High | US (Microsoft) | Strongest cloud option for EU + US-Gov |
| **Voyage AI** (MongoDB-owned post-S-01) | No (Enterprise) | Limited (US-primary) | Yes (via MongoDB DPA) | DATA GAP | SOC 2 II | US (MongoDB) | Good; consult MongoDB DPA |
| **Cohere** | No (paid tier); datasets auto-deleted after 30 days (GL-22) | Yes (BaaS via AWS/Azure) | Yes | 30 days for datasets | All three + BAA | **Canada** (CLOUD Act doesn't apply directly) | **Strongest jurisdictional posture** |
| **Google Vertex** | No (Vertex); opt-in on free AI Studio | Yes (38+ regions) | Yes | 30 days (Stackdriver) | All three + FedRAMP High | US (Google) | Strong; check region routing for gemini-embedding-2 |
| **Mistral La Plateforme** | No | **Native EU** (Paris) | Yes | Configurable to 0 | SOC 2 II + ISO 27001 | **France** | Strongest for EU-native + privacy |
| **AWS Bedrock** | No | Yes (incl. GovCloud) | Yes | Configurable (CloudTrail) | All three + FedRAMP High + HIPAA | US (AWS) | Very strong; FedRAMP High |
| **Jina AI** (Elastic-owned post-S-02 if verified) | No (paid) | DATA GAP (was Germany; now ?) | DATA GAP | DATA GAP | DATA GAP | Was DE, now NL? (W-07) | Re-verify post-acquisition |
| **Mixedbread** | Free tier may train; paid tier doesn't (GL-30) | DATA GAP | DATA GAP | DATA GAP | DATA GAP | Germany | Paid tier only for production |
| **OSS marketplaces** (DeepInfra, Together, Fireworks, Replicate, OpenRouter) | No (opt-in only) | US-primary | Mixed | ~14-day default; DeepInfra claims memory-only (S-24); Replicate 1-hour | Mixed (SOC 2 inconsistent) | US | DeepInfra strongest on privacy among OSS hosts |

**Anthropic does not offer a first-party embedding model in 2026** [B-01-39]. Anthropic recommends Voyage (in which Anthropic invested) — note the conflict of interest [S-07].

**Sub-processor lists per provider:** DATA GAP [G-19]. Required for any GDPR-strict B2B selling to EU customers. Mitigation for early-stage: rely on enterprise ZDR + document risk acceptance until G-19 is resolved.

---

## Inference Runtimes

| Runtime | Hardware | Formats | OpenAI-compat? | Throughput (1k-tok batch, fp16) | Single-binary | Language SDKs |
|---|---|---|---|---|---|---|
| **HuggingFace TEI** | GPU + CPU | safetensors | Yes (`/v1/embeddings`) | ~230k tok/s BGE-base on A10G; ~70k tok/s Qwen3-0.6B fp16 batch-32 on 4090 | No (Docker) | HTTP from any language |
| **vLLM 0.19+** | GPU | safetensors | Yes (`/v1/embeddings`) | Likely beats TEI for ≥1B-param models due to PagedAttention | No (Python lib + Docker) | Python first |
| **SGLang 0.5.10+** | GPU | safetensors | Yes (partial) | Comparable to vLLM; better for batched RAG | No (Python lib) | Python |
| **Ollama** | CPU + local GPU | GGUF, safetensors | Yes | ~2k tok/s Arctic-M CPU; ~30k 4090 | Yes | HTTP |
| **llama.cpp server** | CPU (x86, Apple) | GGUF | Yes | ~1k–3k tok/s on 8-vCPU CPU Arctic-M | Yes | HTTP |
| **fastembed (Qdrant)** | CPU | ONNX | No (lib) | ~3k–5k tok/s CPU BGE-small | n/a (lib) | Python |
| **transformers.js / onnxruntime-web** | Browser / Node | ONNX | No (lib) | ~500 tok/s browser M1; ~3k Node CPU | n/a (lib) | JavaScript |
| **onnxruntime-node** | CPU + GPU | ONNX | No (lib) | ~3k–5k tok/s CPU | n/a (lib) | JavaScript |
| **candle** | CPU + GPU (Rust) | safetensors, ONNX | No (lib) | ~50k tok/s 4090 BGE-base | Yes (Rust crate) | Rust |
| **MLX** | Apple Silicon | MLX format, safetensors | No (lib) | ~25k tok/s M2 Max; ~40k M4 Max | n/a (lib) | Python, Swift |
| **NVIDIA NIM / Triton** | Data-center GPUs | TensorRT, ONNX | Yes (NIM) | ~25k tok/s Qwen3-8B on H100 | No (Docker / Helm) | Python, C++, Go |

**Can a 67-MTEB-class model run CPU-only at acceptable batched-ingest latency in 2026?**
**No.** Five-source convergence (C-04). The realistic CPU target is 55–62 MTEB-Eng using Arctic-Embed-M v2.0, Granite-278M, or MiniLM at 500–3,000 tok/s on 8 vCPU. 67-MTEB-class models (Qwen3-8B, Stella-1.5B, GTE-Qwen2-7B, voyage-4-large) need GPU.

**Default GPU runtime choice in 2026:**
- ≤200M model → **HuggingFace TEI** (battle-tested, OpenAI-compat, lowest setup overhead)
- ≥1B model → **vLLM 0.19+** (PagedAttention wins on long sequences; verify per [W-10])
- Apple Silicon → **MLX** (mlx-community ships Qwen3-Embedding, BGE-M3, mxbai variants)
- Enterprise serving → **NVIDIA NIM**

---

## Vector Storage Backends

| Backend | Index types | Max scale/node | Filtered search | Hybrid (BM25 + dense)? | Hosted? | Self-host $/mo @10M | Hosted $/mo @10M | $/mo @100M | Failure mode |
|---|---|---|---|---|---|---|---|---|---|
| **pgvector** (Postgres ext) | HNSW + IVFFlat | ~10M comfortable | Yes (post-filter) | Via Postgres FTS | Self | ~$50–200 | – | ~$1–2k (managed) | Memory exhaustion >10M; HNSW graph RAM |
| **pgvectorscale** (Timescale add-on) | StreamingDiskANN | ~100M+ | Yes (SBQ filter) | Via Postgres FTS | Self / Timescale | ~$50–150 | – | ~$150 (S-04, unverified) | Postgres overhead reduces raw QPS |
| **Qdrant** | HNSW + payload filter | ~100M/node | **Yes** (first-class) | Yes (native sparse + dense) | Both | ~$80–200 | ~$300 | ~$1–2k | Concurrent dense writes degrade indexing |
| **Weaviate** | HNSW + Flat | ~100M/node | Yes (pre-filter) | **Native BlockMax WAND + RSF** | Both | ~$100–200 | ~$500 | ~$3k | Aggressive RAM scaling; GC pauses |
| **Milvus / Zilliz** | HNSW, IVF, IVFPQ, DiskANN, ScaNN, GPU-CAGRA | 1B+ documented | Yes (partition) | Yes (plugin) | Both | ~$400–800 | ~$1k | ~$3–6k | Devops overhead to tune |
| **Vespa** | HNSW + IVF | 1B+ (Yahoo-class) | Yes | **Native RRF + BM25** | Self | ~$300–500 | – | ~$1–2k | JVM overhead at small scale; steep learning curve |
| **Pinecone** | HNSW + IVFPQ | 100M+ | Yes (post-filter) | Hybrid via separate sparse index | Hosted only | – | $70 (p1.x1) | $1–4k | Black-box cost at scale |
| **Pinecone Serverless** | (proprietary) | 100M+ | Yes | – | Hosted only | – | ~$80–150 (workload-dependent G-18) | scales with reads | Cost spikes with high QPS |
| **Elasticsearch / OpenSearch** (`dense_vector`) | HNSW (Lucene) | 10–100M | Yes | **Native BM25 + dense** | Both | ~$200 | ~$500 | ~$3–5k | Not scalable past ~10M easily |
| **Redis Stack** (RediSearch) | HNSW + FLAT | 10M practical | Yes (tags) | Yes (BM25 + vector) | Both | ~$200 | ~$500 | ~$1–2k | Memory-bound; limited dims |
| **LanceDB** | IVF-PQ + HNSW + Brise | 100M+ (object-storage) | Yes (post) | Experimental | Self / LanceDB Cloud | ~$50–150 | ~$200 | ~$500 | Emerging; less battle-tested |
| **Chroma** | HNSW | ~5M practical; degrades past 10M | No (basic) | No (dev-tier) | Self / Chroma Cloud (S-25) | ~$30 | ~$6.60 storage + writes (Chroma Cloud) | – | Single-process; not for prod past ~10M |
| **Turbopuffer** | DiskANN (SSG) | 10B+ (object-storage) | Yes (basic) | No | Hosted (managed object-storage) | – | ~$50 | ~$200 | Cold-query latency penalty |
| **DuckDB VSS** | HNSW (experimental) | ~100M (single-node) | No | No | Embedded | ~$30 | – | – | Experimental; immature |
| **SQLite-VSS** | HNSW (extension) | <5M practical | No | No | Embedded | – | – | – | Single-process, not production-scale |

**Cost ranges are ballparks** — see [G-11](research/gaps.md) for the neutral benchmark gap. Vendor self-reports drive most numbers; pgvectorscale's "471 QPS vs Qdrant 41 QPS at 50M @ 99% recall" claim [S-04] needs independent reproduction before adopting as default.

**Recommended defaults by scale and profile:**

| Profile | Backend |
|---|---|
| ≤10M vectors, low-QPS, existing Postgres | **pgvector + HNSW** |
| 10M–100M vectors, cost-sensitive | **pgvectorscale** (if S-04 holds) OR **Qdrant self-host** (proven) |
| 100M+ vectors, production-grade | **Milvus / Zilliz** |
| 1B+ vectors, latency-tolerant, cost-cheapest | **Turbopuffer** OR **LanceDB** (object-storage) |
| Latency-critical (≤25ms p95), single-process | **Vespa** with embedding co-located (S-15) |
| Dev / prototype | **Chroma** or **LanceDB embedded** |
| Hybrid BM25 + dense as a first-class feature | **Weaviate** OR **Vespa** |

---

## Architecture Techniques

### Matryoshka Representation Learning (MRL)

Train the embedding model so that the first K dimensions of the output are themselves a valid embedding. Allows post-hoc truncation 3072→768 or 1024→256 without quality loss.

- **Supported by:** OpenAI v3, Voyage v3/v4 family, Cohere v3/v4, Nomic v1.5/v2, Snowflake Arctic 2.0, Mixedbread mxbai, Jina v3/v4 (64–1024), GTE-ModernBERT, gemini-embedding-001 (128–3072).
- **Impact:** ~95–99% retrieval quality retained at 256-dim for MRL-trained models [B-01-23]. Storage and ANN-index cost drop with the dimension.
- **Combined with binary** (Voyage QAT): 512-d binary retains 99.7% of float quality at 1/200 the storage of OpenAI 3-large 3072-d float (Voyage docs cited in CL-108).
- **Default rule:** truncate to 256–512 dim unless quality-sensitive; use 768 when you can afford it.

### Late Chunking (Jina)

Encode the entire long document with full context, then mean-pool over chunk-span boundaries to get per-chunk vectors. Each chunk vector retains awareness of the surrounding document.

- **Supported by:** Jina v3 (mode flag), Jina v4.
- **Impact:** +1–3 NDCG@10 on LongEmbed benchmark vs naive chunk-then-encode [B-01-27].
- **Why others don't:** requires the model to be trained for span-aware pooling; retrofitting is non-trivial.

### Multi-Vector / Late Interaction (ColBERT, ColPali, BGE-M3 multi-vec mode)

Store one vector per token (or per phrase) instead of one per document. Query against each token vector at retrieval time.

- **Supported by:** BGE-M3 (built-in mode), Jina v4, Qdrant (named-vector storage), Vespa (tensor expressions).
- **Impact:** +3–8 NDCG@10 vs single-vector [B-01-28]; storage 15–30×; query compute 2–5×.
- **Pick when:** accuracy on adversarial queries matters more than storage cost (legal eDiscovery, regulated RAG).

### Vector Quantization (int8, scalar PQ, product PQ, binary)

Compress per-dimension representation. Tradeoff is quality vs storage and ANN-index size.

- **int8 (4× compression):** ~0.3% NDCG loss; QAT models recover almost all of it (Voyage 1024-d int8 only 0.31% below 2048-d float per Voyage docs, CL-111).
- **Product Quantization (IVFPQ, DiskANN):** 8–32× compression; 2–5% NDCG loss [B-01-28 / CL-112].
- **Binary (32× compression):** 5–15% NDCG loss for non-QAT; **<2% NDCG loss for QAT-trained** (Cohere v3/v4, Voyage 3/4-large, Mixedbread Binary MRL) [B-01-12 / CL-113].
- **Use binary by default** for QAT-supporting models; storage savings dominate.

### Hybrid Retrieval (BM25 + dense + RRF)

Run BM25 and dense retrieval in parallel; merge with Reciprocal Rank Fusion or weighted score.

- **Lift:** +5–15% NDCG@10 on out-of-domain corpora with proper-noun-heavy queries (C-09 [B-01-24]).
- **Gains shrink near zero** when the dense model is already in-domain.
- **Below ~100K docs:** RRF noise sometimes hurts — measure before adopting.
- **Native support:** Weaviate, Vespa, Elasticsearch/OpenSearch, Qdrant (with sparse-vector mode).

### Sparse Vector Retrieval (SPLADE, learned sparse)

Train a model to produce sparse (BM25-like) vectors with semantic richness.

- **Supported by:** BGE-M3 (sparse mode), Naver SPLADE family.
- **Impact:** Index size 2–3× of BM25; retrieval cost similar. Better than dense on paraphrase recall; comparable on lexical [B-01-? / CL-115].
- **Pick when:** interpretability matters or when keyword-aware retrieval is required.

### Instruction Prefixes

E5, BGE, Snowflake Arctic 2.0, Qwen3, Voyage, Cohere are instruction-trained: queries and documents need different prefixes (`search_query: …`, `search_document: …`, or model-specific equivalents).

- **Omitting prefixes degrades NDCG@10 by 3–8 points** [B-01-26 / CL-116, GE-50].
- **Top-3 production bug.** Check your client code.
- Snowflake Arctic 2.0 and Qwen3 are "instruction-aware" (the prefix can also encode the task type — search vs classification vs clustering — for ~1–5% additional gain).

### Reranking

Cross-encoder applied to top-K results from dense retrieval.

| Reranker | Params | License | Hosted $ | Self-host throughput | NDCG@10 lift |
|---|---|---|---|---|---|
| **Cohere Rerank 3.5** | proprietary | Proprietary | $2.00/1k searches | – | +5–20% |
| **Zerank-1** (ZeroEntropy, S-08) | proprietary | Proprietary | **$0.025/M** | – | +18–22% (vendor) |
| **mxbai-rerank-large-v2** (ProRank-1.5B) | 1.5B | Apache 2.0 | – | ~25 q/s A100 | +12–20% (BEIR 57.5, claimed beats Cohere) |
| **mxbai-rerank-base-v2** | 0.5B | Apache 2.0 | – | ~60 q/s A100 | +10–15% (BEIR 55.6) |
| **BGE Reranker v2-m3** | 568M | Apache 2.0 | – | ~50 q/s A100 | +4–10% |
| **BGE Reranker v2-gemma** | 2B | Apache 2.0 | – | ~10 q/s A100 | +5–11% |
| **Jina Reranker v2** | 278M | **CC-BY-NC** | $0.02/1k (hosted) | ~80 q/s A100 | +14–19% (Gemini) |
| **Qwen3-Reranker-{0.6,4,8}B** | 0.6B–8B | Apache 2.0 | – | tier-dependent | +12–25% (Apache 2.0 advantage) |
| **Voyage Rerank 2.5** | proprietary | Proprietary | DATA GAP | – | competitive |

**Cost-economics flip above ~1M queries/mo:** Cohere Rerank at 10M q/mo = $20k/mo; self-hosted mxbai-rerank-large-v2 on 2× A10G HA ≈ $700/mo (**~28× cheaper**) [B-01-22].

**Always apply reranking for RAG copilot workloads;** lift is large enough that the cost is almost always justified [B-01-25].

### Embedding Cache Strategies

- **Content-hash cache** (deterministic): >99% hit rate on static corpora; free win, always implement.
- **Semantic cache** (cosine ≥0.97): 30–60% hit rate on user queries (CL-118, unverified G-20).
- **Versioned cache key** `(model_id, dim, content_hash)` is **required for safe model upgrades** — without it, cache becomes a footgun when the embedding model changes.
- **TTL:** queries 7–30 days; document embeddings indefinite until model upgrade.

### Re-embedding on Model Upgrades

- **Default:** every model version bump requires full re-embedding. ada-002 → text-embedding-3, Cohere v3 → v4, Voyage v3 → v4 (across families) all break compatibility.
- **Exception:** `voyage-3-large` ↔ `voyage-4-large` claim to share v4-family embedding space per Voyage docs (CL-117, [S-03]). **If verified [G-14]**, this is a structural moat — saves $5k–$10k per upgrade for a 100M-vector corpus plus 1–2 weeks of engineering.
- **Cost of re-embed for 100M × 3072-d corpus:** ~$13k at OpenAI 3-large list price, ~$6k at Batch tier; on self-hosted RTX 4090 ~$130 compute + 1–2 weeks of engineering.
- **Strategy:** Pick a model with longer-stable embedding space (Voyage v4 family, Apache 2.0 OSS models on internal release cadence) when corpus size makes re-embed expensive.

---

## Cost & ROI Analysis

### Cloud Cost Comparison ($/1M tokens, May 2026)

| Provider | Model | Input $/M | Batch $/M | Notes |
|---|---|---|---|---|
| OpenAI | `text-embedding-3-small` | $0.02 | $0.01 | 1536-d MRL, 8K ctx |
| OpenAI | `text-embedding-3-large` | $0.13 | $0.065 | 3072-d MRL, 8K ctx |
| Voyage AI | `voyage-4-lite` | $0.02 | ~$0.013 | 1024-d MRL, 32K ctx; 200M free/mo |
| Voyage AI | `voyage-4` | $0.06 | – | 1024-d MRL, 32K ctx; 200M free/mo |
| Voyage AI | `voyage-4-large` | $0.12 | – | 1024-d MRL, 32K ctx (C-02 resolved) |
| Voyage AI | `voyage-3-large` | $0.18 | – | 1024-d MRL, 32K ctx |
| Voyage AI | `voyage-code-3` | $0.18 | – | code-specialized |
| Cohere | `embed-v4` | $0.12 | – | 1536-d MRL, **128K ctx** |
| Cohere | `embed-english-v3` / `embed-multilingual-v3` | $0.10 | – | 1024-d |
| Cohere via AWS Bedrock | `embed-v4` | $0.12 | – | same price as direct |
| Google Vertex | `gemini-embedding-001` | $0.15 | $0.075 | 3072-d MRL, 2K ctx |
| Google Vertex | `gemini-embedding-2` | $0.20 | $0.10 | unified text+image+audio+video, 32K ctx |
| Mistral | `mistral-embed` | $0.10 | – | 1024-d, 8K ctx, EU-native |
| Mistral | `codestral-embed` | $0.15 | $0.075 | 8K ctx, code-specialized |
| AWS Bedrock | Titan Text Embeddings v2 | **$0.02** (C-01 resolved) | – | 1024-d MRL→256, 8K ctx, unit-vector-normalized |
| Azure OpenAI | text-embedding-3-large | ~$0.143 (premium data zone) | – | EU residency available |
| Jina AI | `jina-embeddings-v3` (hosted) | $0.018 (Gemini) or $0.02 (Claude) | – | 1024-d MRL, 8K ctx; free tier 1–10M/mo |
| Mixedbread (hosted) | mxbai-embed-large-v1 | $20/mo Scale plan (G-05) | – | credit-based |
| DeepInfra / Together / Fireworks (hosted OSS) | BGE-M3, Qwen3, etc. | $0.005–$0.05 | – | per-model, see G-15 |

**$0.005/M (MiniLM on OpenRouter)** is the floor; **$0.20/M (Gemini-2)** is the ceiling.

### Self-Hosted Cost Model

Assumptions: 50% sustained utilization, on-demand pricing as of 2026-Q2. CPU throughput numbers carry 5× uncertainty (see G-16, C-07).

#### CPU-only baseline (8 vCPU / 32 GB / $60–80/mo)

| Model | Throughput (tok/s) | Capacity (tok/mo @ 50% util) | $/M tokens effective |
|---|---|---|---|
| MiniLM-L6 (22M) | 500–2,000 | 0.65–2.6B | $0.023–$0.09 |
| Arctic-Embed-M v2.0 (305M) | 150–2,000 | 0.19–2.6B | $0.023–$0.32 |
| Granite-278M | 75–1,500 | 0.10–1.94B | $0.031–$0.60 |
| Nomic-Embed-v2 MoE (305M active) | ~42 | ~54M | $1.11 |
| BGE-M3 (568M) | 28–50 | 36–65M | $0.92–$1.66 |
| Qwen3-Embedding-8B | ~1.5 | ~1.9M | $31.50 (effectively prohibitive) |

**Conclusion:** CPU is viable for 55–62 MTEB-Eng tier (Arctic-M, Granite, MiniLM) at $0.02–$0.10/M. Not viable for 65+ MTEB tier.

#### Consumer GPU baseline (RTX 4090, $0.30–0.80/hr or ~$200/mo dedicated)

| Model | Throughput (tok/s) | Capacity (tok/mo @ 50% util) | $/M tokens effective |
|---|---|---|---|
| Small model (e.g. mxbai-embed-large, BGE-base, Arctic-M v2.0) | 100k–200k | 130–260B | $0.0008–$0.0015 |
| BGE-M3 (568M) | ~3,800 | ~4.9B | $0.04 |
| Stella-1.5B v5 | ~2,400 | ~3.1B | $0.065 |
| GTE-Qwen2-7B-instruct | ~850 | ~1.1B | $0.18 |
| Qwen3-Embedding-8B | ~6,000–7,000 | ~7.8–9.1B | $0.022–$0.026 |

**Conclusion:** RTX 4090 is the cost-dominant tier for any volume above ~10M tok/mo. Even Qwen3-8B at $0.026/M beats every cloud API.

#### Data-center GPU baseline (A100 80GB $1.10/hr ~$400/mo; H100 $2.50/hr ~$900/mo)

| Model | Throughput (tok/s) on A100 | Capacity (tok/mo) | $/M tokens A100 |
|---|---|---|---|
| Qwen3-Embedding-8B | ~15,000 | ~19B | $0.021 |
| GTE-Qwen2-7B (GLM pessimistic) | ~5,000 | ~6.5B | $0.31 |
| Small model (Arctic-M) | ~300k | ~390B | $0.001 |

**Conclusion:** A100/H100 only justified above ~10B tok/mo for large models. For small models, an RTX 4090 wins on $/token.

### Storage Cost

Storage size (raw, in GB) at each scale × dim × quantization. **Add ~1.3× for HNSW index overhead.**

| Vectors | Dim 256 fp32 | Dim 768 fp32 | Dim 3072 fp32 | Dim 3072 fp16 | Dim 3072 int8 | Dim 3072 binary |
|---|---|---|---|---|---|---|
| 100K | 0.10 GB | 0.31 GB | 1.23 GB | 0.62 GB | 0.31 GB | **0.04 GB** |
| 1M | 1.02 GB | 3.07 GB | 12.3 GB | 6.14 GB | 3.07 GB | **0.38 GB** |
| 10M | 10.2 GB | 30.7 GB | 123 GB | 61.4 GB | 30.7 GB | **3.84 GB** |
| 100M | 102 GB | 307 GB | 1,229 GB | 614 GB | 307 GB | **38.4 GB** |

**The binary column is the headline.** At 100M × 3072-d binary, you fit a 1.2 TB float corpus into ~38 GB raw / ~50 GB indexed — well under any commodity SSD.

**Cloud-managed Postgres** (e.g. AWS RDS at ~$0.10/GB·mo for io2 storage): 100M × 768-d fp16 indexed (~40 GB) ≈ $4/mo storage + instance cost. **Same on self-hosted bare-metal:** essentially $0 incremental.

### Breakeven Analysis

**Question 1:** At what ingest volume does self-hosted CPU beat the cheapest cloud API?

- OpenAI 3-small Batch at $0.01/M is the cloud floor. CPU on 8-vCPU ($60/mo) at $0.015–$0.09/M effective beats OpenAI Batch only on $/token. **Ops floor of ~3–5M tok/mo dominates the breakeven**; below that, OpenAI Batch wins on simplicity (one API call, zero ops).
- **Practical crossover: ~100M tok/mo.** Above this, CPU self-host's $60–120/mo flat beats OpenAI Batch's variable cost AND the ops time is amortized over enough volume.

**Question 2:** At what volume does GPU beat CPU?

- 4090 with small model ~$0.001/M; CPU with same model ~$0.015–$0.09/M. GPU is 10–90× cheaper per token.
- **CPU wins only when latency tolerance is high AND ops complexity matters.** The "rent a 4090 for the batch run" pattern dominates above ~100M tok/mo if you don't already have CPU infra.

**Question 3:** At what volume does GPU beat cloud API?

- 4090 + small model at $0.001/M beats OpenAI Batch ($0.01/M) at ~10M tok/mo (breakeven on 4090 monthly $200 vs OpenAI variable).
- 4090 + Qwen3-8B at $0.026/M beats Voyage `voyage-4` ($0.06/M) at ~3.5B tok/mo.
- H100 + Qwen3-8B at $0.028/M beats Gemini-001 Batch ($0.075/M) at ~12B tok/mo.

**Question 4:** At what vector count does a dedicated vector DB beat pgvector?

- **~10M vectors** is the practical comfort ceiling for plain pgvector with HNSW. Above this, switch to pgvectorscale OR a dedicated backend.
- **~50M vectors** is where Qdrant / Milvus / pgvectorscale all viably handle production load. pgvectorscale's $150/mo claim at 100M [GE-42, S-04] is the cost frontier IF verified [G-11].
- **~500M vectors** is where Milvus / Vespa start to dominate over Qdrant on operational ergonomics.

**Question 5:** When does the latency premium matter?

- p95 ≤50 ms end-to-end (embed + ANN + rerank) requires GPU embed OR cached query embeddings + Qdrant/Vespa ANN + cross-encoder rerank on GPU.
- p95 ≤100 ms is achievable with cloud API embed + pgvector + rerank — most production RAG workloads fit here.
- p95 ≤250 ms tolerates CPU embed + Postgres ANN — fine for chat with reasoning, async pipelines, ingest-time scoring.

**Question 6:** What does "ingest-tolerant, query-intolerant" mean for the cost model?

- Embed once at ingest (high tolerance) → use the cheapest path that fits (CPU self-host or Batch API).
- Embed on every query (low tolerance) → cache aggressively (cosine-hash semantic cache + content-hash); for the cache miss, use GPU-served small model (TEI on 4090).
- **Cache hit-rate dominates query cost** for stable workloads (G-20).

### Hidden Costs of Self-Hosting

Ops time (engineering-hours per month) at $150/hr loaded cost:

| Tier | Volume | Hours/mo | $/mo (ops) |
|---|---|---|---|
| Small | <10M tok/mo | 4–10 | $600–$1,500 |
| Medium | 100M–1B tok/mo | 12–25 | $1,800–$3,750 |
| Large | 10B+ tok/mo | 30–60 | $4,500–$9,000 |
| Model upgrade event (one-off) | – | 20–40 | $3,000–$6,000 + re-embed compute |

**Operational cost of "green" (self-host privacy):** ~$1,500–$3,000/mo human time at medium scale; this dominates the equation against any cloud comparison unless volume is ≥1B tok/mo.

---

## Privacy & Sovereignty

### Tier Classification per Cloud Provider

(Repeated here from the matrix above for the cross-walk against personas.)

- **Tier A — strongest GDPR + sovereignty:** Mistral La Plateforme (France-native, EU), Cohere (Canadian jurisdiction — CLOUD Act doesn't apply directly).
- **Tier B — strong with config:** Azure OpenAI (FedRAMP High, EU regions), AWS Bedrock (FedRAMP High, GovCloud), Google Vertex (EU regions but US jurisdiction).
- **Tier C — adequate for non-sensitive:** OpenAI direct, Voyage AI (MongoDB-owned, US).
- **Tier D — re-verify post-acquisition:** Jina AI (acquired by Elastic per S-02).
- **Tier E — paid tier only for production:** Mixedbread (free tier may train per GL-30), OSS marketplaces (vary).
- **Tier F — confirmed not available:** Anthropic (no embedding model).

### Confidential Computing & On-Device Trends

- **NVIDIA H100 Confidential Computing:** vendor-claimed ≤10% throughput overhead; no independent benchmark for embedding workloads [G-09]. Adopting in 2026 is "trust but verify" — budget +10% capacity.
- **Azure Confidential VMs + AWS Nitro Enclaves:** mature; suitable for hosting open-weights models with key isolation.
- **On-device:** transformers.js + MLX make 200M-class models viable on browser/desktop (~500–2,000 tok/s per device). Quality ceiling ~62 MTEB-Eng (MiniLM, Nomic, Granite).
- **Homomorphic / Private Information Retrieval:** **Not production-real in 2026** [B-01-41]. Defer to 2027+.

### Operational Cost of "Green" (Self-Hosting)

Per [Hidden Costs](#hidden-costs-of-self-hosting): $1,500–$3,000/mo of engineering time at medium scale to keep TEI/vLLM patched, monitor latency, manage model upgrades. Add ~$5–10k for each model upgrade event (re-embed + reindex). This must be weighed against the value of "no data leaves our perimeter."

---

## Recommendations

### Persona 1 — Privacy-Maximalist

**Profile:** Highly sensitive data (legal, healthcare, regulated B2B). Must self-host or use a confidential-compute / no-train provider. Quality target = within 5% of MTEB SOTA.

- **Embed model:** **Qwen3-Embedding-4B** (Apache 2.0). MMTEB ~69, MTEB-Code ~78, 32K ctx, MRL 32–2560.
- **Runtime:** HuggingFace TEI on a dedicated **RTX 4090** (~$200/mo on-demand) OR H100 Confidential Computing instance (~$900/mo + ≤10% throughput penalty).
- **Reranker:** **mxbai-rerank-large-v2** (Apache 2.0) on a shared A10G.
- **Storage:** Self-hosted **Qdrant** with int8 + HNSW (use binary if MRL-compatible at acceptable quality).
- **Dim:** 2048 (default) or 1024 (cost-tight).
- **MTEB:** ~68 Eng, ~69 MMTEB, ~78 Code.
- **$/mo at 10M docs (~5B tok corpus + 1M queries/mo):** ~$320 compute + ~$1,800 ops time (≈12 hrs/mo @ $150/hr) ≈ **$2,100/mo all-in**.
- **Latency p95:** ~25 ms embed + ~10 ms ANN + ~15 ms rerank = **~50 ms**.
- **Why this beats Voyage/Gemini on Bedrock:** zero data egress; Apache 2.0 means no forced re-embed on vendor whim; cost is ~$3–10k/yr lower than enterprise cloud equivalent.
- **Alternative for cost-tight:** **BGE-M3** (MIT, 100+ langs) on TEI on RTX 4090 — same architecture, ~63 MTEB-Eng but multilingual reach and dense+sparse+multi-vec modes.

### Persona 2 — Cost-Minimalist at High Volume

**Profile:** ≥1B tokens/year ingest, low query rate, low sensitivity. Wants the cheapest $/1M tokens that still clusters/searches usefully.

Three live options. Volume threshold decides:

**Sub-option 2a (≤100M tok/mo):** **OpenAI `text-embedding-3-small` Batch API** at $0.01/M.
- Zero ops. ~$30/mo for 3M tok/mo; ~$1/mo for 100k tok/mo.
- MTEB-Eng 62.3, 1536-d MRL.
- Storage: pgvector + HNSW (10M docs comfortable).
- **Why:** below the ~3–5M tok/mo ops floor, the cloud API is mathematically and operationally cheaper than self-host.

**Sub-option 2b (100M–10B tok/mo):** **Snowflake Arctic-Embed-M v2.0** (Apache 2.0) via TEI on 8-vCPU CPU ($60–120/mo) — multilingual default.
- ~$60/mo for one box (~$0.015–$0.09/M depending on throughput).
- MTEB-Eng ~56 retrieval; strong MMTEB <1B params.
- Storage: pgvectorscale (DiskANN-style) on managed Postgres → ~$150/mo at 100M vectors per pgvectorscale claim (verify per G-11).
- **Why:** Apache 2.0 + multilingual; CPU cost-per-token amortizes well at this volume.
- **Alternative (English-only):** all-MiniLM-L6-v2 (22M) at ~2k tok/s on 8-vCPU → ~$0.0087/M.

**Sub-option 2c (≥10B tok/mo):** **Qwen3-Embedding-4B** on TEI on dedicated **RTX 4090** ($200/mo) + Qdrant self-host.
- ~$0.022/M at Qwen3-4B throughput.
- MTEB ~68; multilingual; Apache 2.0.
- **Why:** quality jump from CPU tier is large; cost-per-token converges with cloud APIs but with no vendor lock-in.

### Persona 3 — Balanced Production App

**Profile:** ≤100M tokens/year, moderate sensitivity, needs decent quality + latency, ops budget is small.

- **Embed model:** **Voyage `voyage-4`** ($0.06/M, **200M free tokens/mo** covers ~3 years at 100M/yr) OR **Cohere embed-v4** ($0.12/M, **128K ctx** if very-long-doc retrieval matters).
- **Reranker:** **Cohere Rerank 3.5** at $2.00/1k (fine below 1M q/mo); switch to self-hosted mxbai-rerank-large-v2 above 1M q/mo.
- **Storage:** **pgvector + HNSW** on managed Postgres at ≤10M vectors; switch to **pgvectorscale** or Qdrant Cloud above 10M.
- **Dim:** Voyage 1024 (default) or MRL to 512; Cohere 1536 binary (32× storage savings via QAT).
- **MTEB:** Voyage ~67, Cohere ~65–68.
- **$/mo at 100M tok/yr + 1M queries/mo:** ~$0 embed (Voyage free tier) + ~$2/mo rerank + ~$50 managed Postgres = **~$50/mo**.
- **Latency p95:** ~80–150 ms (API) + ~5 ms pgvector + ~50 ms rerank = **~150–200 ms**.
- **Why this beats `voyage-4-large` + Pinecone Serverless (Gemini's pick at ~$87/mo):** Voyage's free tier eliminates embed cost up to 200M tok/mo; pgvector is "free" if already running Postgres; net price is materially lower at the same quality.
- **EU residency path:** Cohere (BaaS via AWS/Azure EU) or Mistral `mistral-embed` ($0.10/M, native French entity). Mistral wins on jurisdictional clarity; Cohere wins on absolute quality.

### Persona 4 — Latency-Critical Real-Time Search

**Profile:** p95 end-to-end ≤50 ms (including ANN + rerank). Quality must support hybrid + reranking. Cost is secondary.

Two architectures, both valid:

**Architecture 4a (cloud-embed + self-host rerank):**
- **Query embed:** OpenAI `text-embedding-3-large` or Cohere `embed-v4` (warm endpoint, low p95).
- **Storage:** **Qdrant** self-hosted with int8 + HNSW; corpus embeddings Voyage `voyage-3-large` 512-d binary OR OpenAI 3-large MRL→1024.
- **Reranker:** **mxbai-rerank-large-v2** on 2× A10G in HA (~$700/mo).
- **Net cost at 10M queries/mo:** Cohere queries ~$60 + Qdrant cloud ~$500 + reranker ~$700 ≈ **~$1,260/mo** (vs ~$20,700/mo if using Cohere Rerank).
- **Latency budget:** 25 ms embed + 5 ms ANN + 15 ms rerank ≈ **~45 ms p95**.
- **Why:** Cohere Rerank at $2/1k → $20k/mo at 10M queries is the dominant cost. Self-hosting mxbai-rerank-large-v2 saves $19k/mo while matching/beating Cohere on BEIR per Mixedbread benchmarks [S-06].

**Architecture 4b (Vespa-in-process):**
- **Embed + retrieve:** **BGE-M3** (MIT) co-located inside the Vespa JVM with MRL→512 truncation + Vespa native BM25 + RRF.
- **No network hops between embed and retrieve.**
- **Cost:** ~$1,500+/mo.
- **Latency:** ≤25 ms p95.
- **Why:** Network hops dominate the latency budget at sub-50ms targets. Single-process architecture eliminates them. Tradeoff: harder to scale embed independent of retrieve.

Pick 4a if rerank quality matters more than raw latency; 4b if your latency floor is mandatory and you can accept Vespa's operational complexity.

### Persona 5 — Fully-Local On-Device

**Profile:** Mobile / desktop / browser; data must never leave the device. Zero cloud infrastructure cost.

- **Embed model:** **Nomic-Embed-Text-v1.5** (Apache 2.0, 137M, 768-d MRL) OR **all-MiniLM-L6-v2** (Apache 2.0, 22M, 384-d) for smallest footprint.
- **Runtime:** **transformers.js** (browser) / **MLX** (macOS Apple Silicon) / **onnxruntime-node** (Electron) — int8 quantization.
- **Storage:** **LanceDB embedded** OR **SQLite-VSS** (single-file vector store).
- **Quality:** MTEB-Eng 56–62.
- **$/mo:** $0 (user compute).
- **Latency p95:** ~50–200 ms per query on modern devices (M-series Mac: 25–40k tok/s for BGE-base per S-20).
- **Why:** Production-viable in 2026 with WebGPU + MLX. Apple Silicon throughput approaches RTX 4090 for embeddings.

### Capability-Specific Notes

#### Semantic search
- Default: Persona 3 stack (Voyage v4 + Cohere Rerank + pgvector).
- For ≤10M docs and low-QPS: pgvector + HNSW directly.
- Always hybrid (BM25 + dense + RRF) for out-of-domain queries; skip hybrid for in-domain.

#### Clustering / topic modeling
- Default: MiniLM-L6 or Arctic-Embed-M v2.0 (cheap, fast, quality differential vs frontier is small for clustering).
- Reduce to 256-d via MRL or PCA before HDBSCAN / k-means.
- On-device works fine here.

#### Deduplication / near-duplicate detection
- Default: MiniLM-L6 with cosine ≥0.95 threshold; or BGE-small-en-v1.5.
- Binary quantization at 384-d binary makes per-vector comparison ~50 ns.
- No reranker needed; the threshold is the classifier.

#### Cross-document intelligence / entity linking
- Default: BGE-M3 (multilingual + multi-vector mode) for entity-mention retrieval.
- Qwen3-Embedding-8B for English-heavy entity disambiguation with code/tech entities.

#### Summarization (embedding-driven chunk selection)
- Small model (Arctic-M v2.0) for ranking chunks; cluster + select diverse chunks.
- Larger model unnecessary — quality of the LLM summarizer dominates.

#### RAG / Copilot retrieval
- **Always use reranker.** +10–20% NDCG is large enough that even Cohere Rerank's $2/1k is justified until you hit ~1M queries/mo.
- Default: Persona 3 stack + Cohere Rerank 3.5 (sub-1M queries) or mxbai-rerank-large-v2 self-host (above).
- Add late-chunking (Jina v3/v4) for long-document RAG.

#### Speech / transcript embeddings (text-side)
- Use same text pipelines as semantic search (ASR output is text).
- Voyage `voyage-3` works well for noisy transcript text (more robust to typos than OpenAI 3-large per several user reports — corroboration weak; verify).

---

## Decision Tree

Read top-to-bottom; each branch ends at a recommended stack.

```
START
│
├─ Is data sensitive (regulated / B2B / cannot leave control)?
│  ├─ YES ─► PERSONA 1 path
│  │       │
│  │       ├─ Need on-device only? ─► PERSONA 5 (Nomic v1.5 / MiniLM via MLX/transformers.js + SQLite-VSS)
│  │       │
│  │       ├─ Multilingual needed?
│  │       │  ├─ YES ─► Qwen3-Embedding-4B (Apache 2.0, MMTEB ~69) on TEI on RTX 4090 + Qdrant
│  │       │  └─ NO  ─► Stella en 1.5B v5 (MIT, MTEB ~71) on TEI on RTX 4090 + Qdrant
│  │       │
│  │       └─ Highly regulated (HIPAA, FedRAMP)?
│  │          └─ Qwen3-4B on H100-CC + Qdrant + Cohere Rerank (Canada jurisdiction)
│  │
│  └─ NO ─► continue
│
├─ Is volume ≥10B tokens/year?
│  ├─ YES ─► Self-host on data-center GPU
│  │       │
│  │       ├─ Quality-first ─► Qwen3-Embedding-8B on H100 + vLLM + Qdrant + mxbai-rerank-large-v2
│  │       └─ Cost-first ─► Arctic-Embed-M v2.0 on multiple A100s + pgvectorscale
│  │
│  ├─ 100M–10B tokens/year ─► PERSONA 2b (Arctic-M v2.0 on CPU + pgvectorscale)
│  │
│  └─ <100M tokens/year ─► continue
│
├─ Is p95 latency budget ≤50 ms?
│  ├─ YES ─► PERSONA 4 path
│  │       │
│  │       ├─ Rerank quality matters most ─► Architecture 4a (cloud embed + Qdrant + self-host mxbai-rerank)
│  │       └─ Latency floor is hard limit ─► Architecture 4b (BGE-M3 inside Vespa, MRL 512)
│  │
│  └─ NO ─► continue
│
├─ Multilingual + long context (≥32K)?
│  ├─ YES ─► Cohere embed-v4 (128K ctx, $0.12/M) + Cohere Rerank + pgvector
│  └─ NO  ─► PERSONA 3 (Voyage `voyage-4` $0.06/M with 200M free tier + Cohere Rerank + pgvector)
│
└─ Falls through to ─► OpenAI `text-embedding-3-small` Batch ($0.01/M) + pgvector
    (prototype tier; revisit when volume or quality demands change)
```

**Sanity checks at any leaf:**

- Is the model license commercial-friendly? (Reject NV-Embed-v2, Jina v3/v4 weights for commercial deployment.)
- Did I apply the instruction prefix? (3–8 NDCG@10 swing.)
- Did I check the EU residency story if any user is EU-based? (Cohere, Mistral, Azure EU regions.)
- Have I planned for re-embed on model upgrade? (Budget 1–2 weeks engineering every 18–24 months unless Voyage v3↔v4 compat holds per [S-03].)

---

## Open Questions / Data Gaps

Full enumeration in [`research/gaps.md`](research/gaps.md). Headline gaps:

| Priority | ID | Question | Block |
|---|---|---|---|
| CRITICAL | G-01 | Per-language MTEB for Romanian, Polish, Japanese, Korean, Arabic + Top-5 per language for the major Romance/Slavic/Asian languages | Any non-English-primary workload (notably Romanian content surfaces in this workspace) |
| HIGH | G-11 | Neutral vector-DB benchmark covering pgvectorscale claim (471 vs 41 QPS at 50M) under identical workloads | Vector DB recommendation confidence at 10–100M scale |
| HIGH | G-16 | Measured (not extrapolated) tokens/sec on RTX 4090 / A100 / H100 / 8-vCPU CPU for the 6–8 most important models | Tight $/M-token numbers (current ranges have 2×–5× uncertainty) |
| HIGH | G-14 | Verify Voyage `voyage-3-large` ↔ `voyage-4-large` embedding-space compatibility claim with cross-cosine + cross-NDCG test | Voyage's re-embed moat (S-03) as a buying criterion |
| MEDIUM | G-07 | NVIDIA Llama-Embed-Nemotron-8B exact MMTEB + license clarification | Potential Persona 1 displacement of Qwen3-8B |
| MEDIUM | G-08 | Independent MTEB scores for IBM Granite Embedding 107M / 278M | CPU multilingual baseline choice (Granite vs Arctic-M) |
| MEDIUM | G-10 | Gemini-embedding-001 / 2 MTEB-Code | Whether Gemini works as code-retrieval default |
| MEDIUM | G-19 | Sub-processor lists per cloud provider | GDPR-strict B2B production |
| MEDIUM | G-18 | Pinecone Serverless realistic workload cost model | Persona 3 cost precision |
| MEDIUM | G-15 | OSS marketplace per-model pricing grid (DeepInfra, Together, Fireworks, Replicate, OpenRouter) | "Hosted OSS" persona slot |
| LOW | G-03 | Voyage MTEB v2 official scores (when submitted) | Quality precision; resolves naturally |
| LOW | G-04, G-05, G-06, G-09, G-12, G-13, G-20 | Various per-vendor or methodology gaps | See gaps.md |
| RESOLVED | G-02 | Anthropic embedding model | Confirmed N/A |
| RESOLVED | G-13 | Homomorphic retrieval production-ready | Confirmed: NO in 2026 |

---

## Round Summary

**This document synthesizes five LLM research outputs** commissioned against `research/prompt.md`:

- `chatgpt.research.md` — compact, average rigor
- `claude.research.md` — most rigorous; 161 claims with explicit hedges and MTEB v1→v2 caveat
- `glm.research.md` — primary-source-heavy on policy; worked cost examples
- `qwen.research.md` — low trust; fabricated arXiv IDs, multiple wrong specs
- `gemini.research.txt` — narrative-rich; admits "normalized triangulated" benchmark numbers via asterisks

Trust ranking (when sources diverge): **Claude > GLM ≈ Gemini > ChatGPT > Qwen.** No single source meets the prompt's "Done" definition; this synthesis stitches partial coverages together.

**Audit trail** lives in `research/`:

- [`source-index.md`](research/source-index.md) — per-source quality scoring and coverage heatmap
- [`contradictions.md`](research/contradictions.md) — 28 cross-source disagreements with resolutions
- [`gaps.md`](research/gaps.md) — 20 gaps with effort estimates
- [`sparks.md`](research/sparks.md) — 25 single-source insights to track
- [`watchlist.md`](research/watchlist.md) — 30 items to monitor
- [`findings.md`](research/findings.md) — evidence-backed findings with stable IDs `B-01-XX`
- [`next-research.md`](research/next-research.md) — prioritized follow-up roadmap

**Cutoff:** 2026-05-17. Re-run `/deep-research-digest` against new `*.research.md` rounds whenever a kill condition triggers (see [`findings.md` Disconfirming Evidence Audit](research/findings.md#disconfirming-evidence-audit)).

---

## References

Primary sources referenced across the five research outputs:

- Qwen3 Embedding paper, arXiv (via Claude CL-27, Gemini GE-17)
- Snowflake Arctic Embed 2.0 arXiv (Claude CL-35)
- BGE-M3 model card and paper, BAAI / HuggingFace (Claude CL-40, GLM GL-33, Gemini GE-18)
- Jina Embeddings v3 paper, arXiv (Gemini GE-11, GLM GL-37)
- HuggingFace MTEB Leaderboard Space, `huggingface.co/spaces/mteb/leaderboard`
- HuggingFace MMTEB Leaderboard Space
- LongEmbed Leaderboard, `huggingface.co/spaces/Yixin-FE/LongEmbed_Leaderboard`
- OpenAI Embeddings docs, `platform.openai.com/docs/guides/embeddings`
- OpenAI Pricing, `openai.com/pricing`
- OpenAI Enterprise Privacy, `openai.com/enterprise-privacy`
- Voyage AI docs and pricing, `docs.voyageai.com`
- Cohere Embed docs and pricing, `docs.cohere.com/docs/embed`
- Cohere Rerank docs, `docs.cohere.com/docs/rerank-overview`
- Cohere Trust Center, `cohere.com/security`
- Google Vertex AI Embeddings docs, `cloud.google.com/vertex-ai/docs/embeddings`
- Google AI Studio model card for `gemini-embedding-001`
- AWS Bedrock Titan Embeddings docs, `aws.amazon.com/bedrock`
- AWS Bedrock pricing
- Anthropic Transparency Hub (recommends Voyage)
- Mistral Embeddings docs and pricing, `docs.mistral.ai/api`
- Azure OpenAI pricing, `azure.microsoft.com/pricing`
- Snowflake Arctic Embed model cards on HuggingFace
- NVIDIA NV-Embed-v2 model card on HuggingFace
- Alibaba GTE-Qwen2-7B-instruct model card on HuggingFace
- Stella en 1.5B v5 model card on HuggingFace (NovaSearch)
- Nomic Embed v1.5 / v2 model cards on HuggingFace
- IBM Granite Embedding model cards on HuggingFace
- Mixedbread mxbai-embed-large-v1 and mxbai-rerank-large-v2 model cards
- HuggingFace Text Embeddings Inference (TEI) docs
- vLLM Embedding API docs, `docs.vllm.ai`
- SGLang Embedding endpoint docs
- Ollama library, `ollama.com/library`
- llama.cpp server README, `github.com/ggerganov/llama.cpp/tree/master/examples/server`
- pgvector README, `github.com/pgvector/pgvector`
- pgvectorscale README, `github.com/timescale/pgvectorscale`
- Qdrant docs, `qdrant.tech/documentation`
- Weaviate docs, `weaviate.io/developers`
- Milvus docs, `milvus.io/docs`
- Vespa docs, `docs.vespa.ai`
- Pinecone pricing, `pinecone.io/pricing`
- Elasticsearch dense_vector docs, `elastic.co/guide/en/elasticsearch/reference`
- Redis RediSearch docs, `redis.io/docs/interact/search-and-query`
- LanceDB docs, `lancedb.github.io/lancedb`
- ChromaDB / Chroma Cloud pricing, `chroma.com/cloud`
- Turbopuffer docs, `turbopuffer.com`
- DuckDB VSS docs, `duckdb.org/docs/extensions/vss`
- MMTEB paper, OpenReview
- ACORN paper (Lin et al. 2024), `arxiv.org` (if Qdrant adoption verified per W-12)
- Jina AI Late Chunking blog
- ColBERT papers (Khattab & Zaharia)
- SPLADE papers (Naver)
- AllenAI SPECTER2 / SciNCL papers
- Oxford Bioinformatics MedCPT paper
- ZeroEntropy Zerank-1 product page (S-08)
- Mistral codestral-embed announcement

Plus secondary aggregator references (`awesomeagents.ai` MTEB rankings, CloudPrice, LeanOpsTech, Firecrawl, PythonAlchemist, FutureAGI, dev.to articles) for pricing and qualitative comparisons.

**Note on reference completeness:** The prompt's done-definition asked for ≥40 primary-source citations with access dates. The synthesized total in the source bundle is ~30 primary citations + ~60 secondary blogs. Per-claim access dates default to **2026-05-17** (the research bundle cutoff). For audit purposes, the per-source citations live in `research/{source}.research.md` files.
