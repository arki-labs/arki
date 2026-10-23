---
'@arki/journal': minor
---

Every effect job carries its event. The writer puts the stored `journal_events` row in the job's `args`; the worker, `journal.job` and the workflow runner read the event from there and never join `journal_events`. The copy is decoded as replay decodes a row, so upcasters apply to a job queued before a release. `StoredEventRow` from `@arki/journal/pg` parses `args` back to the row type. `forget` rewrites the copy in `journal_jobs` and `journal_job_archive` in the same transaction as the event row. The copy never leaves the database: the archive sink gets an effect row with only the event header in `args` (seq, id, kind, entityId, version, type, recordedAt), and the Foreman job module shows a payload for queue jobs only, even with `payload: 'redacted'`.

Migration: `journal_jobs_kind_check` now requires `args` on an effect row. Drain pending effect jobs or backfill `args` from `journal_events` before the migration; the SQL is in `docs/upgrades/0.3.0-to-0.4.0.md`, step 6.
