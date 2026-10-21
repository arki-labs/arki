---
'@arki/journal': minor
---

Durable workflows. A workflow is a list of steps that runs to the end even when the process dies. Each step runs as a job in `journal_jobs`, and its checkpoint (the result, and the next step scheduled) commits in one transaction. Use it for work that must survive a restart or waits for hours or days. A loop of steps inside one request stays `createFlow` from `@arki/ai`, which is in memory and not durable. See the README chapter Workflows and the agent guide.

- `j.workflow(name, { version, input, output?, needs?, deadline?, concurrency?, onDeadStep?, retention?, limits? })`, then `.step`, `.waitFor`, `.sleep`, `.child`, `.map` and `.finish`. Step results are inferred: a later step reads `results.<name>` typed. Step options: `undo`, `output`, `key`, `retry`, `timeout`, `when` (skip; the result is `R | null`) and `next` (jump back to an earlier node).
- `compose({ workflows, workflowMeta })` registers them, once per `initJournal()`. It adds the effects `workflow.step` and `workflow.timer`.
- A finished definition has `def.start` (`{ input, id? }` → `{ runId }`, idempotent on `id`), `def.signal(name)` (`{ runId, deliveryId, payload }` → `woke`, `kept`, `duplicate`, `finished` or `no-run`; `no-run` is a signal to a run that does not exist or belongs to another workflow, which stores nothing and does not fail, so a webhook is not resent forever), `def.cancel` (`{ runId, reason }`) and `def.read(db, runId)`, which reads a run back typed and returns `WorkflowReadMismatch` (`journal.workflow_read_mismatch`) when a stored value no longer fits its schema.
- Failure and compensation: a thrown error retries with the step's backoff; a returned failure kills the step. `onDeadStep: 'wait'` (default) leaves a dead step for an operator; `'compensate'` undoes the finished steps, newest first. A step without `undo` is listed in `residual`. A cancel compensates the same way. A wait the run was parked on when compensation began is dropped and leaves no result.
- Versions: new runs start the highest registered version; older versions only finish their runs. A run whose code is missing or has other nodes is stranded and never runs the wrong step.
- Operators: `journal.workflows.runs`, `run`, `counts`, `stranded`, `history`, and the verbs `retryStep`, `resolveStep`, `skipUndo`, `signal`, `cancel` and `checkResult`. `journalWorkflowsModule` in `@arki/journal/foreman` serves them in Foreman (`ARKI_JOURNAL_E010` to `E017`).
- Dot: `journalHandlers({ workflows })`, `journalWorkflows(core, defs)` for `defineFeature`, and `journal({ j, workflowMeta })`. A step gets the services of the feature that lists its workflow.
- Testing: `workflowHarness({ setup })` in `@arki/journal/testing`, with `tick`, `drain`, `crash` and `close`.
- Every effect context has `attempt`. An effect whose job lease was lost gets `LEASE_LOST` from `ctx.run`, and nothing it runs is written.
- `EffectSchedule.when(event)`: an effect makes a job only for the events it accepts.
- New `JournalError` codes: `LEASE_LOST`, `STEP_TIMEOUT`, `WORKFLOW_LIMIT`, `WORKFLOW_UNKNOWN`, `WORKFLOW_SHAPE_CHANGED`, `WORKFLOW_VERSION_RETIRED`, `WORKFLOW_NOT_FOUND`, `WORKFLOW_FINISHED`, `WORKFLOW_COMPENSATING`, `STEP_NOT_DEAD`, `STEP_NOT_RESOLVABLE`, `WORKFLOW_READ_MISMATCH` and `JOB_MANAGED`. New failures: `WorkflowStranded`, `WorkflowReadMismatch`.

Breaking (0.x). These shipped in the 0.3.0 code without a changelog entry. 0.3.0 was not published to npm, so an app moving from 0.2.1 meets them here. The upgrade guide is `docs/upgrades/0.3.0-to-0.4.0.md`.

- `initJournal({ tables, meta?, retention? })` takes the journal tables, and `tables` is required. `compose()` no longer takes `tables`, and the Dot adapter `journal({ j })` no longer takes `tables`.
- `retention` moved from `compose()` to `initJournal()`. It gains `retention.workflows` (`completed` 7 days, `failed` 90 days, `cancelled` as `failed`).
- Migration: three new tables, `workflow_runs`, `workflow_steps` and `workflow_signals`, and a nullable `run_id` column on `journal_jobs` and `journal_job_archive`. Export the new tables from the schema module (`ExportsEveryJournalTable` names any you miss) and run `drizzle-kit generate`. Every statement is additive. Migrate first, then roll the workers.
- `journal.retry`, `journal.discard` and `journal.cancel` refuse a job that belongs to a workflow run with `JOB_MANAGED`.
- For code written against the unreleased workflow code in 0.3.0: `NodeSkipped` event data has a required `cause` (`when`, `compensating`, `no-undo`, `detached`, `operator`), and a node dropped by compensation leaves no key in `results` (it was `null`). `RunDetail` takes `<Input, Output, Results>`, and `WorkflowDef`, `WorkflowStarter`, `DefExtension` and `ApplyExtension` have new type parameters. `finish(fn)` with a declared `output` no longer needs a second argument. `Effect.bindPerWorkflow` is internal and no longer in the published types.
