---
'@arki/queue': minor
---

Builder order mistakes are now compile errors, and every declaration mistake throws a coded error.

- `q.job.name(...)` and `q.schedule.<kind>(...).name(...)` now return `JobBuilderNeedsInput` / `ScheduleBuilderNeedsInput`. These types have no `.handler()`; `.input(schema)` unlocks it. `.options()` and `.use()` still work in the same places as before.
- `q.flow.name(...).input(...)` now returns `FlowBuilderNeedsStep`, which has no `.build()`. The first `.step(...)` unlocks it. `.use()` still works before and after steps.
- The runtime checks stay as a backstop for plain JS and casts. They, the flow checks for unknown step ids and dependency cycles, and the `CronPatterns` range checks now throw `QueueDefinitionError` with a `code` (`ARKI_QUEUE_E006` to `ARKI_QUEUE_E011`, listed in `QUEUE_DEFINITION_ERROR_CODES`) and a `remediation`. Messages are unchanged.

Breaking, so a minor bump while the package is below 1.0: code that compiled before can now fail to compile. A `.handler()` with no `.input()`, or a `.build()` with no steps, already threw at runtime. But two working patterns also break: a variable annotated as `JobBuilderChain<..., never, never>` holding the result of `.name()`, and a flow variable built step by step in a loop (`let f = q.flow.name(n).input(s); f = f.step(...)`), whose type no longer has `.build()`. No app in this repo uses either pattern.
