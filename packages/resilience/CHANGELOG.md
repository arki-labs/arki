# @arki/resilience

## Unreleased

- Breaking: retry cancellation returns canonical `Cancelled` before another attempt and after rejected cancelled work. `RetryFailure`/`RETRY_FAILURES` include the exact cancellation and clock outcomes. Pre-aborted retries no longer invoke callbacks. See [upgrade guidance](docs/upgrades/0.2.0-to-0.3.0.md).

## 0.2.0

### Minor Changes

- 9669a84: Propagate exact Clock sleep failures through retry policies, composition, fallback helpers and Dot services. Retry stops on a failed wait. Owned scopes recognize canonical Clock cancellation only with their private cancellation cause. Callers must inspect retry outcomes; success remains unwrapped.

  Transactions and HTTP clients map wait refusals to their existing cancellation/defect contracts without repeating the operation.

- 232d3e8: Carry inferred failures through configure, boot, start, stop and dispose, with atomic service publication, rollback aggregation and supervised usecase invocation even without tracing. Configure now returns a typed outcome and remains synchronous with no I/O; logging activates during boot. Detached lifecycle callbacks must prove an undefined or concrete failure return rather than void.

  Breaking: check configure before accessing the manifest, inspect stop/dispose outcomes, and handle managed CLI preflight failures under `dot.preflight_failed` in `.error.data.{app,migrations,report,failure}` (exit 3). Successful JSON paths remain unchanged. See `docs/upgrade-phases.md` for phase-specific outcomes and migration steps.

  Cron oRPC adapters route canonical supervised defects through the existing failure policy before success mapping; business refusals keep their explicit responders.

  Database, mail, queue, resilience and Journal adapters retain their authored factory and lifecycle return types, including driver-specific service types.

- 3e1735b: Retry now understands failures from `@arki/failure`. A function that returns a failure, such as "card declined", is not retried: the failure is an expected outcome, so it goes back to the caller after one try. A returned failure is retried only when the backoff's `while` predicate accepts it, for example `.while(reason => isFailure(reason) && reason.code === 'db.timeout')`. When those retries run out, the caller gets the last failure as a value instead of an error, and the result type stays the function's own. `onFailure` and `onRetry` report a returned failure as `{ value }`; `onGiveUp` fires for it only after at least one retry. Circuit breakers and bulkheads are unchanged.

  Breaking: the predicate of `while` now also sees returned failures, and a backoff without `while` no longer retries them. A negative predicate such as `reason => !(reason instanceof BadInput)` says yes to failures, so name the failures you want retried instead. `Backoff.delay`'s second parameter is renamed from `error` to `reason`.

