import { describe, expect, it } from 'vitest';

import { decimal } from './decimal.js';
import { InvalidArgumentError, NumericRangeError } from './errors.js';
import { en, enGB, formatOrdinal, spellNumber, spellOrdinal, thousandsGroups } from './words.js';

describe('thousandsGroups', () => {
  it('splits most significant first', () => {
    expect(thousandsGroups(0n)).toEqual([0]);
    expect(thousandsGroups(999n)).toEqual([999]);
    expect(thousandsGroups(1000n)).toEqual([1, 0]);
    expect(thousandsGroups(1_234_567n)).toEqual([1, 234, 567]);
    expect(() => thousandsGroups(-1n)).toThrow(InvalidArgumentError);
  });
});

describe('spellNumber (en)', () => {
  it.each([
    [0, 'zero'],
    [1, 'one'],
    [13, 'thirteen'],
    [20, 'twenty'],
    [21, 'twenty-one'],
    [99, 'ninety-nine'],
    [100, 'one hundred'],
    [102, 'one hundred two'],
    [999, 'nine hundred ninety-nine'],
    [1000, 'one thousand'],
    [1005, 'one thousand five'],
    [1234, 'one thousand two hundred thirty-four'],
    [1_000_000, 'one million'],
    [1_000_001, 'one million one'],
    [2026, 'two thousand twenty-six'],
    [
      1_234_567_890,
      'one billion two hundred thirty-four million five hundred sixty-seven thousand eight hundred ninety',
    ],
  ])('%s → %s', (input, expected) => {
    expect(spellNumber(input)).toBe(expected);
  });

  it('reads negatives, fractions and exact inputs', () => {
    expect(spellNumber(-5)).toBe('minus five');
    expect(spellNumber('3.14')).toBe('three point one four');
    expect(spellNumber(0.1)).toBe('zero point one');
    expect(spellNumber('2.50')).toBe('two point five');
    expect(spellNumber(decimal('-0.05'))).toBe('minus zero point zero five');
    expect(spellNumber(10n ** 35n)).toBe('one hundred decillion');
  });

  it('respects the until / after thresholds like Laravel', () => {
    expect(spellNumber(11, { until: 10 })).toBe('11');
    expect(spellNumber(10, { until: 10 })).toBe('ten');
    expect(spellNumber(11, { after: 10 })).toBe('eleven');
    expect(spellNumber(10, { after: 10 })).toBe('10');
    expect(spellNumber(1_234_567, { until: 100 })).toBe('1,234,567');
  });

  it('throws beyond the largest scale word', () => {
    expect(() => spellNumber(10n ** 36n)).toThrow(NumericRangeError);
  });
});

describe('spellNumber (en-GB)', () => {
  it.each([
    [102, 'one hundred and two'],
    [1005, 'one thousand and five'],
    [1234, 'one thousand two hundred and thirty-four'],
    [1_000_100, 'one million one hundred'],
    [2_000_021, 'two million and twenty-one'],
  ])('%s → %s', (input, expected) => {
    expect(spellNumber(input, { locale: enGB })).toBe(expected);
  });
});

describe('spellOrdinal (en)', () => {
  it.each([
    [1, 'first'],
    [2, 'second'],
    [3, 'third'],
    [4, 'fourth'],
    [5, 'fifth'],
    [8, 'eighth'],
    [9, 'ninth'],
    [12, 'twelfth'],
    [20, 'twentieth'],
    [21, 'twenty-first'],
    [100, 'one hundredth'],
    [101, 'one hundred first'],
    [1000, 'one thousandth'],
    [1_000_000, 'one millionth'],
  ])('%s → %s', (input, expected) => {
    expect(spellOrdinal(input)).toBe(expected);
  });

  it('uses "and" in British English', () => {
    expect(spellOrdinal(101, { locale: enGB })).toBe('one hundred and first');
  });

  it('rejects zero, negatives and fractions', () => {
    expect(() => spellOrdinal(0)).toThrow(InvalidArgumentError);
    expect(() => spellOrdinal(-1)).toThrow(InvalidArgumentError);
    expect(() => spellOrdinal(1.5)).toThrow(InvalidArgumentError);
  });
});

describe('formatOrdinal (en)', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [111, '111th'],
    [1000, '1,000th'],
    [1001, '1,001st'],
  ])('%s → %s', (input, expected) => {
    expect(formatOrdinal(input)).toBe(expected);
  });

  it('accepts bigint and numeric strings', () => {
    expect(formatOrdinal(123n)).toBe('123rd');
    expect(formatOrdinal('42')).toBe('42nd');
  });
});

describe('locale object shape', () => {
  it('exposes the contract fields', () => {
    expect(en.code).toBe('en-US');
    expect(en.negative).toBe('minus');
    expect(en.decimalSeparator).toBe('point');
    expect(en.spell(7n, { gender: undefined })).toBe('seven');
    expect(en.ordinal(2n, '2', { gender: undefined })).toBe('2nd');
  });
});
