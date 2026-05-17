---
name: embeddings-watchlist
description: Items to monitor for changes that would invalidate or strengthen findings from the 2026-05-17 embeddings research bundle
round: 01-state-of-the-art
cutoff: 2026-05-17
digested: 2026-05-17
---

# Watchlist — Text Embeddings

Things to re-check at the next sync cycle. Each has an explicit "if this changes, then revise X" hook.

| ID | Item | Cadence | Signal to watch | Revise findings if... |
|---|---|---|---|---|
| W-01 | MTEB v2 leaderboard official launch and Voyage / Cohere / OpenAI submission | quarterly | huggingface.co/spaces/mteb/leaderboard | A proprietary model materially beats Qwen3-8B's 70.58 MMTEB |
| W-02 | Anthropic embedding API release | monthly | anthropic.com/news | Any first-party Anthropic embedding model is released; updates G-02 from "N/A" to a real entry |
| W-03 | NVIDIA Llama-Embed-Nemotron-8B license clarification | quarterly | huggingface.co/nvidia | If "NVIDIA OS license" permits commercial deployment, displaces Qwen3-8B as Persona 1 default |
| W-04 | Cohere Rerank pricing changes | monthly | cohere.com/pricing | If price drops below $0.10/1k (Zerank-1 territory), self-host reranker recommendation flips back to managed |
| W-05 | Zerank-1 (ZeroEntropy) independent eval | quarterly | zeroentropy.dev + community benchmarks | Independent BEIR or in-house eval verifies the "+18-22% lift" vendor claim |
| W-06 | Voyage AI ↔ MongoDB integration | quarterly | mongodb.com/atlas + voyageai.com | MongoDB Atlas bundles Voyage embeddings; pricing collapses below $0.06/M for paid Atlas customers |
| W-07 | Jina AI ↔ Elastic merger fallout | quarterly | elastic.co + jina.ai changelogs | Jina hosted API moves under Elastic Cloud; jurisdiction shifts from DE to NL; license terms on Jina v3/v4 weights potentially relax |
| W-08 | OpenAI text-embedding-4 release | quarterly | platform.openai.com | If text-embedding-4 ships with MTEB v2 native score ≥66, re-embed cost-benefit analysis changes for OpenAI customers |
| W-09 | pgvectorscale benchmark independent reproduction | quarterly | github.com/timescale/pgvectorscale issues + community blogs | If 471 QPS @ 50M is reproduced by neutral third party, pgvectorscale becomes Persona 2/4 default |
| W-10 | vLLM 0.20+ embedding throughput vs TEI | quarterly | github.com/vllm-project/vllm releases | If vLLM beats TEI by ≥2× on Qwen3-8B throughput, default GPU embedding runtime shifts to vLLM |
| W-11 | Snowflake Arctic-Embed v3 release | quarterly | huggingface.co/Snowflake | A v3 release would likely keep Apache 2.0 and push CPU-tier quality above 60 MTEB-Eng |
| W-12 | Qdrant filtered-HNSW (ACORN-style) confirmation | quarterly | qdrant.tech/changelog + qdrant.tech/articles | Verify whether Qdrant adopted ACORN or another filtered-HNSW variant; affects vector-DB choice for heavy-filter workloads |
| W-13 | Mixedbread hosted pricing transparency | quarterly | mixedbread.com/pricing | Public $/M pricing makes Mixedbread a viable Persona 3 candidate |
| W-14 | Cohere embed-v4 PDF-direct embedding adoption | quarterly | community RAG benchmarks | Independent tests verify PDF→embed pipeline beats OCR→text→embed; triggers RAG architecture re-think |
| W-15 | Confidential-computing H100 GA + independent throughput benchmark | quarterly | nvidia.com + cloud-provider release notes | If CC-H100 ships with verified ≤10% overhead, Persona 1 default shifts to "cloud H100 with CC" over "self-host bare-metal 4090" |
| W-16 | EU Sovereign Cloud embedding offerings (T-Systems, OVH, Scaleway) | quarterly | provider press releases | EU-sovereign embedding API at ≤$0.15/M with native EU residency would dominate Persona 3 in EU jurisdictions |
| W-17 | Homomorphic / private retrieval production case studies | quarterly | arXiv eprint.iacr.org | Any production deployment claim closes G-13 |
| W-18 | Voyage MTEB v2 official submission | monthly | huggingface.co/spaces/mteb | Official numbers close G-03 |
| W-19 | OpenAI Batch API pricing for embeddings | quarterly | platform.openai.com/docs/api-reference/batch | If batch discount deepens beyond 50%, OpenAI 3-small Batch becomes more dominant for Persona 2 |
| W-20 | MoE embedding models (Nomic v2 path) maturity | quarterly | huggingface.co + arXiv | Active-parameter cost model (305M active in Nomic v2 MoE) becomes standard, beating dense at same quality |
| W-21 | New entrants ≥65 MTEB at ≤500M params | monthly | huggingface.co/spaces/mteb (filtered by size) | A new model in this band shifts CPU-tier baseline |
| W-22 | LongEmbed leaderboard top-10 stability | quarterly | huggingface.co/spaces/Yixin-FE/LongEmbed_Leaderboard | Re-validate long-doc model choice when new entrants appear |
| W-23 | OpenAI / Cohere training-on-input policy changes | quarterly | Trust Center pages | Any reversion to "trains on free tier" significantly affects Persona 3 risk tier |
| W-24 | MMTEB Romanian / niche-language eval coverage | quarterly | mteb.huggingface.co + MMTEB paper updates | Real Romanian eval data closes G-01 |
| W-25 | AWS Bedrock provisioned-throughput pricing for Titan v2 | quarterly | aws.amazon.com/bedrock/pricing | Reserved-capacity discounts could push Titan v2 below $0.01/M effective, dominating Persona 2 |
| W-26 | Vespa embedding-in-process performance at scale | quarterly | vespa.ai blog + Yahoo/Notion case studies | Verifies Persona 4 alt-architecture (S-15) |
| W-27 | Turbopuffer p95 cold-query latency at 100M+ scale | quarterly | turbopuffer.com customer cases | Cold-query penalty acceptable for batch workloads; clarifies S-22 |
| W-28 | DeepInfra / Together / Fireworks per-model pricing drift | monthly | provider pricing pages | Per-model price changes affect "hosted OSS" tier viability (G-15) |
| W-29 | New code-retrieval models (post-`codestral-embed`, post-`voyage-code-3`) | quarterly | huggingface.co + arXiv | New code-specific leader displaces current recommendations |
| W-30 | Open-weights model cards adopting MTEB v2 transparently | quarterly | model card releases | Eases comparison; closes the v1/v2 transition pain (C-22) |
