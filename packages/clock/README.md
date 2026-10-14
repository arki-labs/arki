# @arki/clock

Clock abstraction for testable time-dependent code, with deterministic mock and system implementations.

## Installation

```sh
npm install @arki/clock
# or
bun add @arki/clock
# or
pnpm add @arki/clock
```

## Why

Code that calls `new Date()` or `Date.now()` directly is hard to test deterministically. Inject a `Clock` instead, and tests can swap in `MockClock` to advance time on demand — useful for cooling windows, scheduled jobs, expiration logic, and any time-sensitive flow.

## Usage

### Production code

```ts
import type { Clock } from '@arki/clock';
import { SystemClock } from '@arki/clock';

function makeService(clock: Clock = new SystemClock()) {
  return {
    isExpired(at: Date) {
      return clock.now().getTime() > at.getTime();
    },
  };
}
```

### Tests

```ts
import { describe, expect, it } from 'vitest';

import { MockClock } from '@arki/clock';

describe('isExpired', () => {
  it('returns true after the deadline passes', () => {
    const clock = new MockClock(new Date('2026-01-01T00:00:00.000Z'));
    const service = makeService(clock);
    const deadline = new Date('2026-01-01T01:00:00.000Z');

    expect(service.isExpired(deadline)).toBe(false);

    clock.advance(60 * 60 * 1000 + 1);
    expect(service.isExpired(deadline)).toBe(true);
  });
});
```

## API

### `Clock`

Interface with a single method:

- `now(): Date` — return the current time as a `Date`.

### `SystemClock`

Production implementation backed by the runtime `Date`. `now()` returns `new Date()`.

### `MockClock`

Controllable clock for tests.

- `new MockClock(initialNow?: Date)` — defaults to the Unix epoch.
- `now(): Date` — returns a fresh `Date` on every call (callers cannot corrupt internal state by mutating it).
- `advance(ms: number): void` — moves time forward. Throws `ClockError` (`ARKI_CLOCK_E001`) on negative or non-finite values.
- `setNow(date: Date): void` — sets absolute time; allowed to go backward for arranging past scenarios.

## Errors

`import { ClockError } from '@arki/clock'`. Match on `error.code`, never on the message. Each error has a `remediation` string.

| Code              | Raised by           | Meaning                                                             |
| ----------------- | ------------------- | ------------------------------------------------------------------- |
| `ARKI_CLOCK_E001` | `MockClock.advance` | The step is negative, `NaN` or not finite. Use `setNow` to go back. |

`SystemClock` and the other `MockClock` methods never throw.

## Runtime support

Pure ESM with no dependencies and no `node:*` imports. It uses only `Date` at call time, so it runs on Node, Bun, Deno, browsers and React Native (Hermes). `bun run test:runtimes` runs a smoke test of the built package on each runtime; the Hermes leg needs `HERMES_BIN` and prints `INCOMPLETE` when it is missing.

## Documentation

`@arki/clock` is framework-agnostic and works on its own. When you compose
it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

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
