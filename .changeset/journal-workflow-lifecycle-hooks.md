---
'@arki/journal': minor
---

Lifecycle hooks on a workflow or a task: `on: { success, failure, cancel, expired, complete }`. A run end queues one job of the new library-owned effect `workflow.on` in the transaction that ends the run, so a hook runs only after that commit, at least once, with the code of the run's own version. A throw is retried like an effect's; a returned failure is final; a hook never changes the run. Each hook gets the run (`runId`, `workflow`, `version`, `scope`, `tags`, `metadata`, typed `input`, `state`), `output` on `success` (typed by the `output` schema and checked again, `unknown` without one), `error` on `failure`, the job's `db`, `run` (records `workflowMeta` without a meta), `accept`, `signal`, `jobId`, `attempt`, and the definition's needs. `complete` runs for every end, after the specific hook. The effect is added only when a composed definition declares `on`.

`journal.hooks.step.around((ctx, next) => ...)`, next to `command` and `effect`: wraps each step body and undo inside the `journal.step` span. `ctx` is `{ workflow, version, runId, step, attempt, phase }` (exported as `StepHookContext`); it is frozen by the first drain or worker. New exported types: `LifecycleHooks`, `LifecycleHookContext`, `RunEnding`, `StepHookContext`. `WorkflowDef` has a new `on` field, and `WorkflowOptions` a fifth type parameter (the host the hooks see).
