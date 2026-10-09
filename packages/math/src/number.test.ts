import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from './errors.js';
import { approxEqual, clamp, inRange, inverseLerp, lerp, remap, round, roundTo } from './number.js';
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
