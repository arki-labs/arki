# @arki/resilience

Resilience primitives for ARKI — retry, circuit breaker, timeout, bulkhead, and curated presets. Circuit breaker, timeout and bulkhead are built on the [`cockatiel`](https://github.com/connor4312/cockatiel) engine; retry is its own loop, so a `Clock` can drive its delay. It comes with ergonomic factories, ready-made policies for common workloads, and its own public types and errors, so a new cockatiel release never changes this package's API.

## Installation

```sh
npm install @arki/resilience
# or
bun add @arki/resilience
# or
pnpm add @arki/resilience
```

## Usage

### Pre-configured presets

```ts
import { externalApiPolicy, withResilience } from '@arki/resilience';

const data = await withResilience(
  () => fetch('https://api.example.com/billing').then(r => r.json()),
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

const quotes = withFallback(createResiliencePolicy(), () => null);
const quote = await quotes.execute(() => fetchQuote()); // Quote | null
```

`withFallback(policy, fallback)` returns a policy whose call resolves to `T | F`: the function's own result, or what `fallback(error)` returns when the policy gives up (retries used up, circuit open, timeout, ...). The type comes from the fallback, so `null` and `{ stale: true }` show up in the result type.

- A fallback never hides a cancel. If the caller's signal is aborted, the error is rethrown and `fallback` does not run.
- To fall back on some errors only, rethrow the others: `(error) => { if (!isBrokenCircuitError(error)) throw error; return cached; }`.
- Put it outermost. `wrap` does not accept a policy with a fallback (a compile error), because inside a retry it would hide the errors the retry needs.

### Named presets

```ts
import { backoff, definePresets } from '@arki/resilience';

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

const policy = createResiliencePolicy({
  retry: backoff.exponential({ base: 200, max: 5_000, jitter: 0.25 }).upTo(3),
  timeout: { timeoutMs: 5_000 },
  circuitBreaker: { halfOpenAfter: 30_000, consecutiveFailures: 5 },
});

const result = await withResilience(({ signal }) => doWork(signal), policy);
```

Every policy has the same shape, the `Policy` type:

```ts
import type { Policy, PolicyContext } from '@arki/resilience';

const policy: Policy = createResiliencePolicy();

await policy.execute(({ signal, attempt }: PolicyContext) => fetchPage(signal), parentSignal);
```

`signal` aborts when the caller's signal aborts, when a timeout policy reaches its deadline, and after a timed call returns. `attempt` is 0 for the first call and 1 for the first retry; it is always 0 under a policy without retry.

### Retry schedules: `backoff`

A `Backoff` says how long to wait before each retry, and when to stop. The same value drives `createRetryPolicy`, `createResiliencePolicy`, `@arki/queue` job retries and `@arki/journal` effect retries.

```ts
import { isFailure } from '@arki/failure';
import { backoff } from '@arki/resilience';

backoff
  .exponential({ base: 1_000, max: 30_000, jitter: 0.25 }) // 1 s, 2 s, 4 s ... capped at 30 s, each varied by up to 25%
  .upTo(5) // at most 5 retries (6 calls in all)
  .while(reason => reason instanceof NetworkError); // retry network errors only

backoff.constant(60_000).upTo(1); // one retry, a minute later

backoff
  .constant(100)
  .upTo(3)
  .while(reason => isFailure(reason) && reason.code === 'db.timeout'); // retry one returned failure
```

- `backoff.exponential({ base, max?, jitter?, random? })` waits `base * 2^(attempt - 1)`, capped at `max` (default and upper bound: `MAX_TIMER_MS` from `@arki/clock`, about 24.8 days). `jitter` (0 to 1, default 0) picks each wait at random within ±`jitter` of the exact value. `random` (default `Math.random`) is the randomness source; pass a fixed function to make jittered waits deterministic in tests.
- `backoff.constant(ms)` waits `ms` before every retry.
- `.upTo(retries)` limits the retries; `upTo(0)` never retries. Without it a backoff retries forever.
- `.while(predicate)` retries only the reasons for which `predicate(reason)` is true. A reason is a thrown error or a returned failure (see below).
- `.delay(attempt, reason)` is the one question a backoff answers: the wait in ms before retry `attempt` (1 for the first retry), or `undefined` for stop. `.maxRetries` is the `upTo` limit, or `Infinity`.

Backoffs are immutable: `upTo` and `while` return a new one, and each only narrows. A bad option throws `InvalidBackoffError` (`ARKI_RESILIENCE_E006`) where the backoff is built.

### Returned failures

A function may return a failure from [`@arki/failure`](../failure) instead of throwing, for an expected outcome such as "card declined". Retrying it would only repeat it, so retry does not: after one try the failure goes back to the caller as the result.

- A backoff without `while` retries every thrown error and no returned failure.
- A returned failure is retried only when a `while` predicate accepts it. The first `while` decides alone for failures, so a negative predicate such as `reason => !(reason instanceof BadInput)` accepts failures too; name the failures you want instead.
- When the retries run out on a returned failure, the caller gets the last failure as a value. Nothing is thrown, and the result type is still the function's own, so the caller still checks `isFailure`.
- `onFailure` and `onRetry` report a returned failure as `{ value }`. `onGiveUp` fires only for a failure that was retried at least once.
- Circuit breakers and bulkheads see a returned failure as a normal result: it never opens a breaker.

### Testing retries with a clock

Retry delays wait on a `Clock` from `@arki/clock`. Pass a `MockClock` and a retry with delays of seconds finishes at once:

```ts
import { MockClock } from '@arki/clock';
import { backoff, createRetryPolicy } from '@arki/resilience';

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

await withRetry(() => sendEmail('support@example.com'), { backoff: backoff.exponential({ base: 200 }).upTo(3) });
await withTimeout(() => slowOperation(), { timeoutMs: 1_000 });
```

A circuit breaker must remember past failures, so build it once and reuse it:

```ts
const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 2 });

await withResilience(() => callDownstream(), breaker); // opens after 2 failures in a row
```

### Errors

Errors thrown by your function reach you unchanged. Errors raised by the policies themselves all extend `ResilienceError`:

- `CircuitOpenError` — the breaker is open; the function was not called.
- `TimeoutError` — a timeout policy reached its deadline.
- `CancelledError` — the caller's own signal aborted; `cause` is the signal's reason.
- `BulkheadRejectedError` — every slot and queue place of a bulkhead was taken.

```ts
import { isBrokenCircuitError, isResilienceError } from '@arki/resilience';

try {
  await withResilience(() => callDownstream(), policy);
} catch (error) {
  if (isBrokenCircuitError(error)) return cachedAnswer;
  if (isResilienceError(error)) throw new ServiceUnavailable(error);
  throw error;
}
```

### Observability

```ts
import { attachPolicyLogger } from '@arki/resilience';

const detach = attachPolicyLogger(policy, logger, 'billing');
```

`logger` needs `info`, `warn` and `error` methods. The helper subscribes to the events a policy exposes: every policy has `onSuccess` and `onFailure`; a retry policy adds `onRetry` and `onGiveUp`; a circuit breaker adds `onBreak`, `onHalfOpen` and `onReset`; a timeout policy adds `onTimeout`; a bulkhead adds `onReject`. Each event method takes a listener and returns a subscription with `dispose()`. A composed policy (`wrap`, `createResiliencePolicy`, the presets) exposes only `onSuccess` and `onFailure` itself; `createResiliencePolicy` and the presets also give you `components`, whose events are the full set. `attachPolicyLogger` returns a function that ends all its subscriptions.

### Dot plugin

```ts
import { defineApp } from '@arki/dot';
import { resilience } from '@arki/resilience/dot';

const app = await defineApp('my-app').use(resilience(presets)).boot();
await app.services.resilience.run('carrier', () => callCarrier());
```

`services.resilience` has `for(name)` (the preset itself) and `run(name, fn, signal?)`. Names are typed from `presets`. While the app runs, the plugin logs the events of every preset component (retry, give up, circuit open / half-open / closed, timeout, bulkhead reject) at `debug` in the `arki:resilience` category. Turn them on with `DEBUG=arki:resilience`. `dispose` ends the subscriptions. For other levels or per-call records, use `attachPolicyLogger`. `@arki/dot` is an optional peer dependency.

## API

- `createResiliencePolicy(options)` — compose retry + circuit breaker + timeout, plus an optional `bulkhead` that wraps them all (one logical call holds one slot).
- `backoff.exponential`, `backoff.constant` — retry schedules (`Backoff`), shared with `@arki/queue` and `@arki/journal`.
- `createRetryPolicy({ backoff?, clock? })`, `createCircuitBreakerPolicy`, `createTimeoutPolicy`, `createBulkheadPolicy` — individual primitives.
- `externalApiPolicy`, `databasePolicy`, `backgroundJobPolicy` — pre-tuned presets.
- `withResilience`, `withRetry`, `withTimeout` — execution helpers.
- `withFallback(policy, fallback)` — a last answer when a policy gives up; `definePresets({ name: options })` — named composed policies.
- `@arki/resilience/dot`: `resilience(presets)` plugin, `ResilienceService`, `RESILIENCE_PLUGIN_ERROR_CODES`.
- `attachPolicyLogger(policy, logger)` — observability hooks.
- `wrap(...policies)` — compose policies from the outside in; `noop` — a policy that only runs the function.
- `ResilienceError`, `CircuitOpenError`, `TimeoutError`, `CancelledError`, `BulkheadRejectedError`, `RetriesExhaustedError`, `InvalidBackoffError` — typed errors with helpers (`isResilienceError`, `isBrokenCircuitError`, `isBulkheadRejectedError`).
- Types: `Backoff`, `ExponentialBackoffOptions`, `Policy`, `PolicyContext`, `PolicyCallback`, `RetryPolicy`, `CircuitBreakerPolicy`, `TimeoutPolicy`, `BulkheadPolicy`, `PolicyEvent`, `Subscription` and the event payloads `SuccessEvent`, `FailureEvent`, `FailureReason`, `RetryEvent`, `BreakEvent`, `Presets`, `ResiliencePolicy`, `ResilienceComponents`. `Policy<F>` carries the fallback type `F` (`never` for a plain policy).

## Errors

Every error the policies raise is a `ResilienceError` with a stable `code` and a `remediation`. Match on `error.code`, never on the message. Errors thrown by your own function pass through untouched.

| Code                   | Class                   | Meaning                                                          |
| ---------------------- | ----------------------- | ---------------------------------------------------------------- |
| `ARKI_RESILIENCE_E001` | `CircuitOpenError`      | The circuit breaker is open and rejected the call.               |
| `ARKI_RESILIENCE_E002` | `TimeoutError`          | A timeout policy reached its deadline.                           |
| `ARKI_RESILIENCE_E003` | `CancelledError`        | The caller's own signal aborted the call. `cause` is its reason. |
| `ARKI_RESILIENCE_E004` | `BulkheadRejectedError` | Every execution slot and queue slot was taken.                   |
| `ARKI_RESILIENCE_E005` | `RetriesExhaustedError` | Every retry attempt failed. `lastError` holds the last one.      |
| `ARKI_RESILIENCE_E006` | `InvalidBackoffError`   | A `backoff` builder got an option it cannot use.                 |

The codes are also exported as `RESILIENCE_ERROR_CODES`.

The Dot plugin has one code of its own, exported as `RESILIENCE_PLUGIN_ERROR_CODES`:

| Code                          | Meaning                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ARKI_RESILIENCE_PLUGIN_E001` | `for` or `run` got a name that is not in the presets (untyped JS only). Use a name from `definePresets`. |

## Runtime support

Node, Bun, Deno, modern browsers and React Native (Hermes). Pure ESM. The package uses only `setTimeout`, `AbortSignal` and `Promise` at call time, with no `node:*` imports and no `process` or `Buffer`. `bun run test:runtimes` runs a smoke test of the built package on every runtime; the Hermes leg needs a `hermes` binary (`HERMES_BIN`) and prints `INCOMPLETE` when it is missing.

## When does the overhead matter?

Almost never. A policy adds a few microseconds to a call: the benchmarks below measure that on a call that returns at once, and on a call that waits 1 ms. The calls these policies guard, to a network service, an AI provider or a database, take milliseconds to seconds, so the policy costs well under one percent of the call it protects. The one case to think about is a hot loop over an in-memory function, where the policy can cost more than the work. There, wrap the loop, not each iteration.

## Documentation

`@arki/resilience` is framework-agnostic and works on its own. When you
compose it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

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
