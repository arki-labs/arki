# @arki/async

Small timing helpers for every JavaScript runtime: an abortable `sleep`, plus `debounce` and `throttle` with the lodash contract.

- **Same as lodash.** `debounce` and `throttle` call the function at the same moments as lodash, with the latest arguments. A migration is a one-line import change. The test suite replays random call schedules against lodash and requires identical results.
- **No leaks.** `sleep` clears its timer and its abort listener when it settles.
- **Coded errors.** Every failure is an `AsyncError` with a stable `code` and a `remediation`.
- **Runs everywhere.** Pure ESM, no dependencies. It only uses `setTimeout`, `clearTimeout`, `AbortSignal` and `Date.now`, at call time. Tested on Node, Bun, Deno and Chromium; built for React Native (Hermes), which has no `Promise.withResolvers` or `AbortSignal.any`, so this package uses neither. Importing it does nothing. Vitest and Jest fake timers work without any setup.

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

### `sleep(ms, { signal }?)`

Returns a promise that resolves after `ms` milliseconds. `ms` is a number from `0` to `2_147_483_647` (about 24.8 days).

- `sleep(0)` still waits for the next macrotask. It never resolves in the same tick.
- An invalid `ms` rejects the promise with `ARKI_ASYNC_E001`. `sleep` never throws synchronously.
- An already-aborted signal rejects at once and creates no timer. Aborting during the wait clears the timer and rejects with `ARKI_ASYNC_E002`. In both cases `error.cause` is `signal.reason`.

### `debounce(fn, wait, { leading, trailing, maxWait }?)`

Delays `fn` until `wait` ms pass without a new call.

| Option     | Default | Meaning                                                                   |
| ---------- | ------- | ------------------------------------------------------------------------- |
| `leading`  | `false` | Call on the first call of a burst.                                        |
| `trailing` | `true`  | Call after the burst ends, with the latest arguments.                     |
| `maxWait`  | none    | Longest a burst may delay the call. Values below `wait` are raised to it. |

With `leading` and `trailing` both on, `fn` runs on the trailing edge only if there was more than one call in the burst.

### `throttle(fn, wait, { leading, trailing }?)`

Calls `fn` at most once per `wait` ms. It is `debounce` with `maxWait = wait`, and both edges on by default.

### `Scheduled<A>`

What `debounce` and `throttle` return. Call it like `fn`.

| Member     | Meaning                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `cancel()` | Drops the pending call and resets the timers.                             |
| `flush()`  | Runs the pending trailing call now. Does nothing when nothing is pending. |
| `pending`  | `true` while a timer runs and a call may still fire.                      |

The returned function does not use `this`. Callers who need the result can `await` inside `fn`; promise-returning variants are left out on purpose.

## Errors

`import { AsyncError } from '@arki/async'`. Match on `error.code`, never on the message. Each error has a `remediation` string.

| Code              | Raised by                       | Meaning                                                          |
| ----------------- | ------------------------------- | ---------------------------------------------------------------- |
| `ARKI_ASYNC_E001` | `sleep`, `debounce`, `throttle` | A wait is negative, `NaN`, not finite, or above `2_147_483_647`. |
| `ARKI_ASYNC_E002` | `sleep`                         | The wait was aborted. `cause` is `signal.reason`.                |

`debounce` and `throttle` throw `E001` when called. `sleep` rejects its promise instead.
