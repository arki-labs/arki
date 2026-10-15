// Speed of @arki/async against the debounce, throttle and delay libraries most projects use.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// These groups measure scheduling overhead, not waiting: each run creates the
// scheduled function, calls it a few times inside one wait window, then cancels
// it, so no timer survives and no run sleeps. Every `compare` group states a
// contract that is checked before timing; a library that keeps a different
// promise is marked `differs` and shown without a ratio.

import delay from 'delay';
import { debounce as debounceEsToolkit, throttle as throttleEsToolkit } from 'es-toolkit';
import justDebounce from 'just-debounce-it';
import debounceLodash from 'lodash.debounce';
import throttleLodash from 'lodash.throttle';
import pLimit from 'p-limit';
import pMap from 'p-map';
import { debounce as debounceTd, throttle as throttleTd } from 'throttle-debounce';

import { debounce, mapConcurrent, sleep, throttle } from '@arki/async';
import { compare, defineSuite } from '@arki/bench';

/** Long enough that no timer fires while a run is in progress. */
const WAIT = 60_000;

/** The shape every library's scheduled function shares for this bench. */
type Controlled = { (value: number): void; cancel(): void };

/** Create, call `calls` times with 0..calls-1, cancel; report how many times `fn` ran and with what first argument. */
function drive(calls: number, create: (fn: (value: number) => void) => Controlled): string {
  const seen: number[] = [];
  const scheduled = create(value => void seen.push(value));
  for (let i = 0; i < calls; i++) scheduled(i);
  scheduled.cancel();
  return `${seen.length}:${seen[0] ?? '-'}`;
}

const CALLS = [1, 10, 100];

/** Concurrency limit of the mapping groups: low enough that the queue, not `Promise.all`, does the work. */
const LIMIT = 8;

/** The mapped function: async, resolves on the next microtask, so the numbers are pool overhead. */
const double = (value: number): Promise<number> => Promise.resolve(value * 2);

/** `[0, 1, …, n - 1]`, the items each mapping run gets. */
const range = (n: number): number[] => Array.from({ length: n }, (_, index) => index);

