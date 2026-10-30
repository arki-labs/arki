---
'@arki/journal': minor
---

A workflow can wait for one of the app's own events. New table, so `ExportsEveryJournalTable` stops compiling until `workflowWaits` has its export (0.x, no shims).

New:

- `.waitFor(name, { on: { [label]: { entity, events, match, where? } }, timeout | until, onTimeout, when? })` parks a run until an entity records one of the events. The result is `{ via: label, event }`, and narrowing `event.type` types `data`. `match` must return the entity's id type and `events` must belong to the entity: both are compile errors. With `onTimeout: 'continue'` a deadline gives `null`, so a wait doubles as a sleep an event cuts short. The signal form stays.
- No lost wake-ups: a parked wait writes rows in the new `workflow_waits` table, and the library effect `workflow.wake:<entity kind>` is mounted for each entity a wait watches. Park and wake take a lock on the correlation key, and the park reads the log, so whichever commits second sees the other.
- An event counts from the run's admission, so one recorded before the worker reaches the wait is kept. A revisit in a `next` loop reads on from the last event that wait took, one event is taken once per run, and a deadline and an event contend on one run transition. `WaitEventTaken` records each take, with the event id as `deliveryId`.
- An event wait stores a pointer to the event (`{ via, seq }`), never a copy, so `forget` on the entity reaches every run that took its events, parked, running or finished. An event with an `erased` form reads in that form. `results.x`, `def.read` and the operator views keep their types.
- `.sleep(name, until, { next })` loops, as a step's `next` does.
- `workflowHarness` gains `tickTo`, `dueJobs` and `release`, so a test runs due jobs one by one. `workflowHarnessOn(db, { setup })` runs it on a database the test opened, such as a real Postgres.

An event wait is a new node kind, `eventWait`, and its `on` joins the shape hash, so changing it needs a new version. Shape hashes of existing node kinds do not change. A run whose shape has no event wait never touches `workflow_waits`. The upgrade note names the migration step.
