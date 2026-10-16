---
'@arki/queue': minor
---

A job's `retry` option is now a `Backoff` from `@arki/resilience`, the same retry schedule the resilience policies and `@arki/journal` use. `@arki/queue` re-exports `backoff` and the `Backoff` type. Every job retries through BullMQ's custom backoff, and the job's worker asks the `Backoff` for each delay, so `.while(predicate)` can stop retries for errors that will never succeed. The default is unchanged: 3 tries, 1 s then 2 s apart.

Breaking:

- `retry: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, maxDelay: 5000 }` becomes `retry: backoff.exponential({ base: 1000, max: 5000 }).upTo(2)`. `upTo` counts retries, so it is `attempts - 1`. A `fixed` backoff becomes `backoff.constant(ms)`.
- Removed `RetryConfig`, `BackoffStrategy`, `COMMON_RETRY_CONFIGS` and `createBackoffStrategy`, and the strategies only they offered (linear, polynomial, fibonacci, the jitter variants, stepped, custom). Nothing in the monorepo used them.
- The job's action metadata now reports `retry: { attempts }` only (`'unlimited'` when the backoff has no `upTo`), without the backoff type and delay.
