# @arki/async

Timing and concurrency helpers on plain Promises and `AbortSignal`: an abortable `sleep`, `debounce` and `throttle` with the lodash contract, and scopes with structured concurrency (`scoped`, `all`, `mapConcurrent`, `race`, `timeout`).

- **Same as lodash.** `debounce` and `throttle` call the function at the same moments as lodash, with the latest arguments. The test suite replays random call schedules against lodash and requires identical results.
- **No leaks.** `sleep` clears its timer and its abort listener when it settles. `scoped` releases what its body acquired. `all`, `mapConcurrent` and `race` never settle while a task they started is still running.
- **Typed owned outcomes.** Scopes infer callback refusals. Concurrency and waits return canonical cancellation, deadline and defect values. Static setup misuse still throws `AsyncError`.

## Install

```sh
bun add @arki/async
# or
npm install @arki/async
```

## Quick start

Load pages four at a time. Request cancellation after five seconds, wait for started loads to settle, and close the connection on every path.

```ts from="examples/load-pages.ts#load-pages"
/** A connection that loads one page at a time and must be closed when the work ends. */
export type PageClient = {
  load(url: string, signal: AbortSignal): Promise<string | FailureOf<typeof sleep>>;
  close(): Promise<void>;
};

/**
 * Loads every page, four at a time, and requests cancellation after five seconds.
 * All started loads settle before the client closes, including on a deadline.
 */
export function loadPages(
  urls: readonly string[],
  openClient: () => Promise<PageClient>,
  options: { readonly clock?: Clock } = {},
) {
  const clock = options.clock ?? new SystemClock();
  return scoped(
    {
      deadline: resource(
        () => {
          const controller = new AbortController();
          const cancel = clock.setTimer(() => controller.abort(), 5000);
          return { signal: controller.signal, cancel };
        },
        deadline => deadline.cancel(),
      ),
    },
    ({ deadline }, signal) =>
      scoped(
        { client: resource(openClient, client => client.close()) },
        ({ client }, taskSignal) =>
          mapConcurrent(urls, (url, pageSignal) => client.load(url, pageSignal), {
            concurrency: 4,
            signal: taskSignal,
          }),
        { signal, deadline: deadline.signal },
      ),
  );
}
```

`examples/load-pages.ts` is the tested file. Its test runs the success path and the timeout path on a `MockClock`, so five seconds take no time.

Debounce and throttle work like lodash:

```ts run
import { debounce, sleep, throttle } from '@arki/async';
import { orThrow } from '@arki/failure';

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
orThrow(await sleep(5));
if (saved.join() !== 'ab' || save.pending) throw new Error(`unexpected: ${saved.join()}`);
```

## When not to use this

- You need a mutex or a semaphore. Use `@arki/lock` with its memory store.
- You need a deferred promise. Use `Promise.withResolvers()`, or `new Promise` with captured `resolve` and `reject` on Hermes.
- You need fibers, typed effects or a scheduler with retries and backoff. Use `@arki/resilience` for retries, or an effect library.
- You need to stop code that ignores `AbortSignal`. Cancellation here is cooperative: a task that never reads its signal keeps running.

## Runtime support

Pure ESM. Runtime dependencies are `@arki/clock`, `@arki/failure`, `@arki/schema` and the OpenTelemetry API; Standard Schema is type-only. It uses `setTimeout`, `clearTimeout`, `AbortController`, `AbortSignal`, `AggregateError` and `Date.now`, at call time. Importing it does nothing. Vitest and Jest fake timers work without setup.

Tested on Node, Bun, Deno and Chromium with `bun run test:runtimes`. Built for React Native (Hermes), which has no `Promise.withResolvers` or `AbortSignal.any`, so this package uses neither. The Hermes leg needs `HERMES_BIN` and prints `INCOMPLETE` when it is missing.

## Public imports

