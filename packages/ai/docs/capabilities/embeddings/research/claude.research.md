# State of the Art: Text Embeddings (2024–2026)

**File:** `STATE-OF-THE-ART.md`
**Author's knowledge cutoff:** Research conducted 2026-05-17. Load-bearing numbers were pulled from these queries: _"MTEB leaderboard 2026 top embedding models"_, _"OpenAI text-embedding-3 pricing 2026"_, _"Voyage AI voyage-3-large pricing MTEB"_, _"Cohere embed v4 pricing dimensions context"_, _"Google gemini-embedding-001 pricing dimensions MTEB"_, _"Qwen3-Embedding-8B MTEB benchmark license"_, _"Snowflake Arctic Embed 2.0 multilingual MTEB"_, _"Hugging Face Text Embeddings Inference TEI throughput"_, _"pgvector vs Qdrant vs Milvus 2026 benchmark scale"_, _"Cohere Rerank 3.5 BGE Reranker v2 mxbai-rerank"_, _"Mistral embed price dimensions context 2026"_, _"AWS Bedrock Titan Text Embeddings v2 price dimensions"_.

## Overview

As of May 2026, the embedding-model landscape has bifurcated into three operating points: (1) a _quality-first_ cloud tier dominated by **Google `gemini-embedding-001`** (MTEB-Multi 68.32) and **Voyage `voyage-3-large`/`voyage-4-large`**, both with Matryoshka and binary/int8 quantization-aware training; (2) an _Apache-2.0 self-hostable_ tier where **Qwen3-Embedding-8B** (70.58 MMTEB, 80.68 MTEB-Code, June 2025) and **NVIDIA Llama-Embed-Nemotron-8B** match or beat the proprietary leaders on multilingual retrieval; (3) a _commodity_ tier where **OpenAI `text-embedding-3-small`** at $0.02/M tokens, **Snowflake Arctic Embed 2.0 (m/l)** and **Jina v3** remain the price-performance defaults. Self-hosting is now genuinely cheaper than every cloud API above roughly **20–50 M tokens/day of sustained ingest** on a single RTX 4090 with HF Text Embeddings Inference (TEI) — a threshold an order of magnitude lower than in 2024. Vector-store choice has converged: **pgvector 0.9 / pgvectorscale** handles up to ~50 M vectors competitively; **Qdrant** dominates filtered/hybrid at 1–100 M; **Milvus 2.6** is the only credible option past 1 B.

## Historical Context

### Evolution Timeline

| Year              | Milestone                                                      | Key Innovation                                                    |
| ----------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| 2019 (historical) | Sentence-BERT                                                  | Siamese BERT for sentence embeddings                              |
| 2022-12           | OpenAI `text-embedding-ada-002`                                | 1536-d hosted commodity (now legacy)                              |
| 2023-08           | BGE / E5 / GTE families                                        | Open-weight ColBERT-quality retrievers                            |
| 2023-10           | Cohere Embed v3                                                | Quantization-aware (int8/binary) training                         |
| 2024-01           | OpenAI `text-embedding-3-{small,large}`                        | First mainstream Matryoshka (MRL) at hosted scale                 |
| 2024-05           | BGE-M3, mE5-large-instruct                                     | 100-language, multi-functional (dense+sparse+ColBERT)             |
| 2024-09           | Jina v3 + late chunking                                        | Encode-then-chunk preserves cross-chunk context                   |
| 2024-10           | NV-Embed-v2                                                    | LLM-backbone (Mistral-7B) embedder, MTEB-Eng ~72.31               |
| 2024-12           | Snowflake Arctic Embed 2.0 (m/l)                               | Multilingual without English regression, 568 M params, Apache-2.0 |
| 2025-01           | Voyage-3-large                                                 | QAT + MRL: 512-d binary beats OpenAI-3-large 3072-d float         |
| 2025-03           | Gemini Embedding (exp)                                         | Top of MTEB-Multi; later GA 2025-05-20 as `gemini-embedding-001`  |
| 2025-04           | Cohere Embed v4                                                | Multimodal, 128 K context, Matryoshka 256–1536                    |
| 2025-06           | Qwen3-Embedding (0.6/4/8 B)                                    | First open-weight model to surpass Gemini on MMTEB (70.58)        |
| 2025-10           | NVIDIA Llama-Embed-Nemotron-8B                                 | Open-weight MMTEB leader                                          |
| 2026-03           | Gemini Embedding 2 (preview)                                   | Multimodal text/image/video/audio, MTEB-Multi 69.9                |
| 2026-Q1           | vLLM 0.19 / SGLang 0.5.10 ship first-class embedding endpoints | Self-hosted serving parity                                        |

### Paradigm Shifts (ASCII)

```
2019-2022      2023               2024                    2025                          2026
[SBERT]──▶[BGE/E5/GTE]──▶[OpenAI v3 + MRL]──▶[QAT-binary, LLM-backbones]──▶[Open-weight ≥ cloud]
              │                  │                        │                              │
              ▼                  ▼                        ▼                              ▼
        open weights        Matryoshka              MoE + late-chunk            embedding endpoints
        beat closed        at hosted tier           multilingual w/o            in vLLM/SGLang;
        ada-002                                     English regression          CPU finally viable
```

## Current State

### Approach Comparison

| Approach                                | Operating cost @ 100 M tok/mo | Privacy ceiling                     | Quality ceiling (MTEB-Eng)            | Ops burden        |
| --------------------------------------- | ----------------------------- | ----------------------------------- | ------------------------------------- | ----------------- |
| Cloud API (OpenAI/Cohere/Voyage/Google) | $2–18                         | Vendor ToS + DPA                    | 68.32 (Gemini)                        | ~0 hrs/mo         |
| Cloud API + ZDR/business tier           | $2–25 (small premium)         | No training, EU residency available | 68.32                                 | ~1 hr/mo audits   |
| Self-hosted TEI on cloud GPU            | ~$50–250 (1× RTX 4090 / A10G) | Total                               | 70.58 (Qwen3-8B)                      | 8–20 hrs/mo       |
| Self-hosted CPU (small models)          | ~$50–80 server                | Total                               | ≈62 (Arctic-m-v2, MiniLM ceiling ~58) | 4–10 hrs/mo       |
| On-device / browser                     | $0 marginal                   | Maximal                             | ~58 (MiniLM via transformers.js)      | model-update only |

### Embedding Model Leaderboard 2026

Access date: 2026-05-17. Sources: MTEB public leaderboard snapshots (March/April 2026 via awesomeagents.ai; primary numbers cross-checked to vendor model cards / arXiv where available). MTEB scores are self-reported; flagged contamination caveats below the table.

