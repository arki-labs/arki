---
'@arki/journal': minor
---

Workflow `concurrency` now works, and commands, effects and workflow steps emit OpenTelemetry spans.

- `concurrency: { key, limit, onBusy }` was typed but never applied: every run was stored with a null key. A start now counts the unfinished runs with its key, under a transaction-scoped advisory lock. At the limit, `onBusy: 'refuse'` returns the new failure `WorkflowBusy` (`journal.workflow_busy`, exported from `@arki/journal`, `./errors` and `./contract`), and `'join'` returns the oldest running run. A child start that is busy is always `WorkflowBusy`. `def.start` now has `WorkflowBusy` in its result type.
- Breaking for the schema: the unique index `workflow_runs_concurrency_unique` becomes the plain partial index `workflow_runs_concurrency_idx`, so a `limit` above 1 can hold. Generate a migration (`drizzle-kit generate`) after upgrading.
- Spans `journal.command`, `journal.effect` and `journal.step`, with the tracer `@arki/journal`. Outcomes are classified as `ok`, `failure` (with `failure.code`) or `defect`; no payload is an attribute. New dependency: `@opentelemetry/api`.