- ea092aa: `backoff.while` also takes failure definitions from `@arki/failure`: `backoff.exponential({ base: 100 }).while(ExportUnavailable)`. Thrown errors keep retrying, as without `while`. Returned failures of the listed definitions retry too, and other returned failures do not. Pass one or more definitions in one call; a second `while` narrows the first, as before. The predicate form, `.while(reason => …)`, is unchanged. `while()` with nothing throws `InvalidBackoffError`.
- 0d4a2c4: New `onThrow` option on `createResiliencePolicy`, `createRetryPolicy` and `withRetry`. It maps a thrown error that outlasts the retries, or one that is never retried, to a value, usually a failure from `@arki/failure`. The call then resolves to `T | Mapped`, typed from the mapper, so a loop has one error path instead of a failure check plus a try/catch. It wraps everything, so an open circuit, a timeout and a full bulkhead reach it too. A cancel by the caller's signal is never mapped. The mapper may rethrow what it does not recognise, so unknown errors stay bugs. Without `onThrow`, nothing changes. `RetryPolicy` and `ResiliencePolicy` now take the mapped type as `RetryPolicy<F>` and `ResiliencePolicy<F>` (default `never`), and the mapper's type is exported as `OnThrow<Mapped>`.
- 2abf113: New: `withFallback(policy, fallback)` gives a policy a last answer, typed `T | F`, and never hides a cancel. `definePresets({ name: options })` builds named composed policies, each with its own breaker. `createResiliencePolicy` now returns `components` (the retry, breaker, timeout and optional bulkhead it runs), and `Policy` gains a fallback type `F` (`never` for plain policies). `attachPolicyLogger` accepts any policy and returns a function that ends its subscriptions. New entry `@arki/resilience/dot`: the `resilience(presets)` plugin publishes `services.resilience` (`for`, `run`) and logs preset events at `debug` under `arki:resilience`. `@arki/dot` is an optional peer; `@arki/log` is a new dependency. The package moves to the `kernel` layer.
- c8ed500: `createResiliencePolicy` takes an optional `bulkhead` (`{ maxConcurrent, maxQueue }`). It wraps retry, circuit breaker and timeout, so one logical call holds one slot for all its attempts. Without it the composite keeps unlimited concurrency, as before. The README used to say the composite always included a bulkhead; it never did.
- 4b13317: Remove `withCircuitBreaker`. It built a new circuit breaker on every call, so it never remembered a failure and never opened. Build one policy with `createCircuitBreakerPolicy()` and pass it to `withResilience()` on each call.
- 1668156: Policy errors carry stable codes `ARKI_RESILIENCE_E001` to `E005` (exported as `RESILIENCE_ERROR_CODES`) and a `remediation`. `ResilienceError` is now abstract. README gains Errors and Runtime support sections.
- 119ed24: New `backoff` builder: one retry schedule shared by every package that retries. `backoff.exponential({ base, max, jitter, random })` waits `base`, then doubles up to `max`; `backoff.constant(ms)` waits the same time each retry. `.upTo(n)` allows at most `n` retries, and `.while(predicate)` retries only the errors the predicate accepts. A backoff answers one question, `delay(attempt, error)`: the wait in milliseconds, or `undefined` to stop. `random` makes jitter deterministic in tests. A bad option throws the new `InvalidBackoffError` (`ARKI_RESILIENCE_E006`).

  Retry delays now wait on a `Clock` from `@arki/clock`. Pass `clock: new MockClock()` and a retry with delays of seconds finishes instantly in tests. Retry is now its own loop instead of cockatiel's, because cockatiel's retry cannot take a clock.

  Breaking:

  - `createRetryPolicy` and `withRetry` take `{ backoff, clock }` instead of `{ maxAttempts, initialDelay, maxDelay, exponent }`. `maxAttempts: 3, initialDelay: 200, maxDelay: 5000` becomes `backoff: backoff.exponential({ base: 200, max: 5000 }).upTo(3)`.
  - `createResiliencePolicy({ retry })` takes a `Backoff`, and a new `clock` option.
  - The default retry and the presets now use plain doubling with 25% jitter instead of cockatiel's decorrelated jitter.
  - `onFailure`'s `handled` is now true only when the policy will retry that failure.

### Patch Changes

