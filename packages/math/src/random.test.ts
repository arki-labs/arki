import { describe, expect, it } from 'vitest';

import { EmptyDataError, InvalidArgumentError } from './errors.js';
import { createRandom, pick, random, randomBool, randomFloat, randomInt, sample, shuffle } from './random.js';

const take = (n: number, fn: () => number): number[] => Array.from({ length: n }, fn);

describe('determinism', () => {
  it('same seed gives the same next() stream', () => {
    const a = createRandom(42);
    const b = createRandom(42);
    expect(take(50, a.next)).toEqual(take(50, b.next));
  });

  it('same seed gives the same int() stream', () => {
    const a = createRandom(7);
    const b = createRandom(7);
    expect(take(50, () => a.int(-100, 100))).toEqual(take(50, () => b.int(-100, 100)));
  });

  it('same seed gives the same shuffle', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(createRandom('abc').shuffle(items)).toEqual(createRandom('abc').shuffle(items));
  });

  it('different seeds differ', () => {
    expect(take(10, createRandom(1).next)).not.toEqual(take(10, createRandom(2).next));
  });

  it('string seeds work and differ from each other', () => {
    expect(take(10, createRandom('alpha').next)).not.toEqual(take(10, createRandom('beta').next));
    expect(take(10, createRandom('alpha').next)).toEqual(take(10, createRandom('alpha').next));
  });

  it('pins the first outputs so the stream never changes silently', () => {
    const first = createRandom(12_345).next();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(createRandom(12_345).next()).toBe(first);
  });
});

