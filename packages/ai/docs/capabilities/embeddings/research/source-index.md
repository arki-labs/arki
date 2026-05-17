---
name: embeddings-source-index
description: Per-source extraction worksheet for the 2026-05-17 embeddings landscape research bundle (ChatGPT, Claude, GLM, Qwen, Gemini)
round: 01-state-of-the-art
cutoff: 2026-05-17
digested: 2026-05-17
---

# Source Index — Text Embeddings State of the Art

Five LLM research outputs were commissioned against `prompt.md` (cutoff 2026-05-17). Each row scores the source on coverage, rigor, and trustworthiness. Numbers in the table refer to the per-source extraction tables included as agent output and reflected in the per-source claim IDs (e.g. `CL-XX`, `GL-XX`).

## Inventory

| Source | File | Size | Claim count | Conclusion in one sentence |
|---|---|---|---|---|
| ChatGPT | `chatgpt.research.md` | 347 lines / ~36 KB | ~40 claims (no IDs) | OSS models now rival proprietary APIs; trade-off is cost × quality × privacy; Persona winners: MiniLM (cost), Voyage-3/Cohere v4 (balanced), OpenAI 3-large (latency), e5-small (mobile) |
| Claude | `claude.research.md` | 520 lines / ~83 KB | 161 (CL-01..CL-161) | Three tiers — Gemini/Voyage cloud quality leaders; Apache-2.0 Qwen3-8B (MMTEB 70.58, MTEB-Code 80.68) matches proprietary; self-hosting on a 4090+TEI undercuts every cloud at 20–50M tok/day |
| GLM | `glm.research.md` | 528 lines / ~86 KB | 128 (GL-01..GL-128) | Frontier clusters at 65–68 MTEB; Gemini-embedding-001 leads public MTEB at 68.32; hybrid+rerank is mandatory; self-hosting becomes default at scale via TEI/Ollama/vLLM |
| Qwen | `qwen.research.md` | 215 lines / ~65 KB | 78 (QW-01..QW-78) | "Self-hosted Qdrant or Milvus behind a caching layer" is the recommended baseline; mostly narrative, low number density |
| Gemini | `gemini.research.txt` (from .rtf) | 862 lines / ~58 KB | 90 (GE-01..GE-90) | 2026 frontier = MRL + MoE + multimodal unification; OSS (Qwen3-8B, NV-Embed-v2, GTE-Qwen2-7B) closes gap with proprietary; recommends Qwen3 (privacy) / Titan v2 + pgvectorscale (cost) / Voyage-4 + Pinecone + Zerank (balanced) / BGE-M3 in Vespa (latency) |

## Per-source quality rating

| Source | Coverage vs §1.1–§1.11 | Primary-source share | Number density | Hedge honesty | Hallucination risk | Overall |
|---|---|---|---|---|---|---|
| **Claude** | High — only per-language leaderboards missing | ~30% (HF cards, arXiv, vendor docs) | Very high (161 claims) | **Excellent** — every throughput marked "extrapolated", MTEB v1→v2 caveat repeated | Low for citations, medium for asserted-without-source throughput | **A−** |
| **GLM** | Medium-high — silent skip on per-language leaderboards and contamination annotations | ~40% (HF model cards, vendor docs, Trust Center pages) | High (128 claims) | Good — many "(approx)"/"(est.)" tags; flags Voyage pricing as aggregator-only | Medium — cost derivations cascade from unsourced throughput | **B+** |
| **Gemini** | Medium — strong on cloud + reranker, weak on runtime breadth, omits ES/OS/Redis/Lance/Chroma/Turbopuffer/DuckDB/SQLite-VSS | ~30% (HF cards, Voyage/Cohere/Google docs, Ollama, MMTEB) | High (90 claims) | Partial — uses `*` to mark "normalized triangulated" Voyage-4 & Gemini-2 scores but doesn't tag throughput similarly | Medium-high — internal estimate methodology produces suspiciously precise t/s numbers; GE-68 has internal inconsistency | **B** |
| **ChatGPT** | Medium — most §1 sections touched but shallow | ~30% (model cards, vendor pricing pages, blogs) | Medium (~40 claims) | Light — single DATA GAP block at end | Medium — many uncited throughput numbers, unclear sourcing | **B−** |
| **Qwen** | Low — entirely skips per-language leaderboards, most marketplaces, reranker matrix; many cells "Not Publicly Available" | ~10% (Azure pricing, OpenAI privacy page, NVIDIA NGC) | Low (78 claims) | Honest about gaps but bibliography incomplete; no References section in expected format | **High** — fabricated arXiv IDs (`2603.07612v1`, `2604.26482v1`, `2601.10261v1` — invalid prefixes), wrong specs (BGE-M3 at 120M instead of 568M, e5-mistral 7B at 768 dim instead of 4096), claims vLLM has no OpenAI endpoint (false), recommends outdated `voyage-lite-002-instruct` / `google-gecko-preview-0409` | **D+** |

