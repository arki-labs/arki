import { describe, expect, expectTypeOf, it } from 'vitest';

import type { FailureOf } from '@arki/failure';

import type { CellLimit } from './distance.js';
import { ComparisonTooLarge, diceCoefficient, jaroWinkler, levenshtein } from './distance.js';
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

// Both are quadratic by nature: two long texts from outside (a pasted document, an uploaded file)
// would hold the thread for minutes. `maxCells` lets a caller bound the work and get a typed answer.
describe('maxCells bounds the quadratic comparisons', () => {
  const long = 'ab'.repeat(500); // 1,000 graphemes

  it('without maxCells both still return a plain number at any length', () => {
    const distance = levenshtein(long, `${long}x`);
    const similarity = jaroWinkler(long, `${long}x`);
    expectTypeOf(distance).toEqualTypeOf<number>();
    expectTypeOf(similarity).toEqualTypeOf<number>();
    expect(distance).toBe(1);
    expect(similarity).toBeGreaterThan(0.99);
  });

  it('above maxCells both return ComparisonTooLarge instead of computing', () => {
    // 1,000 × 1,001 graphemes = 1,001,000 cells.
    const distance = levenshtein(long, `${long}x`, { maxCells: 1_000_000 });
    const similarity = jaroWinkler(long, `${long}x`, { maxCells: 1_000_000, prefixScale: 0.2 });
    expectTypeOf(distance).toEqualTypeOf<number | FailureOf<typeof ComparisonTooLarge>>();
    expect(distance).toMatchObject({ code: 'string.comparison_too_large', status: 413 });
    expect(ComparisonTooLarge.is(similarity)).toBe(true);
  });

  it('at or below maxCells they compute the same answer as without it, counting cells in graphemes', () => {
    // 'cafe' (4) × 'cafe' + combining accent (4 graphemes, 5 code units) = 16 cells.
    expect(levenshtein('cafe', 'cafe\u0301', { maxCells: 16 })).toBe(1);
    expect(jaroWinkler('MARTHA', 'MARHTA', { maxCells: 36 })).toBe(jaroWinkler('MARTHA', 'MARHTA'));
    expect(levenshtein(long, `${long}x`, { maxCells: Infinity })).toBe(1);
  });

  it('equal strings need no comparison and answer at any length', () => {
    expect(levenshtein(long, long, { maxCells: 0 })).toBe(0);
    expect(jaroWinkler(long, long, { maxCells: 0 })).toBe(1);
  });

  it('a maxCells that is negative or NaN is a caller bug and throws E001', () => {
    expect(() => levenshtein('a', 'b', { maxCells: -1 })).toThrowError(/ARKI_STRING_E001/);
    expect(() => jaroWinkler('a', 'b', { maxCells: Number.NaN })).toThrowError(/ARKI_STRING_E001/);
  });

  it('an options value whose maxCells may be set is typed as possibly failing', () => {
    const options: CellLimit = {};
    expectTypeOf(levenshtein('a', 'b', options)).toEqualTypeOf<number | FailureOf<typeof ComparisonTooLarge>>();
    expectTypeOf(jaroWinkler('a', 'b', { prefixScale: 0.2, ...options })).toEqualTypeOf<
      number | FailureOf<typeof ComparisonTooLarge>
    >();
  });
});
