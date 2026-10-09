import { describe, expect, it as test } from 'vitest';

import { NumericRangeError } from '../errors.js';
import { formatOrdinal, spellNumber, spellOrdinal } from '../words.js';
import { it } from './it.js';

const say = (value: number | string, gender?: 'masculine' | 'feminine' | 'neuter') =>
  spellNumber(value, gender ? { locale: it, gender } : { locale: it });

describe('it cardinals', () => {
  test.each([
    [0, 'zero'],
    [1, 'uno'],
    [3, 'tre'],
    [8, 'otto'],
    [21, 'ventuno'],
    [23, 'ventitré'],
    [28, 'ventotto'],
    [33, 'trentatré'],
    [100, 'cento'],
    [101, 'centouno'],
    [103, 'centotré'],
    [108, 'centotto'],
    [180, 'centottanta'],
    [200, 'duecento'],
    [203, 'duecentotré'],
    [1000, 'mille'],
    [1003, 'milletré'],
    [1100, 'millecento'],
    [2000, 'duemila'],
    [3000, 'tremila'],
    [23_000, 'ventitremila'],
    [1234, 'milleduecentotrentaquattro'],
    [21_000, 'ventunomila'],
    [100_000, 'centomila'],
    [1_000_000, 'un milione'],
    [2_000_000, 'due milioni'],
    [3_200_000, 'tre milioni duecentomila'],
    [23_000_000, 'ventitre milioni'],
    [1_000_000_023, 'un miliardo ventitré'],
    [1_000_000_000, 'un miliardo'],
    [1_000_000_000_000, 'un bilione'],
  ])('%s -> %s', (n, words) => {
    expect(say(n)).toBe(words);
  });

  test('feminine ends in una', () => {
    expect(say(1, 'feminine')).toBe('una');
    expect(say(21, 'feminine')).toBe('ventuna');
    expect(say(101, 'feminine')).toBe('centouna');
    expect(say(21_000, 'feminine')).toBe('ventunomila');
  });

  test('handles sign, decimals and the upper limit', () => {
    expect(say(-5)).toBe('meno cinque');
    expect(say('3.14')).toBe('tre virgola uno quattro');
    expect(() => say('1000000000000000')).toThrow(NumericRangeError);
  });
});

describe('it ordinals', () => {
  test.each([
    [1, 'primo'],
    [3, 'terzo'],
    [10, 'decimo'],
    [11, 'undicesimo'],
    [20, 'ventesimo'],
    [21, 'ventunesimo'],
    [23, 'ventitreesimo'],
    [26, 'ventiseiesimo'],
    [100, 'centesimo'],
    [1000, 'millesimo'],
    [2000, 'duemillesimo'],
    [1_000_000, 'milionesimo'],
    [3_000_000, 'tremilionesimo'],
  ])('masculine %s -> %s', (n, words) => {
    expect(spellOrdinal(n, { locale: it })).toBe(words);
  });

  test('feminine swaps -o for -a; neuter equals masculine', () => {
    expect(spellOrdinal(1, { locale: it, gender: 'feminine' })).toBe('prima');
    expect(spellOrdinal(2, { locale: it, gender: 'feminine' })).toBe('seconda');
    expect(spellOrdinal(20, { locale: it, gender: 'feminine' })).toBe('ventesima');
    expect(spellOrdinal(20, { locale: it, gender: 'neuter' })).toBe('ventesimo');
  });

  test('formats digit ordinals', () => {
    expect(formatOrdinal(21, { locale: it })).toBe('21º');
    expect(formatOrdinal(21, { locale: it, gender: 'feminine' })).toBe('21ª');
  });
});

describe('it oversized integers', () => {
  test('rejects a 100 000-digit integer quickly', () => {
    const huge = 10n ** 100_000n - 1n;
    // spellNumber reads through Decimal, which already caps input at 10 000 digits.
    const maxDecimal = 10n ** 9999n;
    for (const run of [() => spellNumber(maxDecimal, { locale: it }), () => spellOrdinal(huge, { locale: it })]) {
      const start = Date.now();
      expect(run).toThrow(NumericRangeError);
      expect(Date.now() - start).toBeLessThan(50);
    }
  });
});
