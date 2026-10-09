import { describe, expect, it } from 'vitest';

import { NumericRangeError } from '../errors.js';
import { formatOrdinal, spellNumber, spellOrdinal } from '../words.js';
import { es } from './es.js';

describe('es cardinals', () => {
  it.each([
    [0, 'cero'],
    [1, 'uno'],
    [16, 'dieciséis'],
    [21, 'veintiuno'],
    [22, 'veintidós'],
    [31, 'treinta y uno'],
    [99, 'noventa y nueve'],
    [100, 'cien'],
    [101, 'ciento uno'],
    [120, 'ciento veinte'],
    [200, 'doscientos'],
    [500, 'quinientos'],
    [1000, 'mil'],
    [2000, 'dos mil'],
    [21_000, 'veintiún mil'],
    [31_000, 'treinta y un mil'],
    [101_000, 'ciento un mil'],
    [100_000, 'cien mil'],
    [200_000, 'doscientos mil'],
    [1234, 'mil doscientos treinta y cuatro'],
    [1_000_000, 'un millón'],
    [2_000_000, 'dos millones'],
    [21_000_000, 'veintiún millones'],
    [1_000_000_000, 'mil millones'],
    [2_000_000_000, 'dos mil millones'],
    [1_001_000_000, 'mil un millones'],
    [1_000_000_000_000, 'un billón'],
    [2_000_000_000_000, 'dos billones'],
  ])('spells %s as %s', (n, words) => {
    expect(spellNumber(n, { locale: es })).toBe(words);
  });

  it('agrees in the feminine', () => {
    const feminine = (n: number) => spellNumber(n, { locale: es, gender: 'feminine' });
    expect(feminine(1)).toBe('una');
    expect(feminine(21)).toBe('veintiuna');
    expect(feminine(31)).toBe('treinta y una');
    expect(feminine(200)).toBe('doscientas');
    expect(feminine(200_000)).toBe('doscientas mil');
    expect(feminine(21_000)).toBe('veintiuna mil');
    // Million is a masculine noun, so its count never turns feminine.
    expect(feminine(21_000_000)).toBe('veintiún millones');
  });

  it('reads signs and fractions', () => {
    expect(spellNumber(-5, { locale: es })).toBe('menos cinco');
    expect(spellNumber('3.14', { locale: es })).toBe('tres coma uno cuatro');
  });

  it('throws beyond 10^15 - 1', () => {
    expect(() => spellNumber('1000000000000000', { locale: es })).toThrow(NumericRangeError);
  });
});

describe('es ordinals', () => {
  it.each([
    [1, 'primero'],
    [3, 'tercero'],
    [7, 'séptimo'],
    [10, 'décimo'],
    [11, 'undécimo'],
    [12, 'duodécimo'],
    [13, 'decimotercero'],
    [19, 'decimonoveno'],
    [20, 'vigésimo'],
    [21, 'vigésimo primero'],
    [90, 'nonagésimo'],
    [100, 'centésimo'],
    [101, 'centésimo primero'],
    [200, 'ducentésimo'],
    [900, 'noningentésimo'],
    [1000, 'milésimo'],
    [2000, 'dosmilésimo'],
    [3000, 'tresmilésimo'],
    [10_000, 'diezmilésimo'],
    [22_000, 'veintidosmilésimo'],
    [100_000, 'cienmilésimo'],
    [2034, 'dosmilésimo trigésimo cuarto'],
    [1_000_000, 'millonésimo'],
    [2_000_000, 'dosmillonésimo'],
  ])('spells ordinal %s as %s', (n, words) => {
    expect(spellOrdinal(n, { locale: es })).toBe(words);
  });

  it('agrees in the feminine, neuter follows masculine', () => {
    expect(spellOrdinal(1, { locale: es, gender: 'feminine' })).toBe('primera');
    expect(spellOrdinal(21, { locale: es, gender: 'feminine' })).toBe('vigésima primera');
    expect(spellOrdinal(1, { locale: es, gender: 'neuter' })).toBe('primero');
    // Only the ordinal word agrees, not the count before it.
    expect(spellOrdinal(4000, { locale: es, gender: 'feminine' })).toBe('cuatromilésima');
  });

  it('writes digit ordinals with º / ª', () => {
    expect(formatOrdinal(21, { locale: es })).toBe('21.º');
    expect(formatOrdinal(21, { locale: es, gender: 'feminine' })).toBe('21.ª');
  });
});

describe('es oversized integers', () => {
  it('rejects a 100 000-digit integer quickly', () => {
    const huge = 10n ** 100_000n - 1n;
    // spellNumber reads through Decimal, which already caps input at 10 000 digits.
    const maxDecimal = 10n ** 9999n;
    for (const run of [() => spellNumber(maxDecimal, { locale: es }), () => spellOrdinal(huge, { locale: es })]) {
      const start = Date.now();
      expect(run).toThrow(NumericRangeError);
      expect(Date.now() - start).toBeLessThan(50);
    }
  });
});
