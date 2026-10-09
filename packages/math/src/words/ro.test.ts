import { describe, expect, it } from 'vitest';

import { NumericRangeError } from '../errors.js';
import { formatOrdinal, spellNumber, spellOrdinal } from '../words.js';
import { ro } from './ro.js';

const say = (value: number | string, gender?: 'masculine' | 'feminine' | 'neuter') =>
  spellNumber(value, gender ? { locale: ro, gender } : { locale: ro });

describe('ro cardinals', () => {
  it.each([
    [0, 'zero'],
    [1, 'unu'],
    [2, 'doi'],
    [12, 'doisprezece'],
    [14, 'paisprezece'],
    [16, 'șaisprezece'],
    [21, 'douăzeci și unu'],
    [60, 'șaizeci'],
    [100, 'o sută'],
    [101, 'o sută unu'],
    [200, 'două sute'],
    [1000, 'o mie'],
    [2000, 'două mii'],
    [12_000, 'douăsprezece mii'],
    [21_000, 'douăzeci și una de mii'],
    [100_000, 'o sută de mii'],
    [1234, 'o mie două sute treizeci și patru'],
    [1_000_000, 'un milion'],
    [2_000_000, 'două milioane'],
    [25_000_000, 'douăzeci și cinci de milioane'],
    [1_000_000_000, 'un miliard'],
  ])('%s -> %s', (n, words) => {
    expect(say(n)).toBe(words);
  });

  it('agrees with feminine nouns', () => {
    expect(say(1, 'feminine')).toBe('una');
    expect(say(2, 'feminine')).toBe('două');
    expect(say(12, 'feminine')).toBe('douăsprezece');
    expect(say(21, 'feminine')).toBe('douăzeci și una');
  });

  it('follows the DOOM rule for the linking de (multiplier 20+, last two digits 00 or 20-99)', () => {
    expect(say(20_000)).toBe('douăzeci de mii');
    expect(say(101_000)).toBe('o sută una mii');
    expect(say(119_000)).toBe('o sută nouăsprezece mii');
    expect(say(120_000)).toBe('o sută douăzeci de mii');
    expect(say(101_000_000)).toBe('o sută unu milioane');
  });

  it('keeps the trailing unit in the requested gender after scale words', () => {
    expect(say(1001)).toBe('o mie unu');
    expect(say(2001)).toBe('două mii unu');
    expect(say(2001, 'feminine')).toBe('două mii una');
  });

  it('handles sign, decimals and the upper limit', () => {
    expect(say(-5)).toBe('minus cinci');
    expect(say('3.14')).toBe('trei virgulă unu patru');
    expect(say(999_999_999_999_999)).toContain('trilioane');
    expect(() => say('1000000000000000')).toThrow(NumericRangeError);
  });
});

describe('ro ordinals', () => {
  it.each([
    [1, 'primul'],
    [2, 'al doilea'],
    [3, 'al treilea'],
    [4, 'al patrulea'],
    [5, 'al cincilea'],
    [6, 'al șaselea'],
    [7, 'al șaptelea'],
    [8, 'al optulea'],
    [9, 'al nouălea'],
    [10, 'al zecelea'],
    [11, 'al unsprezecelea'],
    [12, 'al doisprezecelea'],
    [20, 'al douăzecilea'],
    [21, 'al douăzeci și unulea'],
    [100, 'al o sutălea'],
    [101, 'al o sută unulea'],
    [1000, 'al o mielea'],
    [1_000_000, 'al un milionulea'],
  ])('masculine %s -> %s', (n, words) => {
    expect(spellOrdinal(n, { locale: ro })).toBe(words);
  });

  it.each([
    [1, 'prima'],
    [2, 'a doua'],
    [3, 'a treia'],
    [4, 'a patra'],
    [5, 'a cincea'],
    [6, 'a șasea'],
    [7, 'a șaptea'],
    [8, 'a opta'],
    [9, 'a noua'],
    [10, 'a zecea'],
    [11, 'a unsprezecea'],
    [12, 'a douăsprezecea'],
    [20, 'a douăzecea'],
    [21, 'a douăzeci și una'],
    [100, 'a o suta'],
    [1000, 'a o mia'],
    [1_000_000, 'a un milioana'],
  ])('feminine %s -> %s', (n, words) => {
    expect(spellOrdinal(n, { locale: ro, gender: 'feminine' })).toBe(words);
  });

  it('formats digit ordinals', () => {
    expect(formatOrdinal(21, { locale: ro })).toBe('al 21-lea');
    expect(formatOrdinal(21, { locale: ro, gender: 'feminine' })).toBe('a 21-a');
    expect(formatOrdinal(1, { locale: ro })).toBe('1-ul');
    expect(formatOrdinal(1, { locale: ro, gender: 'feminine' })).toBe('1-a');
  });
});
