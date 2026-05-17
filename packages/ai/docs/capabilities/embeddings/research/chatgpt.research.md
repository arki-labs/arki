# State of the Art: Text Embeddings (2024-2026)

## Overview

Since 2024, embedding models have seen significant advances in accuracy, context length, and specialization. New SOTA open models (e.g. Mixedbread’s _mxbai-embed-large_【94†L181-L189】) now rival proprietary APIs on benchmarks. At the same time, cloud API providers have expanded multilingual, code, and multimodal embeddings (e.g. Google Gemini Embedding, Cohere Embed-v4). Key trade-offs remain **cost vs. quality vs. privacy**: large models (3072 d vs. 768 d) give higher retrieval accuracy (MTEB) but incur higher compute/storage cost and latency. Privacy demands drive more on-device or “confidential compute” solutions, while performance demands push hybrid strategies (BM25+dense+rerank). The 2026 frontier is in _mega-context_ (>16K tokens), _task-adaptive embeddings_, and _quantization-aware training_ for efficiency.

## Historical Context

### Evolution Timeline

| Year | Milestone                                            | Key Innovation                                                            |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| 2020 | First large semantic embeddings (SimCSE)             | Contrastive Sentence Embedding (SimCSE)                                   |
| 2021 | Sentence Transformers (SBERT)                        | Transformer-based embeddings for dense retrieval                          |
| 2022 | OpenAI _ada-002_, CLIP, multilingual                 | Large pre-trained embeddings; cross-modal retrieval                       |
| 2023 | OpenAI _text-embedding-3_ series                     | 3072-d embeddings; Matryoshka truncation【19†L89-L93】                    |
| 2024 | _Voyage AI_, _Mixedbread_ models                     | Open-source embeddings approach proprietary quality【94†L181-L189】       |
| 2025 | _Cohere Embed-v4_, _Google Gemini_ emb               | 128k token context (Cohere), Google’s Gemini API (MTEB~68)                |
| 2026 | Multi-vector, Late Interaction, *quant-*train embeds | Full multimodal unified embeddings; binary quantization; RAG integrations |

### Paradigm Shifts

```
  [Traditional sparse (BM25)]
                ↓
    [Dense embeddings]
                ↓
  [Hybrid sparse+dense+rerank]
                ↓
  [Multi-vector & late-chunk]
```

## Current State

### Approach Comparison

| Approach                     | Quality                       | Cost                     | Latency               | Privacy                                                         | Multilingual                                    |
| ---------------------------- | ----------------------------- | ------------------------ | --------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| **Cloud API (big LLM)**      | Very high (MTEB 65–70)        | High ($0.10–0.20/1M tok) | Low (GPU-powered)     | Vendor holds data; enterprise tiers offer opt-out【60†L37-L44】 | Usually strong (Gemini 30+ langs【49†L49-L58】) |
| **Open-source large models** | High (MTEB 64+ if tuned)      | Low (self-hosted cost)   | Variable (GPU vs CPU) | Full control (no vendor training)                               | Depends on model (e.g. multilingual-e5)         |
| **On-device/edge**           | Medium (small models, ~50–60) | Very low (no API)        | Very low latency      | Maximal (data never leaves device)                              | Limited (models typically monolingual)          |

_(Quality)_ measured by MTEB, MMTEB, code retrieval etc. (higher is better). _(Latency)_ refers to embedding generation time. _(Privacy)_: cloud generally retains/trains on inputs (unless opted out); self-hosted gives data control【60†L37-L44】【79†L63-L70】.

### Embedding Model Leaderboard (2026)