export default defineSuite({
  id: '@arki/async',
  intro:
    'Speed of `@arki/async` against `lodash`, `es-toolkit`, `throttle-debounce`, `just-debounce-it`, `delay`, `p-map` and `p-limit`. Each debounce or throttle run creates the scheduled function, calls it inside one wait window and cancels it, so the numbers are scheduling overhead, not time spent waiting. Each mapping run maps n numbers through an async function that resolves at once, so the numbers are the cost of the concurrency pool. Each table only ranks libraries that returned the same result on every checked input.',
  notes: [
    'Run on a real clock with a 60 second wait that is never reached; nothing here uses fake timers.',
    '`lodash.debounce` and `lodash.throttle` are the standalone packages (4.0.8 and 4.1.1) most projects install; the monolithic `lodash` 4.18 behaves like `@arki/async`.',
    '`@arki/async` also validates the wait and returns typed controls (`cancel`, `flush`, `pending`).',
    '`mapConcurrent` also hands every call a shared `AbortSignal` that aborts on the first failure, and waits for in-flight calls before it rejects; `p-map` and `p-limit` do neither, so on the success path measured here `@arki/async` does strictly more work.',
  ],
  groups: [
    compare<number>({
      id: 'debounce-leading',
      title: 'Debounce, leading edge: first call runs, the rest are dropped',
      contract: {
        id: 'async-debounce-leading/v1',
        description:
          'after n calls inside one wait, the function ran exactly once, with the first call’s argument, and cancel dropped the rest',
      },
      inputs: CALLS,
      expected: () => '1:0',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/async',
          package: '@arki/async',
          run: calls => drive(calls, fn => debounce(fn, WAIT, { leading: true, trailing: false })),
        },
        lodash: {
          label: 'lodash.debounce',
          package: 'lodash.debounce',
          run: calls => drive(calls, fn => debounceLodash(fn, WAIT, { leading: true, trailing: false })),
        },
        esToolkit: {
          label: 'es-toolkit',
          package: 'es-toolkit',
          run: calls => drive(calls, fn => debounceEsToolkit(fn, WAIT, { edges: ['leading'] })),
        },
        throttleDebounce: {
          label: 'throttle-debounce',
          package: 'throttle-debounce',
          run: calls => drive(calls, fn => debounceTd(WAIT, fn, { atBegin: true })),
        },
        just: {
          label: 'just-debounce-it',
          package: 'just-debounce-it',
          run: calls => drive(calls, fn => justDebounce(fn, WAIT, true)),
        },
      },
    }),
    compare<number>({
      id: 'debounce-trailing',
      title: 'Debounce, trailing edge: nothing runs before the wait ends',
      contract: {
        id: 'async-debounce-trailing/v1',
        description: 'after n calls inside one wait, the function has not run, and cancel drops the pending call',
      },
      inputs: CALLS,
      expected: () => '0:-',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/async',
          package: '@arki/async',
          run: calls => drive(calls, fn => debounce(fn, WAIT)),
        },
        lodash: {
          label: 'lodash.debounce',
          package: 'lodash.debounce',
          run: calls => drive(calls, fn => debounceLodash(fn, WAIT)),
        },
        esToolkit: {
          label: 'es-toolkit',
          package: 'es-toolkit',
          run: calls => drive(calls, fn => debounceEsToolkit(fn, WAIT)),
        },
        throttleDebounce: {
          label: 'throttle-debounce',
          package: 'throttle-debounce',
          run: calls => drive(calls, fn => debounceTd(WAIT, fn)),
        },
        just: {
          label: 'just-debounce-it',
          package: 'just-debounce-it',
          run: calls => drive(calls, fn => justDebounce(fn, WAIT)),
        },
      },
    }),
    compare<number>({
      id: 'throttle',
      title: 'Throttle, default edges: the first call runs at once, the rest wait for the window to end',
      contract: {
        id: 'async-throttle/v1',
        description:
          'after n calls inside one wait, the function ran exactly once, with the first call’s argument, and cancel dropped the trailing call',
      },
      inputs: CALLS,
      expected: () => '1:0',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/async',
          package: '@arki/async',
          run: calls => drive(calls, fn => throttle(fn, WAIT)),
        },
        lodash: {
          label: 'lodash.throttle',
          package: 'lodash.throttle',
          run: calls => drive(calls, fn => throttleLodash(fn, WAIT)),
        },
        esToolkit: {
          label: 'es-toolkit',
          package: 'es-toolkit',
          run: calls => drive(calls, fn => throttleEsToolkit(fn, WAIT)),
        },
        throttleDebounce: {
          label: 'throttle-debounce',
          package: 'throttle-debounce',
          run: calls => drive(calls, fn => throttleTd(WAIT, fn)),
        },
      },
    }),
    compare<number>({
      id: 'map-concurrent',
      title: `Map n items through an async function, at most ${LIMIT} in flight`,
      contract: {
        id: 'async-map-concurrent/v1',
        description: `every item is mapped, at most ${LIMIT} calls run at once, and the results come back in input order`,
      },
      mode: 'async',
      inputs: [1, 100, 1000],
      expected: n => range(n).map(value => value * 2),
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/async',
          package: '@arki/async',
          setup: range,
          run: items => mapConcurrent(items, double, { concurrency: LIMIT }),
        },
        pMap: {
          label: 'p-map',
          package: 'p-map',
          setup: range,
          run: items => pMap(items, double, { concurrency: LIMIT }),
        },
        pLimit: {
          label: 'p-limit',
          package: 'p-limit',
          setup: range,
          run: items => {
            const limit = pLimit(LIMIT);
            return Promise.all(items.map(item => limit(() => double(item))));
          },
        },
      },
    }),
    compare<string>({
      id: 'sleep-abort',
      title: 'Sleep with a signal that is already aborted',
      contract: {
        id: 'async-sleep-abort/v1',
        description: 'the promise rejects at once, without waiting for the delay',
      },
      mode: 'async',
      inputs: ['abort'],
      expected: () => 'rejected',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/async',
          package: '@arki/async',
          setup: () => AbortSignal.abort(),
          run: signal =>
            sleep(WAIT, { signal }).then(
              () => 'resolved',
              () => 'rejected',
            ),
        },
        delay: {
          label: 'delay',
          package: 'delay',
          setup: () => AbortSignal.abort(),
          run: signal =>
            delay(WAIT, { signal }).then(
              () => 'resolved',
              () => 'rejected',
            ),
        },
      },
    }),
  ],
});
