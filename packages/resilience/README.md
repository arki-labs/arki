# @arki/resilience

Resilience primitives for ARKI — retry, circuit breaker, timeout, bulkhead, and curated presets. Built on top of [`cockatiel`](https://github.com/connor4312/cockatiel) with ergonomic factories and ready-made policies for common workloads.

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
import {
  createResiliencePolicy,
  withResilience,
} from '@arki/resilience';

const policy = createResiliencePolicy({
  retry: { maxAttempts: 3, initialDelay: 200 },
  timeout: { durationMs: 5_000 },
  circuitBreaker: { halfOpenAfterMs: 30_000, threshold: 5 },
});

const result = await withResilience(({ signal }) => doWork(signal), policy);
```

### Quick wrappers

For one-off calls without a long-lived policy:

```ts
import { withRetry, withTimeout, withCircuitBreaker } from '@arki/resilience';

await withRetry(() => sendEmail('support@example.com'), { maxAttempts: 3 });
await withTimeout(() => slowOperation(), { durationMs: 1_000 });
```

### Observability

```ts
import { attachPolicyLogger } from '@arki/resilience';

attachPolicyLogger(policy, {
  onRetry: (event) => console.log('retry', event),
  onBreak: (event) => console.warn('circuit open', event),
});
```

## API

- `createResiliencePolicy(options)` — compose retry + timeout + circuit breaker + bulkhead.
- `createRetryPolicy`, `createCircuitBreakerPolicy`, `createTimeoutPolicy`, `createBulkheadPolicy` — individual primitives.
- `externalApiPolicy`, `databasePolicy`, `backgroundJobPolicy` — pre-tuned presets.
- `withResilience`, `withRetry`, `withTimeout`, `withCircuitBreaker` — execution helpers.
- `attachPolicyLogger(policy, logger)` — observability hooks.
- `CircuitOpenError`, `TimeoutError`, `RetriesExhaustedError` — typed errors with helpers (`isResilienceError`, `isBrokenCircuitError`, `isBulkheadRejectedError`).
- Re-exports `IPolicy`, `wrap`, `noop` from `cockatiel`.

## Documentation

`@arki/resilience` is framework-agnostic and works on its own. When you
compose it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## License

MIT — see [LICENSE](./LICENSE).
