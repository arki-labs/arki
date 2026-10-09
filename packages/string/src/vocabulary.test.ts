import { describe, expect, it } from 'vitest';

import {
  lexicalDiversity,
  simpsonsDiversityIndex,
  uniqueWordCount,
  wordFrequencies,
  wordLengthStats,
  yulesK,
} from './vocabulary.js';

describe('uniqueWordCount', () => {
  it('compares words case-insensitively, with an explicit locale when asked', () => {
    expect(uniqueWordCount('The the THE cat')).toBe(2);
    expect(uniqueWordCount('İstanbul istanbul', { locale: 'tr' })).toBe(1);
    expect(uniqueWordCount('')).toBe(0);
  });
});

describe('wordFrequencies', () => {
  it('covers every word with its share, most frequent first then alphabetical', () => {
    expect(wordFrequencies('b a B c a')).toEqual([
      { word: 'a', count: 2, percentage: 40 },
      { word: 'b', count: 2, percentage: 40 },
      { word: 'c', count: 1, percentage: 20 },
    ]);
    expect(wordFrequencies('')).toEqual([]);
  });
});

describe('diversity', () => {
  it('lexicalDiversity is distinct over total; 0 when empty', () => {
    expect(lexicalDiversity('a a b')).toBeCloseTo(2 / 3);
    expect(lexicalDiversity('')).toBe(0);
  });

  it("yulesK is 0 for all-distinct text and grows with repetition; Simpson's is 1 for all-distinct", () => {
    expect(yulesK('a b c d')).toBe(0);
    expect(yulesK('a a a b')).toBeGreaterThan(yulesK('a a b b'));
    expect(simpsonsDiversityIndex('a b c d')).toBe(1);
    expect(simpsonsDiversityIndex('a a a a')).toBe(0);
    expect(simpsonsDiversityIndex('a')).toBe(0);
  });
});

describe('wordLengthStats', () => {
  it('measures graphemes, not UTF-16 units', () => {
    const decomposed = 'ééé'.normalize('NFD'); // 6 code units, 3 graphemes
    expect(decomposed).toHaveLength(6);
    expect(wordLengthStats(`ab abcd ab ${decomposed}`)).toEqual({
      average: 2.75,
      median: 2.5,
      mode: 2,
      shortest: 2,
      longest: 4,
      standardDeviation: Math.sqrt(((2 - 2.75) ** 2 * 2 + (3 - 2.75) ** 2 + (4 - 2.75) ** 2) / 4),
    });
    expect(wordLengthStats('abc').median).toBe(3);
    expect(wordLengthStats('').longest).toBe(0);
  });
});
