// Speed of @arki/resilience against cockatiel (the engine it is built on), p-retry and opossum.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every case wraps a call that succeeds and checks that the wrapped function's value comes
// back. Nothing fails, so no backoff timer ever runs: this is the overhead you pay on every
// healthy call, not behaviour under failure. The first four groups wrap a call that returns
// at once, so they show the raw overhead. The "1 ms" groups wrap the same rows around a call
// that waits 1 ms, which is what a caller feels: these policies guard network, AI and
// database calls that take milliseconds or more.

// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- loads the local module declaration for an untyped competitor
/// <reference path="./opossum.d.ts" />

import {
  circuitBreaker,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleAll,
  retry,
  timeout,
  TimeoutStrategy,
  wrap,
} from 'cockatiel';
import CircuitBreaker from 'opossum';
import pRetry from 'p-retry';

import { compare, defineSuite } from '@arki/bench';
import {
  createCircuitBreakerPolicy,
  createRetryPolicy,
  createTimeoutPolicy,
  externalApiPolicy,
  withResilience,
  withRetry,
  withTimeout,
} from '@arki/resilience';

type Value = number | string | null | { id: number };
type Work = () => Promise<Value>;

// Values of different types, so each call returns something a library could mangle or drop.
const values: readonly Value[] = [1, 0, 'text', null, { id: 7 }];
// `unknown` because async cases are normalized after their promise settles, but typed as the promise.
const json = (value: unknown): string => JSON.stringify(value);
const makeWork =
  (value: Value): Work =>
  async () =>
    value;

// A realistic operation: it waits 1 ms, as a fast network or database round trip would.
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const makeSlowWork =
  (value: Value): Work =>
  async () => {
    await sleep(1);
    return value;
  };

// Policies are built once, as they would be in an application.
const arkiRetry = createRetryPolicy();
const arkiBreaker = createCircuitBreakerPolicy();
const arkiTimeout = createTimeoutPolicy();

const cockatielRetry = retry(handleAll, {
  maxAttempts: 3,
  backoff: new ExponentialBackoff({ initialDelay: 100, maxDelay: 10_000, exponent: 2 }),
});
const cockatielBreaker = circuitBreaker(handleAll, { halfOpenAfter: 30_000, breaker: new ConsecutiveBreaker(5) });
const cockatielTimeout = timeout(30_000, TimeoutStrategy.Aggressive);

// Same shape as `externalApiPolicy`: retry (3 attempts) -> breaker (5 failures) -> timeout (10 s).
const cockatielCombined = wrap(
  retry(handleAll, {
    maxAttempts: 3,
    backoff: new ExponentialBackoff({ initialDelay: 200, maxDelay: 5000, exponent: 2 }),
  }),
  circuitBreaker(handleAll, { halfOpenAfter: 30_000, breaker: new ConsecutiveBreaker(5) }),
  timeout(10_000, TimeoutStrategy.Aggressive),
);

// opossum takes the function once and passes `fire()` arguments through to it.
const echo = async (value: Value): Promise<Value> => value;
const opossumBreaker = new CircuitBreaker(echo, { timeout: false, volumeThreshold: 5 });
const opossumTimeout = new CircuitBreaker(echo, { timeout: 30_000, volumeThreshold: 1_000_000 });
const opossumCombined = new CircuitBreaker(echo, { timeout: 10_000, volumeThreshold: 5 });

const slowEcho = async (value: Value): Promise<Value> => {
  await sleep(1);
  return value;
};
const opossumSlowBreaker = new CircuitBreaker(slowEcho, { timeout: false, volumeThreshold: 5 });
const opossumSlowTimeout = new CircuitBreaker(slowEcho, { timeout: 30_000, volumeThreshold: 1_000_000 });
const opossumSlowCombined = new CircuitBreaker(slowEcho, { timeout: 10_000, volumeThreshold: 5 });

// A hand-rolled timeout, the shortest way to write one without a library.
function raceTimeout(fn: Work, ms: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([fn(), deadline]).finally(() => clearTimeout(timer));
}

