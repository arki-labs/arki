/**
 * Vocabulary statistics: how varied and how long the words of a text are. Words are compared
 * lowercased; pass `locale` for locale-sensitive lowercasing. Each function analyzes its text once,
 * or reuses a `TextAnalysis` from `analyze()` (in `./metrics`) when given one.
 */

import type { TextInput } from './internal/analysis.js';
import type { WordFrequency, WordLengthStats } from './internal/vocabulary.js';
import { toAnalysis } from './internal/analysis.js';
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
export function uniqueWordCount(text: TextInput, options: VocabularyOptions = {}): number {
  return uniqueWordCountOf(toAnalysis(text, options.locale));
}

/** Every distinct word with its count and share, most frequent first; ties alphabetically. */
export function wordFrequencies(text: TextInput, options: VocabularyOptions = {}): WordFrequency[] {
  return wordFrequenciesOf(toAnalysis(text, options.locale));
}

/** Type–token ratio: distinct words divided by all words, 0–1. `0` for empty text. */
export function lexicalDiversity(text: TextInput, options: VocabularyOptions = {}): number {
  return lexicalDiversityOf(toAnalysis(text, options.locale));
}

/** Yule's K: repetitiveness of the vocabulary; `0` when every word is distinct or the text is empty. */
export function yulesK(text: TextInput, options: VocabularyOptions = {}): number {
  return yulesKOf(toAnalysis(text, options.locale));
}

/** Simpson's diversity index for vocabulary, 0–1; `1` when every word is distinct. */
export function simpsonsDiversityIndex(text: TextInput, options: VocabularyOptions = {}): number {
  return simpsonsDiversityIndexOf(toAnalysis(text, options.locale));
}

/** Word lengths in graphemes. All zeros for text without words. */
export function wordLengthStats(text: TextInput): WordLengthStats {
  return wordLengthStatsOf(toAnalysis(text));
}
