---
'@arki/journal': minor
---

Events in another Postgres database, and store switches.

- `postgresEvents({ db, tables })` from the new `@arki/journal/postgres` is an event log in a second Postgres database. Its table comes from `eventLogTables(schema?)` in `@arki/journal/pg`: `journal_events` with the app's `seq` and a `transaction_id xid8` column. Its entities are forwarded. It offers `all` and `erase`, so async projections, `rerun` and `forget` work on it. `all` orders by `(transaction_id, seq)` and reads only below the oldest open transaction, so a reader never passes a row that commits later. Positions are `"transaction id:seq"`, with no `distance`.
- `journal.copyLog(db, entity, { to })` copies an entity kind's events from the log it uses now into `to` (`'stored'` or a log), for a store switch. It is refused while forward jobs of the kind wait (`FORWARD_PENDING`) and onto the log the kind already uses (`BAD_DEFINITION`). It is safe to run again.

The built-in `journal_events` table is unchanged: its columns now come from the same column list as `eventLogTables`.
