---
'@arki/journal': minor
---

`seq` is now commit order. Every `write` takes one advisory transaction lock at its start and holds it until commit, so a transaction that took a lower `seq` always commits first and `rerun`'s `afterSeq` cursor, or any reader that remembers the last `seq` it saw, misses nothing. Before, a slower transaction could commit a lower `seq` after a reader had moved past it. Cost: event appends across the app commit one transaction at a time.
