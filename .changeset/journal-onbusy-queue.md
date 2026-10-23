---
'@arki/journal': minor
---

Workflows: `concurrency: { onBusy: 'queue' }`. A start that a full or paused limit blocks creates the run in the new state `queued` (events `RunStarted` and `RunQueued`) with no node scheduled, and returns its `{ runId }`. A child may queue too; its parent stays parked. A queued run holds no slot: no limit counts it. When a run that held a limit ends, or an operator raises, resets or resumes a limit, or a key override runs out (a new `workflow.limitTimer` job at its `until`), the oldest queued runs that now fit are promoted in the same transaction (`RunDequeued` and the first `NodeScheduled`, due at `start_at` when a delay is still ahead), FIFO per key, checking at most `LIMIT_BOUNDS.promoteTries` (50) candidates per change. A queued run past its `ttl` ends `expired` through its timer job; `cancel` ends it `cancelled` at once; `reschedule` moves its start. `journal.limits.get` and `list` show `queued` next to `running`.

The start gate now runs inside the start's write, after the journal's append lock, and a limit verb takes the limit lock inside its write: every path takes the append lock first and the limit locks after it, so a run end that promotes and a start that queues never deadlock.

Apps need `drizzle-kit generate`: `workflow_runs` gets the partial index `workflow_runs_queued_idx` on `(started_at, id) where state = 'queued'`, and `state` may now be `queued`.
