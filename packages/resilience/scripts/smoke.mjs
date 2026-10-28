// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser target.
// It exercises each policy once with real timers; the unit tests cover the details.

import { MockClock } from '@arki/clock';
import { defineFailure, isFailure } from '@arki/failure';

import {
  backoff,
  Cancelled,
  CircuitOpen,
  createBulkheadPolicy,
  createCircuitBreakerPolicy,
  createResiliencePolicy,
  createRetryPolicy,
  createTimeoutPolicy,
  definePresets,
  externalApiPolicy,
  BulkheadRejected,
  noop,
  Timeout,
  withFallback,
  withResilience,
  wrap,
} from '../dist/index.js';

const preAborted = new AbortController();
preAborted.abort('private');
let cancelledCalls = 0;
const cancelledResult = await createRetryPolicy().execute(() => { cancelledCalls++; return 'unexpected'; }, preAborted.signal);

const pending = () => new Promise(() => undefined);
const failureCode = async promise => { const result = await promise; return isFailure(result) ? result.code : 'success'; };

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
const presetA = await failureCode(presets.a.execute(() => 'x'));
const presetB = await presets.b.execute(() => 'fine');
const fellBack = await withFallback(presets.a, () => 'cached').execute(() => 'live');
const notHidden = new AbortController();
notHidden.abort();
const abortKept = await failureCode(
  withFallback(wrap(createTimeoutPolicy()), () => 'hidden').execute(pending, notHidden.signal),
);

const ExportUnavailable = defineFailure('export.unavailable', { status: 503 });
const ExportUnauthorized = defineFailure('export.unauthorized', { status: 422 });
const namedRetry = backoff.constant(1).while(ExportUnavailable);

// onThrow: a throw that outlasts the retries, or an open circuit, comes back as a value.
const mappedThrow = await createRetryPolicy({
  backoff: backoff.constant(1).upTo(1),
  onThrow: cause => ExportUnavailable({ cause }),
}).execute(() => Promise.reject(new Error('down')));
const mappedPolicy = createResiliencePolicy({
  retry: backoff.constant(1).upTo(0),
  circuitBreaker: { consecutiveFailures: 1 },
  onThrow: () => 'down',
});
const mappedFirst = await mappedPolicy.execute(() => Promise.reject(new Error('down')));
const mappedOpen = await mappedPolicy.execute(() => 'x');

// A reporting failure must never repeat a completed operation or block a deadline.
const observedRetry = createRetryPolicy({ backoff: backoff.constant(0).upTo(1) });
let saved = 0;
observedRetry.onSuccess(() => { throw new Error('private observer'); });
observedRetry.onSuccess(() => Promise.reject(new Error('private async observer')));
observedRetry.onSuccess(() => new Promise(() => {}));
const savedResult = await observedRetry.execute(() => { saved++; return 'saved'; });
const observedTimeout = createTimeoutPolicy({ timeoutMs: 5 });
observedTimeout.onTimeout(() => { throw new Error('private observer'); });
observedTimeout.onTimeout(() => Promise.reject(new Error('private async observer')));
const observedDeadline = await failureCode(observedTimeout.execute(pending));

const sdkLookalike = { isBrokenCircuitError: true, message: 'private callback' };
const provenance = await withFallback(createCircuitBreakerPolicy(), error => error).execute(() => { throw sdkLookalike; });
const timedCaller = new AbortController();
const originPolicy = createTimeoutPolicy({ timeoutMs: 5 });
originPolicy.onTimeout(() => timedCaller.abort());
const origin = await originPolicy.execute(pending, timedCaller.signal);

const checks = [
  ['callback provenance', provenance === sdkLookalike, true],
  ['deadline origin before observer', Timeout.is(origin), true],
  ['observer cannot change success', savedResult, 'saved'],
  ['observer cannot repeat effects', saved, 1],
  ['observer cannot block timeout', observedDeadline, Timeout.code],
  ['retry pre-abort outcome', Cancelled.is(cancelledResult), true],
  ['retry pre-abort no callback', cancelledCalls, 0],
  ['while(definition) retries its failure', namedRetry.delay(1, ExportUnavailable()), 1],
  ['while(definition) skips other failures', namedRetry.delay(1, ExportUnauthorized()), undefined],
  ['while(definition) retries thrown errors', namedRetry.delay(1, new Error('down')), 1],
  ['onThrow maps a throw the retries gave up on', ExportUnavailable.is(mappedThrow), true],
  ['onThrow sees the first throw', mappedFirst, 'down'],
  ['onThrow bypasses an open circuit', CircuitOpen.is(mappedOpen), true],
  ['preset breaker is its own', presetA, CircuitOpen.code],
  ['other preset unaffected', presetB, 'fine'],
  ['fallback bypasses open breaker', CircuitOpen.is(fellBack), true],
  ['fallback does not hide a cancel', abortKept, Cancelled.code],
  ['retry on a MockClock', clockResult, 'ok@0,5000,10000'],
  ['retry', retryResult, 'ok'],
  ['retry attempts', retried.join(','), '0,1'],
  ['timeout', await failureCode(createTimeoutPolicy({ timeoutMs: 5 }).execute(pending)), Timeout.code],
  [
    'timeout is ours',
    Timeout.is(await createTimeoutPolicy({ timeoutMs: 5 })
      .execute(pending)
      .catch(e => e)),
    true,
  ],
  ['breaker open', await failureCode(breaker.execute(() => 'x')), CircuitOpen.code],
  ['breaker is ours', CircuitOpen.is(await breaker.execute(() => 'x')), true],
  ['bulkhead full', BulkheadRejected.is(await bulkhead.execute(() => 'x').catch(e => e)), true],
  ['cancelled', Cancelled.is(await cancelled), true],
  ['composed preset', composed, 'composed'],
  ['composed context', JSON.stringify(attempts), '[[0,true]]'],
  ['withResilience', await withResilience(() => 'through', noop), 'through'],
  [
    'own error passes through',
    await failureCode(noop.execute(() => Promise.reject(new RangeError('mine')))),
    'failure.unexpected_defect',
  ],
  ['predicate', isFailure(new Error('plain')), false],
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
