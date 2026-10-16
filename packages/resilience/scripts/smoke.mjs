// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser target.
// It exercises each policy once with real timers; the unit tests cover the details.

import { MockClock } from '@arki/clock';

import {
  backoff,
  CancelledError,
  CircuitOpenError,
  createBulkheadPolicy,
  createCircuitBreakerPolicy,
  createRetryPolicy,
  createTimeoutPolicy,
  definePresets,
  externalApiPolicy,
  isBulkheadRejectedError,
  isResilienceError,
  noop,
  TimeoutError,
  withFallback,
  withResilience,
  wrap,
} from '../dist/index.js';

const pending = () => new Promise(() => undefined);
const errorName = async promise => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error.name;
  }
};

const retried = [];
const retryResult = await createRetryPolicy({ backoff: backoff.exponential({ base: 1, max: 2 }).upTo(2) }).execute(
  ({ attempt }) => {
    retried.push(attempt);
    if (attempt === 0) throw new Error('first fails');
    return 'ok';
  },
);

const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1 });
await breaker
  .execute(() => {
    throw new Error('down');
  })
  .catch(() => undefined);

const bulkhead = createBulkheadPolicy({ maxConcurrent: 1, maxQueue: 0 });
void bulkhead.execute(pending);

const controller = new AbortController();
const cancelled = wrap(createRetryPolicy(), createTimeoutPolicy())
  .execute(pending, controller.signal)
  .catch(e => e);
setTimeout(() => controller.abort(), 1);

const attempts = [];
const composed = await externalApiPolicy.execute(({ attempt, signal }) => {
  attempts.push([attempt, signal instanceof AbortSignal]);
  return 'composed';
});

// A retry whose delays are seconds long, run on a MockClock: it must finish without waiting.
const clock = new MockClock();
const clockCalls = [];
const clockRetry = createRetryPolicy({ backoff: backoff.constant(5000).upTo(2), clock }).execute(() => {
  clockCalls.push(clock.now().getTime());
  if (clockCalls.length < 3) throw new Error('flaky');
  return 'ok';
});
await clock.advanceAsync(20_000);
const clockResult = `${await clockRetry}@${clockCalls.join(',')}`;

const presets = definePresets({ a: { circuitBreaker: { consecutiveFailures: 1 } }, b: {} });
await presets.a.execute(() => Promise.reject(new Error('down'))).catch(() => undefined);
const presetA = await errorName(presets.a.execute(() => 'x'));
const presetB = await presets.b.execute(() => 'fine');
const fellBack = await withFallback(presets.a, () => 'cached').execute(() => 'live');
const notHidden = new AbortController();
notHidden.abort();
const abortKept = await errorName(
  withFallback(wrap(createTimeoutPolicy()), () => 'hidden').execute(pending, notHidden.signal),
);

const checks = [
  ['preset breaker is its own', presetA, 'CircuitOpenError'],
  ['other preset unaffected', presetB, 'fine'],
  ['fallback on open breaker', fellBack, 'cached'],
  ['fallback does not hide a cancel', abortKept, 'CancelledError'],
  ['retry on a MockClock', clockResult, 'ok@0,5000,10000'],
  ['retry', retryResult, 'ok'],
  ['retry attempts', retried.join(','), '0,1'],
  ['timeout', await errorName(createTimeoutPolicy({ timeoutMs: 5 }).execute(pending)), 'TimeoutError'],
  [
    'timeout is ours',
    (await createTimeoutPolicy({ timeoutMs: 5 })
      .execute(pending)
      .catch(e => e)) instanceof TimeoutError,
    true,
  ],
  ['breaker open', await errorName(breaker.execute(() => 'x')), 'CircuitOpenError'],
  ['breaker is ours', (await breaker.execute(() => 'x').catch(e => e)) instanceof CircuitOpenError, true],
  ['bulkhead full', isBulkheadRejectedError(await bulkhead.execute(() => 'x').catch(e => e)), true],
  ['cancelled', (await cancelled) instanceof CancelledError, true],
  ['composed preset', composed, 'composed'],
  ['composed context', JSON.stringify(attempts), '[[0,true]]'],
  ['withResilience', await withResilience(() => 'through', noop), 'through'],
  [
    'own error passes through',
    await errorName(noop.execute(() => Promise.reject(new RangeError('mine')))),
    'RangeError',
  ],
  ['predicate', isResilienceError(new Error('plain')), false],
];

const runtime =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
