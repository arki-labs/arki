import { describe, expect, it } from 'vitest';

import { NumericRangeError } from '../errors.js';
import { formatOrdinal, spellNumber, spellOrdinal } from '../words.js';
import { fr } from './fr.js';

describe('fr cardinals', () => {
  it.each([
    [0, 'zéro'],
    [1, 'un'],
    [21, 'vingt et un'],
    [22, 'vingt-deux'],
    [70, 'soixante-dix'],
    [71, 'soixante et onze'],
    [72, 'soixante-douze'],
    [77, 'soixante-dix-sept'],
    [80, 'quatre-vingts'],
    [81, 'quatre-vingt-un'],
    [90, 'quatre-vingt-dix'],
    [91, 'quatre-vingt-onze'],
    [99, 'quatre-vingt-dix-neuf'],
    [100, 'cent'],
    [101, 'cent un'],
    [200, 'deux cents'],
    [201, 'deux cent un'],
    [280, 'deux cent quatre-vingts'],
    [1000, 'mille'],
    [2000, 'deux mille'],
    [2421, 'deux mille quatre cent vingt et un'],
    [1234, 'mille deux cent trente-quatre'],
    [80_000, 'quatre-vingt mille'],
    [200_000, 'deux cent mille'],
    [100_000, 'cent mille'],
    [1_000_000, 'un million'],
    [2_000_000, 'deux millions'],
    [80_000_000, 'quatre-vingts millions'],
    [1_000_000_000, 'un milliard'],
    [2_000_000_000, 'deux milliards'],
    [1_000_000_000_000, 'un billion'],
  ])('spells %s as %s', (n, words) => {
    expect(spellNumber(n, { locale: fr })).toBe(words);
  });

  it('uses the feminine where the number ends in 1', () => {
    expect(spellNumber(1, { locale: fr, gender: 'feminine' })).toBe('une');
    expect(spellNumber(21, { locale: fr, gender: 'feminine' })).toBe('vingt et une');
    expect(spellNumber(201, { locale: fr, gender: 'feminine' })).toBe('deux cent une');
  });

  it('reads signs and fractions', () => {
    expect(spellNumber(-5, { locale: fr })).toBe('moins cinq');
    expect(spellNumber('3.14', { locale: fr })).toBe('trois virgule un quatre');
  });

  it('throws beyond 10^15 - 1', () => {
    expect(() => spellNumber('1000000000000000', { locale: fr })).toThrow(NumericRangeError);
  });
});

describe('fr ordinals', () => {
  it.each([
    [1, 'premier'],
    [2, 'deuxième'],
    [3, 'troisième'],
    [4, 'quatrième'],
    [5, 'cinquième'],
    [9, 'neuvième'],
    [11, 'onzième'],
    [21, 'vingt et unième'],
    [80, 'quatre-vingtième'],
    [81, 'quatre-vingt-unième'],
    [100, 'centième'],
    [200, 'deux centième'],
    [1000, 'millième'],
    [1_000_000, 'un millionième'],
    [2_000_000, 'deux millionième'],
  ])('spells ordinal %s as %s', (n, words) => {
    expect(spellOrdinal(n, { locale: fr })).toBe(words);
  });

  it('only 1 changes with gender', () => {
    expect(spellOrdinal(1, { locale: fr, gender: 'feminine' })).toBe('première');
    expect(spellOrdinal(21, { locale: fr, gender: 'feminine' })).toBe('vingt et unième');
  });

  it('writes digit ordinals', () => {
    expect(formatOrdinal(1, { locale: fr })).toBe('1er');
    expect(formatOrdinal(1, { locale: fr, gender: 'feminine' })).toBe('1re');
    expect(formatOrdinal(2, { locale: fr })).toBe('2e');
    expect(formatOrdinal(21, { locale: fr })).toBe('21e');
  });
});

describe('fr oversized integers', () => {
  it('rejects a 100 000-digit integer quickly', () => {
    const huge = 10n ** 100_000n - 1n;
    // spellNumber reads through Decimal, which already caps input at 10 000 digits.
    const maxDecimal = 10n ** 9999n;
    for (const run of [() => spellNumber(maxDecimal, { locale: fr }), () => spellOrdinal(huge, { locale: fr })]) {
      const start = Date.now();
      expect(run).toThrow(NumericRangeError);
      expect(Date.now() - start).toBeLessThan(50);
    }
  });
});
