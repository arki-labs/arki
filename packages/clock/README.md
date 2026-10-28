# @arki/clock

A clock you pass in, so time-dependent code can be tested without waiting. `SystemClock` reads real time. `MockClock` moves only when a test says so.

## Install

```sh
bun add @arki/clock
# or
npm install @arki/clock
```

## Quick start

Limit a password-reset email to one per 15 minutes. The gate takes a `Clock`, so the test runs a 15-minute window in no time.

```ts run
import type { Clock } from '@arki/clock';
import { MockClock } from '@arki/clock';

function createCooldownGate(clock: Clock, windowMs: number) {
  const lastAllowed = new Map<string, number>();
  return (key: string): boolean => {
    const now = clock.now().getTime();
    const last = lastAllowed.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    lastAllowed.set(key, now);
    return true;
  };
}

const clock = new MockClock(new Date('2026-01-01T00:00:00.000Z'));
const tryAcquire = createCooldownGate(clock, 15 * 60 * 1000);
const first = tryAcquire('ana@example.com'); // true
clock.advance(15 * 60 * 1000 - 1);
const early = tryAcquire('ana@example.com'); // false: 1 ms left in the window
clock.advance(1);
const later = tryAcquire('ana@example.com'); // true: the window is over
if (!first || early || !later) throw new Error('the window did not behave');
```

In production, pass `new SystemClock()` instead. The tested version of this gate is `examples/cooldown-gate.ts`, and it has a test.

```ts from="examples/cooldown-gate.ts#cooldown-gate"
/** Lets one action through per window, for example one password-reset email per 15 minutes. */
export function createCooldownGate(clock: Clock, windowMs: number) {
  const lastAllowed = new Map<string, number>();
  return {
    /** True when the key may act now. A true answer starts a new window for that key. */
    tryAcquire(key: string): boolean {
      const now = clock.now().getTime();
      const last = lastAllowed.get(key);
      if (last !== undefined && now - last < windowMs) return false;
      lastAllowed.set(key, now);
      return true;
    },
  };
}
```

## When not to use this

- You need fake timers for code you do not own. That code calls the global `setTimeout`, and `@arki/clock` cannot reach it. Use a library that patches the globals, such as `@sinonjs/fake-timers`.
- You need a scheduler with cron rules or persistence. A clock only reads time and waits.
- You need dates, zones or durations. Use `@arki/date`, which builds on this package.

## Runtime support

Pure ESM with a portable `@arki/failure` dependency and no `node:*` imports. It uses only `Date` and `setTimeout` at call time, so it runs on Node, Bun, Deno, browsers and React Native (Hermes). `bun run test:runtimes` runs a smoke test of the built package on each runtime. The Hermes leg needs `HERMES_BIN` and prints `INCOMPLETE` when it is missing.

<!-- runtimes:start -->

| Runtime | Result  | Version tested        | Date (UTC) |
| ------- | ------- | --------------------- | ---------- |
| node    | pass    | v26.11.1              | 2026-10-17 |
| bun     | pass    | 1.4.2                 | 2026-10-17 |
| deno    | pass    | 2.9.7                 | 2026-10-17 |
| browser | pass    | Chromium 156.0.8078.4 | 2026-10-17 |
| hermes  | not run | -                     | 2026-10-17 |

<!-- runtimes:end -->

## Public imports

`import { Clock, SystemClock, MockClock, MAX_TIMER_MS, ClockError, CLOCK_ERROR_CODES } from '@arki/clock'`. The package has one entry.

### `Clock`

The type every clock implements:

- `now(): Date` — return the current time as a `Date`.
- `setTimer(callback, ms): () => void` — call `callback` once, `ms` milliseconds from now. Returns a function that cancels the timer. Throws `ARKI_CLOCK_E002` when `ms` is negative, not finite, or above `MAX_TIMER_MS`.
- `sleep(ms, signal?): Promise<void | SleepFailure>` — resolve `ms` milliseconds from now. Aborting `signal` clears the timer and returns `SleepCancelled` (private `cause` is `signal.reason`).

