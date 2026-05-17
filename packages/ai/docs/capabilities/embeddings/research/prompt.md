# Research Prompt — State of the Art for Text Embeddings (Cloud vs Self-Hosted, ROI, Privacy)

**Audience:** External AI research agent (ChatGPT Deep Research, Claude with web search, Perplexity, Gemini Deep Research, or equivalent).
**Output destination:** A single `STATE-OF-THE-ART.md` document targeting engineers and tech leads deciding how to do production text embeddings in 2026.
**Cutoff:** Today's date is **2026-05-17**. Treat any artifact dated 2024-01 → today as current; flag anything older as "historical context only."

> Do not ask follow-up questions — produce the deliverable in one shot. If a number is missing from the public record, say so explicitly and explain the gap rather than guessing. **Cover the full landscape; do not assume any particular stack, runtime, vendor, or vector database is preferred.** Your job is to map the space honestly so the reader can make their own architectural choice.

---

## 1. Mandatory Scope

You **must** cover every item below. If you cannot find authoritative data, write "DATA GAP: …" and continue — do not silently skip.

### 1.1 Cloud embedding providers (current generation)

For each, report: model name(s), API price per 1M tokens (both input and any output/storage fee), dimensions (and Matryoshka truncation support), max context length, MTEB English score, MMTEB / multilingual score, code-retrieval score where applicable, license, data-handling commitment (training on inputs y/n, opt-out, EU/regional residency, BAA availability, SOC 2 / ISO 27001), audit trail / logging retention, and date of last model refresh.

Minimum providers to evaluate (add any other 2026 entrant that scores ≥ 65 MTEB):

- OpenAI: `text-embedding-3-small`, `text-embedding-3-large`, plus any 2026-current successor
- Voyage AI: `voyage-3`, `voyage-3-large`, `voyage-code-3`, `voyage-multilingual-3` or newer
- Cohere: `embed-v4` / `embed-english-v3` / `embed-multilingual-v3` (or current)
- Google: `gemini-embedding-001` and any successor (and the Vertex AI multilingual variants)
- Anthropic: any embedding model if released
- Mistral: `mistral-embed` (and any 2026 update)
- AWS Bedrock Titan Embeddings v2 (only if still competitive — otherwise note and skip)
- Azure OpenAI (note pricing/residency differences vs OpenAI direct)
- Jina AI: hosted `jina-embeddings-v3` / `v4` API tier
- Mixedbread: hosted `mxbai-embed-large` API tier
- DeepInfra, Together, Fireworks, Replicate, OpenRouter — hosted-OSS-model marketplaces. Report price per 1M tokens per model, not per provider.

### 1.2 Open-source self-hostable models

For each, report: parameter count, dimensions (and Matryoshka truncation support), context length, license (with commercial-use note: Apache 2.0 vs MIT vs CC-BY-NC vs custom-research-only), MTEB English, MMTEB multilingual, top languages where each model excels and where it collapses, VRAM footprint at fp16 / fp8 / int8 / int4, **CPU-only viability** (yes / marginal / no, with tokens/sec evidence), throughput (tokens/sec on consumer GPU like RTX 4090, on data-center GPU like A100/H100, and on a typical 8-vCPU CPU server), Hugging Face repo ID, and Ollama tag if one exists.

Minimum models to evaluate (add any 2026 model with ≥ 65 MTEB at ≤ 7B params):

- **Snowflake Arctic Embed** family (1.5 and 2.0 — m, s, l, xl, multilingual)
- **BAAI BGE-M3**, **bge-large-en-v1.5**, **bge-en-icl** (in-context learning variant)
- **Nomic Embed Text v1.5 / v2** (Matryoshka, MoE variant)
- **Mixedbread mxbai-embed-large-v1** and 2026 successors
- **Jina Embeddings v3 / v4** (open-weights tier — include long-context and late-chunking variants)
- **Stella** family (`stella_en_400M_v5`, `stella_en_1.5B_v5`)
- **GTE-Qwen2** family (1.5B, 7B)
- **Linq AI Linq-Embed-Mistral**
- **e5-mistral-7b-instruct**, **multilingual-e5-large-instruct**
- **IBM Granite Embedding** (107M, 278M; English + multilingual)
- **Alibaba GTE-ModernBERT-base**, **GTE-large-en-v1.5**
- **NV-Embed-v2** (NVIDIA, if license permits)
- **all-MiniLM-L6-v2** (CPU baseline — is it still defensible as the "cheap CPU" floor in 2026?)

