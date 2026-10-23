---
'@arki/journal': minor
---

The built-in event log sits behind one interface (`src/event-log.ts`): append, stream, highest version, a global order (`all.after`, `all.top`, `all.distance`) and erase, bound to the caller's transaction. Every write takes its `seq` and `recordedAt` from the app database before the append, in both event modes. A contract suite checks the built-in log; adapters for other stores will run the same suite.

Breaking:

- `journal_cursors.seq` (bigint) becomes `journal_cursors.position` (text, null at the start). Move the values with the SQL in `docs/upgrades/0.3.0-to-0.4.0.md`, step 8; the generated drop and add would send every async projection back to the start.
- `journal.cursors(db)` returns `{ name, position, behind, distance }` instead of `{ name, seq, lag }`.
- `journal.rerun(db, projection, { after })` takes an `EventLogPosition` (or `null`) instead of `afterSeq`. `EventLogPosition` and `ProjectionCursor` are exported from `@arki/journal`.