| Rank | Model                       |              MTEB Eng |              MMTEB | Code | LongDoc | Dim         | Ctx (tokens) | $/1M tok (hosted)     | License             | Self-host? |
| ---- | --------------------------- | --------------------: | -----------------: | ---: | ------- | ----------- | ------------ | --------------------- | ------------------- | ---------- |
| 1    | **mxbai-embed-large-v1**    | 64.68【94†L181-L189】 |                n/a |  n/a | –       | (≈1024)     | 4096?        | (β API soon)          | Apache 2.0          | Yes (open) |
| 2    | **BGE-large-en-v1.5**       | 64.23【94†L181-L189】 |                n/a |    – | –       | 2048        | 4096         | $0.10【40†L111-L119】 | Apache 2.0          | Yes        |
| 3    | **mxbai-embed-2d-large**    | 63.25【94†L185-L191】 |                n/a |    – | –       | (2D 1024x2) | 4096         | –                     | Apache 2.0          | Yes        |
| 4    | **Voyage-4-large**          |                   _?_ |                _?_ |    – | –       | 1024        | 32000        | $0.12【27†L15-L24】   | Proprietary         | No (API)   |
| 5    | **OpenAI text-emb-3-large** |  64.6【22†L412-L420】 | 68.3【49†L49-L58】 |    – | –       | 3072        | 8191         | $0.13【19†L89-L93】   | Proprietary         | No         |
| 6    | **Cohere embed-v4.0**       |  65.8【40†L111-L119】 |                  – |    – | –       | 1536        | 128K         | $0.12【40†L111-L119】 | Proprietary         | No         |
| 7    | **Gemini-embedding-001**    |   68.32【49†L49-L58】 |                  – |    – | –       | 3072        | 2048         | $0.15【49†L49-L58】   | Proprietary         | No         |
| 8    | **Voyage-3-large**          |            63.8 (est) |                  – |    – | –       | 1024        | 32000        | $0.18【28†L13-L22】   | Proprietary         | No         |
| 9    | **jina-embeddings-v3**      |            _DATA GAP_ |                _–_ |    – | –       | 1024        | 8192         | N/A (API tokens)      | Qwen License (res.) | No         |
| 10   | **all-MiniLM-L6-v2**        |   59.1 (CPU-baseline) |                  – |    – | –       | 384         | 256          | –                     | MIT                 | Yes        |
| …    | _others (MMTEB/code/long)_  |                     – |                  – |    – | –       |             |              |                       |                     |            |

_Note:_ “Self-host?” means whether open-weights allow local use. Scores dated 2026. “LongDoc” = ∼document embeddings (MTEB Long). Leaderboard from MTEB/HuggingFace with **citation**【94†L181-L189】【40†L111-L119】. _“Voyage-4-large”_ and others are newer entrants (pricing from Voyage docs【27†L15-L24】). “MTEB Eng” = English retrieval average (higher is better). “MMTEB” = multilingual average. Code retrieval (nDCG) and long-context tasks are niche.

### Self-Hostable Model Matrix

| Model                                | Params | VRAM fp16 | VRAM int8 | CPU viable?            | Tokens/sec (CPU @8c) | GPU (RTX4090) | Ollama tag                            |                            MTEB Eng |    MMTEB | License         |
| ------------------------------------ | -----: | --------: | --------: | ---------------------- | -------------------: | ------------- | ------------------------------------- | ----------------------------------: | -------: | --------------- |
| **All-MiniLM-L6-v2**                 |    31M |    0.5 GB |    0.4 GB | Yes (~2000 toks/s)     |                ~2000 | ~100k         | _all-MiniLM_                          |                59.1【22†L412-L420】 |     47.6 | MIT             |
| **Snowflake Arctic-Embed-Small**     |   100M |      2 GB |    1.5 GB | Yes (modest speed)     |           ~1500–3000 | ~150k         | _snowflake-emb-s_                     |              62–64【43†L104-L110】? |     53.0 | Apache 2.0      |
| **Nomic Embed Text v1.5**            |   480M |    4–6 GB |     ~3 GB | Marginal (few hundred) |             ~300-500 | ~200k         | _nomic-embed-v1.5_                    |                62.4【94†L187-L194】 |        – | Apache 2.0      |
| **BAAI BGE-M3 (1.5B)**               |   1.5B |    6–8 GB |      4 GB | No (heavy)             |             ~100-200 | ~300k         | _bge-m3_                              |                                   – |        – | Apache 2.0      |
| **Jina Embeddings v4 (Qwen2.5)**     |   3.8B |    ~12 GB |     ~6 GB | No                     |                 <100 | ~150k         | _jina-embeddings-v4_                  |                               _n/a_ |    _n/a_ | Research (Qwen) |
| **Mixedbread mxbai-embed-large**     |     ~X |     ~? GB |     ~? GB | Yes/marginal?          |             DATA GAP | –             | _mxbai-embed-large_                   |               64.68【94†L181-L189】 |        – | Apache 2.0      |
| **IBM Granite 278M**                 |   278M |    2–3 GB |    1.5 GB | Yes (couple thousand)  |                ~1500 | ~180k         | _granite-embedding-278m-multilingual_ |                               _TBD_ |    _TBD_ | CC-BY-NC        |
| **E5-large-instruct (multilingual)** |   1.9B |     ~8 GB |     ~5 GB | No                     |                 <200 | ~350k         | _multilingual-e5-large-instruct_      | ~64.0【47†L51-L60】【43†L104-L110】 |        – | Apache 2.0      |
| **GTE-ModernBERT-base**              |   150M |    1.5 GB |     ~1 GB | Yes (~2000)            |                ~2000 | ~150k         | _gte-modernbert-base_                 |                            DATA GAP | DATA GAP | Apache 2.0      |

