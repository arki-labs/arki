# @arki/clock for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. A `Clock` has three methods: `now()`, `setTimer(callback, ms)` and `sleep(ms, signal?)`.
2. `SystemClock` is the real one. `MockClock` is the test one: time moves only when you call `advance`, `advanceAsync` or `setNow`.
3. Code that needs time takes a `Clock` parameter and defaults it to `new SystemClock()`.
4. Both clocks apply the same delay rules and raise the same `ClockError` codes.

## Task map

### Make time-dependent code testable

1. Add a `clock: Clock` parameter. Default it to `new SystemClock()` at the edge of the app.
2. Replace `new Date()` with `clock.now()` and `setTimeout` with `clock.setTimer`.
3. In the test, pass a `MockClock` and call `advance`.

```ts run
import type { Clock } from '@arki/clock';
import { MockClock } from '@arki/clock';

function isExpired(clock: Clock, at: Date): boolean {
  return clock.now().getTime() > at.getTime();
}

const clock = new MockClock(new Date('2026-01-01T00:00:00.000Z'));
const deadline = new Date('2026-01-01T01:00:00.000Z');
if (isExpired(clock, deadline)) throw new Error('not expired yet');
clock.advance(60 * 60 * 1000 + 1);
if (!isExpired(clock, deadline)) throw new Error('should be expired');
```

### Test a retry loop that waits between tries

1. Start the code under test without awaiting it.
2. Call `await clock.advanceAsync(totalDelay)`. It lets promise callbacks run between timers, so the next timer exists before time moves on.
3. Await the code under test.

```ts run
import { MockClock } from '@arki/clock';

const clock = new MockClock();
async function retry(attempts: number): Promise<number> {
  let tries = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    tries += 1;
    await clock.sleep(1000 * 2 ** attempt);
  }
  return tries;
}

const done = retry(3);
await clock.advanceAsync(7000); // 1 s + 2 s + 4 s
if ((await done) !== 3) throw new Error('expected three tries');
```

### Cancel a wait

1. Pass an `AbortSignal` to `sleep`.
2. Catch `ClockError` and branch on `error.code === CLOCK_ERROR_CODES.aborted`.

## Rules that bite

- `advance` is synchronous. A timer that async code sets after an `await` is not there yet. Use `advanceAsync`.
- Do not mix `advanceAsync` with fake timers that replace `setTimeout`. It waits one real macrotask per timer.
- `setNow` fires no timers, even when it jumps past their due time.
- A delay above `MAX_TIMER_MS` (2^31 - 1 ms, about 24.8 days) throws. Split a longer wait.
- `MockClock.now()` returns a new `Date`. Changing it does not move the clock.

## Errors

| Code              | Meaning                                                        | What to do                                  |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------- |
| `ARKI_CLOCK_E001` | `advance` or `advanceAsync` got a negative or non-finite step. | Pass zero or more. Use `setNow` to go back. |
| `ARKI_CLOCK_E002` | A delay is negative, not finite, or above `MAX_TIMER_MS`.      | Pass a valid delay. Split long waits.       |
| `ARKI_CLOCK_E003` | The signal aborted a `sleep`. `cause` is `signal.reason`.      | Catch it where you abort.                   |

## Verify

```sh
bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
