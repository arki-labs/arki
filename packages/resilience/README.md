# @arki/resilience

Resilience primitives for ARKI — retry, circuit breaker, timeout, bulkhead, and curated presets. Circuit breaker, timeout and bulkhead are built on the [`cockatiel`](https://github.com/connor4312/cockatiel) engine; retry is its own loop, so a `Clock` can drive its delay. It comes with ergonomic factories, ready-made policies for common workloads, and its own public types and errors, so a new cockatiel release never changes this package's API.

## Install

```sh
bun add @arki/resilience
# or: npm install @arki/resilience
```

`@arki/clock`, `@arki/failure` and `@arki/log` come with it. `@arki/dot` is an optional peer, used only by `@arki/resilience/dot`.

## Quick start

Retry plus a timeout, for the oven API that sulks on Mondays.

```ts
import { externalApiPolicy, withResilience } from '@arki/resilience';

const data = await withResilience(
  () => fetch('https://oven.example/temperature').then(r => r.json()),
  externalApiPolicy,
);
```

A thrown error is retried by the schedule and then thrown again unchanged. A returned failure from `@arki/failure` is an answer, not a fault: it is not retried unless `.while(Definition)` names it. See [Failure behaviour](#failure-behaviour).

## When not to use this

- The call is local and cheap, in a hot loop. A policy adds microseconds. Wrap the loop, not each iteration. See [When does the overhead matter?](#when-does-the-overhead-matter).
- You need retries that survive a restart or run on a schedule. Use `@arki/queue` for jobs and `@arki/journal` for effects. They share the same `backoff` values.
- You need rate limiting across processes. A bulkhead limits concurrency inside one process only.
- You need to hide a bug. A retry repeats a bug; it does not fix it. Return a failure for expected outcomes and let bugs throw.

## Runtime support

Node, Bun, Deno, modern browsers and React Native (Hermes). Pure ESM. The package uses only `setTimeout`, `AbortSignal` and `Promise` at call time, with no `node:*` imports and no `process` or `Buffer`. `bun run test:runtimes` runs a smoke test of the built package on every runtime; the Hermes leg needs a `hermes` binary (`HERMES_BIN`) and prints `INCOMPLETE` when it is missing.

## Public imports

| Import                 | What it gives you                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `@arki/resilience`     | Policies, `backoff`, presets, `withFallback`, `wrap`, `attachPolicyLogger`, typed errors and their codes |
| `@arki/resilience/dot` | `resilience(presets)` unit for `@arki/dot`, `ResilienceService`, `RESILIENCE_PLUGIN_ERROR_CODES`         |

The full list of exports is in [API](#api).

## Failure behaviour

Observation defects are supervised separately: event listener errors never replace the operation outcome. Required work belongs in the operation callback, not an observer.

A call resolves to the callback's value, its returned canonical failure, or an exact owned policy failure. Check `isFailure(result)`.

- Callback throws retry by default. After retries and explicit `onThrow`/`withFallback`, an unmapped throw returns `UnexpectedDefect` with the original cause kept private.
- Returned failures are final unless `.while(Definition)` or a predicate accepts them. This includes `CircuitOpen`, `Timeout` and `BulkheadRejected`. They never open an outer breaker and never enter a throw fallback.
- Every owned execution can return `Cancelled` or `UnexpectedDefect`. `RETRY_FAILURES`, `CIRCUIT_FAILURES`, `TIMEOUT_FAILURES` and `BULKHEAD_FAILURES` contain the original definitions for each policy. `RESILIENCE_FAILURES` admits composed policies and presets; `wrap` infers the exact union of its inputs.
- `Cancelled` means the owning signal stopped execution. A real retry wait preserves its original `SleepCancelled` or `UnexpectedDefect`.
- Static backoff misuse still throws `InvalidBackoffError` (`ARKI_RESILIENCE_E006`) where the builder is called.

## Limits

- **Retries are bounded only if you bound them.** A backoff without `.upTo(n)` retries forever. `upTo(0)` never retries.
- **Wait cap.** A single wait is at most `MAX_TIMER_MS` from `@arki/clock`, about 24.8 days. `backoff.exponential({ base, max })` caps the wait at `max`.
- **Jitter** is between 0 and 1. Any other value throws `InvalidBackoffError` (`ARKI_RESILIENCE_E006`).
- **Policies with a fallback or `onThrow` cannot go inside `wrap`.** It is a compile error, because inside a retry they would hide the errors the retry needs. Put them outermost.
- **A bulkhead limits one process.** One logical call holds one slot.
- **A breaker is per policy.** Two apps that share a `presets` object share its breakers. Build the breaker once and reuse it.
- **Retry delays use a `Clock`.** A fake clock only moves time when you advance it.

Boundary example: `.upTo(2)` means two retries, so the function is called three times in all.

```ts run
import { MockClock } from '@arki/clock';
import { UnexpectedDefect } from '@arki/failure';
import { backoff, createRetryPolicy } from '@arki/resilience';

let calls = 0;
const clock = new MockClock();
const policy = createRetryPolicy({ backoff: backoff.constant(10).upTo(2), clock });

const outcome = policy.execute(() => {
  calls++;
  throw new Error('down');
});
await clock.advanceAsync(100);
if (!UnexpectedDefect.is(await outcome)) throw new Error('Expected the final callback defect');
if (calls !== 3) throw new Error(`upTo(2) must call the function 3 times, got ${calls}`);
```

## Documentation

`@arki/resilience` is framework-agnostic and works on its own. When you compose it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot) application framework, see `packages/dot/docs/` for unit authoring, lifecycle, and diagnostics.

- [Agent guide](docs/agent-guide.md): the model, the task map and the rules.
- [llms.txt](llms.txt): the short index for agents.
- [CHANGELOG](CHANGELOG.md): what changed in each version.

## Support

Report a bug or ask a question in the [Arki issue tracker](https://github.com/arki-labs/arki/issues). Include the policy options and the error `code`.

## Guide

### Pre-configured presets

```ts
import { externalApiPolicy, withResilience } from '@arki/resilience';

const data = await withResilience(
  () => fetch('https://oven.example/temperature').then(r => r.json()),
  externalApiPolicy,
);
```

Three curated presets ship out of the box:

- `externalApiPolicy` — retry + timeout tuned for third-party HTTP calls.
- `databasePolicy` — short timeout + retry for transient connection errors.
- `backgroundJobPolicy` — longer timeout + aggressive retry for long-running work.

### Fallback

```ts
import { createResiliencePolicy, withFallback } from '@arki/resilience';

declare function fetchQuote(): Promise<{ price: number }>;

const quotes = withFallback(createResiliencePolicy(), () => null);
const quote = await quotes.execute(() => fetchQuote()); // Quote | null
```

`withFallback(policy, fallback)` returns a policy whose call resolves to `T | F | OwnedFailure`: the function's result, a policy refusal, or what `fallback(error)` returns after callback throws exhaust retry. The type comes from the fallback, so `null` and `{ stale: true }` show up in the result type.

- A fallback never handles a returned failure, including cancellation, circuit refusal, timeout or capacity refusal.
- To fall back on some errors only, rethrow the others: `(error) => { if (!(error instanceof TypeError)) throw error; return cached; }`.
- Put it outermost. `wrap` does not accept a policy with a fallback (a compile error), because inside a retry it would hide the errors the retry needs.

### Throws as failures: `onThrow`

```ts
import { defineFailure, isFailure } from '@arki/failure';
import { backoff, createResiliencePolicy } from '@arki/resilience';

const ExportUnavailable = defineFailure('export.unavailable', { status: 503 });
declare function send(batch: string): Promise<string>;
const batches = ['a', 'b'];

export async function pushAll() {
  const push = createResiliencePolicy({
    retry: backoff.exponential({ base: 500 }).upTo(3).while(ExportUnavailable),
    onThrow: cause => ExportUnavailable({ cause }), // exhausted callback throws, before public normalization
  });

  const delivered: string[] = [];
  for (const batch of batches) {
    const sent = await push.execute(() => send(batch)); // Sent | the failures send returns | ExportUnavailable
    if (isFailure(sent)) return { delivered, stoppedBy: sent }; // one error path, no try/catch
    delivered.push(sent);
  }
  return { delivered, stoppedBy: undefined };
}
```

`onThrow(error)` turns a thrown error that reaches the caller into a value, usually a failure from [`@arki/failure`](../failure). The call then resolves to `T | Mapped`, typed from the mapper. Without `onThrow`, final callback throws return `UnexpectedDefect`. It is the same word as `attempt(run, onThrow)` in `@arki/failure`.

- It sees only what the retries gave up on, or what they never retry. A returned failure is the answer as before.
- It is outermost. Engine refusals are already returned values and bypass it.
- A cancel by the caller's signal is never mapped; the retry loop returns `Cancelled`.
- Rethrow what you do not recognise, so the public boundary returns an `UnexpectedDefect`: `cause => { if (!isNetworkError(cause)) throw cause; return Unavailable({ cause }); }`.
- `createRetryPolicy` and `withRetry` take it too. A policy with `onThrow` is a `Policy<Mapped>`, so like a fallback it cannot go inside `wrap`.

### Named presets

```ts
import { backoff, definePresets } from '@arki/resilience';

declare function callCarrier(): Promise<string>;

const presets = definePresets({
  carrier: { retry: backoff.exponential({ base: 200, max: 5000 }).upTo(3), timeout: { timeoutMs: 10_000 } },
  search: { bulkhead: { maxConcurrent: 20 } },
});

await presets.carrier.execute(() => callCarrier());
```

Each name gets its own composed policy, so its own breaker. A typo in a name or an option does not compile. A `presets` object shared by two apps shares its breakers too (same downstream, same health). `createResiliencePolicy` and every preset expose `components` (`retry`, `circuitBreaker`, `timeout`, and `bulkhead` when configured): the exact policies the composed one runs, so you can listen to their events.

### Building policies

```ts
import { backoff, createResiliencePolicy, withResilience } from '@arki/resilience';

declare function doWork(signal: AbortSignal): Promise<string>;

const policy = createResiliencePolicy({
  retry: backoff.exponential({ base: 200, max: 5_000, jitter: 0.25 }).upTo(3),
  timeout: { timeoutMs: 5_000 },
  circuitBreaker: { halfOpenAfter: 30_000, consecutiveFailures: 5 },
});

const result = await withResilience(({ signal }) => doWork(signal), policy);
```

Every policy has the same shape, the `Policy` type:

```ts
import type { PolicyContext } from '@arki/resilience';
import { createResiliencePolicy } from '@arki/resilience';

declare function fetchPage(signal: AbortSignal): Promise<string>;
declare const parentSignal: AbortSignal;

const policy = createResiliencePolicy();

await policy.execute(({ signal, attempt }: PolicyContext) => fetchPage(signal), parentSignal);
```

`signal` aborts when the caller's signal aborts, when a timeout policy reaches its deadline, and after a timed call returns. `attempt` is 0 for the first call and 1 for the first retry; it is always 0 under a policy without retry.

### Retry schedules: `backoff`

A `Backoff` says how long to wait before each retry, and when to stop. The same value drives `createRetryPolicy`, `createResiliencePolicy`, `@arki/queue` job retries and `@arki/journal` effect retries.

```ts
import { defineFailure } from '@arki/failure';
import { backoff } from '@arki/resilience';

declare class NetworkError extends Error {}

const DbTimeout = defineFailure('db.timeout', { status: 503 });

backoff
  .exponential({ base: 1_000, max: 30_000, jitter: 0.25 }) // 1 s, 2 s, 4 s ... capped at 30 s, each varied by up to 25%
  .upTo(5) // at most 5 retries (6 calls in all)
  .while(reason => reason instanceof NetworkError); // retry network errors only

backoff.constant(60_000).upTo(1); // one retry, a minute later

backoff.constant(100).upTo(3).while(DbTimeout); // retry thrown errors and this one returned failure
```

- `backoff.exponential({ base, max?, jitter?, random? })` waits `base * 2^(attempt - 1)`, capped at `max` (default and upper bound: `MAX_TIMER_MS` from `@arki/clock`, about 24.8 days). `jitter` (0 to 1, default 0) picks each wait at random within ±`jitter` of the exact value. `random` (default `Math.random`) is the randomness source; pass a fixed function to make jittered waits deterministic in tests.
- `backoff.constant(ms)` waits `ms` before every retry.
- `.upTo(retries)` limits the retries; `upTo(0)` never retries. Without it a backoff retries forever.
- `.while(predicate)` retries only the reasons for which `predicate(reason)` is true. A reason is a thrown error or a returned failure (see below).
- `.while(...definitions)` takes one or more `@arki/failure` definitions. Thrown errors keep retrying as without `while`, returned failures of those definitions retry too, and other returned failures do not. Name them all in one call: a second `while` narrows the first.
- `.delay(attempt, reason)` is the one question a backoff answers: the wait in ms before retry `attempt` (1 for the first retry), or `undefined` for stop. `.maxRetries` is the `upTo` limit, or `Infinity`.

Backoffs are immutable: `upTo` and `while` return a new one, and each only narrows. A bad option throws `InvalidBackoffError` (`ARKI_RESILIENCE_E006`) where the backoff is built.

### Returned failures

A function may return a failure from [`@arki/failure`](../failure) instead of throwing, for an expected outcome such as "card declined". Retrying it would only repeat it, so retry does not: after one try the failure goes back to the caller as the result.

- A backoff without `while` retries every thrown error and no returned failure.
- A returned failure is retried only when a `while` accepts it. The first `while` decides alone for failures, so a negative predicate such as `reason => !(reason instanceof BadInput)` accepts failures too; name the failures you want instead, as in `.while(DbTimeout)`.
- When the retries run out on a returned failure, the caller gets the last failure as a value. Nothing is thrown, and the result type is still the function's own, so the caller still checks `isFailure`.
- `onFailure` and `onRetry` report a returned failure as `{ value }`. `onGiveUp` fires only for a failure that was retried at least once.
- Circuit breakers and bulkheads see a returned failure as a normal result: it never opens a breaker.

### Testing retries with a clock

Retry delays wait on a `Clock` from `@arki/clock`. Pass a `MockClock` and a retry with delays of seconds finishes at once:

```ts
import { MockClock } from '@arki/clock';
import { UnexpectedDefect } from '@arki/failure';
import { backoff, createRetryPolicy } from '@arki/resilience';

declare function callFlakyApi(): Promise<string>;

const clock = new MockClock();
const policy = createRetryPolicy({ backoff: backoff.exponential({ base: 1_000 }).upTo(3), clock });

const result = policy.execute(callFlakyApi);
await clock.advanceAsync(10_000); // runs the 1 s, 2 s and 4 s delays instantly
await result;
```

`createResiliencePolicy` takes `clock` too; it drives the retry delay.

### Quick wrappers

For one-off calls without a long-lived policy:

```ts
import { backoff, withRetry, withTimeout } from '@arki/resilience';

declare function sendEmail(to: string): Promise<void>;
declare function slowOperation(): Promise<void>;

await withRetry(() => sendEmail('support@example.com'), { backoff: backoff.exponential({ base: 200 }).upTo(3) });
await withTimeout(() => slowOperation(), { timeoutMs: 1_000 });
```

A circuit breaker must remember past failures, so build it once and reuse it:

```ts
import { createCircuitBreakerPolicy, withResilience } from '@arki/resilience';

declare function callDownstream(): Promise<string>;
const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 2 });

await withResilience(() => callDownstream(), breaker); // opens after 2 failures in a row
```

### Handle a circuit refusal

```ts
import { CircuitOpen, createResiliencePolicy, withResilience } from '@arki/resilience';

declare function callDownstream(): Promise<string>;
const policy = createResiliencePolicy();
export async function callWithCache(cachedAnswer: string) {
  const result = await withResilience(() => callDownstream(), policy);
  return CircuitOpen.is(result) ? cachedAnswer : result;
}
```

### Observability

```ts
import { attachPolicyLogger, createResiliencePolicy } from '@arki/resilience';

const policy = createResiliencePolicy();
const logger = {
  info: (message: string) => message,
  warn: (message: string) => message,
  error: (message: string) => message,
};
const detach = attachPolicyLogger(policy, logger, 'billing');
```

`logger` needs `info`, `warn` and `error` methods. The helper subscribes to the events a policy exposes: every policy has `onSuccess` and `onFailure`; a retry policy adds `onRetry` and `onGiveUp`; a circuit breaker adds `onBreak`, `onHalfOpen` and `onReset`; a timeout policy adds `onTimeout`; a bulkhead adds `onReject`. Each event method takes a listener and returns a subscription with `dispose()`. A composed policy (`wrap`, `createResiliencePolicy`, the presets) exposes only `onSuccess` and `onFailure` itself; `createResiliencePolicy` and the presets also give you `components`, whose events are the full set. `attachPolicyLogger` returns a function that ends all its subscriptions.

Event listeners are observation only. They run synchronously, so a listener can still request cancellation through an owned `AbortController`. A listener throw or rejected promise never triggers another operation, opens the breaker, replaces a result, runs a fallback or prevents timeout settlement. Pending observation is never awaited. Put required persistence and other authoritative work in the operation callback.

`attachPolicyLogger` and the Dot adapter log canonical failure codes instead of callback error messages or returned payloads. An unknown throw is labelled `failure.unexpected_defect`. Observer defects emit the same safe code through `arki:resilience`; a broken diagnostic reporter cannot affect execution. Explicit user listeners still receive the original event and own their logging policy. Owned execution emits OpenTelemetry spans by default; see the coverage below.

Observer-defect diagnostics are coalesced while a diagnostic reporter is pending. Reporting resumes after settlement; operation execution never waits for that reporter.

#### Default telemetry

The `@arki/resilience` tracer inherits the active caller context. Configure the SDK and exporters in the application; standalone use and Dot use the same instrumentation. No SDK is installed by this library.

| Span | Boundary |
| --- | --- |
| `resilience.execute` | One public owned policy call, including fallback and pre-aborted refusal |
| `resilience.attempt` | Each retry attempt, including its inner policies |
| `resilience.wait` | The selected retry delay, including cancellation or clock refusal |
| `resilience.circuit_breaker` | Breaker admission and execution, including open-circuit refusal |
| `resilience.timeout` | Deadline ownership until the policy settles |
| `resilience.bulkhead` | Capacity admission, queue wait and execution until settlement |

Composition bypasses nested public wrappers: one logical call has one `resilience.execute` span, while distinct inner policies retain their spans. `noop` needs only the logical span; static builders and backoff calculations need no separate spans. Explicit foreign policies passed to `withResilience` retain their own instrumentation; this coverage is for Arki-owned policies.

Only canonical `failure.code`, zero-based attempt numbers and selected delay milliseconds are collected. Raw callback throws use `failure.unexpected_defect` on the failed inner span; a successful fallback leaves the outer call successful. No exception messages, causes, payloads, IDs or preset names are recorded. Custom child spans inherit the current policy context, including across awaits with an application context manager.

Rejected, pending, repeated and throwing telemetry callbacks cannot replace outcomes or repeat execution. Synchronous cancellation by instrumentation is still respected. A timeout span ends when the policy settles, not when uncooperative foreign work eventually stops. The `@arki/resilience` meter emits these instruments at the same owned boundaries:

| Instrument | Unit | Dimensions |
| --- | --- | --- |
| `resilience.operations` | `{operation}` | `resilience.boundary`, `resilience.outcome` |
| `resilience.duration` | `s` | `resilience.boundary`, `resilience.outcome` |
| `resilience.circuit.transitions` | `{transition}` | `resilience.circuit.state` |

Operations count settlements, including refusals, once per boundary. Outcomes are `success`, `failure`, `throw` or `unclassified` if classification itself is unavailable. Opaque values that cannot prove a canonical failure brand remain successful values. Durations measure dispatch to settlement using the runtime's performance clock (wall-clock fallback when absent); unavailable, nonfinite or backwards samples omit duration only. Nested boundary durations overlap; do not sum them as logical request time. Failure codes and user identifiers are never metric dimensions.

Breaker transitions add `resilience.circuit.state_changed` to the active span and increment the transition counter. Destination states are `open`, `half_open`, `closed` and `isolated` (reserved for the engine's manual isolation state). Opening refusals do not create additional transitions. These are transition counts, not a current-state gauge. There is no policy registry, retained instance or extra transition span.

Metrics remain independent of trace sampling. An application can install its meter provider after constructing policies. Faulty asynchronous metric or breaker-event reporters may coalesce measurements while pending; operations they start do not recursively measure themselves. Execution never waits for telemetry. Existing policy events and safe logger/Dot diagnostics remain available.


### Dot unit

```ts
import { defineApp } from '@arki/dot';
import { orThrow } from '@arki/failure';
import { backoff, definePresets } from '@arki/resilience';
import { resilience } from '@arki/resilience/dot';

declare function callCarrier(): Promise<string>;

const presets = definePresets({
  carrier: { retry: backoff.exponential({ base: 200, max: 5000 }).upTo(3), timeout: { timeoutMs: 10_000 } },
});

const app = orThrow(await defineApp('my-app').infra(resilience(presets)).boot());
await app.services.resilience.run('carrier', () => callCarrier());
```

`services.resilience` has `for(name)` (the preset itself) and `run(name, fn, signal?)`. Names are typed from `presets`. While the app runs, the unit logs the events of every preset component (retry, give up, circuit open / half-open / closed, timeout, bulkhead reject) at `debug` in the `arki:resilience` category. Turn them on with `DEBUG=arki:resilience`. `dispose` ends the subscriptions. For other levels or per-call records, use `attachPolicyLogger`. `@arki/dot` is an optional peer dependency.

## API

- `createResiliencePolicy(options)` — compose retry + circuit breaker + timeout, plus an optional `bulkhead` that wraps them all (one logical call holds one slot), and an optional `onThrow` that maps what is still thrown to a value.
- `backoff.exponential`, `backoff.constant` — retry schedules (`Backoff`), shared with `@arki/queue` and `@arki/journal`.
- `createRetryPolicy({ backoff?, clock?, onThrow? })`, `createCircuitBreakerPolicy`, `createTimeoutPolicy`, `createBulkheadPolicy` — individual primitives.
- `externalApiPolicy`, `databasePolicy`, `backgroundJobPolicy` — pre-tuned presets.
- `withResilience`, `withRetry`, `withTimeout` — execution helpers.
- `withFallback(policy, fallback)` — a last answer when a policy gives up; `definePresets({ name: options })` — named composed policies.
- `@arki/resilience/dot`: `resilience(presets)` unit, `ResilienceService`, `RESILIENCE_PLUGIN_ERROR_CODES`.
- `attachPolicyLogger(policy, logger)` — observability hooks.
- `wrap(...policies)` — compose policies from the outside in; `noop` — a policy that only runs the function.
- `CircuitOpen`, `Timeout`, `Cancelled`, `BulkheadRejected` — canonical definitions with `.is`. `InvalidBackoffError` extends `ResilienceError` for static misuse only.
- Types: `Backoff`, `ExponentialBackoffOptions`, `Policy`, `PolicyContext`, `PolicyCallback`, `RetryPolicy`, `CircuitBreakerPolicy`, `TimeoutPolicy`, `BulkheadPolicy`, `PolicyEvent`, `Subscription` and the event payloads `SuccessEvent`, `FailureEvent`, `FailureReason`, `RetryEvent`, `BreakEvent`, `Presets`, `ResiliencePolicy`, `ResilienceComponents`, `OnThrow`. `Policy<F>`, `RetryPolicy<F>` and `ResiliencePolicy<F>` carry the type `F` a fallback or `onThrow` may answer (`never` for a plain policy).

## Errors

Operational outcomes use canonical dotted codes: `resilience.circuit_open`, `resilience.timeout`, `resilience.cancelled`, `resilience.bulkhead_rejected`, the original clock wait outcomes and `failure.unexpected_defect`. Match with each definition's `.is`; private causes are not serialized.

Static backoff misuse retains `ARKI_RESILIENCE_E006`; unknown Dot preset misuse retains `ARKI_RESILIENCE_PLUGIN_E001`.

## When does the overhead matter?

Almost never. A policy adds a few microseconds to a call: the benchmarks below measure that on a call that returns at once, and on a call that waits 1 ms. The calls these policies guard, to a network service, an AI provider or a database, take milliseconds to seconds, so the policy costs well under one percent of the call it protects. The one case to think about is a hot loop over an in-memory function, where the policy can cost more than the work. There, wrap the loop, not each iteration.

<!-- bench:start -->

## Benchmarks

The cost of wrapping a call that succeeds, with `@arki/resilience`, against cockatiel (which it wraps), p-retry and opossum, and a bare `await fn()` for scale. These are the three libraries most often reached for to retry, break a circuit or time out in Node.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Retry wrapper

| Library                                                    | Time / op | vs fastest |
| ---------------------------------------------------------- | --------: | ---------: |
| @arki/resilience createRetryPolicy() + withResilience()    |   1.21 µs |      9.66× |
| @arki/resilience withRetry() (builds the policy each call) |  875.0 ns |      7.00× |
| cockatiel retry().execute() (used directly)                |  375.0 ns |      3.00× |
| p-retry pRetry(fn, { retries: 3 })                         |  667.0 ns |      5.34× |
| plain await fn()                                           |  125.0 ns |    fastest |

### Circuit breaker

| Library                                                          | Time / op | vs fastest |
| ---------------------------------------------------------------- | --------: | ---------: |
| @arki/resilience createCircuitBreakerPolicy() + withResilience() |  334.0 ns |      4.02× |
| cockatiel circuitBreaker().execute() (used directly)             |  292.0 ns |      3.52× |
| opossum new CircuitBreaker(fn, { timeout: false }).fire()        |  875.0 ns |     10.54× |
| plain await fn()                                                 |   83.0 ns |    fastest |

### Timeout wrapper

| Library                                                               | Time / op | vs fastest |
| --------------------------------------------------------------------- | --------: | ---------: |
| @arki/resilience createTimeoutPolicy() + withResilience()             |   6.67 µs |     80.33× |
| @arki/resilience withTimeout() (builds the policy each call)          |   6.42 µs |     77.31× |
| cockatiel timeout().execute() (used directly, aggressive)             |   4.25 µs |     51.20× |
| opossum new CircuitBreaker(fn, { timeout }).fire() (breaker included) |   1.17 µs |     14.05× |
| Promise.race + setTimeout (hand-rolled)                               |  958.0 ns |     11.54× |
| plain await fn()                                                      |   83.0 ns |    fastest |

### Combined: retry + circuit breaker + timeout

The preset an application would use for an external API call. The p-retry + opossum row composes the two libraries by hand to cover all three jobs.

| Library                                                 | Time / op | vs fastest |
| ------------------------------------------------------- | --------: | ---------: |
| @arki/resilience externalApiPolicy + withResilience()   |   5.04 µs |     60.75× |
| cockatiel wrap(retry, breaker, timeout) (used directly) |   4.54 µs |     54.72× |
| p-retry around an opossum breaker with timeout          |   1.50 µs |     18.07× |
| plain await fn()                                        |   83.0 ns |    fastest |

Read the rows with the contracts in mind:

- Every call succeeds on the first try. The numbers show the overhead on a healthy call, not behaviour under failure: how fast a breaker opens, how backoff spaces retries, and what happens to in-flight calls are not measured here.
- Policies are built once and reused, which is how `@arki/resilience` expects them to be used. The `withRetry()` and `withTimeout()` rows build a new policy on every call (that is how those helpers work), so they include construction.
- `@arki/resilience` defaults match cockatiel here (3 attempts, exponential backoff, a breaker that opens on 5 consecutive failures, an aggressive timeout), and the cockatiel rows use the same values. opossum counts failures in a rolling window and keeps statistics, p-retry only retries, and opossum has no separate timeout policy, so those rows do different amounts of work.
- The bare `await fn()` row is a floor, not a rival: it is what a call costs with no protection.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT — see [LICENSE](./LICENSE).

## Typed retry waits

Every public execution supervises final defects. Retry cancellation is cooperative; a callback that never settles needs an explicit timeout and must observe its signal to stop effects. The timeout engine captures deadline versus caller cancellation before forwarding observations. A timed-out callback may still run: reconcile uncertain effects before explicitly selecting `Timeout` for retry. `Policy<F, E>` keeps fallback values and owned policy outcomes separate; policies without retry do not acquire clock-wait failures.

Retry observation timing is best effort. If timing is unavailable, invalid or moves backwards, duration-bearing success/failure events are omitted; operation results and retry/give-up events remain authoritative. Timing failures never repeat completed work. Custom Backoff delays must be finite milliseconds from zero through `MAX_TIMER_MS`, or `undefined` to stop. Custom Clock sleeps must resolve to `undefined` or an original `SLEEP_FAILURES` value. Malformed results return the already-admitted `UnexpectedDefect` before another attempt; private protocol details stay off the wire.

Invalid static breaker, deadline and capacity options throw `AssertError` when the policy is built. Concurrency and failure thresholds must be positive safe integers; queue capacity is nonnegative. Timing is finite and nonnegative, and deadlines fit `MAX_TIMER_MS`. These definition errors are separate from returned execution outcomes.
