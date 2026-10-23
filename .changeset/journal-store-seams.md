---
'@arki/journal': minor
---

The journal's Postgres storage lives in one place, split by concern: entity rows, the event log, receipts, effect jobs and the wake signal (`src/store.ts`). The write path, history and command receipts call it instead of building queries inline. One behaviour changes: a row insert that hits a unique constraint is now `CONFLICT` for every entity, not only for one with `events: 'transient'`. Before, an entity with stored events let the driver's unique-violation error through. The write still rolls back with its events.
