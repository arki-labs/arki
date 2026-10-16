import { describe, expect, it } from 'vitest';

import { backoff, InvalidBackoffError } from './index.js';

const error = new Error('boom');

/** The waits before retries 1..n, or `undefined` where the backoff says stop. */
function waits(schedule: ReturnType<typeof backoff.constant>, n: number): (number | undefined)[] {
  return Array.from({ length: n }, (_, index) => schedule.delay(index + 1, error));
}

describe('backoff.exponential', () => {
  it('doubles from base and holds at max, so a long outage never waits longer than max', () => {
    expect(waits(backoff.exponential({ base: 100, max: 1000 }), 6)).toEqual([100, 200, 400, 800, 1000, 1000]);
  });

  it('retries forever until upTo limits it, and upTo(n) allows exactly n retries', () => {
    const unlimited = backoff.exponential({ base: 1 });
    expect(unlimited.maxRetries).toBe(Infinity);
    expect(unlimited.delay(10_000, error)).toBeGreaterThan(0);
    const three = unlimited.upTo(3);
    expect(three.maxRetries).toBe(3);
    expect(waits(three, 4)).toEqual([1, 2, 4, undefined]);
    expect(backoff.exponential({ base: 1 }).upTo(0).delay(1, error)).toBeUndefined();
  });

  it('jitter varies each wait within its band, and an injected random makes it exact', () => {
    // random 0 -> lowest end (75%), random just under 1 -> top end (125%), capped at max.
    const low = backoff.exponential({ base: 1000, max: 3000, jitter: 0.25, random: () => 0 });
    const high = backoff.exponential({ base: 1000, max: 3000, jitter: 0.25, random: () => 0.999_999 });
    expect(waits(low, 3)).toEqual([750, 1500, 2250]);
    expect(waits(high, 3)).toEqual([1250, 2500, 3000]);
    const real = backoff.exponential({ base: 1000, jitter: 0.25 });
    for (let attempt = 1; attempt <= 50; attempt++) {
      const wait = real.delay(1, error);
      expect(wait).toBeGreaterThanOrEqual(750);
      expect(wait).toBeLessThanOrEqual(1250);
    }
  });

  it('a huge attempt number caps at max instead of overflowing', () => {
    expect(backoff.exponential({ base: 1, max: 5000 }).delay(5000, error)).toBe(5000);
    expect(backoff.exponential({ base: 0 }).delay(5000, error)).toBe(0);
  });
});

describe('backoff.constant', () => {
  it('waits the same time before every retry', () => {
    expect(waits(backoff.constant(60_000).upTo(2), 3)).toEqual([60_000, 60_000, undefined]);
  });
});

describe('narrowing: upTo and while', () => {
  it('while retries only the errors its predicate accepts', () => {
    const transient = backoff.constant(10).while(e => e instanceof TypeError);
    expect(transient.delay(1, new TypeError('flaky'))).toBe(10);
    expect(transient.delay(1, new RangeError('bad input'))).toBeUndefined();
  });

  it('later calls only narrow: two whiles must both pass, and upTo keeps the smaller limit', () => {
    const both = backoff
      .constant(10)
      .while(e => e instanceof Error)
      .while(e => e instanceof Error && e.message === 'retry me');
    expect(both.delay(1, new Error('retry me'))).toBe(10);
    expect(both.delay(1, new Error('other'))).toBeUndefined();
    expect(backoff.constant(10).upTo(2).upTo(5).maxRetries).toBe(2);
  });

  it('returns new values and leaves the original untouched', () => {
    const base = backoff.constant(10);
    base.upTo(1);
    base.while(() => false);
    expect(base.maxRetries).toBe(Infinity);
    expect(base.delay(3, error)).toBe(10);
  });
});

describe('validation', () => {
  it.each([
    () => backoff.exponential({ base: -1 }),
    () => backoff.exponential({ base: Number.NaN }),
    () => backoff.exponential({ base: 1, max: Number.POSITIVE_INFINITY }),
    () => backoff.exponential({ base: 1, jitter: 1.5 }),
    () => backoff.constant(-5),
    () => backoff.constant(1).upTo(-1),
    () => backoff.constant(1).upTo(1.5),
    () => backoff.constant(1).delay(0, error),
  ])('throws a coded error where the backoff is built or misused (%#)', build => {
    expect(build).toThrow(InvalidBackoffError);
    expect(build).toThrow(/backoff:/);
  });
});
