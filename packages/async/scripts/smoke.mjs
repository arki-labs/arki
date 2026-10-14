// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser target.
// One real-timer call per feature; the unit tests cover the details.

import { AsyncError, debounce, sleep, throttle } from '../dist/index.js';

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

  const checks = [
    ['sleep resolves', await sleep(5).then(() => 'ok'), 'ok'],
    ['sleep(0) waits past microtasks', await zero, true],
    ['invalid wait', await rejection(sleep(-1)), 'ARKI_ASYNC_E001'],
    ['abort', await aborting, 'ARKI_ASYNC_E002'],
    ['debounce latest wins', calls.join(','), '2'],
    ['debounce pending', pendingBefore, true],
    ['throttle leading and trailing', leading.join(','), 'a,c'],
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
