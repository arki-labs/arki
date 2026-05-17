---
name: embeddings-gaps
description: Coverage gaps where all five LLM research outputs failed to answer the prompt, plus effort estimates for resolving each
round: 01-state-of-the-art
cutoff: 2026-05-17
digested: 2026-05-17
---

# Gaps — Text Embeddings State of the Art

Gaps where **no source** produced a concrete answer (or where all five hedged). Each gap is actionable: it carries an estimate of how to resolve it and what downstream decision it blocks. Stable IDs `G-01..G-NN` are used in `findings.md` and `next-research.md`.

---

## G-01 — Per-language MTEB leaderboards (Romanian, Polish, Japanese, Korean, Arabic, Chinese, Italian, French, German, Spanish)

**Prompt §1.5 demanded:** "Per-language leaderboards for at least: Chinese (C-MTEB), French, German, Spanish, Italian, Polish, Japanese, Korean, Arabic, Romanian (or nearest Romance/Slavic proxy if no Romanian eval exists)."

**What everyone said:** All five silently skipped this. Only Claude (CL-150) and Gemini (GE-82) explicitly flagged Romanian as a DATA GAP and named cross-lingual translation-proxies as a quality risk.

**Impact:** Cannot recommend a specific model for Romanian retrieval or any non-English language without doing the per-language work. Default fallbacks (BGE-M3, multilingual-e5-large-instruct, Cohere multilingual-v3, Qwen3-Embedding-8B) are claimed to be "good multilingual" without per-language quantification.

**Type:** desk-research (1–2 days)

**How to resolve:** Pull the MMTEB leaderboard from HuggingFace Spaces directly (`https://huggingface.co/spaces/mteb/leaderboard` with each language filter), extract top-5 per language, cross-check with C-MTEB, MIRACL, XNLI, BUCC for languages with sparse eval data.

**Blocks:** Any feature that ships search/RAG to a non-English-primary audience. Specifically blocks Romanian-language workloads (the workspace has Romanian Novelette stories and other Romanian content surfaces).

---

## G-02 — Anthropic embedding model

**Prompt §1.1 demanded:** "Anthropic: any embedding model if released."

**What everyone said:** Five-source convergence: no Anthropic embedding model exists as of 2026-05-17. Claude (CL-25), GLM (GL-10), Gemini (GE-13) explicitly confirm; Qwen, ChatGPT silent (consistent with "no model to cover").

**Resolution:** Not a gap in the research — **confirmed N/A**. Anthropic recommends Voyage (which Anthropic invested in pre-MongoDB acquisition). This means anyone wanting "everything from Anthropic" must accept a multi-vendor architecture for embeddings.

**Watchlist item:** Track Anthropic announcements for embedding API.

---

## G-03 — Voyage `voyage-3-m-exp` and `voyage-3-large` head-to-head MTEB v2 scores

**Prompt §1.5 demanded:** "Top 20 on the current MTEB English leaderboard, with access date."

**What everyone said:** Voyage doesn't publish raw MTEB v2 scores for its proprietary models; they publish domain-relative win-rates instead. All five sources estimate or quote aggregator numbers. Claude (CL-145) is the only one to flag the `voyage-3-m-exp` model card's contamination admission ("uses training sets of MTEB datasets").

**Impact:** "Voyage is the quality leader" is the consensus persona-3 winner, but the actual quality numbers are estimates.

**Type:** monitoring (weeks–months)

**How to resolve:** Wait for the MTEB v2 leaderboard to add Voyage submissions, or run independent evals on a representative held-out corpus.

**Blocks:** Any decision that depends on the marginal Voyage-vs-Cohere-vs-Gemini quality difference. Practically, treat the three as tied within 1–3 MTEB points.

---

## G-04 — AWS Bedrock Titan Text Embed v2 retrieval & code MTEB scores

**Prompt §1.5 demanded:** Code retrieval scores per major cloud model.

**What everyone said:** Gemini (GE-10) provides MTEB-Eng 60.10 / MMTEB 62.40 with no code score. AWS doesn't publish a public MTEB-Code number for Titan v2. Other sources don't address Titan's retrieval quality at all.

**Impact:** Persona 2 (Cost-Min) recommendation rests partly on Titan as a cheap-cloud anchor; we lack quantitative quality evidence for code-search workloads on Titan.

**Type:** desk-research (1–2 hours of AWS doc review + leaderboard check)

**How to resolve:** Search AWS documentation site for "Titan Embed v2 benchmark" or run a small CodeSearchNet eval.