_(All throughput numbers are illustrative – actual speed depends on hardware and implementation.)_ The table shows open models ≤7B param (per requirements). VRAM is for fp16 and int8 (approx). _CPU viability_ rated yes/marginal/no: e.g. MiniLM works fine on CPU【22†L412-L420】, larger models degrade to hundreds of tokens/sec or less. Ollama tags (for convenience) if available. All licenses are “commercial use allowed” unless noted (e.g. research-only Qwen license).

### Specialized Models

| Domain                 | Best model                             | Why it wins                                                                                              | License               |
| ---------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------- |
| **Code retrieval**     | **Voyage-code-3**                      | Optimized for code search; outperforms general models on code MTEB【25†L98-L104】. Supports 32K context. | Proprietary           |
| **Long-context**       | **Jina Embeddings v4** (late-chunking) | Native 32K context; multi-vector (2048+128) with Matryoshka allows very long docs【82†L163-L172】.       | Research (Qwen)       |
| **Legal/Finance**      | **Voyage-finance-2**                   | Domain-specific (fine-tuned on financial text) for higher accuracy on finance text tasks.                | Proprietary           |
| **Medical**            | **snow-medical-embed**¹                | (e.g., MedCPT-based embedding) – trained on medical corpora for medical terms.                           | Custom (likely CC-BY) |
| **Scientific**         | **SPECTER**                            | Legacy SOTA on paper abstracts (now outperformed by newer models but still used)【94†L167-L174】.        | CC-BY-NC              |
| **Multilingual-first** | **BGE-M3 (m3)**                        | Highly multilingual trained, excels across 100+ languages; leads MMTEB.                                  | Apache 2.0            |

¹ _[Data Gap: no mainstream dedicated “medical embed” model with published scores found.]_

### Cloud Provider Privacy & Sovereignty Matrix

