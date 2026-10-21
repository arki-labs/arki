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

Retry delay cancellation now returns `SleepCancelled` from `@arki/clock`; a clock provider fault returns `UnexpectedDefect`. These exact `SleepFailure` outcomes propagate through `wrap`, `withFallback`, `withRetry`, `withResilience` and Dot presets without retrying or invoking a throw fallback. Check returned failures before using successful values. Other policy engine rejections retain their existing bridge during the A-33 migration; cancellation during an in-flight timeout is still `CancelledError`. `Policy<F, E>` keeps fallback output and owned outcomes separate, so policies without retry acquire no sleep failures.
