# @arki/resilience

Resilience primitives for ARKI — retry, circuit breaker, timeout, bulkhead, and curated presets. Built on the [`cockatiel`](https://github.com/connor4312/cockatiel) engine with ergonomic factories, ready-made policies for common workloads, and its own public types and errors, so a new cockatiel release never changes this package's API.

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

### Building policies

```ts
import { createResiliencePolicy, withResilience } from '@arki/resilience';

const policy = createResiliencePolicy({
  retry: { maxAttempts: 3, initialDelay: 200 },
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

### Quick wrappers

For one-off calls without a long-lived policy:

```ts
import { withRetry, withTimeout } from '@arki/resilience';

await withRetry(() => sendEmail('support@example.com'), { maxAttempts: 3 });
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

`logger` needs `info`, `warn` and `error` methods. The helper subscribes to the events a policy exposes: every policy has `onSuccess` and `onFailure`; a retry policy adds `onRetry` and `onGiveUp`; a circuit breaker adds `onBreak`, `onHalfOpen` and `onReset`; a timeout policy adds `onTimeout`; a bulkhead adds `onReject`. Each event method takes a listener and returns a subscription with `dispose()`. A composed policy (`wrap`, `createResiliencePolicy`, the presets) exposes only `onSuccess` and `onFailure`.

## API

- `createResiliencePolicy(options)` — compose retry + timeout + circuit breaker + bulkhead.
- `createRetryPolicy`, `createCircuitBreakerPolicy`, `createTimeoutPolicy`, `createBulkheadPolicy` — individual primitives.
- `externalApiPolicy`, `databasePolicy`, `backgroundJobPolicy` — pre-tuned presets.
- `withResilience`, `withRetry`, `withTimeout` — execution helpers.
- `withCircuitBreaker` — **deprecated**. It builds a new breaker on every call, so it never opens. Use `createCircuitBreakerPolicy()` once and `withResilience()` per call.
- `attachPolicyLogger(policy, logger)` — observability hooks.
- `wrap(...policies)` — compose policies from the outside in; `noop` — a policy that only runs the function.
- `ResilienceError`, `CircuitOpenError`, `TimeoutError`, `CancelledError`, `BulkheadRejectedError`, `RetriesExhaustedError` — typed errors with helpers (`isResilienceError`, `isBrokenCircuitError`, `isBulkheadRejectedError`).
- Types: `Policy`, `PolicyContext`, `PolicyCallback`, `RetryPolicy`, `CircuitBreakerPolicy`, `TimeoutPolicy`, `BulkheadPolicy`, `PolicyEvent`, `Subscription` and the event payloads `SuccessEvent`, `FailureEvent`, `FailureReason`, `RetryEvent`, `BreakEvent`.

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