**Blocks:** Confidence in Titan v2 for code-search use cases. Mitigation: recommend Mistral `codestral-embed` or Voyage `voyage-code-3` for code-specific paths instead of Titan.

---

## G-05 — Mixedbread hosted-API pricing in 2026

**Prompt §1.1 demanded:** "API price per 1M tokens (both input and any output/storage fee)."

**What everyone said:** Claude (CL-16) and Claude (CL-29) flag explicit DATA GAP. GLM (GL-14) gets one specific data point: "$20/mo Scale plan, credit-based" — but doesn't translate to $/M tokens. Others silent.

**Impact:** Cannot compare hosted Mixedbread API on $/token to OpenAI / Voyage / Cohere. Self-host Mixedbread open-weights (mxbai-embed-large-v1, mxbai-rerank-large-v2) is the only fully-evaluated path.

**Type:** desk-research (15 minutes if Mixedbread publishes a pricing page; otherwise contact sales)

**How to resolve:** Check `mixedbread.com/pricing` or recent blog post; failing that, treat self-host as the only Mixedbread path.

**Blocks:** Considering Mixedbread hosted for Persona 3.

---

## G-06 — Jina hosted API pricing and "no-train" guarantee on free tier

**Prompt §1.1 and §1.10 demanded:** Per-token price + training policy on input data.

**What everyone said:** Claude (CL-15, CL-28) gives an asserted $0.02/M and "10M free/mo" with no source; flags "DATA GAP: no explicit no-train guarantee on free tier." Gemini (GE-11) gives $0.018/M (primary-source Jina docs cited). GLM (GL-17) says "free tier <1M tokens then credit-based top-up; exact $/M unclear." Convergence partial.

**Impact:** Free-tier Jina is appealing for prototyping; without no-train guarantee, sensitive content shouldn't go through it.

