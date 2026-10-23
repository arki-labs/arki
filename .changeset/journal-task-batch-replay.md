---
'@arki/journal': minor
---

Tasks, batches and replays for workflows. `j.task(name, options, run)` defines a workflow of one step named `run`: it is `j.workflow(name, options).step('run', run, { retry, timeout, undo, key }).finish()`, so a task is a `WorkflowDef` in every way, and its output is what `run` returns (or the `output` schema's output, which `run` must then return). `def.startBatch({ items, batchId? })` starts up to `BATCH_LIMIT` (1000) runs of one workflow in one transaction and returns `{ batchId, runs }`, one outcome per item: a refused item rolls back only its own savepoint, and an item that does not fit the start schema refuses the whole batch with `InvalidInput`. `journal.workflows.batch(db, batchId)` counts a batch's runs by state and lists their ids, and `runs(db, { batchId })` filters by it. `journal.workflows.replay(db, { runId, overrides? }, op)` starts a new run of a run's workflow at the newest version with the old input, scope, tags and metadata unless `overrides` replaces them; the new run records `replayOf` and the operator.

Migration needed: `workflow_runs` gets the nullable columns `batch_id` (with the index `workflow_runs_batch_id_idx`) and `replay_of`. Run `drizzle-kit generate`. `RunStarted` may carry `batchId`, `replayOf` and the operator fields; older events replay with `null`.
