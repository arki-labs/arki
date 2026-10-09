import { describe, expect, it } from 'vitest';

import {
  automatedReadabilityIndex,
  colemanLiauIndex,
  fleschKincaidGrade,
  fleschReadingEase,
  fleschReadingEaseLevel,
  gunningFog,
  lix,
  readability,
  readingTime,
  smogIndex,
  speakingTime,
  syllableCount,
} from './readability.js';

const EASY =
  'The quick brown fox jumps over the lazy dog. It was a sunny day, and the fox was happy. Dogs are not always lazy, but this one was.';
const MEDIUM =
  'Readability formulas estimate how difficult a passage is to understand. They typically combine average sentence length with a measure of word complexity, such as syllables per word or the share of long words. Although imperfect, these scores remain useful for comparing drafts.';
const HARD =
  'Notwithstanding the aforementioned considerations, the committee unanimously concluded that the implementation of comprehensive organizational restructuring would necessitate extraordinary expenditure. Consequently, alternative methodologies were investigated.';

describe('syllableCount', () => {
  it.each([
    ['the', 1],
    ['cake', 1],
    ['queue', 1],
    ['table', 2],
    ['minute', 2],
    ['hospital', 3],
    ['impressive', 3],
    ['justification', 5],
    ['jumped', 1],
    ['needed', 2],
    ['wanted', 2],
    ['cakes', 1],
    ['boxes', 2],
    ['wishes', 2],
    ['places', 2],
    ['piece', 1],
    ['people', 2],
    ['little', 2],
    ['whale', 1],
    ['beyond', 2],
    ['player', 2],
    ['poem', 2],
    ['radio', 3],
    ['piano', 3],
    ['nation', 2],
    ['special', 2],
    ['movement', 2],
    ['something', 2],
    ['lovely', 2],
    ['implement', 3],
    ['settlement', 3],
    ['readability', 5],
    ['unbelievable', 5],
    ['strength', 1],
    ['café', 2],
  ])('%s → %i', (word, expected) => {
    expect(syllableCount(word)).toBe(expected);
  });

  it('sums over words and counts words without Latin letters as 0', () => {
    expect(syllableCount('the quick brown fox')).toBe(4);
    expect(syllableCount('42 🙂 日本')).toBe(0);
    expect(syllableCount('')).toBe(0);
  });
});

describe('formulas', () => {
  it('computes Flesch and Flesch-Kincaid from their inputs (28 words, 3 sentences, 34 syllables)', () => {
    expect(syllableCount(EASY)).toBe(34);
    const wordsPerSentence = 28 / 3;
    const syllablesPerWord = 34 / 28;
    expect(fleschReadingEase(EASY)).toBeCloseTo(206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord, 6);
    expect(fleschKincaidGrade(EASY)).toBeCloseTo(0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59, 6);
  });

  it('ranks easy < medium < hard on every grade-style index', () => {
    for (const score of [fleschKincaidGrade, gunningFog, smogIndex, colemanLiauIndex, automatedReadabilityIndex, lix]) {
      expect(score(EASY)).toBeLessThan(score(MEDIUM));
      expect(score(MEDIUM)).toBeLessThan(score(HARD));
    }
    expect(fleschReadingEase(EASY)).toBeGreaterThan(fleschReadingEase(MEDIUM));
    expect(fleschReadingEase(MEDIUM)).toBeGreaterThan(fleschReadingEase(HARD));
  });

  it('clamps Flesch to 0–100 and labels the bands', () => {
    expect(fleschReadingEase(HARD)).toBe(0);
    expect(fleschReadingEase('')).toBe(100);
    expect(fleschReadingEaseLevel(95)).toBe('Very Easy');
    expect(fleschReadingEaseLevel(65)).toBe('Standard');
    expect(fleschReadingEaseLevel(10)).toBe('Very Confusing');
    expect(readability(EASY).fleschReadingEaseLevel).toBe('Very Easy');
    expect(readability(HARD).fleschReadingEaseLevel).toBe('Very Confusing');
  });

  it('excludes proper nouns and hyphenated compounds from Gunning complex words', () => {
    const plain = 'the beautiful sentence.';
    expect(gunningFog('the Beautiful sentence.')).toBeLessThan(gunningFog(plain));
    expect(gunningFog('the beauti-ful sentence.')).toBeLessThan(gunningFog(plain));
  });

  it('is all zeros (and Flesch 100) for text without words', () => {
    expect(readability('...')).toEqual({
      fleschReadingEase: 100,
      fleschKincaidGrade: 0,
      gunningFog: 0,
      smogIndex: 0,
      colemanLiauIndex: 0,
      automatedReadabilityIndex: 0,
      lix: 0,
      fleschReadingEaseLevel: 'Very Easy',
    });
  });
});

describe('readingTime / speakingTime', () => {
  it('returns seconds from the word count and rate', () => {
    const text = Array.from({ length: 238 }, () => 'word').join(' ');
    expect(readingTime(text)).toEqual({ words: 238, seconds: 60, minutes: 1 });
    expect(readingTime(text, { wordsPerMinute: 476 }).seconds).toBe(30);
    expect(speakingTime(text).seconds).toBeCloseTo(95.2);
    expect(readingTime('').seconds).toBe(0);
    expect(() => readingTime(text, { wordsPerMinute: 0 })).toThrow(RangeError);
  });
});

describe('option validation', () => {
  it('rejects non-finite reading speeds', () => {
    expect(() => readingTime('a b', { wordsPerMinute: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => speakingTime('a b', { wordsPerMinute: Number.NaN })).toThrow(RangeError);
  });
});
