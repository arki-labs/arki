---
'@arki/async': minor
---

Scopes and structured concurrency on plain Promises and `AbortSignal`. `scoped(body)` gives the body a `scope` with a `signal`, `acquire(open, close)` and `defer(fn)`; on exit the signal aborts and finalizers run newest first, each awaited, all attempted, with finalizer failures reported as `ARKI_ASYNC_E003` (body error kept as `cause`). `all` (tuple-typed) and `mapConcurrent` run tasks with an optional `concurrency` limit, abort the shared signal on the first failure, start nothing new, and wait for in-flight tasks before rejecting. `race` resolves with the first task to fulfill (like `Promise.any`, not `Promise.race`), aborting and awaiting the losers. `timeout` aborts the task's signal at the deadline and rejects with `ARKI_ASYNC_E004`. Invalid `concurrency` rejects with `ARKI_ASYNC_E005`. `ARKI_ASYNC_E002` now covers every aborted helper, and `AsyncError` gains a readonly `errors` list.
