---
'@arki/journal': minor
---

The worker renews a running job's lease every half lease, so an effect longer than the lease is no longer claimed twice while its worker is alive. A lost lease (the worker stalled past a whole lease and another one reclaimed the job) aborts the effect's `ctx.signal`. `drain` and `worker` take `leaseSeconds` (default 60).
