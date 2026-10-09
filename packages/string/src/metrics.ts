/**
 * One object with every count, score, and statistic for a text — the "word counter" dashboard.
 * The text is analyzed once (tokenized, lowercased, syllabified, split into sentences) and every
 * field is derived from that single analysis. Import `./segment`, `./readability`, `./keywords`,
 * or `./vocabulary` directly when you need only a few numbers.
 */

import type { Keyword } from './keywords.js';
import type { ReadabilityScores } from './readability.js';
import type { VocabularyOptions, WordLengthStats } from './vocabulary.js';
import { analyze } from './internal/analysis.js';
import { sum } from './internal/math.js';
import { readabilityOf } from './internal/readability.js';
import {
  lexicalDiversityOf,
  simpsonsDiversityIndexOf,
  uniqueWordCountOf,
  wordFrequenciesOf,
  wordLengthStatsOf,
  yulesKOf,
} from './internal/vocabulary.js';
import { keywords } from './keywords.js';
import { readingTime, speakingTime } from './readability.js';
import { paragraphCount, wordCount } from './segment.js';
import { graphemes, length } from './unicode.js';

export type TextMetrics = Readonly<{
  /** Graphemes, line breaks included. */
  characters: number;
  /** Graphemes that are not whitespace. */
  charactersWithoutSpaces: number;
  words: number;
  uniqueWords: number;
  sentences: number;
  paragraphs: number;
  /** English heuristic; see `syllableCount`. */
  syllables: number;
  averageSentenceLength: number;
  averageSyllablesPerWord: number;
  longestSentenceWords: number;
  shortestSentenceWords: number;
  readingTimeSeconds: number;
  speakingTimeSeconds: number;
  readability: ReadabilityScores;
  /** Top 10 single words. */
  keywords: readonly Keyword[];
  /** Top 10 two-word phrases seen at least twice. */
  keyPhrases: readonly Keyword[];
  lexicalDiversity: number;
  yulesK: number;
  simpsonsDiversityIndex: number;
  wordLength: WordLengthStats;
  /** Top 10 words by raw frequency, stop words included. */
  mostCommonWords: readonly string[];
}>;

const WHITESPACE_ONLY = /^\s+$/u;

function nonWhitespaceGraphemes(text: string): number {
  let count = 0;
  for (const grapheme of graphemes(text)) if (!WHITESPACE_ONLY.test(grapheme)) count += 1;
  return count;
}

export function textMetrics(text: string, options: VocabularyOptions = {}): TextMetrics {
  const a = analyze(text, options.locale);
  const words = a.words.length;
  const syllables = sum(a.syllables);

  let longest = 0;
  let shortest = 0;
  for (const [index, sentence] of a.sentences.entries()) {
    const count = wordCount(sentence);
    longest = Math.max(longest, count);
    shortest = index === 0 ? count : Math.min(shortest, count);
  }

  return {
    characters: length(text),
    charactersWithoutSpaces: nonWhitespaceGraphemes(text),
    words,
    uniqueWords: uniqueWordCountOf(a),
    sentences: a.sentences.length,
    paragraphs: paragraphCount(text),
    syllables,
    averageSentenceLength: a.sentences.length === 0 ? 0 : words / a.sentences.length,
    averageSyllablesPerWord: words === 0 ? 0 : syllables / words,
    longestSentenceWords: longest,
    shortestSentenceWords: shortest,
    readingTimeSeconds: readingTime(text).seconds,
    speakingTimeSeconds: speakingTime(text).seconds,
    readability: readabilityOf(a),
    keywords: keywords(text, { ...options, limit: 10 }),
    keyPhrases: keywords(text, { ...options, length: 2, limit: 10, minOccurrences: 2 }),
    lexicalDiversity: lexicalDiversityOf(a),
    yulesK: yulesKOf(a),
    simpsonsDiversityIndex: simpsonsDiversityIndexOf(a),
    wordLength: wordLengthStatsOf(a),
    mostCommonWords: wordFrequenciesOf(a)
      .slice(0, 10)
      .map(entry => entry.word),
  };
}