| Import               | Exports                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@arki/async`        | `sleep`, `debounce`, `throttle`, `all`, `mapConcurrent`, `race`, `timeout`; `resource`, `cleanup`, `child`, `scoped`, `openScope`, `dynamicScope`, `createLifetime`; descriptor guards/types, scope failures and timing errors |
| `@arki/async/errors` | `AsyncError`, `ASYNC_ERROR_CODES`, `MAX_WAIT_MS`, `AsyncErrorCode`; `Cancelled`, `Deadline`, `ScopeFailed`, `scopeAggregate`, `SUPERVISOR_FAILURES` and their types                                                            |

## Timing API

### `sleep(ms, { signal, clock }?)`

Returns a promise that resolves after `ms` milliseconds. `ms` is a number from `0` to `2_147_483_647` (about 24.8 days).

- `sleep(0)` still waits for the next macrotask. It never resolves in the same tick.
- An invalid `ms` rejects the promise with `ARKI_ASYNC_E001`. `sleep` never throws synchronously.
- An already-aborted signal returns `Cancelled` and creates no timer. Aborting during the wait clears the timer before returning cancellation; its private cause is `signal.reason`. Clock provider faults return `UnexpectedDefect`. A default-clock wait with no signal has no cancellation outcome; an injected clock retains its cancellation contract.
- `clock` is the `@arki/clock` `Clock` whose timer it waits on. The default is the system clock. Pass a `MockClock` and its `advance(ms)` ends the wait, so tests run instantly without fake timers.

```ts run
import { sleep } from '@arki/async';
import { MockClock } from '@arki/clock';
import { isFailure } from '@arki/failure';

const clock = new MockClock();
const done = sleep(60_000, { clock });
clock.advance(60_000);
const outcome = await done; // no real minute passed
if (isFailure(outcome)) throw new Error(outcome.code);
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

### `scoped(plan, body, { signal, deadline }?)`

Describe owned work before starting it. `resource(open, close)` acquires a value and registers cleanup only on success. `cleanup(close)` registers a finalizer; `child(run)` starts work whose settlement belongs to the scope. The body receives the successful resources and a cancellation signal.

```ts run
import { cleanup, resource, scoped } from '@arki/async';
import { isFailure } from '@arki/failure';

const events: string[] = [];
const rows = await scoped(
  {
    db: resource(
      () => ({ query: () => ['select 1'] }),
      () => {
        events.push('db closed');
      },
    ),
    metrics: cleanup(() => {
      events.push('metrics flushed');
    }),
  },
  ({ db }) => db.query(),
);
if (isFailure(rows)) throw new Error(rows.code);
if (rows[0] !== 'select 1' || events.join() !== 'metrics flushed,db closed') throw new Error(events.join());
```

Closure stops admission, requests cancellation, joins every admitted child/acquisition, then runs finalizers newest first, one at a time. Every finalizer is attempted. A child may use its resources while responding to shutdown. Noncooperative work keeps closure pending; a deadline cannot forcibly stop JavaScript.

A single refusal is returned unchanged. Multiple primary or cleanup failures produce `ScopeFailed`, with exact local members in its private `cause`. Public serialized data contains only counts; revival does not reconstruct private members. Unknown throws become `UnexpectedDefect`. External abort reasons become `Cancelled`; a separate deadline signal becomes `Deadline`. Normal owner-requested shutdown is control flow, not a failed result.

Use lexical nesting when one resource or child needs an earlier resource. Use `openScope(plan)` when transferring a lifetime: check its result with `isFailure`, then retain and eventually await the successful handle's `close()`. Repeated closes share the complete settlement.

For dynamic work, `dynamicScope([CanonicalFailure, ...])` fixes the allowed failure definitions before its body runs. Its `acquire`, `defer`, and `fork` registrations cannot enlarge that contract. An admitted acquisition failure remains owned even when its returned promise is ignored; recover before admission or in a separately supervised attempt.

Owned lifetimes (`scoped`, `openScope`, `dynamicScope`, and `createLifetime`) emit one OpenTelemetry `async.scope` span and an `async.scope.duration` histogram under `@arki/async`. The span stays open through cancellation, child joining and cleanup. It records failure codes, status and counts; resource values, abort reasons and private causes are never exported. Owner-requested shutdown is successful control flow. Descriptor construction and guards do not emit spans. Concurrent calls emit one `async.all`, `async.mapConcurrent`, `async.race` or `async.timeout` span and an `async.operation.duration` histogram. Task callbacks activate the owner context; no per-item span duplicates it. A timeout span ends at the deadline; late task settlement cannot end it again. Raw Clock methods, sleep and debounce/throttle are timing substrates observed by enclosing work and do not emit a span per timer.

Install your SDK and context manager at the app entry; providers may be registered after importing this package. With no SDK the API is a no-op. Scope callbacks activate the owned span, so nested scopes, custom OTel operations and app-configured log correlation share its trace. Use the typed `@opentelemetry/api` context, trace and metrics APIs for custom instrumentation. The library installs no SDK, logger or runtime-specific context manager. Telemetry failures cannot change callback execution or scope outcomes. Context across awaits requires an app-provided context manager for the runtime (including Hermes).

