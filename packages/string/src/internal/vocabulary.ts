/** Vocabulary statistics over a `TextAnalysis`; the public module wraps them for plain text. */

import type { TextAnalysis } from './analysis.js';
import { length } from '../unicode.js';
import { countItems } from './analysis.js';
import { sortedAscending, sum } from './math.js';

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

export function uniqueWordCountOf(a: TextAnalysis): number {
  return a.frequencies.size;
}

export function wordFrequenciesOf(a: TextAnalysis): WordFrequency[] {
  const total = a.lowerWords.length;
  return (
    [...a.frequencies]
      .map(([word, count]) => ({ word, count, percentage: (count / total) * 100 }))
      // eslint-disable-next-line unicorn/no-array-sort -- the array is freshly built; no ES2023 toSorted for older engines
      .sort((x, y) => y.count - x.count || (x.word < y.word ? -1 : 1))
  );
}

export function lexicalDiversityOf(a: TextAnalysis): number {
  const total = a.lowerWords.length;
  return total === 0 ? 0 : a.frequencies.size / total;
}

export function yulesKOf(a: TextAnalysis): number {
  const n = a.lowerWords.length;
  if (n === 0) return 0;
  let total = 0;
  for (const [frequency, wordsWithIt] of countItems([...a.frequencies.values()])) {
    total += frequency ** 2 * wordsWithIt;
  }
  return 10_000 * (total / (n * n) - 1 / n);
}

export function simpsonsDiversityIndexOf(a: TextAnalysis): number {
  const n = a.lowerWords.length;
  if (n < 2) return 0;
  let repeats = 0;
  for (const count of a.frequencies.values()) repeats += count * (count - 1);
  return 1 - repeats / (n * (n - 1));
}

export function wordLengthStatsOf(a: TextAnalysis): WordLengthStats {
  const lengths = sortedAscending(a.words.map(word => length(word)));
  if (lengths.length === 0) {
    return { average: 0, median: 0, mode: 0, shortest: 0, longest: 0, standardDeviation: 0 };
  }
  const average = sum(lengths) / lengths.length;
  const middle = Math.floor(lengths.length / 2);
  const median =
    lengths.length % 2 === 0 ? ((lengths[middle - 1] ?? 0) + (lengths[middle] ?? 0)) / 2 : (lengths[middle] ?? 0);
  let mode = 0;
  let modeCount = 0;
  for (const [value, count] of countItems(lengths)) {
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
