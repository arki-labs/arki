# @arki/async

Small timing and concurrency helpers for every JavaScript runtime: an abortable `sleep`, `debounce` and `throttle` with the lodash contract, and scopes plus structured concurrency (`scoped`, `all`, `mapConcurrent`, `race`, `timeout`) on plain Promises and `AbortSignal`.

- **Same as lodash.** `debounce` and `throttle` call the function at the same moments as lodash, with the latest arguments. A migration is a one-line import change. The test suite replays random call schedules against lodash and requires identical results.
- **No leaks.** `sleep` clears its timer and its abort listener when it settles. `scoped` releases what its body acquired, and `all`, `mapConcurrent` and `race` never settle while a task they started is still running.
- **Coded errors.** Every failure is an `AsyncError` with a stable `code` and a `remediation`.
- **Runs everywhere.** Pure ESM. Its one dependency is `@arki/clock`. It only uses `setTimeout`, `clearTimeout`, `AbortController`, `AbortSignal`, `AggregateError` and `Date.now`, at call time. Tested on Node, Bun, Deno and Chromium; built for React Native (Hermes), which has no `Promise.withResolvers` or `AbortSignal.any`, so this package uses neither. Importing it does nothing. Vitest and Jest fake timers work without any setup.

```ts
import { debounce, sleep, throttle } from '@arki/async';

await sleep(250); // wait a quarter second
await sleep(5000, { signal }); // rejects with ARKI_ASYNC_E002 when the signal aborts

const save = debounce(write, 300); // runs 300 ms after the last call
const onScroll = throttle(update, 100); // runs at most every 100 ms
save.flush(); // run the pending call now
save.cancel(); // drop it
```

## API

### `sleep(ms, { signal, clock }?)`

Returns a promise that resolves after `ms` milliseconds. `ms` is a number from `0` to `2_147_483_647` (about 24.8 days).

- `sleep(0)` still waits for the next macrotask. It never resolves in the same tick.
- An invalid `ms` rejects the promise with `ARKI_ASYNC_E001`. `sleep` never throws synchronously.
- An already-aborted signal rejects at once and creates no timer. Aborting during the wait clears the timer and rejects with `ARKI_ASYNC_E002`. In both cases `error.cause` is `signal.reason`.
- `clock` is the `@arki/clock` `Clock` whose timer it waits on. The default is the system clock. Pass a `MockClock` and its `advance(ms)` ends the wait, so tests run instantly without fake timers.

```ts
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

```ts
import { scoped } from '@arki/async';

const rows = await scoped(async scope => {
  const db = await scope.acquire(
    signal => connect(url, { signal }),
    db => db.close(),
  );
  scope.defer(() => metrics.flush());
  return db.query('select 1', { signal: scope.signal });
}); // db closed, metrics flushed, scope.signal aborted
```

- `scope.signal` aborts when the outer `signal` aborts, when `body` rejects (reason: the error), or when the scope ends, so stragglers stop.
- `scope.acquire(open, close)` registers `close` only after `open` succeeds. `scope.defer(fn)` registers any finalizer.
- On exit, `scope.signal` aborts first, then the finalizers run one at a time, newest first, each awaited. All of them run even when one throws.
- Body rejects, cleanup clean: rejects with the body error, unchanged. Any finalizer throws: rejects with `ARKI_ASYNC_E003`; `error.cause` is the body error (or `undefined`) and `error.errors` lists the finalizer errors in run order.
- An already-aborted `signal` rejects with `ARKI_ASYNC_E002` and never runs `body`.

### `all(tasks, { concurrency, signal }?)`

`Promise.all` for tasks that take a signal, typed per position like `Promise.all`.

```ts
import { all } from '@arki/async';

const [user, orders] = await all([signal => getUser(id, { signal }), signal => getOrders(id, { signal })]);
```

At most `concurrency` tasks run at once (default: all). On the first rejection the shared signal aborts so the siblings see it, no pending task starts, and the promise waits for the tasks in flight to settle before it rejects with that first error. No task outlives the call. Aborting `signal` does the same and rejects with `ARKI_ASYNC_E002`. On success the signal is left alone, so a result tied to it (a `fetch` response body) stays readable.

### `mapConcurrent(items, fn, { concurrency, signal }?)`

The same contract as `all`, for a list: maps `items` through `fn(item, signal, index)` and resolves with the results in input order. `items` is read in full before the first call.

```ts
import { mapConcurrent } from '@arki/async';

const pages = await mapConcurrent(urls, (url, signal) => fetch(url, { signal }).then(r => r.text()), {
  concurrency: 4,
});
```

### `race(tasks, { signal }?)`

The first task to **fulfill** wins, like `Promise.any`. This is not `Promise.race`, where the first task to settle wins even when it rejects.

```ts
import { race } from '@arki/async';

const body = await race(mirrors.map(url => signal => fetch(url, { signal }).then(r => r.text())));
```

When one task fulfills, every other task's signal aborts, and the promise waits for those losers to settle before it resolves. The winner's signal is never aborted. When every task rejects (or the list is empty), it rejects with an `AggregateError` of their errors in input order. Aborting `signal` aborts every task, waits for them, and rejects with `ARKI_ASYNC_E002`.

### `timeout(task, ms, { signal, clock }?)`

Runs `task` with a deadline.

```ts
import { timeout } from '@arki/async';

const res = await timeout(signal => fetch(url, { signal }), 5000); // rejects with ARKI_ASYNC_E004 after 5 s
```

At `ms` the task's signal aborts (reason: the `ARKI_ASYNC_E004` error) and the promise rejects at once. Cancellation is cooperative: `timeout` does not wait for a task that ignores its signal, so such a task can keep running. Inside `scoped`, pass `scope.signal` as `signal`; the scope still owns that work and aborts it when the scope ends. `ms` follows the `sleep` rules (`ARKI_ASYNC_E001`). `clock` sets whose timer measures the deadline, as in `sleep`.

### Invalid `concurrency`

`concurrency` must be a positive integer or `Infinity`. Anything else rejects with `ARKI_ASYNC_E005` before any task starts.

### Not included: semaphore, mutex, deferred

Use `@arki/lock` with its memory store for a mutex or a semaphore, and `Promise.withResolvers()` for a deferred (on Hermes, which lacks it, `new Promise` with captured `resolve` and `reject`).

## Errors

`import { AsyncError } from '@arki/async'`. Match on `error.code`, never on the message. Each error has a `remediation` string.

| Code              | Raised by                                                    | Meaning                                                                                    |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `ARKI_ASYNC_E001` | `sleep`, `debounce`, `throttle`, `timeout`                   | A wait is negative, `NaN`, not finite, or above `2_147_483_647`.                           |
| `ARKI_ASYNC_E002` | `sleep`, `scoped`, `all`, `mapConcurrent`, `race`, `timeout` | The work was aborted by its signal. `cause` is `signal.reason`.                            |
| `ARKI_ASYNC_E003` | `scoped`                                                     | A finalizer threw. `errors` lists the finalizer errors; `cause` is the body error, if any. |
| `ARKI_ASYNC_E004` | `timeout`                                                    | The deadline passed before the task finished.                                              |
| `ARKI_ASYNC_E005` | `all`, `mapConcurrent`                                       | `concurrency` is not a positive integer or `Infinity`.                                     |

`debounce` and `throttle` throw `E001` when called. Every other function rejects its promise instead and never throws synchronously.
