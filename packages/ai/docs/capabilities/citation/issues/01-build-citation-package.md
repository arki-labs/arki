---
status: ready-for-agent
app: workspace
feature: citation
package: "@arki/ai"
created: 2026-05-26
assignee: ~
priority: P0
stories: []
---

# Build `packages/ai/citation/` — shared citation verification submodule

## What to build

A new submodule under `@arki/ai` that ships the citation-verification primitive consumed
by ai-summarization (immediate consumer) and ai-copilot (future consumer). The package
must be general enough for both shapes — summary-level pass/fail AND per-claim trace
for RAG answers — without leaking either consumer's domain.

Public API surface (v1.0):

- `createCitationVerifier({ model, threshold? })` factory
- `verifier.verify({ generated: string, sourceText: string }): Promise<CitationVerificationResult>`
- Exported types: `CitationVerificationResult`, `CitationClaim`, `FlaggedClaim`
- Re-export from `@arki/ai` index so consumers can `import { createCitationVerifier } from '@arki/ai'`

Internal shape:

1. Extract factual claims from `generated` via a structured `@arki/ai` call (Zod-typed claim list).
2. For each claim, locate the supporting span in `sourceText` via a second structured call (or batch).
3. Aggregate: `passed = (supportedClaims / totalClaims) >= threshold`. Default threshold per the avocabo PRD: 0.98 recall on hallucination corpus translates to a per-summary pass threshold of ~0.95 (tunable by consumer).

Consumer-tunable surface includes the verifier model (default `gpt-4o-mini` per D-SUMM-006), the per-claim confidence threshold, and the per-summary pass threshold.

## Acceptance criteria

- [ ] `packages/ai/citation/` directory exists with `index.ts`, `types.ts`, `verifier.ts`, internal helpers, and a co-located test file.
- [ ] `createCitationVerifier({ model: 'gpt-4o-mini' })` factory exported.
- [ ] `verify({ generated, sourceText })` returns `{ passed: boolean, claims: CitationClaim[], flaggedClaims: FlaggedClaim[], stats: { total, supported, supportRatio } }`.
- [ ] Types exported from package barrel AND re-exported from `@arki/ai` root barrel.
- [ ] Unit tests cover: (a) clean-summary path (all claims supported, `passed=true`), (b) hallucination injected (claim with no source support → flagged, `passed=false` if ratio < threshold), (c) edge cases (zero-claim summaries, sourceText empty).
- [ ] Synthetic-corpus validation test fixture lives at `packages/ai/citation/__tests__/hallucination-corpus.fixture.ts` — 10-item starter set; EX-05's 50-item × 5-claim corpus is added later under that fixture's expansion path.
- [ ] `@arki/ai/AGENTS.md` (or whatever the package's own context doc is — check before writing) documents the new submodule.
- [ ] Package builds clean via `turbo build --filter=@arki/ai`; typecheck clean via `turbo typecheck --filter=@arki/ai`.

## Blocked by

None — can start immediately. This is the tracer bullet that unblocks avocabo ai-summarization issue 05 (citation pipeline integration) AND any future ai-copilot RAG-grounding work.

## Implementation notes

The two-call shape (extract claims, then verify each) was picked over a single
combined call because per-claim trace fidelity matters for the ai-copilot RAG case
even more than for the summary pass/fail case. A single combined call tends to
hallucinate its own per-claim spans (we've seen this in early prototypes). Two calls
cost ~2x but the trace is auditable.

The threshold tuning is consumer-specific:

- ai-summarization MVP (this issue's primary consumer): default `pass-threshold = 0.95`
  per summary. EX-summarization-hallucination-05 will validate this against the
  synthetic corpus — if recall is below 98% at this threshold, lower threshold or
  upgrade verifier model.
- ai-copilot RAG (future consumer): tunable per-answer; likely needs per-claim trace
  rather than aggregate pass/fail. The result shape exposes both surfaces so
  ai-copilot can consume `.claims` directly without the `.passed` aggregate.

EX-summarization-hallucination-05 in
[avocabo ai-summarization experiments.md](../../../../../../apps/avocabo/docs/features/ai-summarization/experiments.md)
is the gate-5 evidence for this package landing. The synthetic corpus build is part of
that experiment, not part of this package — but the package needs to be importable
from the experiment harness before EX-05 can run.

## Related

- Parent capability: [`packages/ai/docs/capabilities/citation/README.md`](../README.md)
- Sibling capabilities: [`packages/ai/docs/capabilities/`](../../) (deduplication, summarization, embeddings, etc.)
- Consumer: [avocabo ai-summarization issue 05](../../../../../../apps/avocabo/docs/features/ai-summarization/issues/05-integrate-citation-pipeline.md)
- Consumer (future): ai-copilot RAG flows (PRD not yet authored)
- Founder pick: 2026-05-26 via `AskUserQuestion` during ai-summarization to-prd; relocated from `docs/features/ai-citation-pipeline/` to `packages/ai/docs/capabilities/citation/` on 2026-05-27 to match existing `packages/ai/docs/capabilities/<name>/` precedent

## Comments
