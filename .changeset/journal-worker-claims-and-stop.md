---
'@arki/journal': minor
---

The worker no longer runs a job twice because of a slow neighbour. `drain` used to claim its whole batch under one lease and then run the jobs one after another, so the lease of the last jobs could run out before they started and a second worker would take them. It now claims each job right before running it. A job queued during a pass can run in the same pass.

`worker.stop()` now aborts the running effect's `ctx.signal`, claims nothing more, and resolves when that effect returns. Before, the signal was never fired and `stop()` waited for the whole batch. `drain` stops claiming once its `signal` is aborted.

New `journal.strandedJobs(db)` lists pending jobs whose effect the journal does not have, counted per effect name. The worker still never claims them (an older worker may have the effect during a rolling deploy), but a renamed or removed effect no longer hides its jobs.
