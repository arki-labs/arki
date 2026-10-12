import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, ResourceLimitError } from './errors.js';
import { approxEqual, clamp, inRange, inverseLerp, lerp, linspace, range, remap, round, roundTo } from './number.js';
import { ROUNDING_MODES } from './rounding.js';

describe('round', () => {
  it('rounds the number you typed', () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(-1.005, 2)).toBe(-1.01);
    expect(round(2.5)).toBe(3);
    expect(round(-2.5)).toBe(-3);
    expect(round(2.5, 0, 'halfEven')).toBe(2);
    expect(round(3.5, 0, 'halfEven')).toBe(4);
    expect(round(1234, -2)).toBe(1200);
    expect(round(1250, -2, 'halfEven')).toBe(1200);
  });
  it('returns the input when there is nothing to drop', () => {
    expect(round(1.5, 5)).toBe(1.5);
    expect(round(7)).toBe(7);
  });
  it('never returns -0', () => {
    expect(round(-0.4)).toBe(0);
    expect(Object.is(round(-0.4), 0)).toBe(true);
    expect(Object.is(round(-0), 0)).toBe(true);
  });
  it.each([
    ['up', 3, -3],
    ['down', 2, -2],
    ['ceiling', 3, -2],
    ['floor', 2, -3],
    ['halfUp', 3, -3],
    ['halfDown', 2, -2],
    ['halfEven', 2, -2],
  ] as const)('mode %s on 2.5 / -2.5', (mode, pos, neg) => {
    expect(round(2.5, 0, mode)).toBe(pos);
    expect(round(-2.5, 0, mode)).toBe(neg);
  });
  it('unnecessary throws only when digits would be lost', () => {
    expect(() => round(2.5, 0, 'unnecessary')).toThrow();
    expect(round(2.5, 1, 'unnecessary')).toBe(2.5);
  });
  it('knows all modes', () => {
    for (const mode of ROUNDING_MODES) expect(() => round(2.25, 2, mode)).not.toThrow();
  });
  it('rejects bad places', () => {
    expect(() => round(1, 1.5)).toThrow(InvalidArgumentError);
    expect(() => round(1, 1001)).toThrow(InvalidArgumentError);
  });
});

describe('roundTo', () => {
  it('rounds to multiples of step', () => {
    expect(roundTo(127.3, 5)).toBe(125);
    expect(roundTo(0.1 + 0.2, 0.1)).toBe(0.3);
    expect(roundTo(7, 0.25)).toBe(7);
    expect(roundTo(7.13, 0.25)).toBe(7.25);
    expect(roundTo(-127.3, 5)).toBe(-125);
  });
  it('honours the mode', () => {
    expect(roundTo(7.5, 5, 'down')).toBe(5);
    expect(roundTo(7.5, 5, 'halfUp')).toBe(10);
  });
  it('never returns -0', () => {
    expect(Object.is(roundTo(-0.1, 5), 0)).toBe(true);
  });
  it('rejects zero or negative steps', () => {
    expect(() => roundTo(1, 0)).toThrow(InvalidArgumentError);
    expect(() => roundTo(1, -1)).toThrow(InvalidArgumentError);
  });
});

describe('clamp', () => {
  it('limits to the bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(3, 3, 3)).toBe(3);
  });
  it('throws on reversed bounds', () => {
    expect(() => clamp(1, 10, 0)).toThrow(InvalidArgumentError);
  });
});

describe('lerp / inverseLerp / remap', () => {
  it('interpolates', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 2)).toBe(20);
    expect(lerp(0, 10, -1)).toBe(-10);
  });
  it('is exact at the ends', () => {
    expect(lerp(0.1, 0.3, 1)).toBe(0.3);
    expect(lerp(0.1, 0.3, 0)).toBe(0.1);
  });
  it('inverts', () => {
    expect(inverseLerp(0, 10, 5)).toBe(0.5);
    expect(inverseLerp(10, 0, 2.5)).toBe(0.75);
    expect(() => inverseLerp(3, 3, 3)).toThrow(InvalidArgumentError);
  });
  it('remaps', () => {
    expect(remap(5, 0, 10, 0, 100)).toBe(50);
    expect(remap(0, -1, 1, 0, 10)).toBe(5);
  });
});

describe('inRange', () => {
  it.each([
    ['[]', true, true, false],
    ['[)', true, false, false],
    ['(]', false, true, false],
    ['()', false, false, false],
  ] as const)('bounds %s', (bounds, atMin, atMax, outside) => {
    expect(inRange(0, 0, 10, bounds)).toBe(atMin);
    expect(inRange(10, 0, 10, bounds)).toBe(atMax);
    expect(inRange(5, 0, 10, bounds)).toBe(true);
    expect(inRange(11, 0, 10, bounds)).toBe(outside);
    expect(inRange(-1, 0, 10, bounds)).toBe(outside);
  });
  it('defaults to half-open', () => {
    expect(inRange(0, 0, 10)).toBe(true);
    expect(inRange(10, 0, 10)).toBe(false);
  });
  it('throws on reversed bounds', () => {
    expect(() => inRange(1, 10, 0)).toThrow(InvalidArgumentError);
  });
});

describe('approxEqual', () => {
  it('tolerates float noise', () => {
    expect(approxEqual(0.1 + 0.2, 0.3)).toBe(true);
    expect(approxEqual(1e12 + 0.001, 1e12)).toBe(true);
    expect(approxEqual(1, 1.1)).toBe(false);
    expect(approxEqual(1, 1.1, 0.2)).toBe(true);
  });
  it('rejects a negative tolerance', () => {
    expect(() => approxEqual(1, 1, -1)).toThrow(InvalidArgumentError);
  });
});

