# @arki/resilience agent guide

Read `llms.txt` first for the map. When this guide and `AGENTS.md` disagree, `AGENTS.md` wins.

## The model

1. A `Policy` runs your function and applies retry, timeout, circuit breaker or bulkhead around it.
2. Your function can return a value, return a failure from `@arki/failure`, or throw.
3. A returned failure is an answer. It is retried only when `.while(Definition)` names it.
4. A thrown error is retried by the backoff, then thrown again unchanged.
5. `withFallback` and `onThrow` turn what is left into a value. They make a `Policy<F>` and go outermost.

## Task map

### Call a third-party API safely

1. Use `externalApiPolicy` with `withResilience(fn, externalApiPolicy)`.
2. Catch `ResilienceError` by `code` where you need to react.

```ts
import { externalApiPolicy, withResilience } from '@arki/resilience';

declare function callBilling(): Promise<string>;

const answer = await withResilience(() => callBilling(), externalApiPolicy);
```

### Retry only the failures you name

1. Return a failure from the function instead of throwing for expected outcomes.
2. Build the schedule: `backoff.exponential({ base: 200 }).upTo(3).while(DbTimeout)`.
3. Check `isFailure(result)` after the call.

### Get one error path

1. Pass `onThrow: cause => MyFailure({ cause })` to `createResiliencePolicy`.
2. Check `isFailure` on the result. There is no `try/catch`.

### Share one breaker per downstream

1. Call `definePresets({ name: options })` once.
2. Use `presets.name.execute(fn)`. Each name has its own breaker.

### Test a retry without waiting

1. Pass `clock: new MockClock()` from `@arki/clock`.
2. Start the call, then `await clock.advanceAsync(ms)`.

## Rules that bite

- No `.upTo(n)` means forever.
- A second `.while()` narrows the first. Name all definitions in one call.
- A negative predicate such as `reason => !(reason instanceof BadInput)` accepts failures too. Name the failures you want.
- `wrap` rejects a policy that has a fallback or `onThrow`.
- `RetriesExhaustedError` is exported, but the retry policy rethrows the last error as it was.
- A cancel is never retried and never mapped.

## Observation

Subscribe to policy events for diagnostics. Listeners run synchronously; their thrown errors and rejected promises are supervised, and pending promises are never awaited. Observer failure cannot retry completed work or prevent timeout settlement. Synchronous signal cancellation keeps its existing semantics. Put required effects in the operation callback.

Default logger and Dot records contain canonical failure codes, not callback messages or returned payloads. Unknown throws and observer defects use `failure.unexpected_defect`. User listeners still receive original events. Reporter failure is nonauthoritative. OpenTelemetry spans and broader engine failure migration remain separate work.

Observer-defect diagnostics are coalesced while a diagnostic reporter is pending. Reporting resumes after settlement; operation execution never waits for that reporter.

## Errors

| Code                          | Error                   | What to do                                            |
| ----------------------------- | ----------------------- | ----------------------------------------------------- |
| `ARKI_RESILIENCE_E001`        | `CircuitOpenError`      | Wait for half-open, or serve a fallback               |
| `ARKI_RESILIENCE_E002`        | `TimeoutError`          | Raise `timeoutMs`, or make the call faster            |
| `ARKI_RESILIENCE_E003`        | `CancelledError`        | Your own signal aborted. Do not count it as an outage |
| `ARKI_RESILIENCE_E004`        | `BulkheadRejectedError` | Retry later, raise the limits, or shed load           |
| `ARKI_RESILIENCE_E005`        | `RetriesExhaustedError` | Read `lastError`. Exported for hosts                  |
| `ARKI_RESILIENCE_E006`        | `InvalidBackoffError`   | Pass finite, non-negative numbers                     |
| `ARKI_RESILIENCE_PLUGIN_E001` | Dot unit error          | Use a name from `definePresets`                       |

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
```

In an app that uses the `@arki/resilience/dot` unit, check the wiring. `dot explain` reads the manifest and starts nothing. `dot doctor` boots the app and disposes it, so it runs the unit's setup.

```sh
dot explain --json | jq '.data.plugins'
dot doctor --json | jq '.data'
```

## Typed retry waits

Retry execution returns `Cancelled` (`resilience.cancelled`) before an aborted attempt or when failed work/observers observe caller cancellation. Completed successes and returned failures retain identity. Cancellation during an actual clock wait still returns the original `SleepCancelled`; a returned clock defect remains `UnexpectedDefect`. The original definitions in `RETRY_FAILURES` infer `RetryFailure`, propagated through `wrap`, `withFallback`, `withRetry`, `withResilience` and Dot presets without a throw fallback. Admit the full tuple on RPC routes that execute retry policies. `RETRY_WAIT_FAILURES`/`RetryWaitFailure` describe clock waits only. Other engine-only policies retain their existing thrown bridge during A-33 migration; cancellation reaching a retry loop becomes `Cancelled`. `Policy<F, E>` keeps fallback output and owned outcomes separate, so policies without retry acquire no retry failures. Pending callbacks remain cooperative: retry does not race or forcibly stop a callback that ignores its signal. Event callback throws and rejecting custom clocks remain part of the outstanding defect-boundary migration.
