import { describe, expect, it } from 'vitest';

import { NumericRangeError } from '../errors.js';
import { formatOrdinal, spellNumber, spellOrdinal } from '../words.js';
import { de } from './de.js';

describe('de cardinals', () => {
  it.each([
    [0, 'null'],
    [1, 'eins'],
    [7, 'sieben'],
    [11, 'elf'],
    [17, 'siebzehn'],
    [21, 'einundzwanzig'],
    [30, 'dreißig'],
    [32, 'zweiunddreißig'],
    [100, 'einhundert'],
    [101, 'einhunderteins'],
    [200, 'zweihundert'],
    [1000, 'eintausend'],
    [1001, 'eintausendeins'],
    [1234, 'eintausendzweihundertvierunddreißig'],
    [21_000, 'einundzwanzigtausend'],
    [100_000, 'einhunderttausend'],
    [1_000_000, 'eine Million'],
    [2_000_000, 'zwei Millionen'],
    [3_200_000, 'drei Millionen zweihunderttausend'],
    [1_000_001, 'eine Million eins'],
    [101_000_000, 'einhunderteine Millionen'],
    [1_000_000_000, 'eine Milliarde'],
    [2_000_000_000, 'zwei Milliarden'],
    [1_000_000_000_000, 'eine Billion'],
    [2_000_000_000_000, 'zwei Billionen'],
  ])('spells %s as %s', (n, words) => {
    expect(spellNumber(n, { locale: de })).toBe(words);
  });

  it('reads signs and fractions', () => {
    expect(spellNumber(-5, { locale: de })).toBe('minus fünf');
    expect(spellNumber('3.14', { locale: de })).toBe('drei Komma eins vier');
  });

  it('keeps the long scale: the largest supported number is 10^15 - 1, beyond it throws', () => {
    expect(spellNumber('999999999999999', { locale: de })).toContain('neunhundertneunundneunzig Billionen');
    expect(() => spellNumber('1000000000000000', { locale: de })).toThrow(NumericRangeError);
  });
});

describe('de ordinals', () => {
  it.each([
    [1, 'erste'],
    [3, 'dritte'],
    [7, 'siebte'],
    [8, 'achte'],
    [12, 'zwölfte'],
    [13, 'dreizehnte'],
    [20, 'zwanzigste'],
    [21, 'einundzwanzigste'],
    [100, 'hundertste'],
    [101, 'hunderterste'],
    [1000, 'tausendste'],
    [1_000_000, 'millionste'],
    [2_000_000, 'zweimillionste'],
  ])('spells ordinal %s as %s', (n, words) => {
    expect(spellOrdinal(n, { locale: de })).toBe(words);
  });

  it('agrees with gender', () => {
    expect(spellOrdinal(1, { locale: de, gender: 'masculine' })).toBe('erster');
    expect(spellOrdinal(1, { locale: de, gender: 'feminine' })).toBe('erste');
    expect(spellOrdinal(1, { locale: de, gender: 'neuter' })).toBe('erstes');
    expect(spellOrdinal(21, { locale: de, gender: 'neuter' })).toBe('einundzwanzigstes');
  });

  it('writes digit ordinals with a period for every gender', () => {
    expect(formatOrdinal(21, { locale: de })).toBe('21.');
    expect(formatOrdinal(21, { locale: de, gender: 'feminine' })).toBe('21.');
  });
});
