---
'@arki/journal': minor
---

`events: 'stored' | 'transient'` on `initJournal` (the journal default) and `j.entity(kind, table, { events })` (per entity). A transient entity keeps no `journal_events` rows: the write still takes the append lock, checks `expectedVersion`, folds, saves the row, runs inline projections and queues effect jobs, and the events it returns carry a real `seq` from the events table's sequence. Workflow runs always store their events.

- `replay`, `verify`, `repair`, `forget`, `adopt` and `rerun` throw `NO_HISTORY` for a transient entity; an async projection or a tap on one is `BAD_DEFINITION` at `compose`.
- Two creates of one transient id that race end in `CONFLICT`, mapped from the row's unique violation.
- After a delete, a transient entity's next create starts at version 1 again.
- Schema: `journal_jobs_kind_check` no longer requires `event_seq` on effect rows, and the partial unique index `journal_jobs_effect_event_id_unique` on `((args->>'id'), effect) where kind = 'effect'` is new. Generate a migration (`drizzle-kit generate`); both statements are additive. See `docs/upgrades/0.3.0-to-0.4.0.md`, step 7.
- `EntityDef.eventStorage` and the type `EventStorage` are new exports.
