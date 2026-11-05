---
'@arki/dot': minor
---

`dot new` and `dot dev` now return their file-system problems instead of throwing them.

- `runNew` returns `dot.template_missing` when the template folder is missing or a template file cannot be read. Before, only an empty folder returned it; a missing folder threw a raw `ENOENT`.
- `runDev` returns the new `dot.dev_state_failed` (data `{ statePath, reason }`) when it cannot create `.local/dot/dev.json`, for example in a read-only or full project folder. `releaseDevState` no longer rejects: a state file it cannot remove is logged at warn, so the session keeps its own result.
- Breaking: `renderTimeline` checks `barWidth` up front. It must be a whole number from 1 to 1000; any other value fails an `invariant` with a clear message instead of a `RangeError` from deep in the renderer.
- Breaking: `hookSignals`'s `signals` option takes only termination signals a process can catch (`SIGTERM`, `SIGINT`, `SIGHUP`, `SIGQUIT`, `SIGBREAK`, `SIGUSR2`). `SIGKILL` and `SIGSTOP` are now a type error instead of a runtime crash that left some handlers hooked.
- `dot new` templates pin `@arki/db` 0.5.1 and `@arki/journal` 0.4.1, the published versions.
- Failure data schemas in `@arki/dot/cli` are zod schemas now, and each exported `...Data` type is the schema's output. `DoctorFailed` checks the whole diagnostics snapshot, not only that its fields are arrays.