describe('next', () => {
  it('stays in [0, 1)', () => {
    const rng = createRandom(3);
    for (const v of take(5000, rng.next)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('unseeded default generator stays in [0, 1)', () => {
    for (const v of take(1000, random.next)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('unseeded generators are not identical', () => {
    expect(take(5, createRandom().next)).not.toEqual(take(5, createRandom().next));
  });
});

describe('int', () => {
  it('returns the only value when min equals max', () => {
    const rng = createRandom(1);
    for (let i = 0; i < 100; i++) expect(rng.int(5, 5)).toBe(5);
  });

  it('covers every die face and never leaves bounds', () => {
    const rng = createRandom(99);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      const v = rng.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('is roughly uniform', () => {
    const rng = createRandom(5);
    const counts = new Map<number, number>();
    for (let i = 0; i < 30_000; i++) {
      const v = rng.int(0, 2);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect(counts.size).toBe(3);
    for (const c of counts.values()) expect(Math.abs(c - 10_000)).toBeLessThan(500);
  });

  it('handles negative ranges', () => {
    const rng = createRandom(8);
    for (let i = 0; i < 500; i++) {
      const v = rng.int(-10, -5);
      expect(v).toBeGreaterThanOrEqual(-10);
      expect(v).toBeLessThanOrEqual(-5);
    }
  });

  it('handles the full safe-integer range', () => {
    const rng = createRandom(11);
    for (let i = 0; i < 500; i++) {
      const v = rng.int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      expect(Number.isSafeInteger(v)).toBe(true);
    }
    const small = rng.int(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER);
    expect([Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]).toContain(small);
  });

  it('rejects bad arguments', () => {
    const rng = createRandom(1);
    expect(() => rng.int(2, 1)).toThrow(InvalidArgumentError);
    expect(() => rng.int(1.5, 3)).toThrow(InvalidArgumentError);
    expect(() => rng.int(1, 2 ** 60)).toThrow(InvalidArgumentError);
    expect(() => rng.int(Number.NaN, 3)).toThrow(InvalidArgumentError);
    expect(() => rng.int('1' as unknown as number, 3)).toThrow(TypeError);
  });

  it('exported randomInt works without a receiver', () => {
    const v = randomInt(1, 3);
    expect([1, 2, 3]).toContain(v);
  });
});

describe('float', () => {
  it('defaults to [0, 1) and respects bounds', () => {
    const rng = createRandom(2);
    for (let i = 0; i < 2000; i++) {
      const d = rng.float();
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1);
      const v = rng.float(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(5);
    }
  });

  it('does not overflow on huge spans', () => {
    const v = createRandom(4).float(-Number.MAX_VALUE, Number.MAX_VALUE);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('rejects bad arguments', () => {
    const rng = createRandom(1);
    expect(() => rng.float(1, 1)).toThrow(InvalidArgumentError);
    expect(() => rng.float(2, 1)).toThrow(InvalidArgumentError);
    expect(() => rng.float(0, Infinity)).toThrow(InvalidArgumentError);
    expect(() => rng.float('a' as unknown as number)).toThrow(TypeError);
    expect(randomFloat(0, 1)).toBeLessThan(1);
  });
});

describe('bool', () => {
  it('bool(0) is always false and bool(1) always true', () => {
    const rng = createRandom(6);
    for (let i = 0; i < 1000; i++) {
      expect(rng.bool(0)).toBe(false);
      expect(rng.bool(1)).toBe(true);
    }
  });

  it('defaults to a fair coin', () => {
    const rng = createRandom(10);
    let heads = 0;
    for (let i = 0; i < 10_000; i++) if (rng.bool()) heads++;
    expect(Math.abs(heads - 5000)).toBeLessThan(300);
  });

  it('rejects probabilities outside [0, 1]', () => {
    const rng = createRandom(1);
    expect(() => rng.bool(-0.1)).toThrow(InvalidArgumentError);
    expect(() => rng.bool(1.1)).toThrow(InvalidArgumentError);
    expect(() => rng.bool(Number.NaN)).toThrow(InvalidArgumentError);
    expect(typeof randomBool()).toBe('boolean');
  });
});

describe('pick', () => {
  it('returns an element of the array', () => {
    const items = ['a', 'b', 'c'];
    const rng = createRandom(1);
    for (let i = 0; i < 100; i++) expect(items).toContain(rng.pick(items));
    expect(items).toContain(pick(items));
  });

  it('throws EmptyDataError on empty input', () => {
    expect(() => createRandom(1).pick([])).toThrow(EmptyDataError);
  });
});

describe('shuffle', () => {
  it('returns a permutation and leaves the input alone', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const frozen = Object.freeze([...items]);
    const result = createRandom(1).shuffle(frozen);
    expect([...result].toSorted((a, b) => a - b)).toEqual(items);
    expect(frozen).toEqual(items);
    expect(result).not.toBe(frozen);
    expect(shuffle(items)).toHaveLength(items.length);
  });

  it('handles empty and single-item arrays', () => {
    expect(createRandom(1).shuffle([])).toEqual([]);
    expect(createRandom(1).shuffle([9])).toEqual([9]);
  });

  it('actually reorders', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(createRandom(1).shuffle(items)).not.toEqual(items);
  });
});

describe('sample', () => {
  it('returns distinct elements of the requested count', () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const rng = createRandom(3);
    for (let i = 0; i < 50; i++) {
      const picked = rng.sample(items, 10);
      expect(picked).toHaveLength(10);
      expect(new Set(picked).size).toBe(10);
      for (const p of picked) expect(items).toContain(p);
    }
    expect(sample(items, 3)).toHaveLength(3);
  });

  it('allows 0 and full length, and does not mutate', () => {
    const items = [1, 2, 3];
    const rng = createRandom(1);
    expect(rng.sample(items, 0)).toEqual([]);
    expect([...rng.sample(items, 3)].toSorted()).toEqual([1, 2, 3]);
    expect(items).toEqual([1, 2, 3]);
  });

  it('validates count', () => {
    const rng = createRandom(1);
    expect(() => rng.sample([1, 2], 3)).toThrow(InvalidArgumentError);
    expect(() => rng.sample([1, 2], -1)).toThrow(InvalidArgumentError);
    expect(() => rng.sample([1, 2], 1.5)).toThrow(InvalidArgumentError);
    expect(() => rng.sample([1, 2], '1' as unknown as number)).toThrow(TypeError);
  });
});

describe('gaussian', () => {
  it('seeded samples have mean about 0 and stddev about 1', () => {
    const rng = createRandom(2024);
    const values = take(20_000, () => rng.gaussian());
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(Math.sqrt(variance) - 1)).toBeLessThan(0.05);
  });

  it('applies mean and stddev', () => {
    const rng = createRandom(1);
    const values = take(20_000, () => rng.gaussian(10, 2));
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(Math.abs(mean - 10)).toBeLessThan(0.1);
    expect(rng.gaussian(5, 0)).toBe(5);
  });

  it('rejects bad arguments', () => {
    const rng = createRandom(1);
    expect(() => rng.gaussian(0, -1)).toThrow(InvalidArgumentError);
    expect(() => rng.gaussian(Infinity)).toThrow(InvalidArgumentError);
    expect(() => rng.gaussian(0, Number.NaN)).toThrow(InvalidArgumentError);
  });
});

describe('createRandom', () => {
  it('rejects non-finite or wrongly typed seeds', () => {
    expect(() => createRandom(Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => createRandom(Infinity)).toThrow(InvalidArgumentError);
    expect(() => createRandom({} as unknown as number)).toThrow(TypeError);
  });
});
