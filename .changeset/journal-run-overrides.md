---
'@arki/journal': minor
---

A workflow run can narrow how its steps run. `def.start` (and each `startBatch` item, and `journal.workflows.replay` overrides) takes `maxAttempts` (caps the tries of every step; the step's own `retry` still picks the wait and which errors retry), `timeout` (an age; each step attempt times out after it, or after the step's own `timeout` when that is shorter) and `priority` (the claim order of the run's step and timer jobs, on the scale of an effect's `priority`). A run keeps them for its whole life, a replay keeps them unless overridden, and a child does not inherit them. Bad values are `InvalidInput`. `RunOverrides` and `RUN_OVERRIDE_LIMITS` are exported, and the readers return `maxAttempts`, `stepTimeoutMs` and `priority`.

An effect schedule's `priority` may be a function of the event (`priority: event => number`), like `runAt`, so each job gets its own priority. Each value it gives is checked to fit 32 bits.

Migration needed: `workflow_runs` gets the nullable integer columns `max_attempts`, `step_timeout_ms` and `priority`. Run `drizzle-kit generate`. Old runs keep `null`.
