---
'@arki/journal': minor
---

Workflow runs can start later and give up waiting. `def.start` takes `delay` (an age such as `'5m'`, or a `Date`) and `ttl` (an age). A delayed run's first node is due at the planned start, and the readers show `delayedUntil`. A run whose first node has not started `ttl` after it was due ends in the new state `expired` without running, and frees its concurrency slot. `journal.workflows.reschedule(db, { runId, delay } | { runId, at }, op)` moves a start that has not happened. Retention has `workflows.expired` (default: the `failed` time).

Migration needed: `workflow_runs` gets the nullable columns `start_at`, `ttl_at` and `ttl_ms`, and `state` may now hold `expired`. Run `drizzle-kit generate`. Code that lists the end states must handle `expired`.