### 1.3 Specialized models (call out where they dominate)

- **Code retrieval**: Voyage-code-3, jina-code-v2, CodeRankEmbed, etc.
- **Long-context** (≥ 8K, ideally 32K): LongEmbed leaderboard winners, Jina v3 with late-chunking.
- **Domain-specific**: legal, medical, finance, scientific (e.g. SPECTER, SciNCL, MedCPT).
- **Multilingual-first**: BGE-M3, mE5-large-instruct, multilingual-e5, Jina v3 multilingual, Cohere multilingual-v3.
- **Quantization-native**: models trained with binary or int8 awareness (Cohere int8 / binary, Mixedbread binary MRL).

### 1.4 Local inference runtimes

For each, report: hardware target (CPU / GPU / Apple Silicon / edge), model formats supported (safetensors, GGUF, ONNX, etc.), throughput on a 1k-token batch at fp16 and int8, OpenAI-API-compatibility (yes/no), deployment story (single-binary, Docker, Kubernetes, serverless), and integration story from the major languages (Python, Node/Bun, Go, Rust).

Cover at least:

- **Ollama** (model catalog + Modelfile system; OpenAI-compatible API)
- **llama.cpp** server (GGUF; OpenAI-compatible)
- **HuggingFace Text Embeddings Inference (TEI)** (Docker, OpenAI-compatible)
- **vLLM** (does it embed well? when is it overkill vs TEI?)
- **SGLang** (if it has an embedding path)
- **fastembed** (Qdrant's ONNX-based Python library)
- **transformers.js** / **onnxruntime-web** / **onnxruntime-node** (in-process inference)
- **candle** (Rust)
- **MLX** (Apple Silicon)
- **NVIDIA NIM / Triton** (enterprise GPU serving)

Explicitly answer: **can you run a 67-MTEB-class model on CPU only at acceptable latency for batched ingest in 2026, with no GPU at all?** Provide tokens/sec numbers, not adjectives.

### 1.5 MTEB / MMTEB current state

- Top 20 on the current **MTEB English** leaderboard, with access date.
- Top 10 on **MMTEB multilingual**.
- Top 10 on **MTEB Code**.
- Top 10 on **MTEB Long-Doc** (LongEmbed).
- Per-language leaderboards for at least: Chinese (C-MTEB), French, German, Spanish, Italian, Polish, Japanese, Korean, Arabic, Romanian (or nearest Romance/Slavic proxy if no Romanian eval exists). Note where eval data is sparse.
- Flag known leaderboard contamination concerns. Note any model strongly suspected of MTEB-overfit.

### 1.6 Reranking (downstream of embeddings — required for SOTA hybrid retrieval)

Cover at least: Cohere Rerank 3.5, BGE Reranker v2 (m3, large), Jina Reranker v2, mxbai-rerank, and any open-weights cross-encoder ≥ 60 nDCG@10 on BEIR. Same fields as embedding models (price / license / latency / VRAM / local-runnable / multilingual support). Quantify the quality lift over dense-only retrieval (typical: +10–25% nDCG@10 — be specific per benchmark).

### 1.7 Vector storage and retrieval backends

Survey the landscape — **do not assume any particular backend is preferred**. For each, report: index types (HNSW, IVF, IVFPQ, DiskANN, ScaNN), max practical scale per node, support for filtered / hybrid / multi-vector search, hosted vs self-hosted options, license, indicative cost at 10M / 100M vectors, and the failure mode (i.e. at what scale or query pattern does it stop being a good fit).

Minimum to cover:

- **pgvector** (Postgres extension; HNSW + IVFFlat)
- **pgvectorscale** (Timescale's ANN add-on for pgvector — DiskANN-style)
- **Qdrant** (Rust; payload filtering)
- **Weaviate**
- **Milvus** / **Zilliz Cloud**
- **Vespa** (the long-standing dark horse)
- **Pinecone** (managed-only baseline)
- **Elasticsearch / OpenSearch** dense_vector
- **Redis Stack** vector search
- **LanceDB** / **Chroma** (embedded / dev-friendly)
- **Turbopuffer** (object-storage-backed)
- **DuckDB VSS** + **SQLite-VSS**

### 1.8 Architecture techniques (which ones change the cost equation?)

For each: describe in 2-3 sentences, list which models support it, and quantify impact on cost / quality / storage.

- **Matryoshka Representation Learning** — dim truncation (768 → 256 etc.)
- **Late chunking** (Jina) — chunk after encode, not before
- **Multi-vector / ColBERT / ColPali-style** late interaction — storage vs quality trade
- **Instruction prefixes** (E5, BGE, Snowflake Arctic 2.0) — required vs optional, per-task
- **Vector-level quantization** (int8, scalar, product, binary) — quality loss per compression level
- **HNSW vs IVF vs IVFPQ vs DiskANN vs ScaNN** — when does each break?
- **Hybrid retrieval** (BM25 + dense + RRF / weighted) — does it consistently beat dense-only at every scale?
- **Sparse-vector retrieval** (SPLADE, learned sparse) — where it competes with or replaces dense
- **Embedding caching strategies** — fingerprint-based, content-hash, TTL
- **Re-embedding on model upgrade** — does any provider/model preserve representational compatibility across versions?

### 1.9 Cost / ROI analysis (headline section — be rigorous)

Produce a **breakeven analysis** with real numbers and explicit math. Do not write "X is cheap" without a $-figure.

1. **Per-1M-tokens cloud cost** comparison across every provider in §1.1, normalized for ingest vs query separately if priced differently.
2. **Self-hosted cost model** at three reference hardware tiers — pick representative public-cloud / bare-metal SKUs with current 2026 prices:
   - **CPU-only server** (e.g. 8 vCPU / 32 GB RAM commodity Linux box, ~$50–80/month)
   - **Consumer-GPU server** (e.g. RTX 4090 or RTX 4000 SFF Ada, 16–24 GB VRAM, $150–250/month dedicated or $0.30–0.80/hr on-demand)
   - **Data-center-GPU server** (e.g. A100 40 GB or H100 80 GB, $1–4/hr on-demand)

   For each tier, calculate tokens/sec for a small (≤ 200M params) and a large (≥ 1B params) embedding model. Translate to $/1M tokens. Include warm-up and 50%-utilization amortization.

3. **Storage cost at scale**: pure bytes math at 100K / 1M / 10M / 100M rows, for dimensions of 256, 384, 768, 1024, 3072, at fp32, fp16, int8, binary. Include typical HNSW index overhead (~1.3–1.5×). Compare on top of cloud-managed Postgres vs self-hosted Postgres vs a dedicated vector DB.
4. **Breakeven points**: at what ingest volume does self-hosted (CPU) beat the cheapest cloud API? At what volume does GPU beat CPU? At what volume does a dedicated vector DB beat pgvector? Express in concrete monthly token / query / row numbers.
5. **The latency premium**: if a self-hosted CPU path is 3× slower for 10× cheaper, when does that matter? Quantify the "ingest-tolerant, query-intolerant" split.
6. **Hidden self-host costs**: ops time, monitoring, model upgrade cycle, embedding-drift cost on re-embed. Estimate team-hours/month at small / medium / large scale.
7. **Reranker cost**: incremental $-per-query for adding a reranker (cloud rerank API vs self-hosted cross-encoder).

### 1.10 Privacy & sovereignty matrix

For each cloud provider in §1.1, classify on:

- **Training-on-input policy**: trains on submitted text by default? opt-out path? business-tier always-off? Cite the current ToS / policy URL and access date.
- **Data residency**: which regions / sovereign clouds (US, EU, UK, Canada, Australia, India, etc.)?
- **GDPR posture**: DPA available? Standard Contractual Clauses? List of approved sub-processors?
- **Sub-processors**: published list? notification on change?
- **Logging / retention**: how long are inputs retained server-side by default? Can it be set to zero?
- **Compliance**: SOC 2 Type II, ISO 27001, HIPAA BAA, FedRAMP, etc.
- **Sovereignty risk**: jurisdiction of the corporate entity, CLOUD Act / FISA-702 exposure for non-US users.

Self-hosted is implicitly green for all of these — but quantify: **what is the operational cost of "green"?** Specifically: team-hours/month to keep a self-hosted embedding stack patched, monitored, and on the current model generation.

Also flag any **emerging techniques** that change the privacy story:

- **On-device / edge embeddings** (transformers.js in the browser, MLX on macOS clients)
- **Confidential computing** (Azure Confidential VMs, AWS Nitro Enclaves, NVIDIA Confidential Computing on H100)
- **Homomorphic / private retrieval** (state of the art in 2026 — is it production-real yet?)

### 1.11 The "biggest ROI, cheapest path" recommendation

Give a **ranked, opinionated answer** of the form:

> "For a workload with profile X, the cheapest path that captures ≥ 90% of the quality of the SOTA cloud option is: **model Y running on runtime Z**, total cost $A/month at scale B, latency C ms p95."

Produce this recommendation for **at least 4 generic personas**:

1. **Privacy-maximalist** — must self-host or use a confidential-compute / no-train provider; willing to absorb operational complexity; quality target = within 5% of MTEB SOTA.
2. **Cost-minimalist at high volume** — bulk ingest (≥ 1B tokens/year), low query rate, low sensitivity; wants the cheapest $/1M-tokens that still clusters/searches usefully.
3. **Balanced production app** — medium volume (≤ 100M tokens/year), medium sensitivity, wants the best Pareto point on cost × quality × privacy.
4. **Latency-critical real-time search** — query p95 ≤ 50 ms end-to-end including ANN; quality must support hybrid + reranking pipeline; cost is secondary.

Each persona's recommendation must include: model choice, runtime/host choice, dimension choice (Matryoshka if applicable), expected MTEB-English and MMTEB-multilingual score, $/month at the persona's reference scale, latency profile, and a one-line reason why this beats the obvious alternative.

Optionally call out a 5th persona if a 2026 trend (e.g. fully-local on-device embeddings) warrants it.

---

## 2. Required Output Format

Produce **one markdown document** named `STATE-OF-THE-ART.md`, structured below. Match a peer-reviewed-tech-survey level of density: tables over prose, numbers over adjectives.

```markdown
# State of the Art: Text Embeddings (2024-2026)

## Overview
(3-5 sentences: what's new since 2024, what the 2026 frontier is, what the central trade-offs are.)

## Historical Context
### Evolution Timeline
| Year | Milestone | Key Innovation |

### Paradigm Shifts
(ASCII flow diagram showing the conceptual eras.)

## Current State

### Approach Comparison
| Approach | Quality | Cost | Latency | Privacy | Multilingual |

### Embedding Model Leaderboard (2026)
| Rank | Model | MTEB Eng | MMTEB | Code | LongDoc | Dim | Ctx | $/1M tok (hosted) | License | Self-host? |

### Self-Hostable Model Matrix
| Model | Params | VRAM fp16 | VRAM int8 | CPU viable? | Tokens/sec (CPU) | Tokens/sec (RTX 4090) | Ollama tag | MTEB Eng | MMTEB | License |

### Specialized Models
| Domain | Best model | Why it wins | License |

### Cloud Provider Privacy & Sovereignty Matrix
| Provider | Trains on input? | EU residency | GDPR DPA | Retention | SOC 2 | Jurisdiction | Verdict |

## Inference Runtimes
| Runtime | Hardware | Formats | OpenAI-compatible API? | Throughput | Single-binary? | Language integrations |

## Vector Storage Backends
| Backend | Index types | Max scale/node | Filtered search | Hybrid? | Hosted? | $ at 10M | $ at 100M | Failure mode |

## Architecture Techniques
### Matryoshka Representation Learning
### Late Chunking
### Multi-vector / Late Interaction (ColBERT / ColPali)
### Vector Quantization (int8 / scalar / product / binary)
### Hybrid Retrieval (BM25 + Dense + RRF)
### Sparse Vector Retrieval (SPLADE)
### Instruction Prefixes
### Reranking
### Embedding Cache Strategies
### Re-embedding on Model Upgrades

## Cost & ROI Analysis
### Cloud Cost Comparison ($/1M tokens)
### Self-Hosted Cost Model
#### CPU-only baseline
#### Consumer GPU baseline
#### Data-center GPU baseline
### Storage Cost (per backend × dimensions × quantization)
### Breakeven Analysis
(Concrete monthly token / query / row volumes where each path wins.)
### Latency Premium
### Hidden Costs of Self-Hosting

## Privacy & Sovereignty
### Tier Classification per Cloud Provider
### Confidential Computing & On-Device Trends
### Operational Cost of "Green" (Self-Hosting)

## Recommendations
### Persona 1: Privacy-Maximalist
### Persona 2: Cost-Minimalist at High Volume
### Persona 3: Balanced Production App
### Persona 4: Latency-Critical Real-Time Search
### (Optional) Persona 5: 2026-Trend Wildcard

### Capability-Specific Notes
#### Semantic search
#### Clustering / topic modeling
#### Deduplication / near-duplicate detection
#### Cross-document intelligence / entity linking
#### Summarization (embedding-driven chunk selection)
#### RAG / Copilot retrieval
#### Speech / transcript embeddings (text-side)

## Decision Tree
(Flowchart: "Is content sensitive?" → "Volume tier?" → "Multilingual?" → "Latency budget?" → leaf = model + runtime + storage backend.)

## Open Questions / Data Gaps
(Anything you couldn't answer — call it out, do not fabricate.)

## References
(Primary sources: papers, model cards, leaderboards. URL + access date for each.)
```

---

## 3. Quality Bar (Research Honesty Standard)

These rules are non-negotiable. Follow them literally.

1. **Cite primary sources.** Model cards, official leaderboards, papers. Blog posts only when no primary source exists, and label them as such.
2. **Date every claim.** "MTEB 67.3 (Voyage-3, leaderboard accessed YYYY-MM-DD)." A number without a date has no provenance.
3. **Flag data gaps.** If a model has no published benchmark for a given language, write "DATA GAP: …" and name the nearest proxy. Never interpolate silently.
4. **No "best" without "best for whom."** Every recommendation must be tied to one of the 4 personas in §1.11 or a defined scale tier.
5. **No hand-waving on cost.** If you quote a $/month, show the math: _tokens × $/token_, or _cores × hours × $/hour ÷ tokens_produced_. Show your work.
6. **Disclose contamination risk.** MTEB has documented overfit cases — flag where it matters.
7. **No vendor-marketing language.** "Industry-leading," "state-of-the-art," "best-in-class" are banned unless attached to a specific benchmark number. Numbers, not adjectives.
8. **No anchoring on existing stacks.** Do not assume the reader uses any particular vendor, runtime, language, vector database, or deployment model. Surface the option that wins on merit, even if it implies a stack change.
9. **Disclose your own knowledge cutoff.** State the latest date your sources were accessed; if you have web search, name the queries that found the load-bearing numbers.

---

## 4. Anti-scope (do not waste tokens here)

- Image, audio, and multi-modal (CLIP-class) embeddings — **text only**. The "audio" capability in §1.x of the output refers to transcripts after speech-to-text.
- Transformer architecture history pre-2020 beyond a single timeline row.
- Code samples in any language — that's for implementation, not for a state-of-the-art survey.
- LLM-as-embedder hacks (averaging hidden states from a chat model) — only include if 2026 evidence shows them competitive on MTEB.

---

## 5. Done definition

You're done when:

- Every subsection in §1 has populated tables and concrete numbers.
- Every persona in §1.11 has a named winning model, named runtime, named storage backend, and named cost.
- Every data gap is flagged, not papered over.
- The "Decision Tree" can be followed top-to-bottom by someone who has not read the rest of the document and still arrive at a defensible choice.
- The references section has at least 40 primary-source citations with dates.

Now produce the document.
