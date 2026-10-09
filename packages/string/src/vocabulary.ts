/**
 * Vocabulary statistics: how varied and how long the words of a text are. Words are compared
 * lowercased; pass `locale` for locale-sensitive lowercasing.
 */

import { lower } from './internal/locale.js';
import { sortedAscending, sum } from './internal/math.js';
import { words } from './segment.js';
import { length } from './unicode.js';

export type VocabularyOptions = Readonly<{
  /** BCP 47 tag for lowercasing. Default: locale-independent. */
  locale?: string;
}>;

export type WordFrequency = Readonly<{
  word: string;
  count: number;
  /** Share of all words, 0–100. */
  percentage: number;
}>;

export type WordLengthStats = Readonly<{
  average: number;
  median: number;
  mode: number;
  shortest: number;
  longest: number;
  standardDeviation: number;
}>;

function lowerWords(text: string, locale: string | undefined): string[] {
  return words(lower(text, locale));
}

function frequencies<T>(items: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

/** Distinct words, case-insensitively. */
export function uniqueWordCount(text: string, options: VocabularyOptions = {}): number {
  return new Set(lowerWords(text, options.locale)).size;
}

/** Every distinct word with its count and share, most frequent first; ties alphabetically. */
export function wordFrequencies(text: string, options: VocabularyOptions = {}): WordFrequency[] {
  const tokens = lowerWords(text, options.locale);
  return (
    [...frequencies(tokens)]
      .map(([word, count]) => ({ word, count, percentage: (count / tokens.length) * 100 }))
      // eslint-disable-next-line unicorn/no-array-sort -- the array is freshly built; no ES2023 toSorted for older engines
      .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : 1))
  );
}

/** Type–token ratio: distinct words divided by all words, 0–1. `0` for empty text. */
export function lexicalDiversity(text: string, options: VocabularyOptions = {}): number {
  const tokens = lowerWords(text, options.locale);
  return tokens.length === 0 ? 0 : new Set(tokens).size / tokens.length;
}

/** Yule's K: repetitiveness of the vocabulary; `0` when every word is distinct or the text is empty. */
export function yulesK(text: string, options: VocabularyOptions = {}): number {
  const tokens = lowerWords(text, options.locale);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const [frequency, wordsWithIt] of frequencies([...frequencies(tokens).values()])) {
    total += frequency ** 2 * wordsWithIt;
  }
  const n = tokens.length;
  return 10_000 * (total / (n * n) - 1 / n);
}

/** Simpson's diversity index for vocabulary, 0–1; `1` when every word is distinct. */
export function simpsonsDiversityIndex(text: string, options: VocabularyOptions = {}): number {
  const tokens = lowerWords(text, options.locale);
  const n = tokens.length;
  if (n < 2) return 0;
  let repeats = 0;
  for (const count of frequencies(tokens).values()) repeats += count * (count - 1);
  return 1 - repeats / (n * (n - 1));
}

/** Word lengths in graphemes. All zeros for text without words. */
export function wordLengthStats(text: string): WordLengthStats {
  const lengths = sortedAscending(words(text).map(word => length(word)));
  if (lengths.length === 0) {
    return { average: 0, median: 0, mode: 0, shortest: 0, longest: 0, standardDeviation: 0 };
  }
  const average = sum(lengths) / lengths.length;
  const middle = Math.floor(lengths.length / 2);
  const median =
    lengths.length % 2 === 0 ? ((lengths[middle - 1] ?? 0) + (lengths[middle] ?? 0)) / 2 : (lengths[middle] ?? 0);
  let mode = 0;
  let modeCount = 0;
  for (const [value, count] of frequencies(lengths)) {
    if (count > modeCount) {
      mode = value;
      modeCount = count;
    }
  }
  const variance = sum(lengths.map(value => (value - average) ** 2)) / lengths.length;
  return {
    average,
    median,
    mode,
    shortest: lengths[0] ?? 0,
    longest: lengths.at(-1) ?? 0,
    standardDeviation: Math.sqrt(variance),
  };
}
