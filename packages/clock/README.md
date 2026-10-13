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
import { SystemClock, type Clock } from '@arki/clock';

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
import { MockClock } from '@arki/clock';
import { describe, expect, it } from 'vitest';

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
- `advance(ms: number): void` — moves time forward. Throws `RangeError` on negative or non-finite values.
- `setNow(date: Date): void` — sets absolute time; allowed to go backward for arranging past scenarios.

## Documentation

`@arki/clock` is framework-agnostic and works on its own. When you compose
it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## License

MIT. See [LICENSE](./LICENSE).
