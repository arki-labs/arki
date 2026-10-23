---
'@arki/journal': minor
---

`journal.adopt` takes a row at any version whose log is empty, not only a row at version 0. The create event is recorded as version 1 and the row is set to version 1 under the row lock, so the row's version drops from N to 1 and a client holding `expectedVersion: N` gets `CONFLICT` once. This is how an entity goes from `events: 'transient'` to `'stored'`: change the setting, then adopt each row before its first write. A row with a non-empty log is still `CONFLICT`; the message now says the row was written to after its events started being stored.
