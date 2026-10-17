# @arki/async

Timing and concurrency helpers on plain Promises and `AbortSignal`: an abortable `sleep`, `debounce` and `throttle` with the lodash contract, and scopes with structured concurrency (`scoped`, `all`, `mapConcurrent`, `race`, `timeout`).

- **Same as lodash.** `debounce` and `throttle` call the function at the same moments as lodash, with the latest arguments. The test suite replays random call schedules against lodash and requires identical results.
- **No leaks.** `sleep` clears its timer and its abort listener when it settles. `scoped` releases what its body acquired. `all`, `mapConcurrent` and `race` never settle while a task they started is still running.
- **Coded errors.** Every failure is an `AsyncError` with a stable `code` and a `remediation`.

## Install

```sh
bun add @arki/async
# or
npm install @arki/async
```

## Quick start

Load a list of pages four at a time. Give up after five seconds. Close the connection on every path: success, failure and timeout.

```ts from="examples/load-pages.ts#load-pages"
/** A connection that loads one page at a time and must be closed when the work ends. */
export type PageClient = {
  load(url: string, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
};

/**
 * Loads every page, four at a time, and gives up after five seconds.
 * The client is closed on success, on failure and on timeout.
 */
export function loadPages(
  urls: readonly string[],
  openClient: () => Promise<PageClient>,
  options: { readonly clock?: Clock } = {},
): Promise<string[]> {
  return scoped(async scope => {
    const client = await scope.acquire(openClient, opened => opened.close());
    return timeout(
      signal => mapConcurrent(urls, (url, taskSignal) => client.load(url, taskSignal), { concurrency: 4, signal }),
      5000,
      { signal: scope.signal, ...options },
    );
  });
}
```

`examples/load-pages.ts` is the tested file. Its test runs the success path and the timeout path on a `MockClock`, so five seconds take no time.

Debounce and throttle work like lodash:

```ts run
import { debounce, sleep, throttle } from '@arki/async';

const saved: string[] = [];
const save = debounce((text: string) => {
  saved.push(text);
}, 300); // runs 300 ms after the last call
const onScroll = throttle((_y: number) => undefined, 100); // runs at most every 100 ms

save('a');
save('ab');
save.flush(); // run the pending call now, with the latest arguments
save.cancel(); // drop whatever is still pending
onScroll(10);
await sleep(5);
if (saved.join() !== 'ab' || save.pending) throw new Error(`unexpected: ${saved.join()}`);
```

## When not to use this

- You need a mutex or a semaphore. Use `@arki/lock` with its memory store.
- You need a deferred promise. Use `Promise.withResolvers()`, or `new Promise` with captured `resolve` and `reject` on Hermes.
- You need fibers, typed effects or a scheduler with retries and backoff. Use `@arki/resilience` for retries, or an effect library.
- You need to stop code that ignores `AbortSignal`. Cancellation here is cooperative: a task that never reads its signal keeps running.

## Runtime support

Pure ESM. Its one dependency is `@arki/clock`. It uses `setTimeout`, `clearTimeout`, `AbortController`, `AbortSignal`, `AggregateError` and `Date.now`, at call time. Importing it does nothing. Vitest and Jest fake timers work without setup.

Tested on Node, Bun, Deno and Chromium with `bun run test:runtimes`. Built for React Native (Hermes), which has no `Promise.withResolvers` or `AbortSignal.any`, so this package uses neither. The Hermes leg needs `HERMES_BIN` and prints `INCOMPLETE` when it is missing.

## Public imports

| Import               | Exports                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@arki/async`        | `sleep`, `debounce`, `throttle`, `scoped`, `all`, `mapConcurrent`, `race`, `timeout`, `AsyncError`, `ASYNC_ERROR_CODES`, `MAX_WAIT_MS`, and the option types |
| `@arki/async/errors` | `AsyncError`, `ASYNC_ERROR_CODES`, `MAX_WAIT_MS`, `AsyncErrorCode`                                                                                           |

## Timing API

### `sleep(ms, { signal, clock }?)`

Returns a promise that resolves after `ms` milliseconds. `ms` is a number from `0` to `2_147_483_647` (about 24.8 days).

- `sleep(0)` still waits for the next macrotask. It never resolves in the same tick.
- An invalid `ms` rejects the promise with `ARKI_ASYNC_E001`. `sleep` never throws synchronously.
- An already-aborted signal rejects at once and creates no timer. Aborting during the wait clears the timer and rejects with `ARKI_ASYNC_E002`. In both cases `error.cause` is `signal.reason`.
- `clock` is the `@arki/clock` `Clock` whose timer it waits on. The default is the system clock. Pass a `MockClock` and its `advance(ms)` ends the wait, so tests run instantly without fake timers.

```ts run
import { sleep } from '@arki/async';
import { MockClock } from '@arki/clock';