| Rank | Model                           |                   MTEB-Eng |               MMTEB |           MTEB-Code |                                 LongDoc |                      Dim |   Ctx | $/1M tok hosted                    | License                                                           | Self-host?                                     |
| ---: | ------------------------------- | -------------------------: | ------------------: | ------------------: | --------------------------------------: | -----------------------: | ----: | ---------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
|    1 | Google `gemini-embedding-001`   |                      68.32 |       68.32 (Multi) |                75.6 |                                DATA GAP |      3072 (MRL→768/1536) | 2,048 | $0.15 ($0.075 batch)               | Proprietary                                                       | No                                             |
|    2 | NVIDIA Llama-Embed-Nemotron-8B  |                   DATA GAP |            #1 MMTEB |            DATA GAP |                                DATA GAP |                     4096 |  32 K | n/a (open)                         | NVIDIA OS license                                                 | Yes (8 B)                                      |
|    3 | Qwen3-Embedding-8B              |                        ~69 |           **70.58** |           **80.68** |                                DATA GAP | up to 4096 (MRL 32–4096) |  32 K | hosted ~$0.05 (SiliconFlow et al.) | Apache 2.0                                                        | Yes                                            |
|    4 | NV-Embed-v2                     | **72.31** (legacy MTEB v1) |             mid-60s |            DATA GAP |                                DATA GAP |                     4096 |  32 K | n/a                                | CC-BY-NC 4.0 (**research-only**)                                  | Self-host but no commercial                    |
|    5 | Voyage-3-large / voyage-4-large |     ~67.1 / claimed higher |              strong | strong (code-3 80+) |                                  strong |  2048/1024/512/256 (MRL) |  32 K | $0.06 (v4) – $0.18 (v3-large)      | Proprietary                                                       | No (open-weight `voyage-4-nano` is Apache-2.0) |
|    6 | Qwen3-Embedding-4B              |                        ~68 |                 ~69 |                 ~78 |                                  strong |           MRL up to 2560 |  32 K | hosted ~$0.03                      | Apache 2.0                                                        | Yes                                            |
|    7 | OpenAI `text-embedding-3-large` |                       64.6 |             mid-60s |             mid-60s |                          weak (8 K ctx) |          3072 (MRL→256+) | 8,191 | $0.13 ($0.065 batch)               | Proprietary                                                       | No                                             |
|    8 | Cohere `embed-v4`               |      65.2 (text-only MTEB) |              strong |            DATA GAP |                          strong (128 K) |  256/512/1024/1536 (MRL) | 128 K | $0.12 (text), $0.47 (img)          | Proprietary                                                       | No                                             |
|    9 | BGE-en-ICL                      |            ~71 (legacy v1) |            DATA GAP |            DATA GAP |                                DATA GAP |                     4096 |  32 K | open                               | MIT                                                               | Yes                                            |
|   10 | Snowflake Arctic-Embed-L-v2.0   |       ~57 retrieval (MTEB) | leader < 1 B params |                 n/a |                                  strong |           1024 (MRL→256) | 8,192 | open                               | Apache 2.0                                                        | Yes                                            |
|   11 | Stella `stella_en_1.5B_v5`      |                        ~71 |            DATA GAP |            DATA GAP |                                DATA GAP |         up to 8192 (MRL) |   512 | open                               | MIT                                                               | Yes                                            |
|   12 | Linq-Embed-Mistral              |                        ~68 |            DATA GAP |              strong |                                DATA GAP |                     4096 |  32 K | open                               | Apache 2.0 (subject to Mistral base)                              | Yes                                            |
|   13 | e5-mistral-7b-instruct          |                        ~66 |              strong |              strong |                                  strong |                     4096 |  32 K | open                               | MIT                                                               | Yes                                            |
|   14 | GTE-Qwen2-7B-instruct           |            ~70 (legacy v1) |              strong |            DATA GAP |                                DATA GAP |                     3584 |  32 K | open                               | Apache 2.0                                                        | Yes                                            |
|   15 | GTE-Qwen2-1.5B-instruct         |                        ~67 |              strong |            DATA GAP |                                DATA GAP |                     1536 |  32 K | open                               | Apache 2.0                                                        | Yes                                            |
|   16 | BGE-M3                          |                        ~63 |          100+ langs |                 n/a | strong (8 K dense + sparse + multi-vec) |                     1024 | 8,192 | open                               | MIT                                                               | Yes                                            |
|   17 | Stella `stella_en_400M_v5`      |                        ~70 |            DATA GAP |            DATA GAP |                                DATA GAP |         up to 8192 (MRL) |   512 | open                               | MIT                                                               | Yes                                            |
|   18 | OpenAI `text-embedding-3-small` |                       62.3 |                 mid |                 mid |                                    weak |          1536 (MRL→256+) | 8,191 | $0.02 ($0.01 batch)                | Proprietary                                                       | No                                             |
|   19 | Jina-embeddings-v3              |                       65.5 |   strong (89 langs) |                  OK |             strong (late chunking, 8 K) |            1024 (MRL→64) | 8,192 | $0.02 hosted                       | CC-BY-NC 4.0 (**non-commercial open-weight**); commercial via API | Yes (non-commercial)                           |
|   20 | Snowflake Arctic-Embed-M-v2.0   |                        ~56 |        strong < 1 B |                 n/a |                                  strong |            768 (MRL→256) | 8,192 | open                               | Apache 2.0                                                        | Yes                                            |

> **Contamination caveat.** Voyage's `voyage-3-m-exp` card states it "uses training sets of MTEB datasets" and is "tailored to datasets similar to MTEB". Treat any 2024-2025 model claiming MTEB scores > 70 with skepticism unless retrieval-only and code-only subsets are reported. The Milvus CCKM and the legacy MTEB v1 → v2 transition (2026) **make scores between v1 and v2 non-comparable**.

> NV-Embed-v2 (legacy v1 MTEB 72.31) is **CC-BY-NC 4.0**: research-only, no commercial deployment. Substitute Qwen3-Embedding-8B for commercial use.

### Self-Hostable Model Matrix

VRAM and tok/sec numbers below: fp16 footprint from model card / parameter count (≈ 2 bytes/param + activations); int8 ≈ ½; consumer-GPU throughput is for 512-token sequences, batch 32, on an RTX 4090; CPU is 8-vCPU Xeon-class.

| Model                             |                     Params |    VRAM fp16 |    VRAM int8 | CPU viable?        |       tok/s CPU |                                           tok/s 4090 | tok/s A100/H100 | Ollama tag                     |                                             MTEB-Eng |                MMTEB | License                     |
| --------------------------------- | -------------------------: | -----------: | -----------: | ------------------ | --------------: | ---------------------------------------------------: | --------------: | ------------------------------ | ---------------------------------------------------: | -------------------: | --------------------------- |
| all-MiniLM-L6-v2                  |                       22 M |       ~80 MB |       ~40 MB | **yes**            |    8,000–15,000 |                                               200 k+ |          400 k+ | `all-minilm`                   |                                                 56.3 |                 poor | Apache 2.0                  |
| BGE-small-en-v1.5                 |                       33 M |       130 MB |        70 MB | yes                |    6,000–10,000 |                                               180 k+ |          350 k+ | `bge-small`                    |                                                 62.2 |                   OK | MIT                         |
| Snowflake Arctic-Embed-M v2.0     |                      305 M |      ~610 MB |      ~310 MB | **yes (marginal)** |    ~2,000–4,000 | ~80 k (≈100 docs/s × ~500 tok on A10G per Snowflake) |          200 k+ | `snowflake-arctic-embed2:m`    |                                        ~56 retrieval |               strong | Apache 2.0                  |
| Snowflake Arctic-Embed-L v2.0     |                      568 M |      ~1.1 GB |      ~570 MB | marginal           |    ~1,000–2,000 |                                                ~60 k |          150 k+ | `snowflake-arctic-embed2`      |                                        ~57 retrieval |         leader < 1 B | Apache 2.0                  |
| Nomic-Embed-Text-v1.5             |                      137 M |      ~270 MB |      ~140 MB | yes                |          ~4,000 |                                               ~120 k |          ~300 k | `nomic-embed-text`             |                                                 62.4 |                   OK | Apache 2.0                  |
| Nomic-Embed-v2 (MoE)              | 305 M total / 158 M active |      ~620 MB |      ~310 MB | yes (marginal)     |        DATA GAP |                                             DATA GAP |        DATA GAP | `nomic-embed-v2`               |                                                  ~64 |               strong | Apache 2.0                  |
| GTE-Qwen2-1.5B-instruct           |                      1.5 B |        ~3 GB |      ~1.5 GB | no                 |            <500 |                                                ~40 k |           ~90 k | (not in Ollama default; on HF) |                                                  ~67 |               strong | Apache 2.0                  |
| Qwen3-Embedding-0.6B              |                      0.6 B |      ~1.2 GB |      ~600 MB | marginal           |      ~800–1,500 |                                                ~70 k |          ~180 k | `qwen3-embedding:0.6b`         |                                                  ~65 |                  ~64 | Apache 2.0                  |
| Qwen3-Embedding-4B                |                        4 B |        ~8 GB |        ~4 GB | no                 |             n/a |                                                ~12 k |           ~30 k | `qwen3-embedding:4b`           |                                                  ~68 |                  ~69 | Apache 2.0                  |
| Qwen3-Embedding-8B                |                        8 B |       ~16 GB |        ~8 GB | no                 |             n/a |                                                 ~6 k |    ~18 k (H100) | `qwen3-embedding:8b`           |                                                  ~69 |            **70.58** | Apache 2.0                  |
| BGE-M3                            |                      568 M |      ~1.1 GB |      ~570 MB | marginal           |          ~1,500 |                                                ~60 k |          ~150 k | `bge-m3`                       |                                                  ~63 |           100+ langs | MIT                         |
| Stella_en_1.5B_v5                 |                      1.5 B |        ~3 GB |      ~1.5 GB | no                 |            <500 |                                                ~40 k |           ~90 k | (HF only)                      |                                                  ~71 |             DATA GAP | MIT                         |
| e5-mistral-7b-instruct            |                        7 B |       ~14 GB |        ~7 GB | no                 |             n/a |                                                 ~6 k |           ~16 k | `e5-mistral` (community)       |                                                  ~66 |               strong | MIT                         |
| Linq-Embed-Mistral                |                        7 B |       ~14 GB |        ~7 GB | no                 |             n/a |                                                 ~6 k |           ~16 k | HF only                        |                                                  ~68 |               strong | Apache 2.0                  |
| NV-Embed-v2                       |                        7 B |       ~14 GB |        ~7 GB | no                 |             n/a |                                                 ~6 k |           ~16 k | HF only                        |                                        **72.3** (v1) |               strong | **CC-BY-NC 4.0**            |
| Jina-embeddings-v3                |                      572 M |      ~1.1 GB |      ~570 MB | marginal           |          ~1,500 |                                                ~60 k |          ~150 k | `jina/jina-embeddings-v3`      |                                                 65.5 |               strong | CC-BY-NC 4.0 (open weights) |
| Jina-embeddings-v4                |                      3.8 B |      ~7.5 GB |      ~3.8 GB | no                 |             n/a |                                                ~10 k |           ~25 k | HF only                        |                                             DATA GAP |               strong | CC-BY-NC 4.0                |
| mxbai-embed-large-v1              |                      335 M |      ~670 MB |      ~340 MB | yes                |    ~2,000–3,500 |                                                ~80 k |          ~200 k | `mxbai-embed-large`            |                                                 64.7 |                   OK | Apache 2.0                  |
| IBM Granite Embedding 107M / 278M |                107 / 278 M | 215 / 560 MB | 110 / 280 MB | yes                | ~3,000 / ~2,000 |                                       ~120 k / ~80 k |        DATA GAP | not in Ollama default          | DATA GAP (positioned ≈ BGE-base/MiniLM tier per IBM) |                   OK | Apache 2.0                  |
| GTE-ModernBERT-base               |                      149 M |      ~300 MB |      ~150 MB | yes                |          ~3,000 |                                               ~100 k |          ~250 k | (HF)                           |                                                  ~64 | weak (English-first) | Apache 2.0                  |
| GTE-large-en-v1.5                 |                      434 M |      ~870 MB |      ~440 MB | yes (marginal)     |          ~1,800 |                                                ~70 k |          ~170 k | `gte-large`                    |                                                 65.4 |                 weak | Apache 2.0                  |

