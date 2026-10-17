# @arki/async for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. Work is a function that takes an `AbortSignal`: `(signal) => Promise<T>`. The helpers start it, bound it and stop it.
2. `scoped` owns a lifetime. What the body acquires or defers is released when it ends.
3. `all`, `mapConcurrent`, `race` and `timeout` share one internal signal. The first failure aborts it, so siblings see it.
4. Cancellation is cooperative. A task must pass its signal to `fetch`, `sleep` and anything else that accepts one.
5. Time comes from a `Clock`. Tests pass a `MockClock`.

## Task map

### Load many things with a limit and a deadline

1. Open the shared resource with `scope.acquire`, so it closes on every path.
2. Wrap `mapConcurrent` in `timeout`, and pass `scope.signal` as the outer signal.
3. Pass each task's `signal` on to the work it starts.

The tested version is `examples/load-pages.ts` in the repository. A smaller form:

```ts run
import { mapConcurrent } from '@arki/async';

const doubled = await mapConcurrent([1, 2, 3, 4], n => Promise.resolve(n * 2), {
  concurrency: 2,
});
if (doubled.join() !== '2,4,6,8') throw new Error(doubled.join());
```

### Wait in a test without waiting

1. Pass `{ clock }` to `sleep` and `timeout`.
2. Call `clock.advance(ms)`, or `await clock.advanceAsync(ms)` when async code sets the next timer.

```ts run
import { sleep } from '@arki/async';
import { MockClock } from '@arki/clock';

const clock = new MockClock();
const done = sleep(60_000, { clock });
clock.advance(60_000);
await done;
```

### Stop a wait on user cancel

1. Create an `AbortController` and pass its signal.
2. Catch `AsyncError` and check `code === ASYNC_ERROR_CODES.aborted`.

### Debounce a save

1. `const save = debounce(write, 300)`.
2. Call `save.flush()` before the page unloads and `save.cancel()` when the form closes.

## Rules that bite

- `race` is `Promise.any`, not `Promise.race`. A fast failure does not win.
- `timeout` rejects at the deadline, but a task that ignores its signal keeps running.
- `sleep(0)` waits for the next macrotask. It never resolves in the same tick.
- A wait above `MAX_WAIT_MS` (about 24.8 days) rejects with `ARKI_ASYNC_E001`.
- `concurrency: 0` rejects with `ARKI_ASYNC_E005`. Leave it out for no limit.
- Inside `scoped`, pass `scope.signal` to `timeout`, `all` and `race`. Then the scope owns that work.
- `debounce` and `throttle` do not use `this` and return no result.

## Errors

| Code              | Meaning                                           | What to do                                   |
| ----------------- | ------------------------------------------------- | -------------------------------------------- |
| `ARKI_ASYNC_E001` | A wait is invalid.                                | Pass 0 to `MAX_WAIT_MS`.                     |
| `ARKI_ASYNC_E002` | A signal aborted the work. `cause` is the reason. | Catch it where you abort.                    |
| `ARKI_ASYNC_E003` | A `scoped` finalizer threw.                       | Read `error.errors` and `error.cause`.       |
| `ARKI_ASYNC_E004` | A `timeout` deadline passed.                      | Raise the deadline or speed up the task.     |
| `ARKI_ASYNC_E005` | `concurrency` is invalid.                         | Pass an integer of 1 or more, or `Infinity`. |

## Verify

```sh
bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