const clock = new MockClock();
const done = sleep(60_000, { clock });
clock.advance(60_000);
await done; // no real minute passed
```

### `debounce(fn, wait, { leading, trailing, maxWait, clock }?)`

Delays `fn` until `wait` ms pass without a new call.

| Option     | Default | Meaning                                                                   |
| ---------- | ------- | ------------------------------------------------------------------------- |
| `leading`  | `false` | Call on the first call of a burst.                                        |
| `trailing` | `true`  | Call after the burst ends, with the latest arguments.                     |
| `maxWait`  | none    | Longest a burst may delay the call. Values below `wait` are raised to it. |
| `clock`    | system  | The `Clock` whose time and timers it uses. Pass a `MockClock` in tests.   |

With `leading` and `trailing` both on, `fn` runs on the trailing edge only if there was more than one call in the burst.

### `throttle(fn, wait, { leading, trailing, clock }?)`

Calls `fn` at most once per `wait` ms. It is `debounce` with `maxWait = wait`, and both edges on by default. `clock` works as in `debounce`.

### `Scheduled<A>`

What `debounce` and `throttle` return. Call it like `fn`.

| Member     | Meaning                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `cancel()` | Drops the pending call and resets the timers.                             |
| `flush()`  | Runs the pending trailing call now. Does nothing when nothing is pending. |
| `pending`  | `true` while a timer runs and a call may still fire.                      |

The returned function does not use `this`. Callers who need the result can `await` inside `fn`; promise-returning variants are left out on purpose.

## Scopes and structured concurrency

The guarantees Effect is known for (owned lifetimes, no orphaned work, cleanup that always runs) on plain Promises and `AbortSignal`. No fibers, no effect type. Every task takes a `signal`; cancellation is cooperative, so pass that signal on to `fetch`, `sleep` and anything else that accepts one.

### `scoped(body, { signal }?)`

Runs `body` with an owned lifetime. What it acquires or defers is released when it ends, whether it resolves or rejects.

```ts run
import { scoped } from '@arki/async';

const events: string[] = [];
const connect = (_signal: AbortSignal) =>
  Promise.resolve({
    query: (sql: string) => Promise.resolve([sql]),
    close: () => {
      events.push('db closed');
      return Promise.resolve();
    },
  });

const rows = await scoped(async scope => {
  const db = await scope.acquire(connect, opened => opened.close());
  scope.defer(() => {
    events.push('metrics flushed');
  });
  return db.query('select 1');
}); // scope.signal aborted, then the finalizers run, newest first
if (rows[0] !== 'select 1' || events.join() !== 'metrics flushed,db closed') throw new Error(events.join());
```

- `scope.signal` aborts when the outer `signal` aborts, when `body` rejects (reason: the error), or when the scope ends, so stragglers stop.
- `scope.acquire(open, close)` registers `close` only after `open` succeeds. `scope.defer(fn)` registers any finalizer.
- On exit, `scope.signal` aborts first, then the finalizers run one at a time, newest first, each awaited. All of them run even when one throws.
- Body rejects, cleanup clean: rejects with the body error, unchanged. Any finalizer throws: rejects with `ARKI_ASYNC_E003`; `error.cause` is the body error (or `undefined`) and `error.errors` lists the finalizer errors in run order.
- An already-aborted `signal` rejects with `ARKI_ASYNC_E002` and never runs `body`.

### `all(tasks, { concurrency, signal }?)`

`Promise.all` for tasks that take a signal, typed per position like `Promise.all`.

```ts run
import { all } from '@arki/async';

const getUser = (_signal: AbortSignal) => Promise.resolve({ name: 'Ana' });
const getOrders = (_signal: AbortSignal) => Promise.resolve([1, 2, 3]);

const [user, orders] = await all([signal => getUser(signal), signal => getOrders(signal)]);
if (user.name !== 'Ana' || orders.length !== 3) throw new Error('unexpected results');
```

At most `concurrency` tasks run at once (default: all). On the first rejection the shared signal aborts so the siblings see it, no pending task starts, and the promise waits for the tasks in flight to settle before it rejects with that first error. No task outlives the call. Aborting `signal` does the same and rejects with `ARKI_ASYNC_E002`. On success the signal is left alone, so a result tied to it (a `fetch` response body) stays readable.

### `mapConcurrent(items, fn, { concurrency, signal }?)`

The same contract as `all`, for a list: maps `items` through `fn(item, signal, index)` and resolves with the results in input order. `items` is read in full before the first call.

```ts
import { mapConcurrent } from '@arki/async';

declare const urls: string[];

const pages = await mapConcurrent(urls, (url, signal) => fetch(url, { signal }).then(r => r.text()), {
  concurrency: 4,
});
```

### `race(tasks, { signal }?)`

The first task to **fulfill** wins, like `Promise.any`. This is not `Promise.race`, where the first task to settle wins even when it rejects.

```ts
import { race } from '@arki/async';