- 2bac455: `withResilience()`, `withRetry()`, `withTimeout()` and `withCircuitBreaker()` now return the policy's own promise instead of wrapping it in a second one, so every call skips an extra promise and its microtask hops. A policy that throws instead of rejecting still gives a rejected promise.
- 652eb4b: `env()`, `resilience()`, `auth()`, `journal()`, `journalProjections()`, `queue()`, `durableScheduler()` and `outboxPlugin()` keep their plugin name in the type, so their handles carry `provider: 'env' | 'resilience' | …` instead of `string` and the feature builder's handle-identity checks apply around them. The three queue plugins gain an overload: with no `name` option the type carries the default name (`'queue'`, `'durable-scheduler'`, `'outbox'`); with `name: 'jobs'` it carries `'jobs'`.
- cbefc52: Dot plugins no longer pass a hard-coded `version` (the field was removed from `@arki/dot`).
- 7922fb5: Docs standard: README reordered with install, quick start, limits and failure behaviour; `AGENTS.md`, `llms.txt` and `docs/agent-guide.md` added; the seven error codes carry `@fix` and `@verify` tags; doc examples compile under `test:docs`. Only JSDoc comments changed in `src/`.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- Updated dependencies [dcf2cef]
- Updated dependencies [afecc7a]
- Updated dependencies [5bc6390]
- Updated dependencies [899d0a9]
- Updated dependencies [ce8d707]
- Updated dependencies [92b38ed]
- Updated dependencies [9a4babb]
- Updated dependencies [80a4aa5]
- Updated dependencies [232d3e8]
- Updated dependencies [69d054f]
- Updated dependencies [cbefc52]
- Updated dependencies [7b19289]
- Updated dependencies [923124f]
- Updated dependencies [5721742]
- Updated dependencies [01400a0]
- Updated dependencies [0ab11d8]
- Updated dependencies [a531063]
- Updated dependencies [9b35520]
- Updated dependencies [5721742]
- Updated dependencies [232d3e8]
- Updated dependencies [9192d0e]
- Updated dependencies [3230f02]
- Updated dependencies [232d3e8]
- Updated dependencies [232d3e8]
- Updated dependencies [932c9e4]
- Updated dependencies [232d3e8]
- Updated dependencies [cc656e3]
- Updated dependencies [ff8e384]
- Updated dependencies [ce8d707]
- Updated dependencies [847f025]
- Updated dependencies [232d3e8]
- Updated dependencies [d9864f3]
- Updated dependencies [742f4c3]
- Updated dependencies [115aa87]
- Updated dependencies [6e4d7da]
- Updated dependencies [8b3cc80]
  - @arki/dot@0.7.0

## 0.1.0

### Minor Changes

- The package now owns its public types and errors. `Policy` replaces cockatiel's `IPolicy`: `execute(fn, signal?)` gives `fn` a `{ signal, attempt }` context, and every policy exposes `onSuccess` and `onFailure`, with `onRetry`, `onGiveUp`, `onBreak`, `onHalfOpen`, `onReset`, `onTimeout` and `onReject` on the policies that have them. `CircuitOpenError`, `TimeoutError` and `BulkheadRejectedError` are this package's own classes with the engine error as `cause`, and a call cancelled by the caller's signal now rejects with `CancelledError` instead of being reported as a timeout. The `wrap` and `noop` exports are this package's own too. No cockatiel name appears in the published types anymore, so a cockatiel major release is no longer a breaking change here. The engine is upgraded to cockatiel 4.

  Breaking: import `Policy` instead of `IPolicy`. Errors thrown by the policies are no longer `instanceof` cockatiel's classes.

## 0.0.3

### Patch Changes

- Deprecate `withCircuitBreaker`. It builds a new circuit breaker on every call, so the breaker never remembers a failure and never opens. Build one policy with `createCircuitBreakerPolicy()` and pass it to `withResilience()` on each call. The export stays until the next breaking release.
- Fix the README: the timeout option is `timeoutMs`, not `durationMs`, and the circuit-breaker options are `halfOpenAfter` and `consecutiveFailures`. The quick-wrapper example no longer imports `withCircuitBreaker`, and a reused-breaker example is added.
- Add the first tests for the execution helpers.

## 0.0.2

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.

## 0.0.1

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  Part of **Wave 1**, the ARKI foundation: zero-dependency utilities and runtime primitives shipped together because every downstream wave (DOT kernel, infrastructure adapters) consumes them. Wave 1 packages: `assert`, `clock`, `contracts`, `date`, `env`, `log`, `resilience`, `slugify`, `string`, `ts`.

  **Why 0.0.x, not 1.0.0**: ARKI is on an experimental track. The 0.0.x prefix is an honest signal — APIs may change without semver discipline until the kernel is field-tested. The release scorecard (metadata, privacy, dependencies, build-output, packlist, docs, fixtures, DOT gates, agent-native gates) is satisfied at this version; the gate certifies _the artifact_, not _API stability_. Stability is earned through reuse, not declared at first publication.

  Wave 2 (`@arki/dot`) and Wave 3 (`@arki/db`, `@arki/kv`, `@arki/event-sourcing`) publish in subsequent releases once their inter-package transitive resolution against the public npm registry is verified.
