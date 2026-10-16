---
'@arki/queue': minor
---

A job handler may now return a failure from `@arki/failure`. The job then fails at once, without a retry, unless the job's `retry` backoff accepts that failure in its `while`. A thrown error retries as before. The job's `failedReason` is the failure as JSON, with its code, message, status and data, so the board and the foreman show why the job failed. The `runtime-local` queue does not apply this yet.