const plain = { label: 'plain await fn() (no protection, the floor)', differs: 'no policy applied' } as const;

export default defineSuite({
  id: '@arki/resilience',
  intro:
    'The cost of wrapping a call that succeeds, with `@arki/resilience`, against cockatiel (the engine it is built on), p-retry and opossum, and a bare `await fn()` for scale. These are the three libraries most often reached for to retry, break a circuit or time out in Node.',
  notes: [
    "Every call succeeds on the first try and the contract is only that the function's value comes back. The numbers show the overhead on a healthy call, not behaviour under failure: how fast a breaker opens, how backoff spaces retries, and what happens to in-flight calls are not measured here.",
    'These policies wrap calls that take milliseconds or more: network, AI and database round trips. The first four groups wrap a call that returns at once, so they show the raw overhead of each library. The "1 ms" groups wrap the same rows around a call that waits 1 ms, so they show what a caller actually feels: the overhead as a share of a real call.',
    'Policies are built once and reused, which is how `@arki/resilience` expects them to be used. The `withRetry()` and `withTimeout()` rows build a new policy on every call (that is how those helpers work), so they include construction; they are shown as variants of the `@arki/resilience` row.',
    '`@arki/resilience` defaults match cockatiel here (3 attempts, exponential backoff, a breaker that opens on 5 consecutive failures, an aggressive timeout), and the cockatiel rows use the same values. opossum counts failures in a rolling window and keeps statistics, p-retry only retries, and opossum has no separate timeout policy, so those rows do different amounts of work.',
    'The bare `await fn()` row is a floor, not a rival: it is what a call costs with no protection. It is measured and shown but never ranked.',
  ],
  groups: [
    compare<Value>({
      id: 'retry',
      title: 'Retry wrapper',
      mode: 'async',
      contract: {
        id: 'resilience-retry-success/v1',
        description: "the function's own value from a call that succeeds",
      },
      inputs: values,
      expected: json,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/resilience createRetryPolicy() + withResilience()',
          package: '@arki/resilience',
          setup: makeWork,
          run: fn => withResilience(fn, arkiRetry),
          normalize: json,
        }),
        arkiHelper: c({
          label: '@arki/resilience withRetry() (builds the policy each call)',
          variant: true,
          setup: makeWork,
          run: fn => withRetry(fn),
          normalize: json,
        }),
        cockatiel: c({
          label: 'cockatiel retry().execute() (used directly)',
          package: 'cockatiel',
          setup: makeWork,
          run: fn => cockatielRetry.execute(fn),
          normalize: json,
        }),
        pRetry: c({
          label: 'p-retry pRetry(fn, { retries: 3 })',
          package: 'p-retry',
          setup: makeWork,
          run: fn => pRetry(fn, { retries: 3 }),
          normalize: json,
        }),
        plain: c({ ...plain, setup: makeWork, run: fn => fn(), normalize: json }),
      }),
    }),
    compare<Value>({
      id: 'circuit-breaker',
      title: 'Circuit breaker',
      mode: 'async',
      contract: {
        id: 'resilience-breaker-success/v1',
        description: "the function's own value from a call that succeeds",
      },
      inputs: values,
      expected: json,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/resilience createCircuitBreakerPolicy() + withResilience()',
          package: '@arki/resilience',
          setup: makeWork,
          run: fn => withResilience(fn, arkiBreaker),
          normalize: json,
        }),
        cockatiel: c({
          label: 'cockatiel circuitBreaker().execute() (used directly)',
          package: 'cockatiel',
          setup: makeWork,
          run: fn => cockatielBreaker.execute(fn),
          normalize: json,
        }),
        opossum: c({
          label: 'opossum new CircuitBreaker(fn, { timeout: false }).fire()',
          package: 'opossum',
          run: value => opossumBreaker.fire(value),
          normalize: json,
        }),
        plain: c({ ...plain, setup: makeWork, run: fn => fn(), normalize: json }),
      }),
    }),
    compare<Value>({
      id: 'timeout',
      title: 'Timeout wrapper',
      mode: 'async',
      contract: {
        id: 'resilience-timeout-success/v1',
        description: "the function's own value from a call that finishes before the deadline",
      },
      inputs: values,
      expected: json,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/resilience createTimeoutPolicy() + withResilience()',
          package: '@arki/resilience',
          setup: makeWork,
          run: fn => withResilience(fn, arkiTimeout),
          normalize: json,
        }),
        arkiHelper: c({
          label: '@arki/resilience withTimeout() (builds the policy each call)',
          variant: true,
          setup: makeWork,
          run: fn => withTimeout(fn),
          normalize: json,
        }),
        cockatiel: c({
          label: 'cockatiel timeout().execute() (used directly, aggressive)',
          package: 'cockatiel',
          setup: makeWork,
          run: fn => cockatielTimeout.execute(fn),
          normalize: json,
        }),
        opossum: c({
          label: 'opossum new CircuitBreaker(fn, { timeout }).fire() (breaker included)',
          package: 'opossum',
          differs: 'also runs a circuit breaker and keeps statistics',
          run: value => opossumTimeout.fire(value),
          normalize: json,
        }),
        race: c({
          label: 'Promise.race + setTimeout (hand-rolled)',
          setup: makeWork,
          run: fn => raceTimeout(fn, 30_000),
          normalize: json,
        }),
        plain: c({ ...plain, setup: makeWork, run: fn => fn(), normalize: json }),
      }),
    }),
    compare<Value>({
      id: 'combined',
      title: 'Combined: retry + circuit breaker + timeout',
      note: 'The preset an application would use for an external API call. The p-retry + opossum row composes the two libraries by hand to cover all three jobs.',
      mode: 'async',
      contract: {
        id: 'resilience-combined-success/v1',
        description: "the function's own value from a call that succeeds through retry, breaker and timeout",
      },
      inputs: values,
      expected: json,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/resilience externalApiPolicy + withResilience()',
          package: '@arki/resilience',
          setup: makeWork,
          run: fn => withResilience(fn, externalApiPolicy),
          normalize: json,
        }),
        cockatiel: c({
          label: 'cockatiel wrap(retry, breaker, timeout) (used directly)',
          package: 'cockatiel',
          setup: makeWork,
          run: fn => cockatielCombined.execute(fn),
          normalize: json,
        }),
        composed: c({
          label: 'p-retry around an opossum breaker with timeout',
          package: 'p-retry',
          run: value => pRetry(() => opossumCombined.fire(value), { retries: 3 }),
          normalize: json,
        }),
        plain: c({ ...plain, setup: makeWork, run: fn => fn(), normalize: json }),
      }),
    }),
    compare<Value>({
      id: 'retry-1ms',
      title: 'Retry wrapper around a 1 ms call',
      mode: 'async',
      contract: {
        id: 'resilience-retry-success-1ms/v1',
        description: "the function's own value from a call that waits 1 ms and succeeds",
      },
      inputs: values,
      expected: json,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/resilience createRetryPolicy() + withResilience()',
          package: '@arki/resilience',
          setup: makeSlowWork,
          run: fn => withResilience(fn, arkiRetry),
          normalize: json,
        }),
        arkiHelper: c({
          label: '@arki/resilience withRetry() (builds the policy each call)',
          variant: true,
          setup: makeSlowWork,
          run: fn => withRetry(fn),
          normalize: json,
        }),
        cockatiel: c({
          label: 'cockatiel retry().execute() (used directly)',
          package: 'cockatiel',
          setup: makeSlowWork,
          run: fn => cockatielRetry.execute(fn),
          normalize: json,
        }),
        pRetry: c({
          label: 'p-retry pRetry(fn, { retries: 3 })',
          package: 'p-retry',
          setup: makeSlowWork,
          run: fn => pRetry(fn, { retries: 3 }),
          normalize: json,
        }),
        plain: c({ ...plain, setup: makeSlowWork, run: fn => fn(), normalize: json }),
      }),
    }),
    compare<Value>({
      id: 'circuit-breaker-1ms',
      title: 'Circuit breaker around a 1 ms call',
      mode: 'async',
      contract: {
        id: 'resilience-breaker-success-1ms/v1',
        description: "the function's own value from a call that waits 1 ms and succeeds",
      },
      inputs: values,
      expected: json,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/resilience createCircuitBreakerPolicy() + withResilience()',
          package: '@arki/resilience',
          setup: makeSlowWork,
          run: fn => withResilience(fn, arkiBreaker),
          normalize: json,
        }),
        cockatiel: c({
          label: 'cockatiel circuitBreaker().execute() (used directly)',
          package: 'cockatiel',
          setup: makeSlowWork,
          run: fn => cockatielBreaker.execute(fn),
          normalize: json,
        }),
        opossum: c({
          label: 'opossum new CircuitBreaker(fn, { timeout: false }).fire()',
          package: 'opossum',
          run: value => opossumSlowBreaker.fire(value),
          normalize: json,
        }),
        plain: c({ ...plain, setup: makeSlowWork, run: fn => fn(), normalize: json }),
      }),
    }),
    compare<Value>({
      id: 'timeout-1ms',
      title: 'Timeout wrapper around a 1 ms call',
      mode: 'async',
      contract: {
        id: 'resilience-timeout-success-1ms/v1',
        description: "the function's own value from a call that waits 1 ms and finishes before the deadline",
      },
      inputs: values,
      expected: json,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/resilience createTimeoutPolicy() + withResilience()',
          package: '@arki/resilience',
          setup: makeSlowWork,
          run: fn => withResilience(fn, arkiTimeout),
          normalize: json,
        }),
        arkiHelper: c({
          label: '@arki/resilience withTimeout() (builds the policy each call)',
          variant: true,
          setup: makeSlowWork,
          run: fn => withTimeout(fn),
          normalize: json,
        }),
        cockatiel: c({
          label: 'cockatiel timeout().execute() (used directly, aggressive)',
          package: 'cockatiel',
          setup: makeSlowWork,
          run: fn => cockatielTimeout.execute(fn),
          normalize: json,
        }),
        opossum: c({
          label: 'opossum new CircuitBreaker(fn, { timeout }).fire() (breaker included)',
          package: 'opossum',
          differs: 'also runs a circuit breaker and keeps statistics',
          run: value => opossumSlowTimeout.fire(value),
          normalize: json,
        }),
        race: c({
          label: 'Promise.race + setTimeout (hand-rolled)',
          setup: makeSlowWork,
          run: fn => raceTimeout(fn, 30_000),
          normalize: json,
        }),
        plain: c({ ...plain, setup: makeSlowWork, run: fn => fn(), normalize: json }),
      }),
    }),
    compare<Value>({
      id: 'combined-1ms',
      title: 'Combined: retry + circuit breaker + timeout around a 1 ms call',
      note: 'The preset an application would use for an external API call, around a call that waits 1 ms. The p-retry + opossum row composes the two libraries by hand to cover all three jobs.',
      mode: 'async',
      contract: {
        id: 'resilience-combined-success-1ms/v1',
        description:
          "the function's own value from a call that waits 1 ms and succeeds through retry, breaker and timeout",
      },
      inputs: values,
      expected: json,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/resilience externalApiPolicy + withResilience()',
          package: '@arki/resilience',
          setup: makeSlowWork,
          run: fn => withResilience(fn, externalApiPolicy),
          normalize: json,
        }),
        cockatiel: c({
          label: 'cockatiel wrap(retry, breaker, timeout) (used directly)',
          package: 'cockatiel',
          setup: makeSlowWork,
          run: fn => cockatielCombined.execute(fn),
          normalize: json,
        }),
        composed: c({
          label: 'p-retry around an opossum breaker with timeout',
          package: 'p-retry',
          run: value => pRetry(() => opossumSlowCombined.fire(value), { retries: 3 }),
          normalize: json,
        }),
        plain: c({ ...plain, setup: makeSlowWork, run: fn => fn(), normalize: json }),
      }),
    }),
  ],
});