**Type:** desk-research (15 minutes — Jina's ToS post-Elastic acquisition)

**How to resolve:** Re-read Jina's ToS / pricing page (likely changed under Elastic ownership per C-12).

**Blocks:** Choosing Jina free tier for any privacy-sensitive workload.

---

## G-07 — NVIDIA Llama-Embed-Nemotron-8B exact MMTEB score

**Prompt §1.5 demanded:** "Top 10 on MMTEB multilingual."

**What everyone said:** Only Claude (CL-37, CL-147) names the model and claims "#1 MMTEB at release (2025-10)" but doesn't have the exact score. Other sources don't mention it.

**Impact:** Possibly displaces Qwen3-Embedding-8B (70.58 MMTEB) as the MMTEB leader. If true, it changes the Persona 1 recommendation.

**Type:** desk-research (30 minutes — NVIDIA model card + MTEB leaderboard search)

**How to resolve:** Check NVIDIA's HF model card and the MMTEB leaderboard.

**Blocks:** Confidence that Qwen3-8B is the open-weights MMTEB leader. Mitigation: license check first — if Nemotron's "NVIDIA OS license" is non-commercial-friendly like CC-BY-NC, it's commercially irrelevant regardless of score.

---

## G-08 — IBM Granite Embedding 107M / 278M independent MTEB scores

**Prompt §1.2 demanded:** "MTEB English, MMTEB multilingual."

**What everyone said:** Claude (CL-46) flags DATA GAP — only IBM positioning at BGE-base/MiniLM tier; no independent verification. Gemini (GE-31) provides throughput estimates but no MTEB number. GLM (GL-45) gives 200+ languages but no MTEB score.

**Impact:** IBM Granite is the only Apache 2.0 multilingual CPU-baseline candidate that's smaller than Arctic-Embed-M. We don't know if it actually delivers competitive retrieval quality.

**Type:** quick-experiment (1 day on a held-out multilingual corpus)

**How to resolve:** Pull Granite-278M from HF, run on a 1k-query slice of MIRACL or BUCC, compare to Arctic-Embed-M and BGE-M3.

**Blocks:** Choosing Granite over Arctic-M for the multilingual CPU baseline.

---

## G-09 — Confidential-computing H100 throughput penalty (third-party verified)

**Prompt §1.10 demanded:** Quantification of confidential-compute overhead.

**What everyone said:** All sources report "5–10% throughput penalty" but Claude (CL-155) flags this as NVIDIA-self-reported with no peer-reviewed third-party benchmark for embedding workloads specifically.

**Impact:** Persona 1 (Privacy-max) recommendation Phase 2 may include Nitro Enclaves or H100-CC; the throughput hit affects $/M tokens.

**Type:** quick-experiment (Days; requires CC-enabled H100 access, which is gated)

**How to resolve:** Wait for community benchmark or request NVIDIA enterprise demo.

**Blocks:** Quoting a hard $/M number for Persona 1 on CC infrastructure. Mitigation: budget +10% over plain GPU $/M.

---

## G-10 — MTEB-Code score for `gemini-embedding-001` and `gemini-embedding-2`

**Prompt §1.5 demanded:** "Top 10 on MTEB Code."

**What everyone said:** Google publishes aggregate MTEB-Multi only. Gemini's own research (GE-07) marks Gemini-2 MTEB-Code with an asterisk indicating "normalized triangulation." Claude (CL-148) flags DATA GAP. Other sources silent.

**Impact:** Cannot recommend Gemini for code retrieval with confidence. Persona 3 for code-heavy workloads (e.g. an IDE assistant) defaults to Voyage `voyage-code-3` or Mistral `codestral-embed` instead.

**Type:** desk-research → quick-experiment (1 day if Google publishes; longer if independent eval needed)

**How to resolve:** Wait for Google to publish MTEB-Code, or run CodeSearchNet against Gemini API.

**Blocks:** Gemini as code-retrieval default. Mitigation: route code queries to `voyage-code-3` or `codestral-embed`.

---

## G-11 — Head-to-head vector DB benchmarks under identical workloads

**Prompt §1.7 demanded:** "Max practical scale per node, support for filtered / hybrid / multi-vector search."

**What everyone said:** Most sources cite vendor self-reports. Claude (CL-107) flags the pgvectorscale "471 QPS vs Qdrant 41 QPS at 50M" as "anomalous" — single benchmark from Timescale's own blog. Gemini's vector-DB cost numbers (GE-38..GE-44) come from a single LeanOpsTech source. Qwen (QW-76) explicitly DATA GAPs this. There is no neutral third-party benchmark suite covering pgvector + pgvectorscale + Qdrant + Milvus + Weaviate + Vespa + Pinecone + Elasticsearch + Redis + LanceDB + Chroma + Turbopuffer under one workload.

**Impact:** Vector-DB cost numbers in the SOTA doc are ballparks. The "pgvectorscale wins at 50M" claim drives the Persona-2 Gemini recommendation (Titan + pgvectorscale = $80/mo) — if pgvectorscale isn't actually 10× Qdrant, the recommendation tilts toward Qdrant or LanceDB.

**Type:** engineering-spike (1 week — pick top-3 backends and run on a 10M vector dataset with realistic query mix)

**How to resolve:** Use the ANN-Benchmarks project (`erikbern/ann-benchmarks`) and extend with payload filtering + hybrid queries. The neutral benchmark world hasn't done this since 2023.

**Blocks:** High-confidence vector-DB recommendation at >10M scale. Mitigation: at <10M default to pgvector + HNSW; at 10–100M use pgvectorscale (cost) or Qdrant (proven); above 100M use Milvus.

---

## G-12 — Long-term self-host operational cost (beyond placeholder hours)

**Prompt §1.9 demanded:** Hidden self-host costs in team-hours.

**What everyone said:** Claude (CL-132) gives tiered hours; Gemini (GE-73) gives $1500–3000/mo. GLM (GL-109) gives ranges. ChatGPT vague. Qwen (QW-64) admits "at least one FTE" placeholder. **None of these are based on field studies; all are LLM extrapolations.**

**Impact:** Persona 2 cost-min decision (cloud vs self-host) hinges on this number. Underestimating ops cost by 2× kills the self-host ROI argument.

**Type:** monitoring (collect own data during operations)

**How to resolve:** Track actual ops time in week-1, month-1, quarter-1 of a self-host deployment. Industry surveys exist (Roost, Tabnine, etc.) but none specifically for embedding-serving teams.

**Blocks:** Confident absolute cost comparison; relative cost (self-host wins ≥1B tok/mo, cloud wins <100M tok/mo) is robust.

---

## G-13 — Homomorphic / private retrieval production-readiness in 2026

**Prompt §1.10 demanded:** "State of the art in 2026 — is it production-real yet?"

**What everyone said:** Five-source convergence: NO, not production-real. Gemini (GE-86), Claude implicit in privacy section, Qwen (QW-77) explicit DATA GAP, GLM (GL-127 implicit), ChatGPT vague. Consensus: "~10× slower with ~5% accuracy drop, not adopted at scale."

**Resolution:** Not a gap in the research — **confirmed not production-ready.** Skip for 2026 decisions.

**Watchlist item:** Re-check in 2027.

---

## G-14 — Embedding-drift cost on re-embed (model upgrade)

**Prompt §1.8 demanded:** "Re-embedding on model upgrade — does any provider/model preserve representational compatibility across versions?"

**What everyone said:** Claude (CL-117) provides the cleanest answer: re-embedding required across most version bumps; **exception: `voyage-3-large` → `voyage-4-large` share v4-family embedding space** per Voyage docs. GLM (GL-91), Gemini, Qwen agree "almost always requires re-embedding." **Quantification of the cost is missing.**

**Impact:** Picking a model = committing to a re-embed budget at every upgrade. Voyage's compatibility claim, if it holds, is a significant moat.

**Type:** desk-research → engineering-spike (verify Voyage compatibility claim with a small test corpus)

**How to resolve:** Embed 1k docs under voyage-3-large and voyage-4-large; check cosine similarity of paired embeddings; confirm whether NDCG@10 changes when querying the v4 model against the v3 corpus.

**Blocks:** Confidence in Voyage's "no re-embed on upgrade" promise as a buying criterion.

---

## G-15 — Stable per-model pricing on DeepInfra / Together / Fireworks / Replicate / OpenRouter

**Prompt §1.1 demanded:** "Report price per 1M tokens per model, not per provider."

**What everyone said:** Claude (CL-17) "$0.005–$0.04/M asserted." GLM (GL-12, GL-13) gives two data points: BGE-M3 at $0.01/M, MiniLM at $0.005/M. Qwen (QW-74) DATA GAP. Gemini (GE-12) gives $0.01–$0.05/M range. ChatGPT mentions providers without per-model prices. **No source gives a full grid.**

**Impact:** The OSS-on-marketplace tier is the third path to "cheap embeddings" (besides DIY self-host and OpenAI/Titan cheap APIs). Without per-model prices we can't say whether DeepInfra-hosted BGE-M3 beats OpenAI Batch.

**Type:** desk-research (1 hour — visit each marketplace's pricing page)

**How to resolve:** Manually pull current per-model pricing from DeepInfra, Together, Fireworks, Replicate, OpenRouter. These pages update frequently.

**Blocks:** A "hosted OSS" persona slot. Workaround: use Claude's $0.005–$0.04 range as a planning band.

---

## G-16 — Real (measured) tokens/sec on consumer GPU, A100, H100 for each major model

**Prompt §1.2 + §1.4 demanded:** "throughput (tokens/sec on consumer GPU like RTX 4090, on data-center GPU like A100/H100, and on a typical 8-vCPU CPU server)."

**What everyone said:** Every source provides throughput numbers; Claude explicitly disclaims them as "reasonable extrapolations." Gemini provides "internal estimates" — most precise (e.g. 850 t/s for GTE-Qwen2-7B on RTX 4090) but only one methodology disclosure. **No source benchmarks with reproducible code.**

**Impact:** All cost-per-token math in the SOTA doc inherits this uncertainty. Spread is 2×–5× across sources.

**Type:** engineering-spike (1 week — run sentence-transformers Benchmark or HF TEI benchmark suite on 4090 + A100 + H100 + 8-vCPU, batch 32, sequence 512, fp16 and int8)

**How to resolve:** Standard benchmark suite. Output: a small published table covering the 6–8 most important models.

**Blocks:** $/M-token claims tighter than ±2×. Mitigation: quote a range, not a point.

---

## G-17 — Decision-tree-style "given my profile, model is X" calculator

**Prompt §2 demanded:** "Decision Tree (Flowchart: 'Is content sensitive?' → 'Volume tier?' → 'Multilingual?' → 'Latency budget?' → leaf = model + runtime + storage backend.)"

**What everyone said:** Every source produced a decision-tree section, but all in shallow prose ("Sensitive? → self-host; latency? → API"). None drilled to specific model + runtime + storage at the leaf.

**Impact:** Reader can't follow the prompt's stated "decision tree usable by someone who hasn't read the rest of the document."

**Type:** synthesis work (this digest produces it — see `STATE-OF-THE-ART.md`)

**Resolution:** Produced in the SOTA doc; not a research gap.

---

## G-18 — Cost crossover for Pinecone Serverless under realistic workload

**Prompt §1.9 demanded:** Concrete monthly token/query/row volumes where each path wins.

**What everyone said:** Gemini (GE-77) claims "$70 Pinecone Serverless" at unspecified scale; Claude (CL-100) says Pinecone $70/mo p1.x1 at 10M, $1–4k/mo at 100M. GLM (GL-77) says $200–500 at 10M. No source benchmarks Pinecone Serverless `$0.07 per million reads + $0.33/GB stored` against a realistic 100 QPS workload.

**Impact:** Pinecone Serverless changes the breakeven math vs self-host — the per-query pricing model dominates above ~10M reads/mo and falls below below that.

**Type:** desk-research → spreadsheet model (2 hours — Pinecone unit pricing × workload scenario)

**How to resolve:** Build a spreadsheet that models {storage GB, QPS, ingest TPS} → $/mo for Pinecone Serverless, Qdrant Cloud, pgvectorscale on RDS.

**Blocks:** Precise Persona 3 cost statement. Mitigation: use $80–$150/mo range at 10M-vector / moderate-QPS scenario.

---

## G-19 — Sub-processor lists and notification-on-change policies per cloud provider

**Prompt §1.10 demanded:** "Sub-processors: published list? notification on change?"

**What everyone said:** All sources cite SOC 2 / ISO 27001 status but no source enumerates sub-processors per provider or quotes notification policies.

**Impact:** Required for any GDPR-strict deployment (Article 28). Without sub-processor lists, the privacy matrix isn't legally complete.

**Type:** desk-research (3–4 hours — pull each vendor's Trust Center sub-processor page)

**How to resolve:** Visit `openai.com/trust`, `cohere.com/trust`, `voyageai.com` (or mongodb.com post-acquisition), `vertex.google.com`, `aws.amazon.com/compliance`, `azure.microsoft.com/compliance`, `mistral.ai`, `jina.ai`, `mixedbread.com`. Extract sub-processor lists with access date.

**Blocks:** Production launch in any GDPR-strict context (B2B selling to EU customers with their own DPA). Mitigation for early-stage: rely on enterprise tier opt-outs and document risk acceptance.

---

## G-20 — Embedding cache hit-rate evidence for the "30–60%" claim on user queries

**Prompt §1.8 demanded:** Quantified embedding caching impact.

**What everyone said:** Claude (CL-118) asserts "semantic cache (cosine ≥0.97) 30–60% hit-rate user queries" without primary-source backing. No other source quantifies.

**Impact:** A real 30–60% hit rate cuts query-embed cost in half. If actual is 10%, the cache isn't worth the complexity.

**Type:** monitoring (collect own data during operations) or desk-research (search Anthropic/OpenAI/Cohere blog posts for cache analyses)

**How to resolve:** Read existing benchmarks (e.g. GPTCache, langchain-cache analyses) or instrument own deployment.

**Blocks:** Whether to invest in a semantic-cache layer. Mitigation: implement content-hash cache (free win) before investing in semantic.

---

## Gap summary

| Priority | ID | Topic | Type | Effort |
|---|---|---|---|---|
| CRITICAL | G-01 | Per-language MTEB (esp. Romanian) | desk-research | 1–2 days |
| HIGH | G-11 | Neutral vector DB benchmark | engineering-spike | 1 week |
| HIGH | G-16 | Measured tokens/sec on 4090/A100/H100/CPU | engineering-spike | 1 week |
| HIGH | G-14 | Voyage v3↔v4 compatibility verification | engineering-spike | 1 day |
| MEDIUM | G-07 | NVIDIA Nemotron-8B exact MMTEB | desk-research | 30 min |
| MEDIUM | G-08 | IBM Granite independent MTEB | quick-experiment | 1 day |
| MEDIUM | G-10 | Gemini MTEB-Code | desk-research → spike | 1 day |
| MEDIUM | G-19 | Sub-processor lists per cloud | desk-research | 3–4 hours |
| MEDIUM | G-18 | Pinecone Serverless workload model | desk-research | 2 hours |
| MEDIUM | G-15 | OSS marketplace per-model pricing grid | desk-research | 1 hour |
| LOW | G-03 | Voyage MTEB v2 official scores | monitoring | weeks |
| LOW | G-04 | Titan v2 MTEB-Code | desk-research | 1–2 hours |
| LOW | G-05 | Mixedbread hosted pricing | desk-research | 15 min |
| LOW | G-06 | Jina hosted no-train guarantee | desk-research | 15 min |
| LOW | G-09 | CC-H100 throughput penalty independent | monitoring | months |
| LOW | G-12 | Long-term self-host ops cost | monitoring | quarters |
| LOW | G-20 | Embedding cache hit-rate evidence | monitoring | quarters |
| RESOLVED | G-02 | Anthropic embedding model | confirmed N/A | — |
| RESOLVED | G-13 | Homomorphic retrieval in production | confirmed not ready | — |
| RESOLVED | G-17 | Decision tree at-the-leaf detail | produced in SOTA doc | — |
