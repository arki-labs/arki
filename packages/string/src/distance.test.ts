import { describe, expect, it } from 'vitest';

import { diceCoefficient, jaroWinkler, levenshtein } from './distance.js';
import { fold } from './unicode.js';

describe('levenshtein', () => {
  it.each([
    ['kitten', 'sitting', 3],
    ['flaw', 'lawn', 2],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['same', 'same', 0],
    ['Sunday', 'Saturday', 3],
  ])('%s → %s = %i', (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected);
  });

  it('counts graphemes, not code units: one accent or one flag is one edit', () => {
    expect(levenshtein('cafe', 'cafe\u0301')).toBe(1); // decomposed é
    expect(levenshtein('a\u{1F1F7}\u{1F1F4}', 'a')).toBe(1);
  });

  it('is symmetric and respects the triangle inequality on a sample', () => {
    const words = ['poem', 'poet', 'poetry', 'toe', 'moat'];
    for (const a of words)
      for (const b of words) {
        expect(levenshtein(a, b)).toBe(levenshtein(b, a));
        for (const c of words) expect(levenshtein(a, c)).toBeLessThanOrEqual(levenshtein(a, b) + levenshtein(b, c));
      }
  });
});

describe('diceCoefficient', () => {
  it('matches the textbook example', () => {
    expect(diceCoefficient('night', 'nacht')).toBeCloseTo(0.25, 5);
  });

  it('scores identical strings 1 and disjoint strings 0', () => {
    expect(diceCoefficient('abc', 'abc')).toBe(1);
    expect(diceCoefficient('abc', 'xyz')).toBe(0);
    expect(diceCoefficient('a', 'b')).toBe(0); // no bigrams at all
    expect(diceCoefficient('', '')).toBe(1);
  });

  it('counts repeated bigrams with multiplicity', () => {
    // "aaaa" has three "aa" bigrams, "aa" has one: 2·1 / (3+1)
    expect(diceCoefficient('aaaa', 'aa')).toBeCloseTo(0.5, 5);
  });
});

describe('jaroWinkler', () => {
  it('matches the reference values', () => {
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.9611, 3);
    expect(jaroWinkler('DWAYNE', 'DUANE')).toBeCloseTo(0.84, 2);
    expect(jaroWinkler('DIXON', 'DICKSONX')).toBeCloseTo(0.8133, 3);
  });

  it('handles empty input and the prefix option', () => {
    expect(jaroWinkler('', '')).toBe(1);
    expect(jaroWinkler('abc', '')).toBe(0);
    expect(jaroWinkler('abcdef', 'abcxyz', { prefixScale: 0 })).toBeLessThan(jaroWinkler('abcdef', 'abcxyz'));
    expect(() => jaroWinkler('a', 'b', { prefixScale: 0.5 })).toThrowError(/ARKI_STRING_E001/);
  });

  it('is what a name matcher needs: folding first makes accents and case irrelevant', () => {
    expect(jaroWinkler(fold('Émile Zola'), fold('emile zola'))).toBe(1);
  });
});
