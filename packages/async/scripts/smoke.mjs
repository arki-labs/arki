// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser target.
// One real-timer call per feature; the unit tests cover the details.

import { all, AsyncError, debounce, mapConcurrent, race, scoped, sleep, throttle, timeout } from '../dist/index.js';

async function main() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rejection = async promise => {
    try {
      await promise;
      return 'resolved';
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
        throw new AsyncError('ARKI_ASYNC_E004', 'x', 'y');
      },
      async signal => {
        await sleep(1000, { signal }).catch(() => {
          siblingAborted = signal.aborted;
        });
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
      await sleep(1000, { signal }).catch(() => {
        loserAborted = true;
      });
      return 'slow';
    },
  ]);

  let timeoutSignalAborted = false;
  const timedOut = await rejection(
    timeout(async signal => {
      await sleep(1000, { signal }).catch(() => {
        timeoutSignalAborted = signal.aborted;
      });
    }, 5),
  );

  const order = [];
  const cleanup = await rejection(
    scoped(async scope => {
      scope.defer(() => void order.push('a'));
      await scope.acquire(
        () => 'b',
        () => {
          order.push('b');
          throw new Error('close failed');
        },
      );
    }),
  );

  const checks = [
    ['sleep resolves', await sleep(5).then(() => 'ok'), 'ok'],
    ['sleep(0) waits past microtasks', await zero, true],
    ['invalid wait', await rejection(sleep(-1)), 'ARKI_ASYNC_E001'],
    ['abort', await aborting, 'ARKI_ASYNC_E002'],
    ['debounce latest wins', calls.join(','), '2'],
    ['debounce pending', pendingBefore, true],
    ['throttle leading and trailing', leading.join(','), 'a,c'],
    ['mapConcurrent keeps input order', mapped.join(','), '15,5,10,1'],
    ['mapConcurrent respects the limit', peak, 2],
    [
      'mapConcurrent invalid concurrency',
      await rejection(mapConcurrent([1], async n => n, { concurrency: 0 })),
      'ARKI_ASYNC_E005',
    ],
    ['all rejects with the first error', allFailure, 'ARKI_ASYNC_E004'],
    ['all aborts the sibling', siblingAborted, true],
    ['race first fulfilled wins', winner, 'fast'],
    ['race aborts and awaits the loser', loserAborted, true],
    ['timeout rejects at the deadline', timedOut, 'ARKI_ASYNC_E004'],
    ['timeout aborts the task signal', timeoutSignalAborted, true],
    ['scoped cleanup failure', cleanup, 'ARKI_ASYNC_E003'],
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
