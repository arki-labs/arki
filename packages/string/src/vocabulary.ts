/**
 * Vocabulary statistics: how varied and how long the words of a text are. Words are compared
 * lowercased; pass `locale` for locale-sensitive lowercasing. Each function analyzes its text once.
 */

import type { WordFrequency, WordLengthStats } from './internal/vocabulary.js';
import { analyze } from './internal/analysis.js';
import {
  lexicalDiversityOf,
  simpsonsDiversityIndexOf,
  uniqueWordCountOf,
  wordFrequenciesOf,
  wordLengthStatsOf,
  yulesKOf,
} from './internal/vocabulary.js';

export type { WordFrequency, WordLengthStats } from './internal/vocabulary.js';

export type VocabularyOptions = Readonly<{
  /** BCP 47 tag for lowercasing. Default: locale-independent. */
  locale?: string;
}>;

/** Distinct words, case-insensitively. */
export function uniqueWordCount(text: string, options: VocabularyOptions = {}): number {
  return uniqueWordCountOf(analyze(text, options.locale));
}

/** Every distinct word with its count and share, most frequent first; ties alphabetically. */
export function wordFrequencies(text: string, options: VocabularyOptions = {}): WordFrequency[] {
  return wordFrequenciesOf(analyze(text, options.locale));
}

/** Type–token ratio: distinct words divided by all words, 0–1. `0` for empty text. */
export function lexicalDiversity(text: string, options: VocabularyOptions = {}): number {
  return lexicalDiversityOf(analyze(text, options.locale));
}

/** Yule's K: repetitiveness of the vocabulary; `0` when every word is distinct or the text is empty. */
export function yulesK(text: string, options: VocabularyOptions = {}): number {
  return yulesKOf(analyze(text, options.locale));
}

/** Simpson's diversity index for vocabulary, 0–1; `1` when every word is distinct. */
export function simpsonsDiversityIndex(text: string, options: VocabularyOptions = {}): number {
  return simpsonsDiversityIndexOf(analyze(text, options.locale));
}

/** Word lengths in graphemes. All zeros for text without words. */
export function wordLengthStats(text: string): WordLengthStats {
  return wordLengthStatsOf(analyze(text));
}
