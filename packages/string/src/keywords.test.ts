import { describe, expect, it } from 'vitest';

import { keywords, STOP_WORDS } from './keywords.js';

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
    expect(STOP_WORDS.en.includes('the')).toBe(true);
    expect(keywords('')).toEqual([]);
    expect(() => keywords(TEXT, { length: 0 })).toThrowError(/ARKI_STRING_E001/);
  });
});

describe('tokenization follows words()', () => {
  it('never spans a comma glued to a word and keeps decomposed accents', () => {
    expect(keywords('alpha,beta gamma', { length: 2 })).toEqual([
      { keyword: 'beta gamma', occurrences: 1, percentage: 100 },
    ]);
    expect(keywords('café café')).toEqual([{ keyword: 'café', occurrences: 2, percentage: 100 }]);
    expect(keywords("don't stop", { minWordLength: 4 })).toEqual([
      { keyword: "don't", occurrences: 1, percentage: 50 },
      { keyword: 'stop', occurrences: 1, percentage: 50 },
    ]);
    expect(() => keywords('a', { limit: 0 })).toThrowError(/ARKI_STRING_E001/);
  });
});

describe('languages', () => {
  it('uses the stop-word list of the chosen language', () => {
    // `pentru` ("for") is a Romanian function word; the English list does not know it.
    expect(keywords('casa pentru masă', { language: 'ro' }).map(entry => entry.keyword)).toEqual(['casa', 'masă']);
    expect(keywords('casa pentru masă').map(entry => entry.keyword)).toContain('pentru');
    expect(STOP_WORDS.de).toContain('und');
  });
});

describe('keywords with a malformed locale tag', () => {
  it('matches the default result instead of throwing', () => {
    const text = 'Cats chase mice and cats chase birds';
    expect(keywords(text, { locale: 'xx_yy' })).toEqual(keywords(text));
  });
});
