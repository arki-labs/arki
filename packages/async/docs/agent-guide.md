# @arki/async for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. Work is a function that takes an `AbortSignal`: `(signal) => Promise<T>`. The helpers start it, bound it and stop it.
2. `scoped(plan, body)` owns descriptor acquisitions, child tasks and cleanup. The body receives successful resources and a signal. Closure joins admitted work before releasing resources.
3. `all`, `mapConcurrent`, `race` and `timeout` share one internal signal. The first failure aborts it, so siblings see it.
4. Cancellation is cooperative. A task must pass its signal to `fetch`, `sleep` and anything else that accepts one.
5. Time comes from a `Clock`. Tests pass a `MockClock`.

## Task map

### Load many things with a limit and a deadline

1. Declare the shared resource with `resource(open, close)` in a scope plan.
2. Pass a Clock-driven deadline signal in the scope options and await the actual work in its body. Own the deadline timer too.
3. Pass each task's signal on to the work it starts. Check the returned value with `isFailure` from `@arki/failure`.

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
- Passing a signal to an early-returning wrapper does not transfer ownership. Await the original work or register it with `child`; closure waits for it even after a deadline.
- Put dependent acquisitions in nested scopes. An inner child drains before an outer resource closes.
- For dynamic registration, use `dynamicScope([CanonicalFailure, ...])`; every registered callback must fit that inferred union. Even an ignored acquisition failure remains owned.
- Use `openScope(plan)` only when transferring a lifetime to another owner; check its failure result and await the successful handle's `close()` exactly as an ordinary scope would.
- `debounce` and `throttle` do not use `this` and return no result.

## Errors

| Code              | Meaning                                           | What to do                                   |
| ----------------- | ------------------------------------------------- | -------------------------------------------- |
| `ARKI_ASYNC_E001` | A wait is invalid.                                | Pass 0 to `MAX_WAIT_MS`.                     |
| `ARKI_ASYNC_E002` | A signal aborted the work. `cause` is the reason. | Catch it where you abort.                    |
| `ARKI_ASYNC_E003` | Reserved legacy scope cleanup exception.        | Managed scopes now return typed failures.  |
| `ARKI_ASYNC_E004` | A `timeout` deadline passed.                      | Raise the deadline or speed up the task.     |
| `ARKI_ASYNC_E005` | `concurrency` is invalid.                         | Pass an integer of 1 or more, or `Infinity`. |
| `async.cancelled` | An owned scope was externally cancelled.        | Handle cancellation at its owner.          |
| `async.deadline` | An owned scope's deadline signal aborted.        | Inspect the budget and cooperative work.   |
| `async.scope_failed` | Multiple primary or cleanup failures occurred. | Inspect exact local members in private `cause`; wire data contains counts only. |
| `failure.unexpected_defect` | An owned callback threw or rejected unexpectedly. | Fix the defect; inspect its private cause. |

## Verify

```sh
bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