`MAX_TIMER_MS` is 2^31 - 1 ms (about 24.8 days), the longest delay every runtime's `setTimeout` honors.

### `SystemClock`

Production implementation backed by the runtime `Date` and `setTimeout`. `now()` returns `new Date()`.

### `MockClock`

Controllable clock for tests.

- `new MockClock(initialNow?: Date)` — defaults to the Unix epoch.
- `now(): Date` — returns a fresh `Date` on every call (callers cannot corrupt internal state by mutating it).
- `advance(ms: number): void` — moves time forward and fires every timer that comes due, in time order, each at its own due time. A timer set by a firing callback fires too if it is due within the step. Throws `ClockError` (`ARKI_CLOCK_E001`) on negative or non-finite values.
- `advanceAsync(ms: number): Promise<void>` — like `advance`, but lets pending promise callbacks run before the first timer and after each one. Use it when async code sets the next timer after an `await`, like a retry loop. It waits one real macrotask per timer, so do not mix it with fake timers that replace `setTimeout`.
- `setNow(date: Date): void` — sets absolute time; allowed to go backward for arranging past scenarios. Fires no timers.

```ts run
import { MockClock } from '@arki/clock';
import { isFailure } from '@arki/failure';

const clock = new MockClock();
async function callWithRetry(): Promise<number> {
  let tries = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    tries += 1;
    const outcome = await clock.sleep(1000 * 2 ** attempt); // 1 s, 2 s, 4 s between tries
    if (isFailure(outcome)) throw outcome;
  }
  return tries;
}

const result = callWithRetry();
await clock.advanceAsync(7000); // all the retry delay, in about a millisecond
if ((await result) !== 3) throw new Error('expected three tries');
```

## Failure behaviour

Operational cancellation returns `SleepCancelled`, defined once in `SLEEP_FAILURES`; `SleepFailure` is inferred from that tuple. Static timer/advance misuse still throws `ClockError` under A33. Sleep timer/listener registration and cleanup defects return the canonical `UnexpectedDefect` included in `SLEEP_FAILURES`. Raw timer callbacks and mock advancement retain their foreign callback exception contract. Raw Clock methods are timing substrates observed through enclosing work; they emit no per-timer span. `now()` and `setNow()` add no failure outcome.

| Code                    | Raised by                           | Meaning                                                             |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| `ARKI_CLOCK_E001`       | `MockClock.advance`, `advanceAsync` | The step is negative, `NaN` or not finite. Use `setNow` to go back. |
| `ARKI_CLOCK_E002`       | `setTimer`, `sleep`                 | The delay is negative, not finite, or above `MAX_TIMER_MS`.         |
| `clock.sleep_cancelled` | `sleep`                             | The signal aborted the sleep; private `cause` is `signal.reason`.   |

Handle an aborted sleep like this:

```ts run
import { MockClock, SleepCancelled } from '@arki/clock';

const clock = new MockClock();
const controller = new AbortController();
const waiting = clock.sleep(1000, controller.signal);
controller.abort('user cancelled');
const outcome = await waiting;
if (!SleepCancelled.is(outcome)) throw new Error('sleep should have returned cancellation');
if (outcome.cause !== 'user cancelled') throw new Error('cause should be the abort reason');
```

## Limits

- The longest delay is `MAX_TIMER_MS`: 2^31 - 1 ms, about 24.8 days. `setTimer(fn, MAX_TIMER_MS)` works. `setTimer(fn, MAX_TIMER_MS + 1)` throws `ARKI_CLOCK_E002`. Split a longer wait into steps.
- `MockClock.advance` is synchronous. A timer that async code sets after an `await` does not exist yet. Use `advanceAsync`, which waits one real macrotask per timer.
- `setNow` moves time and fires no timers, even ones it jumps past.
- A timer has no jitter and no drift. `SystemClock` timers are as exact as the platform `setTimeout`.
- The clock does not patch the globals. Code that calls `Date` or `setTimeout` directly is not controlled.

## Documentation

