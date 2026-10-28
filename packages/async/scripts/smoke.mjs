// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser target.
// One real-timer call per feature; the unit tests cover the details.

import { MockClock } from '@arki/clock';

import {
  all,
  AsyncError,
  cleanup,
  debounce,
  mapConcurrent,
  race,
  resource,
  scoped,
  sleep,
  throttle,
  timeout,
} from '../dist/index.js';

async function main() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rejection = async promise => {
    try {
      const outcome = await promise;
      return outcome && typeof outcome === 'object' && 'code' in outcome ? outcome.code : 'resolved';
    } catch (error) {
      return error instanceof AsyncError ? error.code : error.name;
    }
  };

  const calls = [];
  const debounced = debounce(value => calls.push(value), 20);
  debounced(1);
  debounced(2);
  const pendingBefore = debounced.pending;

  const leading = [];
  const throttled = throttle(value => leading.push(value), 30);
  throttled('a');
  throttled('b');
  throttled('c');

  const controller = new AbortController();
  const aborting = rejection(sleep(5000, { signal: controller.signal }));
  controller.abort();

  let microtasksDone = false;
  const zero = sleep(0).then(() => microtasksDone);
  Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      microtasksDone = true;
    });
  await wait(60);

  // Structured concurrency: one real-timer call per function.
  let active = 0;
  let peak = 0;
  const mapped = await mapConcurrent(
    [15, 5, 10, 1],
    async ms => {
      active++;
      peak = Math.max(peak, active);
      await wait(ms);
      active--;
      return ms;
    },
    { concurrency: 2 },
  );

  let siblingAborted = false;
  const allFailure = await rejection(
    all([
      async () => {
        await wait(5);
        throw new Error('private task defect');
      },
      async signal => {
        const outcome = await sleep(1000, { signal });
        siblingAborted = signal.aborted;
        return outcome;
      },
    ]),
  );

  let loserAborted = false;
  const winner = await race([
    async () => {
      await wait(5);
      return 'fast';
    },
    async signal => {
      await sleep(1000, { signal });
      loserAborted = signal.aborted;
      return 'slow';
    },
  ]);

  let timeoutSignalAborted = false;
  const timedOut = await rejection(
    timeout(async signal => {
      const outcome = await sleep(1000, { signal });
      timeoutSignalAborted = signal.aborted;
      return outcome;
    }, 5),
  );

  const order = [];
  const cleanupResult = await scoped(
    {
      first: cleanup(() => void order.push('a')),
      second: resource(
        () => 'b',
        () => {
          order.push('b');
          throw new Error('close failed');
        },
      ),
    },
    () => undefined,
  );

  // Long waits on a MockClock: debounce and sleep follow its time, not real time.
  const clock = new MockClock();
  const debouncedOnClock = [];
  const onClock = debounce(value => debouncedOnClock.push(`${value}@${clock.now().getTime()}`), 60_000, { clock });
  onClock('a');
  clock.advance(30_000);
  onClock('b');
  clock.advance(60_000);
  const slept = sleep(3_600_000, { clock }).then(() => clock.now().getTime());
  clock.advance(3_600_000);

  const checks = [
    ['debounce on a MockClock', debouncedOnClock.join(','), 'b@90000'],
    ['sleep on a MockClock', await slept, 3_690_000],
    ['sleep resolves', await sleep(5).then(() => 'ok'), 'ok'],
    ['sleep(0) waits past microtasks', await zero, true],
    ['invalid wait', await rejection(sleep(-1)), 'ARKI_ASYNC_E001'],
    ['abort', await aborting, 'async.cancelled'],
    ['debounce latest wins', calls.join(','), '2'],
    ['debounce pending', pendingBefore, true],
    ['throttle leading and trailing', leading.join(','), 'a,c'],
    ['mapConcurrent keeps input order', Array.isArray(mapped) ? mapped.join(',') : mapped.code, '15,5,10,1'],
    ['mapConcurrent respects the limit', peak, 2],
    [
      'mapConcurrent invalid concurrency',
      await rejection(mapConcurrent([1], async n => n, { concurrency: 0 })),
      'ARKI_ASYNC_E005',
    ],
    ['all returns a canonical task defect', allFailure, 'failure.unexpected_defect'],
    ['all aborts the sibling', siblingAborted, true],
    ['race first fulfilled wins', winner, 'fast'],
    ['race aborts and awaits the loser', loserAborted, true],
    ['timeout returns its canonical deadline', timedOut, 'async.deadline'],
    ['timeout aborts the task signal', timeoutSignalAborted, true],
    ['scoped cleanup failure', cleanupResult?.code, 'failure.unexpected_defect'],
    ['scoped finalizers run newest first', order.join(','), 'b,a'],
  ];

  let failed = 0;
  for (const [name, actual, expected] of checks) {
    if (actual === expected) continue;
    failed++;
    console.log(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  const runtime =
    typeof HermesInternal !== 'undefined'
      ? 'hermes'
      : typeof Deno !== 'undefined'
        ? 'deno'
        : typeof Bun !== 'undefined'
          ? 'bun'
          : typeof window !== 'undefined'
            ? 'browser'
            : 'node';
  if (failed > 0) {
    console.log(`${runtime}: ${failed} smoke checks FAILED`);
    throw new Error('smoke failed');
  }
  console.log(`${runtime}: ${checks.length} smoke checks passed`);
}

main();
