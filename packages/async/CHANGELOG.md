# @arki/async

## 0.2.0

### Minor Changes

- d7e9886: Return canonical owned cancellation, deadline and provider/callback defect outcomes from async waits and concurrency. Preserve fulfilled Failure elements, heterogeneous result inference, joined work and late settlement observation; contain foreign scope-listener failures. Add default operation telemetry without changing callback execution or exposing private causes. Retire migrated exception-only exports and update callers and runtime examples. AI Flow propagates retry-wait defects unchanged; Clock docs clarify its existing supervised sleep contract.

  no demo impact: public examples and runtime smoke checks cover the changed behaviour; no separate demo application exists.

### Patch Changes

- Updated dependencies [11c5bc2]
- Updated dependencies [a905468]
- Updated dependencies [11c5bc2]
- Updated dependencies [a07bccc]
- Updated dependencies [49517e2]
- Updated dependencies [d7e9886]
- Updated dependencies [1a897f8]
- Updated dependencies [5d55e12]
- Updated dependencies [b76c8a6]
- Updated dependencies [cac4bc6]
  - @arki/failure@0.3.0
  - @arki/clock@0.2.0
  - @arki/schema@0.3.0

## 0.1.1

### Patch Changes

- c794d12: Object checks on unknown values now use `is(value, recordSchema)` from `@arki/schema` instead of hand-written `typeof value === 'object'` guards. Behaviour is unchanged.
- Updated dependencies [6601242]
- Updated dependencies [2000a7e]
- Updated dependencies [6601242]
  - @arki/failure@0.2.0
  - @arki/schema@0.2.0
  - @arki/clock@0.1.1

## 0.1.0

### Minor Changes

- 8c91dd3: Own resources and child work through typed descriptors. Replace imperative `scoped` registration with `resource`, `cleanup`, `child`, `scoped(plan, body)`, `openScope` and checked dynamic scopes. Preserve exact callback failures and canonical cancellation, deadline and defect outcomes; keep cleanup members private when serializing aggregate failures.

  Dot owns partial plugin construction, publishes services atomically, joins children before disposal and retains finalizer failures. Lazy services coalesce initialization, retry only on a later explicit get, and expose only successful values through peek. Lifecycle callers, HMR and CLI supervision now inspect resolved ownership failures. Existing static/configure and legacy start/stop exception migration continues separately.

  Breaking upgrade: see `@arki/dot/docs/upgrade-ownership.md` and `@arki/async/README.md`. Check boot/start/get/dispose results before using them; deadlines request cancellation and wait for admitted work to settle before releasing resources.

  `ProvidesFactories` now describes raw callback returns, including promises. Infer factory records at their definitions; handles and lifecycle callbacks continue to receive resolved service values.

- 509515e: `sleep`, `debounce`, `throttle` and `timeout` take an optional `clock` (an `@arki/clock` `Clock`). The default is the system clock, so nothing changes unless you pass one. With a `MockClock`, `clock.advance(ms)` drives the waits, so tests of long delays run instantly without fake timers. New type `TimeoutOptions` for `timeout`'s options. The package now depends on `@arki/clock`.
- 67c7dbf: New foundation package. `sleep(ms, { signal })` waits and can be aborted; `debounce` and `throttle` follow the lodash contract (checked against lodash on random call schedules) and return a function with `cancel`, `flush` and `pending`. Zero dependencies, runs on Node, Bun, Deno, browsers and Hermes, and every failure is an `AsyncError` with a code (`ARKI_ASYNC_E001` invalid wait, `ARKI_ASYNC_E002` aborted).
- 06712c7: `@arki/async` no longer has its own `attempt`, `Outcome` and `unwrap` helpers. They were internal and never exported from the package entry, so no import breaks. `all`, `mapConcurrent`, `race`, `timeout` and `scoped` behave as before. To turn a throw into a value, use `attempt` from `@arki/failure`.
- ac0f811: Scopes and structured concurrency on plain Promises and `AbortSignal`. `scoped(body)` gives the body a `scope` with a `signal`, `acquire(open, close)` and `defer(fn)`; on exit the signal aborts and finalizers run newest first, each awaited, all attempted, with finalizer failures reported as `ARKI_ASYNC_E003` (body error kept as `cause`). `all` (tuple-typed) and `mapConcurrent` run tasks with an optional `concurrency` limit, abort the shared signal on the first failure, start nothing new, and wait for in-flight tasks before rejecting. `race` resolves with the first task to fulfill (like `Promise.any`, not `Promise.race`), aborting and awaiting the losers. `timeout` aborts the task's signal at the deadline and rejects with `ARKI_ASYNC_E004`. Invalid `concurrency` rejects with `ARKI_ASYNC_E005`. `ARKI_ASYNC_E002` now covers every aborted helper, and `AsyncError` gains a readonly `errors` list.

### Patch Changes

- 064e096: Propagate exact Clock sleep failures through retry policies, composition, fallback helpers and Dot services. Retry stops on a failed wait. Owned scopes recognize canonical Clock cancellation only with their private cancellation cause. Callers must inspect retry outcomes; success remains unwrapped.

  Transactions and HTTP clients map wait refusals to their existing cancellation/defect contracts without repeating the operation.

- abffdfd: Docs standard: README sections, `AGENTS.md`, `llms.txt`, an agent guide, a tested `examples/load-pages.ts`, and `@fix` / `@verify` notes on every error code. no demo impact: documentation and doc-example changes only, runtime behaviour unchanged
- c5c79d6: Observe owned scopes through acquisition, child settlement and finalization with one OpenTelemetry span and duration metric. Propagate its context to admitted callbacks, including custom Dot telemetry. Guard provider and context-manager failures so application work runs once and keeps its original outcome.

  Enable failure lint rules in the package and assert previously discarded test outcomes. Public success and failure types are unchanged.

- Updated dependencies [57313a4]
- Updated dependencies [f43d509]
- Updated dependencies [232d3e8]
- Updated dependencies [3f6d39f]
- Updated dependencies [12e7fa2]
- Updated dependencies [1668156]
- Updated dependencies [7f9b4bb]
- Updated dependencies [86efafc]
- Updated dependencies [d541df1]
- Updated dependencies [f6a15d0]
- Updated dependencies [4913009]
- Updated dependencies [232d3e8]
- Updated dependencies [73ef41b]
- Updated dependencies [abffdfd]
- Updated dependencies [9669a84]
- Updated dependencies [f796e5a]
  - @arki/failure@0.1.0
  - @arki/clock@0.1.0

## 0.0.0

Not published yet. `sleep`, `debounce`, `throttle`, `scoped`, `all`, `mapConcurrent`, `race` and `timeout`, with coded `AsyncError` failures. The release tooling appends the first version here.
