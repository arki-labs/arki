---
'@arki/journal': minor
---

`journal_jobs` now takes `kind = 'queue'` rows: jobs written in the caller's transaction by `@arki/queue/outbox`, with no event. `worker` and `drain` accept `jobs` (a `JobRunner`) and claim both kinds. Without `jobs` they claim effect rows only, as before, and an older worker never claims a queue row. `journalWorker({ jobs })` takes a `JobsSource`. `StrandedJobs` is now `{ kind, name, jobs }`, and `strandedJobs(db, { jobs })` counts queue rows when it gets the runner. `jobs({ job })` filters queue rows by job name. `jobId` is exported from the root. New types: `JobRunner`, `ScheduledJob`, `JobsSource`. Run `drizzle-kit generate` in each app: the migration drops `NOT NULL` on `event_seq` and `effect` and adds `kind`, `job_name`, `args`, `dedupe_key`, a check and a dedupe index. Roll out in this order: migrate, then workers, then producers.

`listenOnPool` closes its client on stop instead of handing it back to the pool. A reused client kept the stopped worker's handlers: they fired its taps and released the next worker's client twice ("Release called on client which has already been released").
