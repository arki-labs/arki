---
'@arki/journal': minor
---

New verb `journal.adopt(tx, entity, id, { meta, events })` for rows that existed before the journal. It takes a row at version 0 with no history, records one create event built from the stored row as version 1, and moves the row to version 1, so `replay`, `verify` and `repair` work from then on. The event's `.create` reducer must rebuild the row exactly, or `VALUE_MISMATCH` and nothing changes. Before, a legacy row's history started at version 2 and its original values were lost to the first write.
