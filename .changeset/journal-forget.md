---
'@arki/journal': minor
---

Erasure. `j.event(type, schema, { erased: data => ... })` declares an event's erased form. New verb `journal.forget(db, entity, id)` rewrites every stored event of the entity that has one to that form, stamps `erased_at`, and repairs the row from the rewritten log, in one transaction. Recorded events carry `erasedAt`. Projections are not rerun; the app forgets its own read models.

Schema change, additive: one nullable column on `journal_events`:

```sql
ALTER TABLE journal_events ADD COLUMN erased_at timestamp with time zone;
```
