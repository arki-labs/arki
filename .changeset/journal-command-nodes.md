---
'@arki/journal': minor
'@arki/payments': patch
---

Effects only reach out, `startOn` says when a run starts, and workflows get a command node. Breaking (0.x, no shims):

- An effect's context has no `run` and no `accept`: `{ jobId, attempt, signal, db }`. An event that must run a command starts a `j.task` or a `j.workflow` with `startOn`. `Effect` and `EffectHandlers` lose their runner type argument, and `RootCommandRunner` is no longer exported.
- `startOn.timing` is required: `'after-commit'` (the behaviour so far) or `'with-event'`. `'with-event'` writes `RunStarted`, the first scheduled node and its job in the event's transaction, so a rollback of the command removes the run. No body runs inline. `onBusy: 'refuse'` with `'with-event'` is a type error. A standalone `workflow()` now types its `startOn` mapping.

New:

- `.command(name, command, ({ input, results }) => commandInput, { accept?, undo?, when?, retry? })` runs one command as a savepoint inside the checkpoint's transaction: exactly once per node, even when the job runs again after a crash. A refused command rolls back and the failure transition commits. `accept` names failures the run goes on from, and they join the typed result. `undo` runs in compensation, in reverse order.
- `j.command(name, input, { writes, output }, handler)` takes a schema of the plain result. A command node stores it, and `results.x` and `def.read` are typed from it. Stored JSON is checked by the schema, never cast.

Shape hashes of existing node kinds do not change. `@arki/payments`: the refund workflow names `timing: 'after-commit'`. Its steps stay steps, because none has a body of exactly one command.