## Source trust priority (when claims diverge, prefer in this order)

1. **Claude** — when the question is a numerical estimate or a hedge is needed
2. **Gemini** OR **GLM** — when the question is a primary-source spec or policy fact
3. **ChatGPT** — corroborative tier-3 confirmation
4. **Qwen** — corroborative ONLY; never load-bearing alone

## Claim-density heatmap

| Section of prompt | ChatGPT | Claude | GLM | Qwen | Gemini |
|---|---|---|---|---|---|
| §1.1 Cloud pricing (≥10 providers) | partial | full | partial-marketplaces | partial | full |
| §1.2 OSS model specs (≥13 families) | partial | full | full | partial | full |
| §1.3 Specialized models | thin | thin | thin | absent | medium |
| §1.4 Runtime catalog (≥10) | full | full | full | partial | partial |
| §1.5 MTEB top-20 + per-language | none | top-20 mixed, per-language absent | top-13 only, per-language absent | none | none |
| §1.6 Reranker matrix | partial | full | partial | absent | full |
| §1.7 Vector backends (≥12) | full | full | full | partial | partial (5 only) |
| §1.8 Architecture techniques (≥10) | full | full | full | partial | full |
| §1.9 Cost & ROI math | partial | full | full (worked examples) | partial | partial |
| §1.10 Privacy & sovereignty matrix | partial | full | full | partial (4 providers) | partial |
| §1.11 Persona recommendations (≥4 + optional 5th) | 5 personas | 5 personas | 5 personas | 4 personas | 4 personas |

Coverage of "Done definition" in `prompt.md` §5:

| Done criterion | ChatGPT | Claude | GLM | Qwen | Gemini |
|---|---|---|---|---|---|
| Every §1 subsection populated | partial | mostly | partial | partial | partial |
| Each persona has named model + runtime + storage + cost | yes | yes | yes | partial | yes |
| Data gaps flagged not papered over | weak | strong | strong | strong | strong |
| Decision tree usable cold | weak | weak (prose only) | weak (prose only) | weak (prose only) | weak (prose only) |
| ≥40 primary-source citations with dates | ~15 primary | ~15 primary | ~25 primary | <10 primary | ~15 primary |

**No source meets the "Done" bar.** The synthesis below stitches partial coverages together, with Claude and GLM as the load-bearing spines.

## Anti-anchoring protection

Per-source extraction was completed in isolation (four parallel subagents reading only their assigned file plus `prompt.md`) before any cross-source comparison happened. ChatGPT was read directly. No findings.md or sparks.md existed at that time. This audit trail is the safety net against framing leakage from one source into the reading of another.

## Inputs snapshot

| File | Modified | Bytes | Lines | Read at digest |
|---|---|---|---|---|
| `prompt.md` | 2026-05-17 11:16 | 19,543 | 316 | full |
| `chatgpt.research.md` | 2026-05-17 12:38 | 36,374 | 347 | full |
| `claude.research.md` | 2026-05-17 12:38 | 82,624 | 520 | full (subagent, chunked) |
| `glm.research.md` | 2026-05-17 12:39 | 85,624 | 528 | full (subagent, chunked) |
| `qwen.research.md` | 2026-05-17 12:38 | 65,397 | 215 | full (subagent, chunked) |
| `gemini.research.rtf` → `gemini.research.txt` | 2026-05-17 12:44 → 12:46 | 3.7 MB → 49 KB | 11,569 → 862 | full (subagent, chunked) |