declare const mirrors: string[];

const body = await race(mirrors.map(url => signal => fetch(url, { signal }).then(r => r.text())));
```

When one task fulfills, every other task's signal aborts, and the promise waits for those losers to settle before it resolves. The winner's signal is never aborted. When every task rejects (or the list is empty), it rejects with an `AggregateError` of their errors in input order. Aborting `signal` aborts every task, waits for them, and rejects with `ARKI_ASYNC_E002`.

### `timeout(task, ms, { signal, clock }?)`

Runs `task` with a deadline.

```ts
import { timeout } from '@arki/async';

declare const url: string;

const res = await timeout(signal => fetch(url, { signal }), 5000); // rejects with ARKI_ASYNC_E004 after 5 s
```

At `ms` the task's signal aborts (reason: the `ARKI_ASYNC_E004` error) and the promise rejects at once. Cancellation is cooperative: `timeout` does not wait for a task that ignores its signal, so such a task can keep running. Inside `scoped`, pass `scope.signal` as `signal`; the scope still owns that work and aborts it when the scope ends. `ms` follows the `sleep` rules (`ARKI_ASYNC_E001`). `clock` sets whose timer measures the deadline, as in `sleep`.

### Invalid `concurrency`

`concurrency` must be a positive integer or `Infinity`. Anything else rejects with `ARKI_ASYNC_E005` before any task starts.

### Not included: semaphore, mutex, deferred

Use `@arki/lock` with its memory store for a mutex or a semaphore, and `Promise.withResolvers()` for a deferred (on Hermes, which lacks it, `new Promise` with captured `resolve` and `reject`).

## Failure behaviour

Every failure is an `AsyncError` with a stable `code` and a `remediation` sentence. Match on `error.code`, never on the message.

`debounce` and `throttle` throw `ARKI_ASYNC_E001` when you call them with a bad wait. Every other function rejects its promise and never throws synchronously. A task that throws its own error makes `all`, `mapConcurrent` and `timeout` reject with that error unchanged. `race` rejects with an `AggregateError` when every task fails.

| Code              | Raised by                                                    | Meaning                                                                                    |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `ARKI_ASYNC_E001` | `sleep`, `debounce`, `throttle`, `timeout`                   | A wait is negative, `NaN`, not finite, or above `2_147_483_647`.                           |
| `ARKI_ASYNC_E002` | `sleep`, `scoped`, `all`, `mapConcurrent`, `race`, `timeout` | The work was aborted by its signal. `cause` is `signal.reason`.                            |
| `ARKI_ASYNC_E003` | `scoped`                                                     | A finalizer threw. `errors` lists the finalizer errors; `cause` is the body error, if any. |
| `ARKI_ASYNC_E004` | `timeout`                                                    | The deadline passed before the task finished.                                              |
| `ARKI_ASYNC_E005` | `all`, `mapConcurrent`                                       | `concurrency` is not a positive integer or `Infinity`.                                     |

Handle a timeout and an abort apart:

```ts run
import { ASYNC_ERROR_CODES, AsyncError, sleep, timeout } from '@arki/async';

try {
  await timeout(signal => sleep(1000, { signal }), 10);
  throw new Error('timeout should have rejected');
} catch (error) {
  if (!(error instanceof AsyncError) || error.code !== ASYNC_ERROR_CODES.timedOut) throw error;
  // ARKI_ASYNC_E004: show "try again later". An E002 means someone aborted on purpose.
}
```

## Limits

- The longest wait is `MAX_WAIT_MS`: 2^31 - 1 ms, about 24.8 days. `sleep(2_147_483_647)` works. `sleep(2_147_483_648)` rejects with `ARKI_ASYNC_E001`. Sleep again when the timer fires for longer waits.
- Cancellation is cooperative. `timeout(task, 100)` rejects at 100 ms, but a task that ignores its signal keeps running after that.
- `concurrency` is a positive integer or `Infinity`. `concurrency: 0` rejects with `ARKI_ASYNC_E005` before any task starts.
- `all` and `mapConcurrent` read their input in full before the first call. Do not pass an endless iterable.
- `race` returns the first task to fulfill, not the first to settle. A fast failure does not win.
- `debounce` and `throttle` return no result and do not use `this`. Await inside the function when you need a result.

## Documentation

- [Agent guide](./docs/agent-guide.md): tasks, rules that bite, errors.
- [llms.txt](./llms.txt): the index an agent reads first.
- [Changelog](./CHANGELOG.md).

## Support

Report a bug or ask a question at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues). Include the call, the options and the error code you saw.

## License

MIT. See [LICENSE](./LICENSE).
