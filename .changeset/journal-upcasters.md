---
'@arki/journal': minor
---

Versioned events with upcasters. `j.event(type, schema, { upcasters: [{ from: oldSchema, up: old => newer }] })` keeps an event's older shapes, oldest first, and each `up` is typed from its own `from`. New column `schema_version` on `journal_events` (integer, default 1): writes and `forget` store the event's current version, and every reader lifts older rows step by step before parsing with the current schema. A row from a newer release, a row that does not fit its version's schema, or an upcaster that throws is `REPLAY_FAILED` and names the version. Apps that own journal tables need a migration for the new column.
