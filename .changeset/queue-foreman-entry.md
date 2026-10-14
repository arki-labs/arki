---
'@arki/queue': minor
---

New `@arki/queue/foreman` entry for the Foreman control plane. `queueForemanModule({ queues })` gives a paged `queue.failedJobs` read (last error redacted of secrets) and a `queue.retryJob` action that pins the failure it previewed: a stale revision is rejected, and a job already re-queued cannot be retried again. `pgBossFailedJobSource({ pglite })` backs it for the runtime-local queue. `@arki/admin` is an optional peer, needed only by this entry.
