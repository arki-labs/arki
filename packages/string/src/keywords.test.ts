import { describe, expect, it } from 'vitest';

import { ENGLISH_STOP_WORDS, keywords } from './keywords.js';

const TEXT = 'Machine learning is fun. Machine learning, deep learning: learning machines.';

describe('keywords', () => {
  it('counts single words without stop words, most frequent first then alphabetical', () => {
    expect(keywords(TEXT)).toEqual([
      { keyword: 'learning', occurrences: 4, percentage: (4 / 9) * 100 },
      { keyword: 'machine', occurrences: 2, percentage: (2 / 9) * 100 },
      { keyword: 'deep', occurrences: 1, percentage: (1 / 9) * 100 },
      { keyword: 'fun', occurrences: 1, percentage: (1 / 9) * 100 },
      { keyword: 'machines', occurrences: 1, percentage: (1 / 9) * 100 },
    ]);
  });

  it('never builds phrases across clause punctuation or through stop words', () => {
    expect(keywords(TEXT, { length: 2 })).toEqual([
      { keyword: 'machine learning', occurrences: 2, percentage: 50 },
      { keyword: 'deep learning', occurrences: 1, percentage: 25 },
      { keyword: 'learning machines', occurrences: 1, percentage: 25 },
    ]);
    expect(keywords(TEXT, { length: 2, minOccurrences: 2, limit: 5 })).toHaveLength(1);
    expect(keywords(TEXT, { length: 3 })).toEqual([]);
  });

  it('honours stopWords: null, minWordLength, locale, and validates length', () => {
    expect(keywords('is is it', { stopWords: null, minWordLength: 1 })).toEqual([
      { keyword: 'is', occurrences: 2, percentage: (2 / 3) * 100 },
      { keyword: 'it', occurrences: 1, percentage: (1 / 3) * 100 },
    ]);
    expect(keywords('İstanbul istanbul', { locale: 'tr' })).toHaveLength(1);
    expect(ENGLISH_STOP_WORDS.includes('the')).toBe(true);
    expect(keywords('')).toEqual([]);
    expect(() => keywords(TEXT, { length: 0 })).toThrow(RangeError);
  });
});
