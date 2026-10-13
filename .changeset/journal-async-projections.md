---
'@arki/journal': minor
---

Async projections: `j.projection(name, entity, handlers, { lane: 'async' })` runs later, in batches, by the worker. Each batch locks the projection's cursor in the new `journal_cursors` table, scans the next events in commit order, applies the matching ones and moves the cursor, all in one transaction. `journal.catchUp`, `journal.reset` (clears the read model and rewinds under the lock) and `journal.cursors` (lag per projection). `forget` locks the cursors first.

Schema change, additive: new table `journal_cursors`.
