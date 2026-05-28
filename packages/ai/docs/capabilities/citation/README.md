---
title: AI Citation Pipeline — @arki/ai capability
type: package-capability
package: "@arki/ai"
slug: citation
status: planned
tags: [arki-ai, capability, citation, source-grounding]
---

# AI Citation Pipeline (`packages/ai/citation/`)

A `@arki/ai` capability that verifies generated text against a source corpus and
returns a structured per-claim trace (supported / flagged). Sibling to the existing
[`deduplication`](../deduplication/STATE-OF-THE-ART.md),
[`summarization`](../summarization/), and [`embeddings`](../embeddings/) capabilities.

## Why this lives in `@arki/ai`, not in a single app

Multiple downstream consumers need the same pipeline shape — implementing it once in
the shared package avoids a guaranteed future migration:

- **avocabo `ai-summarization`** — uses the pipeline to verify ≥98% of factual claims
  in every generated summary trace to source text. Without it, the legal-compliance
  floor (per spec Q-002) is not defensible. See
  [`apps/avocabo/docs/features/ai-summarization/PRD.md`](../../../../../apps/avocabo/docs/features/ai-summarization/PRD.md)
  §D-SUMM-011 + US-10 for the avocabo-specific acceptance contract.
- **avocabo `ai-copilot`** (future PRD, not yet authored) — RAG flows over a user's
  library must emit source-grounded citations per the workspace "Source-grounded AI"
  non-negotiable contract. The same pipeline shape (verify generated text against
  source corpus) applies, with subtly different result-trace requirements (per-claim
  spans vs. per-summary pass/fail).

The capability sits next to the other `@arki/ai` capabilities to match the existing
convention: each `packages/ai/docs/capabilities/<name>/` folder documents the
capability's rationale, state-of-the-art notes, and tracked implementation issues.

## Scope of v1.0

A single Zod-typed factory + verify call:

```ts
const verifier = createCitationVerifier({ model: 'gpt-4o-mini' });
const result = await verifier.verify({ generated: string, sourceText: string });
// result.passed: boolean
// result.claims: Array<{ text, sourceSpan, confidence }>
// result.flaggedClaims: Array<{ text, reason }>
```

The implementation orchestrates a verifier-LLM call that, for each factual claim
extracted from `generated`, locates the supporting span in `sourceText` (or marks the
claim as unsupported). The aggregate verdict (`passed: boolean`) is true when ≥X% of
claims are supported above confidence threshold; X and threshold are tunable per
consumer.

EX-summarization-hallucination-05 (in
[`apps/avocabo/docs/features/ai-summarization/experiments.md`](../../../../../apps/avocabo/docs/features/ai-summarization/experiments.md))
is the v1.0 validation gate: ≥98% recall on a synthetic 50-newsletter × 5-injected-claim
corpus, ≤5% false positives.

## Cross-references

- [Avocabo ai-summarization PRD §D-SUMM-011](../../../../../apps/avocabo/docs/features/ai-summarization/PRD.md)
  — the founder pick that established this as package-scope (2026-05-26)
- [Avocabo ai-summarization US-10](../../../../../apps/avocabo/docs/features/ai-summarization/PRD.md)
  — the consumer acceptance criterion (≥98% recall on synthetic hallucination corpus)
- [`@arki/ai` package source](../../../../../packages/ai/) — host of the new submodule
- [`@arki/ai` AGENTS.md](../../../../../packages/ai/AGENTS.md) — package conventions
- Sibling capabilities: [`deduplication/`](../deduplication/),
  [`summarization/`](../summarization/), [`embeddings/`](../embeddings/),
  [`semantic-search/`](../semantic-search/), [`clustering/`](../clustering/),
  [`copilot/`](../copilot/), [`agentic/`](../agentic/),
  [`cross-doc-intelligence/`](../cross-doc-intelligence/), [`audio/`](../audio/)
- Future: ai-copilot PRD (not yet authored) — will append a second consumer reference

## Issues

This folder's `issues/` tracks the package-scope implementation work. Feature-local
integration issues (wiring the pipeline into `SummarizationService`, into ai-copilot's
RAG flow, etc.) live under each consuming feature's own `issues/` and reference back
to this folder's issue 01 as a blocker.