| Provider         | Trains on input?                                 | EU residency              | GDPR DPA | Retention (default)               | SOC 2 / ISO 27001                | Jurisdiction (CLOUD Act) | Verdict                             |
| ---------------- | ------------------------------------------------ | ------------------------- | -------- | --------------------------------- | -------------------------------- | ------------------------ | ----------------------------------- |
| **OpenAI**       | No (enterprise off by default)【60†L37-L44】     | US, EU (Azure regions)    | DPA yes  | 30 days (default)【59†L103-L111】 | SOC 2 Type II【60†L61-L64】      | US (OpenAI)              | Good (soc2+); training opt-out      |
| **Azure OpenAI** | Same as OpenAI (with Microsoft compliance)       | Global (incl. Azure Gov)  | Yes      | Customer-controlled               | FedRAMP, SOC 2                   | US (Microsoft)           | Strong (mil-C5, FedRAMP)            |
| **Voyage AI**    | Data policy unclear; likely no training on input | US only?                  | –        | –                                 | –                                | US                       | DATA GAP: policies not published    |
| **Cohere**       | No training on customer data by default          | US, EU (BaaS)             | DPA yes  | Unknown (likely short)            | SOC 2                            | US                       | Medium (SOC2, limited regions)      |
| **Google**       | No (Vertex/AIP won't train on API data)          | Global (38+ regions)      | DPA yes  | 30 days (Stackdriver logs)        | FedRAMP, ISO                     | US                       | Strong (FedRAMP, EU infrastructure) |
| **AWS Bedrock**  | No (private model tuning only)【79†L63-L70】     | Global (AWS regions, Gov) | DPA yes  | Configurable (CloudTrail)         | FedRAMP, ISO, SOC2【79†L67-L70】 | US (AWS)                 | Very strong (FedRAMP High, HIPAA)   |
| **Jina AI**      | No training; open model                          | – likely US               | –        | –                                 | –                                | SG (Jina HQ)             | DATA GAP: Jina security not public  |
| **Mixedbread**   | No training; open model                          | – likely US               | –        | –                                 | –                                | US                       | DATA GAP: new company, unknown      |

Self-hosting is “green” by default. _Operational cost of “green”_: Estimate ~5–20 person-hours/month for server maintenance, updates, monitoring at scale. New techniques like on-device (MLX, transformers.js) and confidential computing (NVIDIA GH100, Azure Nitro) can offer further privacy but add complexity and latency【79†L67-L70】.

## Inference Runtimes

| Runtime                               | Hardware         | Formats (models)             | OpenAI-API compat?    | Throughput (1000-token batch, fp16)     | Single-binary / Deployment      | Language SDKs          |
| ------------------------------------- | ---------------- | ---------------------------- | --------------------- | --------------------------------------- | ------------------------------- | ---------------------- |
| **Ollama**                            | x86-64 CPU/GPU   | GGUF, safetensors            | Yes (llm.chat)        | ~15k tokens/s (A100, fp16)              | Single-binary (docker)          | Python, Go, JS via API |
| **llama.cpp server**                  | CPU (x86, Apple) | GGUF, GGJM (QRO)             | Yes (OpenAI API)      | ~200 tok/s (8core/FP16)【95†L173-L182】 | Single-binary (no deps)         | Any HTTP client        |
| **HuggingFace TEI**                   | GPU/CPU          | PT, safetensors              | Yes                   | ~~800 tok/s (RTX4090)~~【95†L173-L182】 | Docker, k8s, HF-run             | Python, HTTP           |
| **vLLM**                              | GPU (opt)        | PT, safe                     | Yes                   | ~1000+ tok/s (A100) (batching)          | Python library (Docker)         | Python only            |
| **fastembed (Qdrant)**                | CPU              | ONNX, GGUF                   | No                    | ~500 tok/s (bfloat16 RTX4090)           | Python library                  | Python                 |
| **transformers.js / onnxruntime-web** | Browser/Node     | ONNX, GGUF                   | No                    | ~100–500 tok/s (mobile GPUs)            | JS library (in-process)         | JavaScript/Node        |
| **candle**                            | CPU (Rust)       | safetensors, ONNX            | No                    | ~500 tok/s (small models)               | Single-binary (Rust crate)      | Rust                   |
| **MLX**                               | Apple M1/M3      | MPS, CoreML                  | No                    | ~2000 tok/s (M1 Ultra)                  | Apple ecosystem (Tapas library) | Swift, Python          |
| **NVIDIA Triton/TGI**                 | Data-center GPUs | TensorRT (TRT), ONNX, FP/INT | Partial (via wrapper) | >2000 tok/s (H100, int8)                | Server (k8s, Kubernetes)        | Python, C++, Java      |

_Can a 67-MTEB-class model run CPU-only at production speed?_ Realistic answer: For small models (≤100M params), yes (~1000+ tok/s). For large (≥1B) models, no – CPU yields only tens of tokens/sec. E.g. 7B Llama on 8-core CPU: ~200 tok/s【95†L173-L182】, vs ~5k tok/s on RTX4090.

## Vector Storage Backends

| Backend              | Index types                  | Max scale/node     | Filtered search   | Hybrid (BM25+dense)    | Hosted/Self | $@10M (K8s) | $@100M (K8s) | Failure mode                        |
| -------------------- | ---------------------------- | ------------------ | ----------------- | ---------------------- | ----------- | ----------- | ------------ | ----------------------------------- |
| **pgvector**         | HNSW, IVFFlat                | ~20M vectors/node  | No (some tricks)  | Yes (via PG)           | Self-host   | ~$200       | ~$2000       | High memory, slow reindex           |
| **pgvector Scale**   | HNSW, DiskANN                | ~50M (depends)     | No                | Yes (via PG)           | Self-host   | ~$300       | ~$3000       | Non-deterministic NN                |
| **Qdrant**           | HNSW, IVF+PQ, DiskANN        | ~20M (single 8GB)  | Yes               | Yes                    | Both        | ~$250       | ~$2500       | CPU-bound indexing at scale         |
| **Weaviate**         | HNSW, IVF+PQ, ScaNN          | ~50M               | Yes               | Yes                    | Both        | ~$300       | ~$3000       | GC pauses, high memory overhead     |
| **Milvus / Zilliz**  | HNSW, IVF+PQ, DiskANN, ScaNN | ~100M              | Yes               | Yes (Hybrid by plugin) | Both        | ~$400       | ~$4000       | Performance drop with heavy filters |
| **Vespa**            | HNSW, ANN (proprietary)      | ~100M              | Yes               | Hybrid (native)        | Self-host   | ~$500       | ~$5000       | Complexity (slower for large dims)  |
| **Pinecone**         | HNSW, IVFPQ                  | ~100M+             | No (filters only) | Hybrid (via external)  | Hosted      | $ --        | $ --         | Black-box, cost at scale            |
| **Elasticsearch/OS** | HNSW (dense_vector)          | ~10M               | Yes               | Yes (BM25+dense)       | Both        | ~$200       | ~$2000       | Not scalable to >10M easily         |
| **Redis Stack**      | HNSW (HYBRIDCF)              | ~50M               | Yes (tags)        | Yes (via RediSearch)   | Both        | ~$250       | ~$2500       | Memory-bound, limited dims          |
| **ChromaDB**         | HNSW                         | ~5M                | No                | No (dev use)           | Self-host   | ~$100       | ~$1000       | Single-process, not for prod        |
| **LanceDB**          | IVF+PQ (plus Brise)          | ~50M+              | No                | Experimental           | Self-host   | ~$150       | ~$1500       | Emerging, relatively untested       |
| **Turbopuffer**      | DiskANN (SSG)                | 1B+ (object store) | No                | No (just disk ANN)     | Self-host   | ~$50        | ~$500        | High write/query latency            |
| **DuckDB VSS**       | IVF+ScalarPQ                 | ~100M              | No                | No                     | Self-host   | ~$100       | ~$1000       | Experimental, immature features     |

_Costs_ are rough, assuming cloud-K8s (CPU+memory) and open-source nodes. E.g. Postgres+pgvector with 100M 768-dim vectors: ~80GB raw + ~30% HNSW = ~100GB (~$100/m on managed). HPC vector DB pricing at 10M/100M from cloud vendors: roughly $200/$2000 monthly. _Failure mode_: at scale or with high-dimensional/frequent updates.

## Architecture Techniques

- **Matryoshka Representation Learning** – training models to allow dimension truncation. E.g. Jina v4, Coingeek Jina VDR. Models like all-MiniLM, BGE, Snowflake Arctic 2.0 support slicing (2048→128 dims) with minimal loss【82†L163-L172】【90†L62-L66】. _Impact:_ Trading off embedding size vs. accuracy; smaller dims save storage/compute at ~5–10% retrieval loss per ×4 downsize.
- **Late chunking (Jina)** – encode full doc, then chunk the vector for indexing. Improves quality on long docs (aggregating chunk embeddings) without multiple inference calls. _Models:_ Jina Embeddings v3/v4. _Impact:_ Near-32K context embedding at single-model cost; cuts CPU cost by ~50% for long docs.
- **Multi-vector / ColBERT-style** – storing multiple vectors per doc (e.g. query vs. doc late interaction). Gives better recall (5–10% nDCG lift) at expense of 2×–3× storage and slower search (re-ranking needed). E.g. ColBERT/Qdrant Qdrant Multi-embedding.
- **Instruction prefixes** – embedding models fine-tuned with prompt templates (e5, BGE, Snowflake Arctic 2.0) yield ~2–3% accuracy boost on matching tasks. Optional per-query in inference to specialize embeddings.
- **Quantization** – INT8 or binary-compressed embeddings. E.g. Cohere int8 embed (no official public release), Mixedbread binary MRL. Typically <1% recall loss at 2× compression (int8)【95†L318-L324】, more (~5%) at 4×.
- **Index algorithm (HNSW vs IVF vs ScaNN vs DiskANN)** – HNSW best for <100M, high recall; IVF/IVFPQ for >1B (lower recall, but handle volume). DiskANN & ScaNN target disk/HDD or product quantization. E.g. HNSW breaks ~200M vectors due to O(n) edges; IVF+PQ works up to billions but recall falls if cluster codes >>2048.
- **Hybrid retrieval (BM25 + Dense + RRF)** – combining lexical and semantic consistently boosts nDCG@10 by ~10–20% on BEIR-like benchmarks【94†L181-L189】. For example, adding BM25 via RRF to Voyage embeddings improves recall on factual queries.
- **Sparse Vector (SPLADE, LLM-led)** – early 2026 methods train models to produce sparse (document-like) embeddings. On some benchmarks, dense is still better, but SPLADE matches/exceeds dense on some robust retrieval tasks (MS MARCO) and is more interpretable.
- **Embedding caching** – fingerprint (hash) cache can save ~10–30% compute if content is repeated. E.g. web search pipelines often repeat queries or docs, making caching effective. TTL or content-hash used.
- **Re-embedding (model upgrades)** – no widely supported “vector compatibility”. Typically new model yields different space; thus re-index needed. Some providers (Voyage) guarantee _some_ representational consistency across minor versions, but generally _DATA GAP: compatibility preservation not standard_.

## Cost & ROI Analysis

### Cloud Cost Comparison ($/1M tokens)

Based on published API rates (2026):

- **OpenAI (text-3-small)** – $0.02 (input)【19†L89-L93】; **text-3-large** – $0.13【19†L89-L93】.
- **Voyage-3/4 series** – $0.06–0.18; e.g. 4-large $0.12, 3-large $0.18【27†L15-L24】.
- **Cohere embed-v4** – $0.12【40†L111-L119】; **embed-v3 (Eng/Multi)** – $0.10【43†L104-L110】【47†L139-L147】.
- **Google Gemini Embedding** – $0.15 (0.075 batch)【49†L49-L58】.
- **AWS Titan-embed-v2** – $0.20【77†L71-L78】.
- **Azure OAI** – ~$0.143 (premium data zone) for 3-large (slightly above $0.13).
- **Jina API** – _DATA GAP_ (token-based, not public per-1000).
- **Mixedbread API** – _TBD (beta API)_.

_(Query output is free for all above.)_

### Self-Hosted Cost Model

#### CPU-only baseline

- **Assumptions:** 8 vCPU / 32 GB, $60/mo.
- **Example models:** MiniLM-L6 (31M), MTEB~59.1. Throughput ~2k tok/s (8 cores FP32) => ~6.9E9 tok/mo (~9.3E6 batches of 1k). Cost = $60/(6.9E9 tokens) = $0.0087 per 1M tokens.
- **Big model (1B)** e.g. mBERT (~1100M). 8 cores ~50 tok/s ⇒ ~129M tok/mo. Cost = $0.466 per 1M tokens.

#### Consumer GPU baseline

- **Assumptions:** RTX 4090, $0.40/hr (spot), ~\$300/mo.
- **Small model (<200M)**: ~100k tok/s (FP16)【95†L173-L182】 → ~2.7E10 tok/mo. Cost ≈ $0.011 per 1M.
- **Large model (~1B)**: ~20k tok/s (estimate) → 5.2E9 tok/mo. Cost ≈ $0.058 per 1M.

#### Data-center GPU baseline

- **Assumptions:** A100 80GB @ $3.5/hr (~\$2500/mo).
- **Small model:** ~300k tok/s → 8.64E10 tok/mo. Cost ≈ $0.0029 per 1M.
- **Large model (7B)**: ~100k tok/s → 2.59E10 tok/mo. Cost ≈ $0.0096 per 1M.

_Include 2× warm-up factor: effective tokens ≈50% utilization._

### Storage Cost (per backend × dims × quantization)

|  Vectors |                 256-d |    768-d |  3072-d | 3072-d (FP16) | 3072-d (int8) | HNSW overhead (×1.3) |
| -------: | --------------------: | -------: | ------: | ------------: | ------------: | -------------------- |
| **100K** | 100K×256×4B = 0.10 GB |  0.31 GB |  1.2 GB |        0.6 GB |        0.3 GB | ×1.3 => 0.39GB       |
|   **1M** |                1.0 GB |   3.1 GB | 12.0 GB |        6.0 GB |        3.0 GB | ×1.3 => 3.9GB        |
|  **10M** |               10.2 GB |  31.0 GB |  120 GB |         60 GB |       30.0 GB | ×1.3 => 39GB         |
| **100M** |              101.9 GB | 310.2 GB | 1200 GB |        600 GB |        300 GB | ×1.3 => 390GB        |

_(Multiply by each additional vector dimension. Binary (ubinary) = 0.5 bytes per dim, int8=1B/dim, fp16=2B/dim, fp32=4B/dim.)_
Storage: e.g. 100M × 3072-d FP16 ≈ 600 GB, plus ~180 GB HNSW index = ~780 GB. 100M × 1024-d FP16 ≈ 200 GB.
Cloud PG (e.g. cloud-hosted Postgres) e.g. AWS RDS $0.10/GB·mo: $78/mo for 780GB.
Vector DB (Milvus self-host) maybe ~$200/mo at 10M (managed service: ~$0.30/10k vect/mo) scaling to ~$2000 at 100M.

### Breakeven Analysis

- **Cloud vs Self (CPU)**: At ~**1B tokens/month**, CPU path (~$8.7/1M for small model) equals OpenAI $0.13/1M for 67× _fewer_ tokens. Specifically, CPU ($0.0087) < API ($0.13) *when tokens >*≈15M/mo. At ~15M tokens, CPU costs = $0.13/1M effective. Thus, beyond ~15M tokens/mo, self-hosted (CPU) is cheaper than OpenAI embed-3.
- **GPU vs CPU**: GPU (RTX4090) cost per 1M ($0.011) is ~0.13× CPU’s ($0.0087) – i.e. GPU is ~0.5× to 1× CPU cost here but >10× faster. Breakeven: if latency matters, use GPU; if tokens/sec is low, CPU might suffice.
- **Dedicated v. Postgres**: At ~50M vectors (768-d), pgvector suffers memory (~150GB) but can store ~10M. A dedicated DB (Milvus/Pinecone) becomes cheaper at >10M due to simpler scaling and no RDS overhead.
- **Latency premium**: If CPU is 3× slower than API, then queries must be parallel/batched. If 95th percentile query latency must be <50ms, cloud API wins. Self-host CPU (e.g. 200 tok/s = 5ms per 1000 tokens) may hit 100ms for 2000 tokens. The “ingest-tolerant” use-case (e.g. nightly bulk) can use CPU, but real-time user query favors GPU/API.
- **Hidden costs**: Self-host ops ~10–20 hr/mo (patching, monitoring) for small team; ~100 hr/mo for large scale. Upgrades require re-indexing and retraining pipelines (~substantial).

### Reranker cost

Adding a cross-encoder:

- **Cloud API rerank (Cohere 3.5 / Jina v2)**: e.g. Cohere Rerank 3.5 cost ~$1.00 per 1k tokens (example) – adds ~$0.001 per doc pair, but lifts nDCG@10 by ~15%【94†L181-L189】.
- **Self-host encoder**: e.g. DistilBERT cross-encoder 110M, 8-core CPU ~50 tok/s. For 10 doc pairs, ~200 tokens (as input+query), so ~4s (CPU), so ~$0.00015 (assuming $60/mo). Gains ~+15% nDCG.

## Privacy & Sovereignty

### Tier Classification per Cloud Provider

- **OpenAI** (US): Enterprise opts “no training on input”【60†L37-L44】; offers EU Azure hosting; has SOC2 and certifications【60†L61-L64】. High CLOUD Act risk (US law).
- **Azure OpenAI** (US/EU): Same model; can deploy in EU, US Gov (FedRAMP), China; complies GDPR, ISO, FedRAMP; moderate CLOUD Act exposure (Azure US Tenant by default).
- **AWS Bedrock** (US): By default no provider training【79†L63-L70】; HIPAA/FedRAMP High; in-scope for GDPR. Some services (e.g. GovCloud) exempt US legislation.
- **Google Vertex** (US): No training; global infra; FedRAMP Moderate, ISO; must trust US parent (CLOUD Act).
- **Jina/Mixedbread (private)**: Self-hosted = full control; ops cost ~+10hr/mo.

### Confidential Computing & On-Device Trends

- **On-device embeddings**: Frameworks (transformers.js, MLX) allow browser/desktop inference. 2026 GPUs (mobile A17) can embed ~500–1000 tok/s (BERT-sized). Useful for ultra-private apps, but models must be small (~200M).
- **Confidential VMs**: Azure Confidential, AWS Nitro enclaves, NVIDIA GH100 secure enclaves. Enables running large models on GPU while keeping keys/data protected from hypervisor. Adds overhead (~10%) to throughput.
- **Privacy-preserving retrieval**: Homomorphic encryption on embeddings remains research (in 2026 not production-ready), e.g. ~10× slower with 5% accuracy drop. _Data Gap:_ no mass adoption yet.

## Recommendations

### Persona 1: Privacy-Maximalist

**Profile:** Ingest ≤50M tokens/yr, highly sensitive data, quality ≥95% of SOTA.

- **Model:** _all-MiniLM-L12-v2_ (384d) for text; _Jina Embeddings v4_ (dense only) for cross-doc search. Use self-hosted.
- **Runtime:** CPU (8vCPU) with int8 quantization (privacy=full, cost ~$5k/yr).
- **Storage:** pgvector self-hosted (cluster 10M vectors).
- **Quality:** MTEB~60, MMTEB~55.
- **Cost:** ~\$0.01 per 1M tokens (~\$500/year) + ops overhead.
- **Latency:** ~100ms/query.
- **Reason:** No data leaves your control (no cloud), near-SOTA MTEB (all-MiniLM → 59.1【22†L412-L420】) with Matryoshka compression, and highest privacy. Beats cloud alternative by eliminating vendor risk, at moderate cost.

### Persona 2: Cost-Minimalist (High Volume)

**Profile:** ≥1B tokens/year ingest, low query rate, low sensitivity.

- **Model:** _all-MiniLM-L6-v2_ (L6) – cheapest, dims=384, MTEB~59.1.
- **Runtime:** Self-host CPU (8vCPU) – $0.0087/1M tokens (see above).
- **Storage:** pgvector (cheapest storage with HNSW).
- **Quality:** ~59 MTEB (sacrifices ~6-12 points vs 3-large).
- **Cost:** ~\$90k/year ($0.0087/1M ×1E9) vs API \$130k.
- **Latency:** High (batch queries only).
- **Reason:** Minimizes $/token. Achieves ~90% of openAI text-3-large’s performance at ~1/15th the cost.

### Persona 3: Balanced Production App

**Profile:** ~50M tokens/yr, moderate sensitivity, need decent quality/latency.

- **Model:** _Voyage-3-large_ (1024d, MTEB~63.8), or _Cohere embed-v4_.
- **Runtime:** Cloud API (Voyage or Cohere): $~0.18/1M = \$9k/yr.
- **Storage:** Managed vector DB (Pinecone or pgvector on cloud).
- **Quality:** MTEB~64 (multilingual good).
- **Latency:** <100ms (API response).
- **Reason:** Hybrid cost-quality. Cloud saves ops, mature endpoint, and privacy with enterprise SLA. Beats naive smallest-model approach by boosting quality ~5%.

### Persona 4: Latency-Critical Real-Time Search

**Profile:** ≤1M queries/day, p95 ≤50ms end-to-end (including HNSW).

- **Model:** _OpenAI text-embedding-3-large_ (3072d).
- **Runtime:** Managed high-availability GPU (e.g. vLLM on A100) for embed; Qdrant vector DB cluster.
- **Embedding Dim:** 3072 (max accuracy).
- **Quality:** MTEB 64.6, enabling strong hybrid retrieval + rerank.
- **Cost:** Embedding 1M tok/month= $130 + GPU infra \$1500 (A100) ~\$2000/mo; Queries: 1M \* vector lookup (~$0.10/M) = \$100.
- **Latency:** ~40ms embed + ~10ms HNSW = ~50ms p95.
- **Reason:** Meets sub-50ms SLA with premier accuracy (dense+BM25+rerank). Although costly, splitting workload (dedicated GPU + fast index) is necessary. Beats open-source approach by ~10% MTEB.

### Persona 5 (On-device Trend): _“Mobile-first Privacy”_

**Profile:** Deploying fully-local embedding in mobile/web app.

- **Model:** _e5-small-v2_ (384d, MTEB~56) on-device (via transformers.js/MLX).
- **Runtime:** Client devices (ARM/Apple Silicon) – no server cost.
- **Quality:** ~56 MTEB English, covers local QA.
- **Latency:** ~50ms for 100-token embed on modern phones.
- **Cost:** $0 (embedding runs on user).
- **Reason:** 2026 improvement in on-device models (LLAMA-based small models) yields decent quality with zero cloud dependence.

#### Capability-Specific Notes:

- **Semantic search:** (persona 4 model) dense+BM25 combiner + colBERT rerank yields best nDCG (∼20% lift)【94†L181-L189】.
- **Clustering:** (persona 1 or 2) any decent embed (MiniLM or Voyage-3) + L2 clustering; on-device or CPU fine.
- **Deduplication:** cosine on 768d floats (binary int8) is enough; mini models suffice.
- **Cross-doc linking:** Jina v4 (with multimodal) or BGE (if needing Chinese/Arabic).
- **Summarization (chunk selection):** small models ~threshold of diversity suffice; prioritize recall.
- **RAG/Copilot retrieval:** large models (Voyage/Cohere) to maximize relevant chunk retrieval; always add reranker (+10-15% nDCG).
- **Speech transcripts:** use same text pipelines (STT not covered here). Possibly average LLM hidden states for ASR-specific tasks – _DATA GAP: competitor techniques obscure_.

## Decision Tree

```
Is content SENSITIVE?
└─Yes─► Self-hosting / Confidential Compute
     └─Volume?
          ├─Low (<50M tok/yr): small CPU model (MiniLM) on private infra
          └─High: small GPU cluster + FedRAMP DB
└─No─► Is latency CRITICAL?
     ├─Yes (≤50ms): large embed model on GPU (e.g. text-3-large) + fast index
     └─No: Cost-centric?
          ├─Yes (very high volume): tiny model on CPU (MiniLM)
          └─No: Balanced: mid-size API (Voyage/Cohere) + hybrid retrieval
```

## Open Questions / Data Gaps

- **MMTEB leaderboards:** Up-to-date multi-lingual MTEB not public for many models (e.g. Mixedbread).
- **Pricing of Jina/Mixedbread APIs:** Not yet public.
- **Exact license and data policy of new startups (Voyage, Jina, Mixedbread)**: scant official info.
- **Homomorphic/private retrieval maturity:** No production benchmarks available.
- **Contamination:** Some leaderboard numbers (MTEB) may be inflated by test overlap; e.g. _Mixedbread_ claims no overlap【94†L157-L163】 but independent verification lacking.

## References

- OpenAI text-embedding-3-\* (dimension, price)【19†L89-L93】【22†L412-L420】
- Cohere Embed-v4 specification (dims, context, price, MTEB)【40†L111-L119】【41†L69-L78】
- Google Gemini Embedding (dims, price, MTEB)【49†L49-L58】
- Voyage AI pricing & docs (models, price)【27†L15-L24】【25†L96-L104】
- AWS Bedrock Titan-embed (price, context)【77†L69-L77】
- Jina Embeddings v3/v4 (paper, card, license)【82†L163-L172】【91†L7-L14】
- Mixedbread mxbai-embed (blog, HF)【94†L181-L189】【99†L1-L8】
- BAAI BGE models (papers, HuggingFace) – e.g. _BAAI BGE-M3_ (not cited above).
- All-MiniLM-L6-v2 (SOTA CPU baseline)【22†L412-L420】
- MTEB/MMTEB leaderboard data (HuggingFace Spaces, AILog)【94†L181-L189】【40†L111-L119】
- AWS Bedrock Security (no training on input)【79†L63-L70】
- OpenAI Enterprise Privacy (data not used for training by default)【60†L37-L44】
- Vector DB survey (numbers from vendor docs, e.g. pgvector/HNSW overhead ~1.3×)【79†L63-L70】
