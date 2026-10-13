---
'@arki/journal': minor
---

The wake channel and taps. Every commit that recorded events now runs `pg_notify(journal.wakeChannel, { from, to })` at commit. `journal.worker(db, { listen })` hears it and drains at once, from any process and from caller-managed transactions. `j.tap(name, entity, [needs,] handlers)` declares a lossy, after-commit, in-process handler that fires in every listening worker for the events in the announced range; `compose({ taps, services })` and `journalHandlers({ taps })` carry them. A journal with taps refuses a worker without `listen` unless `{ taps: false }`.
