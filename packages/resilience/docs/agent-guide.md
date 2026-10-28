# @arki/resilience agent guide

Read `llms.txt` first for the map. When this guide and `AGENTS.md` disagree, `AGENTS.md` wins.

## The model

1. A `Policy` runs your function and applies retry, timeout, circuit breaker or bulkhead around it.
2. Your function can return a value, return a failure from `@arki/failure`, or throw.
3. A returned failure is an answer. It is retried only when `.while(Definition)` names it.
4. A callback throw is retried by default; explicit fallback receives it unchanged before final UnexpectedDefect normalization.
5. `withFallback` and `onThrow` turn what is left into a value. They make a `Policy<F>` and go outermost.

## Task map

### Call a third-party API safely

1. Use `externalApiPolicy` with `withResilience(fn, externalApiPolicy)`.
2. Check returned canonical failures with their definitions or `isFailure`; use RESILIENCE_FAILURES for RPC admission.

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
- Raw callback throws reach retry and explicit fallback; an unmapped final throw returns `UnexpectedDefect`.
- A cancel is never retried and never mapped.

## Observation

Subscribe to policy events for diagnostics. Listeners run synchronously; their thrown errors and rejected promises are supervised, and pending promises are never awaited. Observer failure cannot retry completed work or prevent timeout settlement. Synchronous signal cancellation keeps its existing semantics. Put required effects in the operation callback.

Default logger and Dot records contain canonical failure codes, not callback messages or returned payloads. Unknown throws and observer defects use `failure.unexpected_defect`. User listeners still receive original events. Reporter failure is nonauthoritative. Owned execution emits OpenTelemetry spans by default.

Observer-defect diagnostics are coalesced while a diagnostic reporter is pending. Reporting resumes after settlement; operation execution never waits for that reporter.

### Trace policy execution

Configure OpenTelemetry once at the application boundary. The `@arki/resilience` tracer emits `resilience.execute` around each owned public call. Retry emits `resilience.attempt` and `resilience.wait`; engine execution emits `resilience.circuit_breaker`, `resilience.timeout` and `resilience.bulkhead`. Composition keeps one logical execution span. Attach custom spans in the callback with the application's OTel API; active context follows the current engine/attempt.

Only canonical failure codes, attempt numbers and selected delay milliseconds are recorded. Telemetry cannot replace results, repeat work or wait for a pending reporter. Timeout spans describe policy settlement, not termination of abandoned foreign effects. Foreign policies retain their own instrumentation. The meter emits `resilience.operations` and `resilience.duration` (seconds) per settled boundary with bounded boundary/outcome labels. `resilience.circuit.transitions` counts destination states; `resilience.circuit.state_changed` records the same state on the active span. No instance IDs, callback data or failure-code metric labels are collected. Durations overlap in composition and stop at policy settlement. Missing clock samples omit durations; faulty pending metric or breaker-event reporters may coalesce measurements without blocking execution. Static builders need no spans or metrics.

## Errors

| Code | Definition | What to do |
| --- | --- | --- |
| `resilience.circuit_open` | `CircuitOpen` | Wait for half-open or handle the returned refusal |
| `resilience.timeout` | `Timeout` | Stop work through its signal; reconcile before retry |
| `resilience.cancelled` | `Cancelled` | Stop this execution |
| `resilience.bulkhead_rejected` | `BulkheadRejected` | Shed load or explicitly retry later |
| `failure.unexpected_defect` | `UnexpectedDefect` | Inspect the private original cause |
| `ARKI_RESILIENCE_E006` | `InvalidBackoffError` | Fix static backoff options |
| `ARKI_RESILIENCE_PLUGIN_E001` | Dot unit error | Use a declared preset |

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

Use `RETRY_FAILURES` for retry-only callers and `RESILIENCE_FAILURES` for composed policies/presets. `wrap` infers heterogeneous unions. `Policy<F, E>` includes common cancellation/defect outcomes and keeps fallback values separate. Returned engine refusals bypass `onThrow`/`withFallback` and never open a breaker; select them explicitly with `.while(...)` only when replay is safe. Actual clock waits preserve their original failures. Timeout captures cancellation origin before observers; retry-only callbacks remain cooperative.
Custom Clock/Backoff implementations are execution protocols. Invalid delay/outcome values return `UnexpectedDefect` before another attempt; thrown/rejected providers remain supervised. Preserve the original canonical sleep failure object. Timing is observation only: unavailable or invalid samples omit duration-bearing events, never results or retry/give-up events.

Each measurement retains the same clock function and receiver across awaited work. Timing samples are schema-validated before arithmetic; switching global clock objects cannot mix origins.
