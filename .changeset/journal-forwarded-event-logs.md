---
'@arki/journal': minor
---

Events can live outside the app database. `events` on `initJournal` and `j.entity` takes an `EventLog` besides `'stored'` and `'transient'`. A log that joins the row's transaction is written with the row. A log that cannot join is forwarded: the write commits the row, its projections and effect jobs, and one `forward` job with the write's events. The worker appends them to the log after the commit.

- One entity's forward jobs form a stream (`stream`, `stream_position` on `journal_jobs`). A job is claimed only when no earlier job of its stream is left in the table. `purgeDead` keeps a dead job that later jobs of its stream wait behind. Any job kind can use the columns.
- The worker reads the log's top first. Below the job's version, the job waits and never dies of waiting. Other events at its versions are the new `FORWARD_DIVERGED`, and the job dies at once.
- `replay`, `verify`, `repair` and `forget` read the entity's own log, and throw the new `FORWARD_PENDING` while a forward job for the entity waits. `cancel` refuses a forward job. `discard` takes one only when the log already holds its versions.
- `journal.forwardLag(db)` returns `{ pending, dead, oldestEnqueuedAt }`.
- `compose` refuses a tap on a forwarded entity, an async projection whose entities live in different logs, and one on a forwarded log with no global order. One entity kind has one log.
- `EventLog` and its parts are exported from `@arki/journal`, and the adapter conformance suite from `@arki/journal/event-log-contract` (`eventLogContract`, `ContractSkip`). `JOB_KINDS`, `JobKind` and `ForwardArgs` are exported from `@arki/journal/pg`.

Migration: two columns, a check branch and an index on the job tables, all additive. See `docs/upgrades/0.3.0-to-0.4.0.md`, step 9.
