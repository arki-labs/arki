import { describe, expect, it } from 'vitest';

import { MATH_CONSTANTS } from '../constants';
import { displayToNumber, numberToDisplay, parseFraction } from '../utils';

describe('numberToDisplay', () => {
  it('returns empty string for null', () => {
    expect(numberToDisplay(null)).toBe('');
  });

  it('maps Infinity to +∞', () => {
    expect(numberToDisplay(Infinity)).toBe('+∞');
  });

  it('maps -Infinity to −∞', () => {
    expect(numberToDisplay(-Infinity)).toBe('−∞');
  });

  it('maps Math.PI to π', () => {
    expect(numberToDisplay(Math.PI)).toBe('π');
  });

  it('maps Math.E to e', () => {
    expect(numberToDisplay(Math.E)).toBe('e');
  });

  it('maps golden ratio to φ', () => {
    expect(numberToDisplay((1 + Math.sqrt(5)) / 2)).toBe('φ');
  });

  it('maps 2*Math.PI to τ', () => {
    expect(numberToDisplay(2 * Math.PI)).toBe('τ');
  });

  it('maps Math.sqrt(2) to √2', () => {
    expect(numberToDisplay(Math.sqrt(2))).toBe('√2');
  });

  it('maps Math.sqrt(3) to √3', () => {
    expect(numberToDisplay(Math.sqrt(3))).toBe('√3');
  });

  it('maps Math.LN2 to ln2', () => {
    expect(numberToDisplay(Math.LN2)).toBe('ln2');
  });

  it('maps Euler-Mascheroni to γ', () => {
    expect(numberToDisplay(0.5772156649015329)).toBe('γ');
  });

  it('maps an arbitrary number to its string representation', () => {
    expect(numberToDisplay(42)).toBe('42');
    expect(numberToDisplay(3.5)).toBe('3.5');
    expect(numberToDisplay(-7)).toBe('-7');
  });

  it('covers all constants in MATH_CONSTANTS', () => {
    for (const c of MATH_CONSTANTS) {
      expect(numberToDisplay(c.value)).toBe(c.symbol);
    }
  });
});

describe('displayToNumber', () => {
  it('returns null for empty string', () => {
    expect(displayToNumber('')).toBeNull();
    expect(displayToNumber('   ')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(displayToNumber('abc')).toBeNull();
    expect(displayToNumber('??')).toBeNull();
  });

  it('parses +∞ to Infinity', () => {
    expect(displayToNumber('+∞')).toBe(Infinity);
    expect(displayToNumber('∞')).toBe(Infinity);
    expect(displayToNumber('Infinity')).toBe(Infinity);
    expect(displayToNumber('+Infinity')).toBe(Infinity);
  });

  it('parses −∞ to -Infinity', () => {
    expect(displayToNumber('−∞')).toBe(-Infinity);
    expect(displayToNumber('-∞')).toBe(-Infinity);
    expect(displayToNumber('-Infinity')).toBe(-Infinity);
  });

  it('parses π to Math.PI', () => {
    expect(displayToNumber('π')).toBe(Math.PI);
  });

  it('parses e to Math.E', () => {
    expect(displayToNumber('e')).toBe(Math.E);
  });

  it('parses φ to golden ratio', () => {
    expect(displayToNumber('φ')).toBe((1 + Math.sqrt(5)) / 2);
  });

  it('parses τ to 2*Math.PI', () => {
    expect(displayToNumber('τ')).toBe(2 * Math.PI);
  });

  it('parses √2 to Math.sqrt(2)', () => {
    expect(displayToNumber('√2')).toBe(Math.sqrt(2));
  });

  it('parses γ to Euler-Mascheroni constant', () => {
    expect(displayToNumber('γ')).toBe(0.5772156649015329);
  });

  it('round-trips all constants via numberToDisplay → displayToNumber', () => {
    for (const c of MATH_CONSTANTS) {
      expect(displayToNumber(numberToDisplay(c.value))).toBe(c.value);
    }
  });

  it('parses plain numeric strings', () => {
    expect(displayToNumber('3.5')).toBe(3.5);
    expect(displayToNumber('42')).toBe(42);
    expect(displayToNumber('-7')).toBe(-7);
    expect(displayToNumber('0')).toBe(0);
  });

  it('parses fraction shorthand 3/4', () => {
    expect(displayToNumber('3/4')).toBe(0.75);
  });

  it('parses fraction shorthand 22/7', () => {
    expect(displayToNumber('22/7')).toBeCloseTo(22 / 7);
  });

  it('parses negative fraction -1/3', () => {
    expect(displayToNumber('-1/3')).toBeCloseTo(-1 / 3);
  });

  it('returns null for division by zero fraction', () => {
    expect(displayToNumber('1/0')).toBeNull();
  });
});

describe('parseFraction', () => {
  it('computes 3/4 = 0.75', () => {
    expect(parseFraction(3, 4)).toBe(0.75);
  });

  it('computes 1/3', () => {
    expect(parseFraction(1, 3)).toBeCloseTo(1 / 3);
  });

  it('returns null for denominator 0', () => {
    expect(parseFraction(1, 0)).toBeNull();
  });

  it('handles negative numerator', () => {
    expect(parseFraction(-1, 2)).toBe(-0.5);
  });

  it('handles negative denominator', () => {
    expect(parseFraction(1, -2)).toBe(-0.5);
  });

  it('returns null for non-finite result', () => {
    // Infinity / Infinity would be NaN, but parseFraction receives numbers
    // Trigger via 0/0 → NaN (not finite)
    expect(parseFraction(0, 0)).toBeNull();
  });
});