describe('input validation', () => {
  it('rejects NaN and Infinity', () => {
    expect(() => round(Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => clamp(Number.POSITIVE_INFINITY, 0, 1)).toThrow(InvalidArgumentError);
    expect(() => lerp(0, 1, Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => approxEqual(Number.NEGATIVE_INFINITY, 1)).toThrow(InvalidArgumentError);
    expect(() => roundTo(1, Number.POSITIVE_INFINITY)).toThrow(InvalidArgumentError);
  });
  it('rejects non-numbers with TypeError', () => {
    expect(() => Reflect.apply(round, undefined, ['1.5'])).toThrow(TypeError);
    expect(() => Reflect.apply(clamp, undefined, [1, '0', 2])).toThrow(TypeError);
    expect(() => Reflect.apply(lerp, undefined, [0, 1, '0.5'])).toThrow(TypeError);
  });
});

describe('range', () => {
  it('counts up to but excluding the end', () => {
    expect(range(5)).toEqual([0, 1, 2, 3, 4]);
    expect(range(2, 5)).toEqual([2, 3, 4]);
    expect(range(0, 10, 5)).toEqual([0, 5]);
  });
  it('counts down with a negative step', () => {
    expect(range(3, 0, -1)).toEqual([3, 2, 1]);
    expect(range(0, -1, -0.5)).toEqual([0, -0.5]);
  });
  it('does not drift on fractional steps', () => {
    expect(range(0, 1, 0.25)).toEqual([0, 0.25, 0.5, 0.75]);
  });
  it('never includes its excluded end when the step count rounds up', () => {
    // Reviewer repro: (0.4 - 0.1) / 0.1 is 3.0000000000000004, so ceil made a fourth element equal to 0.4.
    expect(range(0.1, 0.4, 0.1)).toHaveLength(3);
    expect(range(0.1, 0.4, 0.1).at(-1)).toBeLessThan(0.4);
    expect(range(0.4, 0.1, -0.1)).toHaveLength(3);
    expect(range(0.4, 0.1, -0.1).at(-1)).toBeGreaterThan(0.1);
    const tenths = range(0, 1, 0.1);
    expect(tenths).toHaveLength(10);
    expect(tenths[3]).toBe(3 * 0.1);
    expect(tenths[9]).toBe(9 * 0.1);
  });
  it('is empty when the step points away from the end', () => {
    expect(range(0)).toEqual([]);
    expect(range(5, 0)).toEqual([]);
    expect(range(0, 5, -1)).toEqual([]);
    expect(range(2, 2)).toEqual([]);
  });
  it('never returns -0', () => {
    expect(Object.is(range(-0, 1)[0], 0)).toBe(true);
    expect(Object.is(range(-1, 1, 1)[1], 0)).toBe(true);
  });
  it('rejects a zero or non-finite step and non-finite bounds', () => {
    expect(() => range(0, 5, 0)).toThrow(InvalidArgumentError);
    expect(() => range(0, 5, Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => range(0, 5, Infinity)).toThrow(InvalidArgumentError);
    expect(() => range(Infinity)).toThrow(InvalidArgumentError);
  });
  it('caps the length so a huge range cannot exhaust memory', () => {
    expect(() => range(0, 1e12)).toThrow(ResourceLimitError);
    expect(() => range(0, 1, 1e-300)).toThrow(ResourceLimitError);
    expect(range(0, 1e7)).toHaveLength(1e7);
  });
});

describe('linspace', () => {
  it('spaces numbers evenly with both ends included', () => {
    expect(linspace(0, 1, 5)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(linspace(10, 0, 3)).toEqual([10, 5, 0]);
    expect(linspace(0, 1, 2)).toEqual([0, 1]);
  });
  it('does not overflow when the span exceeds the float range', () => {
    // Reviewer repro: `end - start` overflowed to Infinity and gave [NaN, Infinity, 1e308].
    expect(linspace(-1e308, 1e308, 3)).toEqual([-1e308, 0, 1e308]);
    expect(linspace(0, 1e308, 4).every((x) => Number.isFinite(x))).toBe(true);
    expect(linspace(0, 1e308, 4)[2]).toBeCloseTo((2 / 3) * 1e308, -300);
  });
  it('gives exact 0 (never -0 or residue) at the middle of a symmetric span', () => {
    expect(linspace(-1, 1, 3)[1]).toBe(0);
    expect(Object.is(linspace(-1, 1, 3)[1], 0)).toBe(true);
    expect(Object.is(linspace(1, -1, 3)[1], 0)).toBe(true);
    expect(Object.is(linspace(-1e308, 1e308, 5)[2], 0)).toBe(true);
    expect(linspace(-0.3, 0.3, 3)[0]).toBe(-0.3);
  });
  it('forces the last element to be exactly the end', () => {
    expect(linspace(0, 0.3, 4).at(-1)).toBe(0.3);
    expect(linspace(0.1, 0.7, 7).at(-1)).toBe(0.7);
  });
  it('handles one and zero points', () => {
    expect(linspace(3, 9, 1)).toEqual([3]);
    expect(linspace(3, 9, 0)).toEqual([]);
  });
  it('never returns -0', () => {
    expect(Object.is(linspace(-0, 1, 2)[0], 0)).toBe(true);
    expect(Object.is(linspace(-1, 0, 2)[1], 0)).toBe(true);
  });
  it('rejects a bad count', () => {
    expect(() => linspace(0, 1, -1)).toThrow(InvalidArgumentError);
    expect(() => linspace(0, 1, 2.5)).toThrow(InvalidArgumentError);
    expect(() => linspace(0, 1, Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => linspace(0, 1, 2 ** 53)).toThrow(InvalidArgumentError);
  });
  it('caps the length', () => {
    expect(() => linspace(0, 1, 10_000_001)).toThrow(ResourceLimitError);
  });
});