- [Agent guide](./docs/agent-guide.md): tasks, rules that bite, errors.
- [llms.txt](./llms.txt): the index an agent reads first.
- [Changelog](./CHANGELOG.md).

`@arki/clock` works on its own. With the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot) application framework, see `packages/dot/docs/`.

## Support

Report a bug or ask a question at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues). Include the delay or step you passed and the error code you saw.

<!-- bench:start -->

## Benchmarks

Compares @arki/clock with the platform clocks (`Date`, `performance`) and with @sinonjs/fake-timers, the fake clock behind Jest, Vitest and many Sinon setups. These are the two things a clock abstraction does: read real time, and stand in for it in tests.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Read the real time

| Library                       | Time / op | vs fastest |
| ----------------------------- | --------: | ---------: |
| @arki/clock SystemClock.now() |  349.3 ns |      2.61× |
| native new Date()             |  280.0 ns |      2.09× |
| native Date.now()             |  137.2 ns |      1.03× |
| native performance.now()      |  133.7 ns |    fastest |

### Read a fake time

A mock clock stopped at a fixed instant. @arki/clock and `new clock.Date()` return a `Date`; `clock.now` is a plain number.

| Library                      | Time / op | vs fastest |
| ---------------------------- | --------: | ---------: |
| @arki/clock MockClock.now()  |  235.6 ns |      6.70× |
| fake-timers new clock.Date() |  902.8 ns |     25.67× |
| fake-timers clock.now        |   35.2 ns |    fastest |

### Advance the fake time by 1 ms (no timers pending)

| Library                          | Time / op | vs fastest |
| -------------------------------- | --------: | ---------: |
| @arki/clock MockClock.advance(1) |   50.2 ns |    fastest |
| fake-timers clock.tick(1)        |  549.0 ns |     10.94× |

### Schedule a callback, advance 10 ms, run it

fake-timers schedules with `setTimeout` and runs the callback inside `tick`. The @arki/clock row computes the deadline, advances, and runs the callback itself.

| Library                                     | Time / op | vs fastest |
| ------------------------------------------- | --------: | ---------: |
| @arki/clock advance + manual deadline check |  720.6 ns |    fastest |
| fake-timers setTimeout + tick(10)           |   3.23 µs |      4.49× |

### Create a fresh fake clock

The per-test setup cost. `install` also patches the global timers and `Date`, so the row includes `uninstall` to restore them. `createClock` makes a clock without touching globals.

| Library                                 | Time / op | vs fastest |
| --------------------------------------- | --------: | ---------: |
| @arki/clock new MockClock(date)         |   33.6 ns |    fastest |
| fake-timers createClock(date)           |  16.21 µs |    482.72× |
| fake-timers install(), then uninstall() | 247.19 µs |   7360.67× |

Read the rows with the contracts in mind:

- @arki/clock is a small injected object: your code takes a `Clock` and calls `now()`. @sinonjs/fake-timers instead replaces the global `Date`, `setTimeout` and friends, and then moves them with `tick`. The two solve the same testing problem with different contracts.
- @arki/clock has no timers. In the "advance and fire" group the @arki/clock row advances time and checks a deadline by hand, which is how code written against an injected clock does the same job. fake-timers does the scheduling for you, so it does more work per call.
- `SystemClock.now()` returns a fresh `Date`, exactly like `new Date()`. The gap between those two rows is the cost of the wrapper. `Date.now()` and `performance.now()` return numbers and skip the allocation.
- `MockClock.advance` throws on negative or non-finite input, so time can never run backward by mistake. fake-timers accepts the value you give it.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT. See [LICENSE](./LICENSE).

Sleep waits for asynchronous cleanup returned by a provider before settling. Asynchronous listener registration rejection becomes a defect while sleep is pending; a rejection after completion is observed without changing the completed outcome. Owned sleep provider registration and cleanup defects return canonical `UnexpectedDefect` from `@arki/failure`. `SLEEP_FAILURES` contains exactly `SleepCancelled` and `UnexpectedDefect`; private causes are excluded from serialization.
