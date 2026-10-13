---
'@arki/journal': minor
---

`expectedVersion` on `journal.write` and on a command's `write`: the row version the caller saw. A stored version that differs (0 for no row) is refused with `CONFLICT` before the rules run. Replaces hand-written version compares for concurrent editors and stale client moves.
