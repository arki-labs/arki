---
'@arki/schedule': minor
---

Schedules can run under a lock (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, phase 1c).

- `schedules(core, [{ ..., lock: true | 'key' })`: `true` locks on the schedule name; a string shares one key so two jobs exclude each other. A run that finds the lock held reports `skipped-lock`. The lock is held until the job ends (no fixed-time lease), and it replaces the driver's KV lease for that schedule.
- A `lock:` schedule needs a `locks` service; without one it is a compile error. `advisoryLocks(...)` from `@arki/db/dot` provides it on PostgreSQL.
- `Locker` (new type): the whole lock port — `tryRun(key, fn)` returns `{ ran: true, value }` or `{ ran: false }`. Structural, so any lock library can implement it and this package needs no database.
- `dot explain` shows each schedule's lock key.
