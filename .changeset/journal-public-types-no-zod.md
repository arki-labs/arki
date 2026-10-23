---
'@arki/journal': minor
---

The public types of workflows no longer reach Zod, so the `.`, `./dot`, `./orpc` and `./foreman` declaration files pass `TYPES_E001` (A-43).

- The types of starting and operating a run (`StartArgs`, `StartSchema`, `StartOutcome`, `StartBatchArgs`, `StartBatchSchema`, `StartBatchOutcome`, `WorkflowStarter`, `StarterOf`, `ReplayArgs`, `ReplayOverrides`, `RescheduleArgs`, `RescheduleOutcome`, `CancelArgs`, `CancelSchema`, `CancelOutcome`, `SignalArgs`, `SignalSchema`, `SignalOutcome`) moved from `workflow/runner.ts` to the new Zod-free `workflow/run-types.ts`. The schemas that check them stay in `runner.ts`, which no public declaration file reaches now.
- The run field schemas (`runFieldsSchema`, `runTimingSchema`, `runOverridesSchema`, `delayAgeSchema`, `ttlAgeSchema`, `metadataChangeSchema`, `addedTagsSchema`) moved from `workflow/run-fields.ts` to the new internal `workflow/run-field-schemas.ts`. `run-fields.ts` keeps the types (`RunFields`, `RunTiming`, `RunOverrides`, `MetadataChange`, ...), the limits and the pure functions, and imports no Zod.
- `StepStatus` moved from `workflow/machine.ts` to `workflow/states.ts`, next to `STEP_VIEW_STATUSES`.
- No export of a package entry was removed or renamed: these are internal files, and the root still exports the same names. `schemas.test-d.ts` still locks every type to its schema both ways.

Breaking: `WorkflowBusy.data.key` is now `string | null`. It is `null` for a start without a concurrency key (only a `total` limit can block one); it was `''`. A failure recorded before this change still reads, with `''`.