> The throughput numbers above are reasonable extrapolations from public benchmarks (HF TEI's BGE-base @ ~450 req/s × 512 tok on A10G ≈ 230 k tok/s on a card slower than 4090 by ~2×). **Where I show DATA GAP, no primary benchmark exists**. all-MiniLM-L6-v2 remains the defensible CPU floor in 2026 only for low-quality bulk clustering/dedup — Arctic-Embed-M-v2.0 (305 M, Apache 2.0) is the _better_ CPU floor wherever ≥ 4 GB RAM is available.

### Specialized Models

| Domain                            | Best model                                                                                                | Why it wins                                                                                        | License                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------ |
| Code retrieval                    | Qwen3-Embedding-8B (MTEB-Code **80.68**, June 2025)                                                       | Surpasses Gemini and Voyage-code-3 on MTEB-Code; Apache 2.0                                        | Apache 2.0               |
| Code retrieval (hosted)           | `voyage-code-3` ($0.18/M, 32 K ctx, MRL+QAT) or Mistral `codestral-embed-2505` ($0.15/M)                  | Outperform OpenAI-3-large by 9-25 % on code-only NDCG@10                                           | Proprietary              |
| Long-context (8 K–32 K)           | Jina v3 with **late chunking**; Cohere `embed-v4` (128 K)                                                 | Late chunking preserves cross-passage context; Cohere has longest hosted ctx                       | Mixed                    |
| Long-context open-weight          | Qwen3-Embedding (32 K), BGE-M3 (8 K, dense+sparse+ColBERT)                                                | True 32 K dense vectors                                                                            | Apache 2.0 / MIT         |
| Legal                             | `voyage-law-2` (Voyage); domain-tuned BGE-M3; older Legal-BERT                                            | Voyage reports +5-7 pts NDCG on legal corpora vs general models                                    | Proprietary / MIT        |
| Medical                           | MedCPT (historical context only, pre-2024 SOTA); domain fine-tuned BGE-M3; new tools use Qwen3 fine-tuned | DATA GAP: no 2025–26 medical-specific commercial leader; finance/medical Voyage v2 only            | Mixed                    |
| Finance                           | `voyage-finance-2`                                                                                        | +4-6 NDCG on financial filings vs general                                                          | Proprietary              |
| Scientific                        | SPECTER 2.0, SciNCL (historical 2023 baselines), GTE-large fine-tuned                                     | DATA GAP: no dominant 2026 model                                                                   | MIT                      |
| Multilingual-first                | **Qwen3-Embedding-8B** (open) / `gemini-embedding-001` (hosted) / Snowflake Arctic 2.0 (< 1 B)            | NDCG leaders on MIRACL, CLEF, MMTEB                                                                | Apache 2.0 / proprietary |
| Multilingual budget               | Cohere `embed-multilingual-v3` ($0.10), mE5-large-instruct, BGE-M3                                        | Cheapest hosted multilingual API                                                                   | Mixed                    |
| Quantization-native (binary/int8) | Voyage-3-large/4-large (QAT), Cohere v3/v4 (int8/binary native), Mixedbread "binary MRL"                  | Voyage-3-large 512-d binary outperforms OpenAI-3-large 3072-d float by 1.16 % at 1/200 the storage | Proprietary / Apache 2.0 |

### Cloud Provider Privacy & Sovereignty Matrix

> Verified against vendor doc pages April-May 2026. ZDR = Zero Data Retention.

| Provider                                                  | Trains on input?                                                                                                       | EU residency                                      | GDPR DPA               | Default retention                        | SOC 2 / ISO / HIPAA                           | Jurisdiction                                                               | Verdict                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------- | ---------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| OpenAI direct                                             | No (API by default since Mar 2023)                                                                                     | EU data residency available (Enterprise/ZDR)      | Yes                    | 30 days unless ZDR (Enterprise)          | SOC 2 II / ISO 27001 / HIPAA BAA (Enterprise) | US (CLOUD Act)                                                             | OK for most; ZDR/Enterprise for regulated            |
| Azure OpenAI                                              | No                                                                                                                     | Yes (per-region; e.g., Sweden/France/Switzerland) | Yes (MS DPA)           | 30 days; 0-day filter on request         | SOC 2 II / ISO / HIPAA / FedRAMP High         | US, but Azure regions are local                                            | Best US-hyperscale option for EU/regulated           |
| Voyage AI (direct)                                        | No                                                                                                                     | DATA GAP (default US)                             | Yes per ToS            | "No training" policy                     | SOC 2 II per voyageai.com                     | US                                                                         | Acquired by MongoDB; check MongoDB DPA               |
| Voyage via AWS Bedrock / Azure                            | No                                                                                                                     | Yes (Bedrock regions incl. eu-west, eu-central)   | Yes                    | Per Bedrock                              | SOC 2 / ISO / HIPAA / FedRAMP (via Bedrock)   | US, regional residency                                                     | Strong for enterprise                                |
| Cohere direct                                             | No (per ToS)                                                                                                           | Yes (EU dedicated deployment)                     | Yes                    | Configurable; SaaS by default minimal    | SOC 2 II / ISO 27001 / HIPAA BAA              | Canada HQ → CLOUD Act not directly applicable; FISA-702 risk lower than US | Strong, especially for Canadian/EU                   |
| Cohere via Bedrock / Azure / OCI                          | No                                                                                                                     | Yes                                               | Yes                    | Per host cloud                           | Per host cloud                                | Per host cloud                                                             | Strong                                               |
| Google Vertex AI (`gemini-embedding-001`)                 | No on Vertex; opt-in on free AI Studio                                                                                 | Yes (eu-west, eu-central, etc.)                   | Yes (Google Cloud DPA) | Configurable, default short              | SOC 2 II / ISO / HIPAA BAA / FedRAMP High     | US                                                                         | Strong; gemini-2-preview routing may be cross-region |
| Anthropic                                                 | DATA GAP: **no first-party embedding model as of 2026-05** — Anthropic recommends Voyage AI (which it has invested in) | n/a                                               | n/a                    | n/a                                      | n/a                                           | n/a                                                                        | Use Voyage                                           |
| Mistral La Plateforme                                     | No                                                                                                                     | Yes (EU-native, Paris)                            | Yes                    | Configurable                             | SOC 2 II / ISO 27001                          | France                                                                     | Best EU-sovereign hosted option                      |
| AWS Bedrock (Titan v2)                                    | No                                                                                                                     | Yes (per region)                                  | Yes                    | Per Bedrock (no model training on input) | SOC 2 II / ISO / HIPAA / FedRAMP High         | US, regional                                                               | Strong; default for AWS shops                        |
| Jina (hosted)                                             | DATA GAP (no explicit "no-train" guarantee on free tier)                                                               | EU optional                                       | Yes                    | Configurable                             | DATA GAP on SOC 2                             | Germany                                                                    | EU-sovereign for German shops; verify DPA            |
| Mixedbread (hosted)                                       | DATA GAP                                                                                                               | DATA GAP                                          | Yes                    | DATA GAP                                 | DATA GAP                                      | Germany                                                                    | EU-sovereign in principle; small vendor risk         |
| DeepInfra / Together / Fireworks / Replicate / OpenRouter | No (transit-only on most plans)                                                                                        | Marketplace-dependent                             | Per provider           | Often ~14 days logs                      | Varies                                        | US primarily                                                               | Treat as commodity; check each model's ToS           |

## Inference Runtimes

| Runtime                                | Hardware                                     | Formats                     | OpenAI-compat?                                   | Throughput (Qwen3-0.6B fp16, batch 32, ~500 tok)                    | Single-binary?              | Language integrations                    |
| -------------------------------------- | -------------------------------------------- | --------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | --------------------------- | ---------------------------------------- |
| **HF Text Embeddings Inference (TEI)** | NVIDIA CUDA 7.5–12.0, Intel CPU, Apple Metal | Safetensors + ONNX          | **Yes** (`/v1/embeddings`)                       | ~70 k tok/s on RTX 4090; BGE-base ~450 req/s on A10G = ~230 k tok/s | Docker / single Rust binary | HTTP/gRPC; any language                  |
| **vLLM 0.19+**                         | CUDA                                         | Safetensors                 | **Yes** (Q1 2026 embedding endpoint)             | Higher than TEI for ≥ 1 B-param models due to PagedAttention        | Docker                      | Python primary, HTTP for others          |
| **SGLang 0.5.10+**                     | CUDA                                         | Safetensors                 | **Yes** (Q1 2026)                                | Comparable to vLLM; better for batched RAG pipelines                | Docker                      | Python, HTTP                             |
| **Ollama**                             | CPU + CUDA/Metal                             | GGUF                        | Partial (`/api/embeddings` and `/v1/embeddings`) | ~2 k tok/s CPU on Arctic-m; ~30 k on 4090                           | **Yes** (one binary)        | All via HTTP                             |
| **llama.cpp server**                   | CPU, CUDA, Metal, ROCm                       | GGUF                        | Partial                                          | ~1 k–3 k tok/s on 8-vCPU CPU for Arctic-m                           | **Yes**                     | C / HTTP                                 |
| **fastembed (Qdrant)**                 | CPU primary, GPU via ORT                     | ONNX                        | No (Python lib)                                  | ~3 k–5 k tok/s CPU for BGE-small                                    | Python lib                  | Python; Qdrant Cloud has hosted endpoint |
| **transformers.js / onnxruntime-web**  | Browser / Node (CPU, WebGPU)                 | ONNX (quantized)            | No                                               | ~500 tok/s in browser on M1; ~3 k Node CPU                          | Browser bundle              | JS/TS/Bun primary                        |
| **candle**                             | CPU, CUDA, Metal                             | Safetensors                 | No (lib)                                         | ~50 k tok/s on 4090 for BGE-base                                    | Rust lib → single binary    | Rust                                     |
| **MLX (Apple)**                        | Apple Silicon (M1-M4)                        | Safetensors / MLX           | Partial via wrappers                             | M2 Max: ~25 k tok/s BGE-base; M4 Max: ~40 k                         | Python pkg                  | Swift, Python                            |
| **NVIDIA NIM / Triton**                | NVIDIA only                                  | TensorRT, ONNX, Safetensors | **Yes**                                          | NIM-optimized Qwen3-8B ~25 k tok/s H100                             | Docker                      | Any (HTTP/gRPC)                          |

> **CPU-ONLY VIABILITY OF A ≥ 67-MTEB-CLASS MODEL IN 2026:** **No, not yet at "real-time" latency**. The 67-MTEB tier today is Qwen3-Embedding-4B / 8B, Voyage / Gemini, GTE-Qwen2-7B. All of these need a GPU. On a single 8-vCPU box you can run **Snowflake Arctic-Embed-M-v2.0** (~56 retrieval, but leader < 1 B on MMTEB) or **Stella_en_400M_v5** (≈ 70 MTEB-Eng but English-only, 512-token ctx) at roughly **2,000–4,000 tokens/sec for batched ingest** via TEI+CPU. That is **~170–340 M tokens/day per box** — enough for most enterprise corpora overnight. For latency-sensitive queries (≤ 50 ms p95) a CPU still loses; for _batched ingest_ it is fine. **MiniLM remains viable only for shallow clustering/dedup; Arctic-Embed-M is the 2026 CPU baseline.**

## Vector Storage Backends

| Backend                          | Index types                                 | Practical scale/node                                  | Filtered search                         | Hybrid (BM25+dense)?                         | Hosted?                         | $ @ 10 M (768-d fp16)                       | $ @ 100 M       | Failure mode                                        |
| -------------------------------- | ------------------------------------------- | ----------------------------------------------------- | --------------------------------------- | -------------------------------------------- | ------------------------------- | ------------------------------------------- | --------------- | --------------------------------------------------- |
| **pgvector 0.9 / pgvectorscale** | HNSW, IVFFlat, DiskANN (pgvectorscale)      | ~50 M comfortable, 100 M with pgvectorscale + DiskANN | Native SQL                              | Via `tsvector` + RRF, manual                 | Supabase, Tiger Data, Neon, RDS | ~$100–400 self-host / ~$300–800 managed     | ~$1–2 k managed | Index rebuild on schema change; QPS drops past 50 M |
| **Qdrant**                       | HNSW (only)                                 | 100 M (4.74 ms p50 @ 50 M, Tiger benchmark)           | **Best-in-class** payload + geo + range | Native (named vectors + sparse) v1.9+        | Qdrant Cloud                    | $80–200 self-host (r6g.xlarge); ~$300 cloud | ~$1–2 k         | Single-node ceiling; needs sharding above 100 M     |
| **Milvus 2.6 / Zilliz**          | HNSW, IVF, IVFPQ, DiskANN, ScaNN, GPU-CAGRA | **1 B+** (Reddit 340 M production)                    | Yes (rich)                              | Sparse-BM25 (30× faster than ES on 1 M test) | Zilliz Cloud                    | ~$400–800 self-host (k8s) / ~$1 k cloud     | ~$3–6 k         | k8s ops; over-engineered below 50 M                 |
| **Weaviate**                     | HNSW + flat                                 | ~100 M per node                                       | Yes                                     | Native BlockMax WAND + RSF                   | WCS                             | ~$500 cloud                                 | ~$3 k           | Ops complexity self-hosted                          |
| **Vespa**                        | HNSW, IVF                                   | 1 B+ (Yahoo-class)                                    | Yes                                     | Native (best-in-class)                       | Vespa Cloud                     | DATA GAP cloud price; self-host ~$300       | DATA GAP        | Steep learning curve                                |
| **Pinecone**                     | Proprietary                                 | Unbounded (managed)                                   | Yes                                     | Pinecone sparse (proprietary)                | Yes only                        | ~$70/mo p1.x1 = ~$840/yr                    | ~$1–4 k/mo      | Vendor lock-in; serverless cold-start latency       |
| **Elasticsearch / OpenSearch**   | HNSW (Lucene)                               | 10–100 M                                              | Yes (Lucene)                            | Native (BM25 + kNN)                          | Elastic Cloud / AWS             | ~$500 cloud                                 | ~$3–5 k         | Memory blow-up; tuning required                     |
| **Redis Stack vector search**    | HNSW, FLAT                                  | 10 M practical                                        | Yes                                     | Manual fusion                                | Redis Cloud                     | ~$200 self-host / ~$500 cloud               | ~$2 k           | RAM-bound (all in-memory)                           |
| **LanceDB**                      | IVF-PQ, HNSW (Rust + Lance format)          | 100 M+ (object-storage backed)                        | Yes                                     | Native FTS + dense                           | LanceDB Cloud                   | ~$50–100 self-host (S3-backed); ~$200 cloud | ~$500           | Cold-read latency from object storage               |
| **Chroma**                       | HNSW                                        | 1–5 M                                                 | Limited                                 | Partial                                      | Chroma Cloud                    | ~$30 self-host                              | ~$2 k           | Falls over past 10 M                                |
| **Turbopuffer**                  | Custom (proprietary disk-first)             | 10 B+ at low QPS                                      | Yes                                     | Native BM25 + dense                          | Hosted only                     | ~$50 cloud (object-storage pricing)         | ~$200           | Higher latency than RAM-resident systems            |
| **DuckDB VSS / SQLite-VSS**      | HNSW                                        | <1 M practical (embedded)                             | Limited                                 | No                                           | Embedded                        | ~$0                                         | not applicable  | Not for production at scale                         |

## Architecture Techniques

### Matryoshka Representation Learning (MRL)

Train embedding so the **prefix** of the vector is itself a usable embedding. Supported by OpenAI v3, Voyage 3/4 (256/512/1024/2048), Cohere v4 (256/512/1024/1536), Gemini Embedding (768/1536/3072), Snowflake Arctic 2.0 (256/768/1024), Nomic, Qwen3 (32–4096), Stella, Mixedbread. **Impact:** 4× storage reduction at ≤ 1 % retrieval-NDCG loss when truncating 3072→768 (Google), 2048→512 (Voyage). Combined with int8/binary, voyage-3-large 512-d binary retains 99.7 % of float quality at **1/200 the storage**.

### Late Chunking (Jina)

Encode the whole long document with a long-context model, then chunk-pool at the token-embedding layer. Supported by Jina v3, Jina v4. **Impact:** +1–3 NDCG@10 on LongEmbed-style benchmarks vs naive chunk-then-encode, because chunk embeddings retain bidirectional context.

### Multi-vector / Late Interaction (ColBERT / ColPali)

Store one vector per token (e.g., 100 vectors per doc), score via MaxSim. Models: ColBERTv2, BGE-M3 (multi-vec head), ColPali (image patches), Jina-ColBERT-v2. **Impact:** typically +3–8 NDCG@10 vs single-vec dense on hard retrieval; **15–30× more storage** and **2–5× more compute at query time**. Qdrant and Vespa have first-class support; pgvector requires extension.

### Vector Quantization (int8 / scalar / product / binary)

- **int8 / scalar:** 4× storage cut, ~0.3 % NDCG loss (Voyage-3-large @ 1024-d int8 only 0.31 % below 2048-d float per Voyage).
- **Product quantization (IVFPQ, DiskANN):** 8–32× compression, 2–5 % NDCG loss.
- **Binary:** 32× compression, ~5–15 % NDCG loss for non-QAT models; **<2 % for QAT models** (Cohere v3/v4 binary, Voyage-3/4-large binary, Mixedbread binary MRL).

### Hybrid Retrieval (BM25 + Dense + RRF)

Native in Vespa, Weaviate, Milvus 2.5+, Qdrant v1.9+, Elasticsearch, LanceDB, Turbopuffer, Pinecone. **Impact:** consistently +2–5 NDCG@10 on out-of-domain corpora with proper-noun / citation queries; gains shrink to near-zero when the embedding model is itself in-domain. Hybrid is **not** strictly better at every scale — at < 100 K docs RRF noise sometimes hurts.

### Sparse Vector Retrieval (SPLADE)

Learned-sparse alternative to BM25. SPLADE-v3, BGE-M3-sparse, OpenSearch neural sparse, Cohere sparse encoder (proprietary). **Impact:** comparable to BM25 on lexical-heavy queries, much better than BM25 on paraphrase. Index size 2–3× of BM25, retrieval cost similar.

### Instruction Prefixes

Required by E5 family (`"query: "` / `"passage: "`), BGE-en-ICL, Snowflake Arctic 2.0, Qwen3 (instruction-aware, optional, ~1–5 % gain), Voyage (`input_type=query/document`), Cohere (`input_type=search_query / search_document`). **Forgetting them costs 3–8 NDCG@10** on instruction-trained models — a top-3 production bug.

### Reranking

See §1.6 table below.

### Embedding Cache Strategies

- **Content hash (SHA-256 of normalized text):** > 99 % hit-rate for static corpora; default.
- **Semantic cache (cosine ≥ 0.97):** 30–60 % hit-rate for user queries; risk of false positives if threshold too loose.
- **Versioned cache key `(model_id, dim, hash)`:** required for safe model upgrades.
- Typical TTL: documents → no TTL (only invalidate on edit); queries → 7–30 d.

### Re-embedding on Model Upgrades

**No provider preserves vector-space compatibility across major versions.** OpenAI ada-002 → v3-small, Cohere v3 → v4, Voyage-3 → voyage-4 all require **full re-embedding**. Voyage-3-large → voyage-4-large _does_ share an embedding space within the v4 family (per Voyage docs). Plan re-embedding cost into your budget: at 100 M tokens it is $2–18 hosted or 1 GPU-day self-hosted.

## Cost & ROI Analysis

### Cloud Cost Comparison ($/1M tokens)

| Provider                                                           | Model                                  |                                      Standard |      Batch | Free tier        | Notes                                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------- | --------------------------------------------: | ---------: | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| OpenAI                                                             | `text-embedding-3-small`               |                                     **$0.02** |      $0.01 | $5 credit        | 1536-d, 8 K ctx                                                                                            |
| OpenAI                                                             | `text-embedding-3-large`               |                                         $0.13 |     $0.065 | $5 credit        | 3072-d                                                                                                     |
| Voyage                                                             | `voyage-4-lite`                        |                                     **$0.02** | (33 % off) | 200 M tok        | open-weight `voyage-4-nano`                                                                                |
| Voyage                                                             | `voyage-4`                             |                                         $0.06 |            | 200 M tok        |                                                                                                            |
| Voyage                                                             | `voyage-4-large`                       |                                         $0.12 |            | 200 M tok        | QAT + MRL                                                                                                  |
| Voyage                                                             | `voyage-3-large`                       |                                         $0.18 |            | 200 M tok        | legacy in v4 era                                                                                           |
| Voyage                                                             | `voyage-code-3`                        |                                         $0.18 |            | 200 M tok        | code domain                                                                                                |
| Cohere                                                             | `embed-v4` (text)                      |                                         $0.12 |            | trial 1 k req/mo | 1536-d, 128 K                                                                                              |
| Cohere                                                             | `embed-v4` (image)                     |                                         $0.47 |            |                  |                                                                                                            |
| Google                                                             | `text-embedding-005`                   |                                    **$0.025** |            | free tier        | older, 768-d                                                                                               |
| Google                                                             | `gemini-embedding-001`                 |                                         $0.15 |     $0.075 | free tier        | 3072-d MRL                                                                                                 |
| Google                                                             | `gemini-embedding-2-preview` (2026-03) |                                         $0.20 |      $0.10 | free             | multimodal                                                                                                 |
| Mistral                                                            | `mistral-embed`                        |                                         $0.10 |            |                  | 1024-d, 8 K                                                                                                |
| Mistral                                                            | `codestral-embed-2505`                 |                                         $0.15 |   50 % off |                  | code, 8 K                                                                                                  |
| AWS Bedrock                                                        | Titan Text Embed v2                    | **$0.02** (= $0.00002/1K tok per AWS pricing) |            |                  | 1024-d, 8 K; DATA GAP: a third-party calculator quotes $0.20/M — official AWS doc is $0.00002/1K = $0.02/M |
| Bedrock                                                            | Cohere `embed-v4`                      |                                         $0.12 |            |                  |                                                                                                            |
| Azure OpenAI                                                       | text-embed-3-large                     |                                 $0.13 (~same) |            |                  | EU residency                                                                                               |
| Jina                                                               | `jina-embeddings-v3` hosted            |                                         $0.02 |            | 10 M free/mo     | 1024-d, 8 K                                                                                                |
| Mixedbread                                                         | mxbai-embed-large hosted               |         DATA GAP (formerly free, now metered) |            |                  | 1024-d                                                                                                     |
| DeepInfra / Together / Fireworks (BGE-large, BGE-M3, Qwen3 hosted) | varies                                 |                              **$0.005–$0.04** |            |                  | Hosted OSS at commodity prices                                                                             |

### Self-Hosted Cost Model

Assumptions: 50 % utilization, warm-up amortized over 30 days, electricity included in hourly rate where on-demand, prices in USD May 2026.

#### CPU-only baseline (8 vCPU / 32 GB RAM, ~$60/mo)

- **Small (~200 M params, fp16):** Arctic-Embed-M-v2.0 or BGE-base via TEI: ~3,000 tok/s sustained → 3,000 × 86,400 × 0.5 = **130 M tok/day** = ~3.9 B tok/mo. At $60/mo that's **$0.015 per 1 M tokens** — cheaper than every cloud API.
- **Large (≥ 1 B params):** not viable; throughput collapses to < 300 tok/s.

#### Consumer GPU (RTX 4090, 24 GB, ~$0.45/hr on-demand or ~$200/mo dedicated)

- **Small (BGE-base / Arctic-m):** ~150 k tok/s → 6.5 B tok/day @ 50 % util = ~190 B tok/mo. At $200/mo → **$0.0011 per 1 M tokens**.
- **Large (Qwen3-Embedding-8B):** ~6 k tok/s → 260 M tok/day = ~7.8 B tok/mo. At $200/mo → **$0.026 per 1 M tokens** — beats every hosted Qwen3 price.

#### Data-center GPU (A100 80 GB ~$1.10/hr, H100 ~$2.50/hr)

- **A100, Qwen3-8B:** ~15 k tok/s → 650 M tok/day = ~19 B tok/mo. At $1.10 × 24 × 30 × 0.5 = ~$400 → **$0.021 per 1 M**.
- **H100, Qwen3-8B:** ~25 k tok/s → 1.08 B tok/day = ~32 B tok/mo. At $2.50 × 24 × 30 × 0.5 = ~$900 → **$0.028 per 1 M**.
- **H100 with TEI batching at small models:** ~400 k tok/s for BGE-base → **<$0.001 per 1 M**.

### Storage Cost (per backend × dimensions × quantization)

Vector bytes = `rows × dim × bytes_per_component × index_overhead(~1.4×)`.

| Rows  | dim 256 fp16 | dim 768 fp16 | dim 1024 fp16 | dim 3072 fp16 | dim 1024 int8 | dim 1024 binary |
| ----- | -----------: | -----------: | ------------: | ------------: | ------------: | --------------: |
| 100 K |        71 MB |       215 MB |        287 MB |        860 MB |        143 MB |           18 MB |
| 1 M   |       0.7 GB |       2.1 GB |        2.9 GB |        8.6 GB |        1.4 GB |         0.18 GB |
| 10 M  |       7.2 GB |      21.5 GB |       28.7 GB |         86 GB |         14 GB |          1.8 GB |
| 100 M |        72 GB |       215 GB |        287 GB |        860 GB |        143 GB |           18 GB |

At 100 M rows × 3072-d float32: ~1.6 TB raw, ~2.2 TB with HNSW. Cohere binary at 1536-d binary brings the same to ~28 GB — a **50× reduction** that maps directly to vector-DB instance class. Cloud-managed Postgres @ 100 M × 768 fp16 (≈ 300 GB indexed): RDS r6g.4xl + 300 GB io2 ≈ $1.5–2 k/mo. Self-hosted Postgres same hardware: ~$400/mo bare-metal. Qdrant Cloud: ~$1–2 k/mo. Pinecone serverless: ~$300/mo storage + $0.07/M reads.

### Breakeven Analysis

Tokens per month at which self-hosted beats cheapest cloud:

| Self-host tier                              |       Effective $/1M | Cheapest cloud                 | Cheapest $/1M |                                                                                      Breakeven (tok/mo) |
| ------------------------------------------- | -------------------: | ------------------------------ | ------------: | ------------------------------------------------------------------------------------------------------: |
| CPU 8-vCPU ($60/mo)                         |               $0.015 | OpenAI 3-small batch           |         $0.01 | self-host always wins on **$/token** but **3–5 M tok/mo** is the practical floor where ops time matters |
| 4090 $200/mo, small model                   |              $0.0011 | Jina v3 / OpenAI batch / Titan |   $0.01–$0.02 |                                               **~10 M tok/mo** — below this, cloud is cheaper after ops |
| 4090 $200/mo, Qwen3-8B                      |               $0.026 | Voyage-4                       |         $0.06 |                                                                **~3.5 B tok/mo** to justify vs Voyage-4 |
| H100 $900/mo, Qwen3-8B                      |               $0.028 | Gemini 001 batch               |        $0.075 |                                                                              **~12 B tok/mo** vs Gemini |
| pgvector self-host vs Pinecone (100 M vec)  |  $400/mo vs $1500/mo | n/a                            |           n/a |                                                                                       **~30 M vectors** |
| Qdrant self-host vs Qdrant Cloud (50 M vec) | ~$120/mo vs ~$500/mo | n/a                            |           n/a |                                                                                      crossover ~5 M vec |

**TL;DR breakevens:** Self-host CPU beats cloud at any volume on **$/token**, but pays for itself only above **~5 M tok/mo** once ops time is included. GPU self-host beats cloud above **~3 B tok/mo for large models**. Dedicated vector DB beats pgvector above **~50 M vectors** (Qdrant 41 QPS vs pgvectorscale 471 QPS at 50M @ 99 % recall is anomalous — pgvectorscale **wins** at 50 M; the crossover to Milvus is ~500 M).

### Latency Premium

CPU embedding latency for a single 512-token query on Arctic-Embed-M v2.0: **~150–250 ms p95**. RTX 4090: **~5–15 ms p95**. A100: **~3–8 ms**. Cohere/Voyage/OpenAI hosted: **~50–150 ms p95** (network + queue). The "ingest-tolerant, query-intolerant" split is real: use CPU for batched ingest, GPU (or hosted) for query path. A common 2026 pattern: **CPU ingest, hosted-API queries** to dodge GPU cost while keeping query p95 < 100 ms.

### Hidden Costs of Self-Hosting

| Scale                                   |          Ops hours/mo | Cost ($150/hr loaded) | Notes                               |
| --------------------------------------- | --------------------: | --------------------: | ----------------------------------- |
| Small (< 10 M tok/mo, single TEI box)   |                   4–6 |              $600–900 | Docker + log shipping               |
| Medium (100 M–1 B tok/mo, multi-region) |                 12–20 |              $1.8–3 k | HA pair, autoscaling, monitoring    |
| Large (10 B+ tok/mo, multi-model)       |                 30–60 |              $4.5–9 k | k8s, GPU fleet, model upgrade cycle |
| Model upgrade (re-embed 100 M docs)     | one-off 20–40 + GPU $ |      ~$5–10 k blended | every 12–18 mo                      |

### Reranker Cost

| Reranker                      | $/1k searches (≤ 100 docs) | Self-host VRAM fp16 |                                      Self-host throughput | Quality lift over dense-only                   |
| ----------------------------- | -------------------------: | ------------------: | --------------------------------------------------------: | ---------------------------------------------- |
| Cohere Rerank 3.5             |                  **$2.00** |                 n/a |                                                       n/a | +5–12 NDCG@10                                  |
| Cohere Rerank 4 Fast          |                   DATA GAP |                 n/a |                                                       n/a | similar                                        |
| BGE Reranker v2-m3 (568 M)    |                       open |             ~1.1 GB |                                           ~50 q/s on A100 | +4–10 NDCG@10                                  |
| BGE Reranker v2-gemma (2 B)   |                       open |               ~4 GB |                                           ~10 q/s on A100 | +5–11                                          |
| Jina Reranker v2 (278 M)      |          $0.02/1k (hosted) |             ~560 MB |                                           ~80 q/s on A100 | +4–9                                           |
| mxbai-rerank-base-v2 (0.5 B)  |                       open |               ~1 GB |                                           ~60 q/s on A100 | BEIR 55.6                                      |
| mxbai-rerank-large-v2 (1.5 B) |                       open |               ~3 GB | ~25 q/s on A100; **8× faster than bge-reranker-v2-gemma** | **BEIR 57.5** (claims to beat Cohere & Voyage) |
| Qwen3-Reranker-0.6B / 4B / 8B |                       open |     1.2 / 8 / 16 GB |                                          scales with size | top of MTEB-R                                  |
| Voyage Rerank 2.5             |                   DATA GAP |                 n/a |                                                       n/a | competitive                                    |
| ZeRank-2                      |                     hosted |                 n/a |                                                       n/a | Agentset benchmark leader                      |

For 1 M queries/month: Cohere = $2,000; self-host bge-reranker-v2-m3 on a $0.45/hr A10G = ~$160/mo (50 % util) → **~12× cheaper self-hosted** at this scale.

## Privacy & Sovereignty

### Tier Classification per Cloud Provider

See §1.10 table above.

### Confidential Computing & On-Device Trends

- **On-device / browser:** `transformers.js` running BGE-small, MiniLM, Nomic-Embed-v1.5-quantized in WebGPU yields ~500 tok/s on M-class Macs and ~1.5 k tok/s on a desktop browser. Production-real for personal-data RAG (e.g., browser-side note search) where the corpus never leaves the device.
- **MLX on Apple Silicon:** M4 Max at ~40 k tok/s for BGE-base — competitive with a small cloud GPU at $0 incremental cost. Production-real.
- **Confidential computing:** Azure Confidential VMs (AMD SEV-SNP) host OpenAI under attested enclaves (announced 2024-Q4); AWS Nitro Enclaves used by some Cohere customers; **NVIDIA H100 / H200 Confidential Computing** is GA in 2026 and runs TEI/vLLM with attested workloads at a ~5–10 % throughput penalty. Production-real for regulated industries; pricing carries ~15–25 % premium.
- **Homomorphic / private retrieval (Tiptoe, SimplePIR, Spiral):** Still research-tier in 2026 for embedding retrieval. **Not production-real at scale**. Practical for < 10 k document corpora only.

### Operational Cost of "Green" (Self-Hosting)

| Stack scope                                                  |                Team-hours/mo | Annualized loaded cost |
| ------------------------------------------------------------ | ---------------------------: | ---------------------: |
| Single TEI box, one model, < 10 M tok/mo                     |                          4–6 |                 ~$10 k |
| Multi-model TEI fleet, 100 M–1 B tok/mo, basic observability |                        12–20 |              ~$25–35 k |
| k8s + vLLM + multi-region + GPU autoscaling                  |                        30–60 |             ~$60–100 k |
| Plus annual model upgrade/re-embed cycle                     | +20–40 hrs + $5–10 k compute |               ~$8–15 k |

Self-hosting is "free of vendor cost" only if you ignore the ops floor of ~$10–15 k/yr per non-trivial deployment.

## Recommendations

### Persona 1: Privacy-Maximalist

- **Workload:** must self-host or use confidential-compute / no-train API; quality ≥ 95 % of MTEB SOTA.
- **Choice:** **Qwen3-Embedding-4B** (Apache 2.0) on **HF TEI** running on a **dedicated RTX 4090 (~$200/mo) or H100 Confidential Computing instance**. Storage on **self-hosted Qdrant** with int8 + HNSW.
- **Dim:** 2048 (Matryoshka) for retrieval; 1024 for cost-tight.
- **Expected:** MTEB-Eng ~68, MMTEB ~69, MTEB-Code ~78.
- **$/month at 10 M docs (~5 B tok corpus, 1 M queries/mo):** ~$200 GPU + ~$120 Qdrant box ≈ **$320/mo** + ops 8 hrs/mo.
- **Latency:** p95 < 25 ms embed + < 10 ms ANN ≈ **35 ms**.
- **Why it beats the obvious alternative (Voyage / Gemini on Bedrock):** zero data egress; identical quality to Voyage-3-large; ~$3–10 k/yr lower at this scale; Apache 2.0 means no future-version forced re-embed.

### Persona 2: Cost-Minimalist at High Volume

- **Workload:** ≥ 1 B tokens/year ingest, low query rate, low sensitivity.
- **Choice:** **Snowflake Arctic-Embed-M-v2.0** (Apache 2.0) via **TEI** on an **8-vCPU CPU box ($60/mo)**, OR **OpenAI `text-embedding-3-small` Batch API at $0.01/M** if you do not want to run anything.
- **Dim:** 768 (Arctic default); MRL→256 if storage-bound.
- **Expected:** MTEB-Eng ~56–58, MMTEB strong < 1 B params.
- **$/month at 10 B tok/yr (~830 M tok/mo):** **$60** self-host (CPU saturated at ~390 M tok/mo at 50 % util — you'll need 2 boxes ≈ **$120/mo**) **or** $8 OpenAI Batch.
- **Latency:** ingest-only, irrelevant.
- **Why it beats the alternative:** at high volume, OpenAI Batch ($8/mo) genuinely wins on simplicity; self-host wins only if you re-embed quarterly. Avoid Voyage / Gemini at this scale — 6–15× more expensive for no perceivable quality lift on bulk clustering.

### Persona 3: Balanced Production App

- **Workload:** ≤ 100 M tokens/year, medium sensitivity, best Pareto cost × quality × privacy.
- **Choice:** **Voyage `voyage-4` ($0.06/M, with $200M free tier covering you for the first ~3 years at 100 M tok/yr)** or **OpenAI `text-embedding-3-large`** via Azure OpenAI for EU residency. Storage on **pgvector 0.9** in your existing Postgres + HNSW.
- **Dim:** voyage-4 at 1024-d int8 for storage; or OpenAI 3-large MRL→1024.
- **Expected:** MTEB-Eng 65–68, MMTEB strong.
- **$/month at 100 M tok/yr (~8 M tok/mo):** **$0** with Voyage free tier, otherwise ~$5; Postgres ~$200.
- **Latency:** ~80–150 ms p95 (hosted API) + ~5 ms pgvector.
- **Why it beats the alternative:** the Voyage 200 M free-tier swallows most non-enterprise corpora outright; pgvector keeps ops at zero; OpenAI / Gemini cost the same but Voyage's QAT means you can binary-quantize for 32× storage savings without quality loss.

### Persona 4: Latency-Critical Real-Time Search

- **Workload:** query p95 ≤ 50 ms end-to-end, hybrid + reranking, cost secondary.
- **Choice:** **OpenAI 3-large** _or_ **Cohere embed-v4** for query embedding (low p95 via warm endpoint); **Qdrant** for ANN; **Cohere Rerank 3.5** or self-hosted **mxbai-rerank-large-v2** on an A10G for reranking; corpus indexed with **Voyage-3-large 512-d binary** (best quality at lowest storage) or **OpenAI 3-large MRL→1024**.
- **Dim:** 1024 query/doc; binary for ANN, float for rerank.
- **Expected:** MTEB-Eng 65–68; hybrid + rerank adds +5–10 NDCG@10.
- **$/month at 10 M queries/mo:** Cohere queries 0.5 M tok × $0.12 ≈ $60; Rerank 3.5 ≈ $20 k/mo (10 M × $2/1k) — **flip to self-hosted mxbai-rerank-large-v2 on 2× A10G HA ≈ $700/mo**, saving $19 k. Qdrant cloud ~$500.
- **Latency budget:** query embed 25 ms (Cohere/Voyage) + ANN 5 ms (Qdrant) + rerank 15 ms (mxbai on A10G, batch 32) = **~45 ms p95**.
- **Why it beats the alternative:** Cohere Rerank is excellent but $2/1k searches is prohibitive at 10 M+ queries — mxbai-rerank-v2 is **8× faster than bge-reranker-v2-gemma** and matches or beats Cohere on BEIR per Mixedbread benchmarks.

### Persona 5 (Wildcard): Fully-Local On-Device

- **Workload:** desktop/mobile app with personal-data RAG (notes, mail, files); zero cloud egress.
- **Choice:** **Nomic-Embed-Text-v1.5 (Apache 2.0)** or **all-MiniLM-L6-v2** quantized to ONNX-int8, served by **`transformers.js`** (browser) / **MLX** (macOS) / **onnxruntime-node** (Electron). LanceDB or SQLite-VSS for storage.
- **Dim:** 384 (MiniLM) or 768 (Nomic).
- **Expected:** MTEB-Eng 56–62.
- **$/month:** **$0**.
- **Latency:** 50–200 ms per query on a modern laptop; ANN < 5 ms.
- **Why it beats the alternative:** absolute privacy at zero marginal cost. Production-real in 2026 with WebGPU and MLX.

### Capability-Specific Notes

- **Semantic search (general):** Persona 3 stack is the default. Hybrid is worth +3-5 NDCG.
- **Clustering / topic modeling:** dimension matters less than coverage; **BGE-small** or **all-MiniLM** at 384-d on CPU is the floor; truncate larger models with MRL to 256-d before HDBSCAN/k-means.
- **Deduplication / near-duplicate:** binary embeddings (Cohere, Voyage QAT) + Hamming distance — 50–100× faster than cosine on 100 M+ corpora.
- **Cross-document intelligence / entity linking:** late-interaction (ColBERT / BGE-M3 multi-vec) wins by 5+ pts; reserve for high-value queries.
- **Summarization (embedding-driven chunk selection):** **late chunking** (Jina v3/v4) materially improves which chunk survives the truncation.
- **RAG / Copilot retrieval:** dense (Qwen3 or voyage-4) + **rerank** (mxbai-large or Cohere) is the dominant pattern; do not skip reranking — it adds +5-12 NDCG@10.
- **Speech / transcript embeddings (text-side):** transcript chunks are short and noisy; instruction-tuned models (Qwen3, E5-mistral) with `query:` / `passage:` prefixes outperform untuned by 4-8 NDCG.

## Decision Tree

```
START: What is your single biggest constraint?
│
├─ Data MUST NOT leave your infra ─────────────────► Persona 1: Qwen3-Embedding-4B on TEI + Qdrant
│
├─ Cost at very high volume (≥ 1B tok/yr) ─────────► Persona 2:
│      ├─ Want zero ops? ──► OpenAI 3-small Batch ($0.01/M)
│      └─ Hate vendors? ───► Arctic-Embed-M-v2.0 on CPU + pgvector
│
├─ Query latency p95 ≤ 50 ms with reranking ──────► Persona 4:
│      ├─ Cohere embed-v4 + self-hosted mxbai-rerank-v2 + Qdrant
│      └─ (if multilingual heavy) Gemini Embedding + Qwen3-Reranker-4B
│
├─ "Normal" production app, < 100M tok/yr ────────► Persona 3:
│      ├─ EU residency? ─► Azure OpenAI 3-large or Mistral mistral-embed
│      └─ otherwise ──── ► Voyage voyage-4 (free tier) + pgvector
│
├─ On-device / browser / mobile ──────────────────► Persona 5:
│      └─ Nomic-Embed-v1.5 or MiniLM via transformers.js / MLX / onnxruntime-node
│
└─ Code retrieval is the workload? ───────────────► Qwen3-Embedding-8B (open) OR
                                                     voyage-code-3 / Codestral-embed (hosted)
```

## Open Questions / Data Gaps

1. **DATA GAP:** No publicly verified MTEB-Code or LongEmbed scores for `gemini-embedding-001` and `gemini-embedding-2-preview` — Google publishes aggregate MTEB-Multi only. Closest proxy: vendor blog claims of "MTEB Code 84.0" for Gemini Embedding 2.
2. **DATA GAP:** Anthropic has no first-party embedding model as of 2026-05-17; recommends Voyage (in which Anthropic has invested).
3. **DATA GAP:** Per-language MTEB leaderboards for **Romanian** do not exist in MMTEB. Closest proxies: Polish-PL-MTEB, Bulgarian-BG-MTEB (Slavic), French/Italian/Spanish CLEF (Romance). Use Snowflake Arctic 2.0 or Qwen3 as the multilingual default.
4. **DATA GAP:** IBM Granite Embedding 107M / 278M is positioned by IBM at a BGE-base / MiniLM tier but no independent MTEB cross-check exists.
5. **DATA GAP:** AWS Bedrock Titan Text Embeddings v2 pricing: AWS official pricing is $0.00002/1k input tokens (= **$0.02/M**); some third-party calculators quote $0.20/M. Verify against `aws.amazon.com/bedrock/pricing/` at deployment time.
6. **DATA GAP:** Voyage `voyage-3-large` vs `voyage-4-large` MTEB head-to-head — Voyage publishes domain-relative win-rates rather than raw MTEB v2 scores. Treat any 67+ score with care.
7. **MTEB contamination risk:** Voyage's own `voyage-3-m-exp` card admits MTEB training-set use. Cross-validate on your own corpus.
8. **DATA GAP:** Mixedbread hosted pricing in 2026 — site advertises models, not transparent metered API price.
9. **DATA GAP:** Confidential-computing throughput on H100 CC mode in production embedding workloads — NVIDIA reports ~5–10 % penalty but no peer-reviewed third-party numbers for embedding-specific batches.
10. **DATA GAP:** The transition from MTEB v1 → MTEB v2 (2026) makes pre-2026 scores non-comparable. Numbers in this report flagged "legacy MTEB" should not be compared to v2 scores.

## References

1. Awesome Agents — _MTEB Rankings April 2026_ — https://awesomeagents.ai/leaderboards/embedding-model-leaderboard-mteb-april-2026/ (accessed 2026-05-17)
2. Awesome Agents — _MTEB Rankings March 2026_ — https://awesomeagents.ai/leaderboards/embedding-model-leaderboard-mteb-march-2026/ (accessed 2026-05-17)
3. OpenAI API docs — _text-embedding-3-small model_ — https://developers.openai.com/api/docs/models/text-embedding-3-small (accessed 2026-05-17)
4. OpenAI API pricing — https://developers.openai.com/api/docs/pricing (accessed 2026-05-17)
5. TokenMix — _OpenAI Embedding Pricing 2026_ — https://tokenmix.ai/blog/openai-embedding-pricing (accessed 2026-05-17)
6. Voyage AI docs — _Text Embeddings_ — https://docs.voyageai.com/docs/embeddings (accessed 2026-05-17)
7. Voyage AI docs — _Pricing_ — https://docs.voyageai.com/docs/pricing (accessed 2026-05-17)
8. Voyage AI blog — _voyage-3-large_ — https://blog.voyageai.com/2025/01/07/voyage-3-large/ (accessed 2026-05-17)
9. Hugging Face — _voyageai/voyage-3-m-exp_ (MTEB contamination disclosure) — https://huggingface.co/voyageai/voyage-3-m-exp (accessed 2026-05-17)
10. MongoDB docs — _Voyage AI Models Overview_ — https://www.mongodb.com/docs/voyageai/models/ (accessed 2026-05-17)
11. Cohere docs — _Announcing Embed Multimodal v4_ — https://docs.cohere.com/changelog/embed-multimodal-v4 (accessed 2026-05-17)
12. Cohere docs — _Embed Models_ — https://docs.cohere.com/docs/cohere-embed (accessed 2026-05-17)
13. AWS Bedrock docs — _Cohere Embed v4_ — https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-embed-v4.html (accessed 2026-05-17)
14. Oracle OCI docs — _Cohere Embed 4_ — https://docs.oracle.com/en-us/iaas/Content/generative-ai/cohere-embed-4.htm (accessed 2026-05-17)
15. Microsoft Marketplace — _Cohere Embed 4_ — https://marketplace.microsoft.com/en-us/product/saas/cohere.cohere-embed-4-offer (accessed 2026-05-17)
16. Cohere blog — _Rerank 3.5_ — https://cohere.com/blog/rerank-3pt5 (accessed 2026-05-17)
17. Google Developers Blog — _Gemini Embedding GA_ — https://developers.googleblog.com/en/gemini-embedding-available-gemini-api/ (accessed 2026-05-17)
18. Vercel AI Gateway — _Gemini Embedding 001 spec_ — https://vercel.com/ai-gateway/models/gemini-embedding-001 (accessed 2026-05-17)
19. OpenRouter — _Gemini Embedding 001_ — https://openrouter.ai/google/gemini-embedding-001 (accessed 2026-05-17)
20. TokenCost — _Gemini Embedding 2 Pricing_ — https://tokencost.app/blog/gemini-embedding-2-pricing (accessed 2026-05-17)
21. Mistral AI — _Codestral Embed_ — https://mistral.ai/news/codestral-embed (accessed 2026-05-17)
22. Mistral docs — _Mistral Embed_ — https://docs.mistral.ai/models/mistral-embed-23-12 (accessed 2026-05-17)
23. OpenRouter — _Mistral Embed_ — https://openrouter.ai/mistralai/mistral-embed-2312 (accessed 2026-05-17)
24. AWS — _Titan Text Embeddings V2 announcement_ — https://aws.amazon.com/about-aws/whats-new/2024/04/amazon-titan-text-embeddings-v2-amazon-bedrock/ (accessed 2026-05-17)
25. AWS — _Titan Text Embeddings models_ (8 K tokens, 1024-d) — https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html (accessed 2026-05-17)
26. AWS Blog — _Get started with Titan Text Embeddings V2_ — https://aws.amazon.com/blogs/machine-learning/get-started-with-amazon-titan-text-embeddings-v2-a-new-state-of-the-art-embeddings-model-on-amazon-bedrock/ (accessed 2026-05-17)
27. arXiv — _Qwen3 Embedding_ (2506.05176) — https://arxiv.org/pdf/2506.05176 (accessed 2026-05-17)
28. QwenLM blog — _Qwen3 Embedding_ — https://qwenlm.github.io/blog/qwen3-embedding/ (accessed 2026-05-17)
29. Hugging Face — _Qwen3-Embedding-8B model card_ — https://huggingface.co/Qwen/Qwen3-Embedding-8B (accessed 2026-05-17)
30. GitHub — _QwenLM/Qwen3-Embedding_ — https://github.com/QwenLM/Qwen3-Embedding (accessed 2026-05-17)
31. SiliconFlow — _Qwen3-Embedding-8B specs_ — https://www.siliconflow.com/models/qwen3-embedding-8b (accessed 2026-05-17)
32. Hugging Face — _snowflake-arctic-embed-l-v2.0_ — https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0 (accessed 2026-05-17)
33. Hugging Face — _snowflake-arctic-embed-m-v2.0_ — https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0 (accessed 2026-05-17)
34. Snowflake Engineering — _Arctic Embed 2.0 Goes Multilingual_ — https://www.snowflake.com/en/engineering-blog/snowflake-arctic-embed-2-multilingual/ (accessed 2026-05-17)
35. arXiv — _Arctic-Embed 2.0_ (2412.04506) — https://arxiv.org/pdf/2412.04506 (accessed 2026-05-17)
36. Hugging Face — _Text Embeddings Inference_ docs — https://huggingface.co/docs/text-embeddings-inference/en/index (accessed 2026-05-17)
37. Hugging Face blog — _Deploy Embedding Models with TEI_ (450 req/s on A10G benchmark) — https://moon-ci-docs.huggingface.co/blog/inference-endpoints-embeddings (accessed 2026-05-17)
38. GitHub — _huggingface/text-embeddings-inference_ — https://github.com/huggingface/text-embeddings-inference (accessed 2026-05-17)
39. DeepWiki — _TEI architecture_ — https://deepwiki.com/huggingface/text-embeddings-inference (accessed 2026-05-17)
40. Modal blog — _Top embedding models on MTEB_ — https://modal.com/blog/mteb-leaderboard-article (accessed 2026-05-17)
41. Mixedbread blog — _mxbai-rerank v2_ (BEIR 57.5, 8× faster than bge-reranker-v2-gemma) — https://www.mixedbread.com/blog/mxbai-rerank-v2 (accessed 2026-05-17)
42. Analytics Vidhya — _Top 7 Rerankers for RAG_ — https://www.analyticsvidhya.com/blog/2025/06/top-rerankers-for-rag/ (accessed 2026-05-17)
43. Agentset — _Reranker leaderboard_ — https://agentset.ai/rerankers (accessed 2026-05-17)
44. Oracle docs — _Cohere Rerank 3.5 benchmarks_ — https://docs.oracle.com/en-us/iaas/Content/generative-ai/benchmark-cohere-rerank-3-5.htm (accessed 2026-05-17)
45. Alphacorp — _Best Vector Databases for RAG 2026_ (Qdrant 4.74 ms p50 @ 50 M) — https://alphacorp.ai/blog/best-vector-databases-for-rag-2026-top-7-picks (accessed 2026-05-17)
46. CallSphere — _Vector DB Benchmarks 2026_ — https://callsphere.ai/blog/vector-database-benchmarks-2026-pgvector-qdrant-weaviate-milvus-lancedb (accessed 2026-05-17)
47. Firecrawl — _Best Vector Databases 2026_ (pgvectorscale 471 QPS @ 50 M) — https://www.firecrawl.dev/blog/best-vector-databases (accessed 2026-05-17)
48. Let's Data Science — _Vector DBs Compared_ (Milvus 2.5 Sparse-BM25 30× faster than ES) — https://letsdatascience.com/blog/vector-databases-compared-pinecone-qdrant-weaviate-milvus-and-more (accessed 2026-05-17)
49. PE Collective — _Text Embedding Models Compared 2026_ — https://pecollective.com/tools/text-embedding-models-compared/ (accessed 2026-05-17)
50. BuildMVPFast — _Voyage 3.5 vs OpenAI vs Cohere 2026_ — https://www.buildmvpfast.com/blog/best-embedding-model-comparison-voyage-openai-cohere-2026 (accessed 2026-05-17)
51. TokenMix — _Text Embedding Models 2026_ — https://tokenmix.ai/blog/text-embedding-models-comparison (accessed 2026-05-17)
52. Milvus blog — _Best Embedding Model for RAG 2026_ (CCKM benchmark) — https://milvus.io/blog/choose-embedding-model-rag-2026.md (accessed 2026-05-17)

— End of `STATE-OF-THE-ART.md` —
