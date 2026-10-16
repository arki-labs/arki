---
'@arki/journal': minor
---

An effect's schedule takes `retry`, a `Backoff` from `@arki/resilience` (re-exported as `backoff`): `withSchedule({ retry: backoff.exponential({ base: 5000 }).upTo(3) })`. It is the same retry schedule queue jobs and resilience policies use. It sets how long a failed job waits before the next try, and when the job is dead instead; `.while(predicate)` makes an error that will never succeed kill the job at once. The default keeps the old behavior: 8 tries, doubling from 1 s to at most 5 minutes, with 25% jitter. The package now depends on `@arki/resilience`.
