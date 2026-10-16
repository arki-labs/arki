---
'@arki/journal': minor
---

An effect handler may now return a failure from `@arki/failure`. The job is then dead after one try, unless the effect's `retry` backoff accepts that failure in its `while`. A thrown error retries as before. The job's `lastError` is the failure as JSON, with its code, message, status and data, so `journal.jobs(db, { status: 'dead' })` shows why. `Effect.run` now resolves with the handler's result instead of nothing.
