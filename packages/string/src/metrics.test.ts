import { describe, expect, it } from 'vitest';

import { textMetrics } from './metrics.js';
import { readability } from './readability.js';

describe('textMetrics', () => {
  it('reports grapheme counts and a consistent composite', () => {
    const text = 'Hi 👩‍💻!\n\nSecond line here.';
    const metrics = textMetrics(text);
    expect(metrics.characters).toBe(24);
    expect(metrics.charactersWithoutSpaces).toBe(19);
    expect(metrics.words).toBe(4);
    expect(metrics.sentences).toBe(2);
    expect(metrics.paragraphs).toBe(2);
    expect(metrics.longestSentenceWords).toBe(3);
    expect(metrics.shortestSentenceWords).toBe(1);
    expect(metrics.averageSentenceLength).toBe(2);
    expect(metrics.readability).toEqual(readability(text));
    expect(metrics.readingTimeSeconds).toBeCloseTo((4 / 238) * 60);
  });

  it('is all zeros for empty text', () => {
    const metrics = textMetrics('   ');
    expect(metrics.words).toBe(0);
    expect(metrics.averageSyllablesPerWord).toBe(0);
    expect(metrics.keywords).toEqual([]);
    expect(metrics.mostCommonWords).toEqual([]);
    expect(metrics.wordLength.average).toBe(0);
  });

  it('keyPhrases are two-word phrases seen at least twice', () => {
    // Candidates: "deep learning" ×3, "learning here", "learning everywhere" ("there" is a stop word) = 5.
    const metrics = textMetrics('deep learning here, deep learning there, deep learning everywhere');
    expect(metrics.keyPhrases).toEqual([{ keyword: 'deep learning', occurrences: 3, percentage: 60 }]);
  });
});