### `all(tasks, { concurrency, signal }?)`

`Promise.all` for tasks that take a signal, typed per position like `Promise.all`.

```ts run
import { all } from '@arki/async';
import { isFailure } from '@arki/failure';

const getUser = (_signal: AbortSignal) => Promise.resolve({ name: 'Ana' });
const getOrders = (_signal: AbortSignal) => Promise.resolve([1, 2, 3]);

const result = await all([signal => getUser(signal), signal => getOrders(signal)]);
if (isFailure(result)) throw new Error(result.code);
const [user, orders] = result;
if (user.name !== 'Ana' || orders.length !== 3) throw new Error('unexpected results');
```

At most `concurrency` tasks run at once (default: all). On the first rejection the shared signal aborts so the siblings see it, no pending task starts, and the promise waits for the tasks in flight to settle before returning `UnexpectedDefect` with that first exception as its private cause. No task outlives the call. Aborting `signal` does the same and returns `Cancelled`. On success the signal is left alone, so a result tied to it (a `fetch` response body) stays readable.

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

When one task fulfills, every other task's signal aborts, and the promise waits for those losers to settle before it resolves. The winner's signal is never aborted. When every task rejects, it returns `UnexpectedDefect` with a private `AggregateError` of their exceptions in input order. An empty task list is static misuse and rejects with `AggregateError`. Aborting `signal` aborts every task, waits for them, and returns `Cancelled`.

### `timeout(task, ms, { signal, clock }?)`

Runs `task` with a deadline.

```ts
import { timeout } from '@arki/async';

declare const url: string;

const res = await timeout(signal => fetch(url, { signal }), 5000); // returns Deadline after 5 s
```

At `ms` the task's signal aborts with the canonical `Deadline` value and the operation returns that value. Task exceptions return `UnexpectedDefect`; external cancellation returns `Cancelled`. Late settlements remain observed. Cancellation is cooperative: `timeout` does not wait for a task that ignores its signal, so such a task can keep running. Passing a scope signal to `timeout` does not make its detached settlement owned. Await the original work or register it with `child`; prefer a scope deadline signal when resources must stay alive until work settles. `ms` follows the `sleep` rules (`ARKI_ASYNC_E001`). `clock` sets whose timer measures the deadline, as in `sleep`.

### Invalid `concurrency`

`concurrency` must be a positive integer or `Infinity`. Anything else rejects with `ARKI_ASYNC_E005` before any task starts.

### Not included: semaphore, mutex, deferred

Use `@arki/lock` with its memory store for a mutex or a semaphore, and `Promise.withResolvers()` for a deferred (on Hermes, which lacks it, `new Promise` with captured `resolve` and `reject`).

## Failure behaviour

Owned work returns ordinary values or canonical failures from `@arki/failure`. A returned failure keeps its original identity. Callback exceptions and provider registration/cleanup defects become `UnexpectedDefect` with private causes. `race` preserves first-fulfillment semantics: a losing rejection does not replace a later fulfilled value; when all tasks reject their exceptions remain in its private aggregate cause.

`all` and `mapConcurrent` preserve fulfilled `Failure` values as explicit tuple/array elements. They do not hoist them or stop admission because of them. `race` and `timeout` preserve a directly fulfilled failure unchanged. The failure union is inferred from actual operation and callback results.

| Code                        | Owner                          | Meaning                                                                     |
| --------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `async.cancelled`           | Waits and concurrency          | An external signal or clock provider cancelled the operation.               |
| `async.deadline`            | Scopes and timeout             | The owned deadline elapsed.                                                 |
| `async.scope_failed`        | Scopes                         | Multiple primary/cleanup failures; public counts and exact private members. |
| `failure.unexpected_defect` | Owned execution                | A callback or foreign provider failed unexpectedly.                         |
| `ARKI_ASYNC_E001`           | Static delay definitions       | Delay is outside the supported timer range.                                 |
| `ARKI_ASYNC_E005`           | Static concurrency definitions | Limit is not a positive integer or Infinity.                                |

Static misuse may throw; async helpers reject their returned promise for it. `debounce` and `throttle` invoke their void callbacks directly and retain the foreign callback exception contract. They do not supervise detached promises returned from a callback.

```ts run
import { Deadline, sleep, timeout } from '@arki/async';

const outcome = await timeout(signal => sleep(1000, { signal }), 10);
if (!Deadline.is(outcome)) throw new Error('expected a deadline');
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
