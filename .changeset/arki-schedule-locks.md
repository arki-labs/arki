---
'@arki/schedule': minor
---

Schedules can run under a lock (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, phase 1c).

- `schedules(core, [{ ..., lock: true | 'key' | { key?, holdAtLeast? } })`: `true` locks on the schedule name; a string shares one key so two jobs exclude each other. A run that finds the lock held reports `skipped-lock`. The lock is held until the job ends (no fixed-time lease). The KV lease path is gone: a schedule has no `lock` option on the driver any more.
- The lock stays held at least `holdAtLeast`, default `1s` (`0` turns it off), so a replica with a slow clock cannot rerun a sub-second job. `trigger()` and the shutdown drain wait for the release.
- A `lock:` schedule needs a `locks` service; without one it is a compile error. `locks(...)` from `@arki/lock/dot` provides it, on any `@arki/lock` store.
- `Locker` (new type): the whole lock port — `mutex(key).tryRun(fn, { holdAtLeast })` returns `{ ran: true, value }` or `{ ran: false }`. Structural, so any lock library can implement it and this package needs no database. The handler gets `run.lock` (`{ signal, fence }`) as its second argument.
- `dot explain` shows each schedule's lock key.
