/**
 * String similarity measured in graphemes, so `é` and a flag count as one unit whichever way they
 * are encoded. Compare case-insensitively or accent-insensitively by folding both inputs first
 * (`fold` in `./unicode`). All three are O(n·m) in the grapheme counts.
 *
 * `levenshtein` and `jaroWinkler` are quadratic by nature: their time grows with the grapheme count
 * of `a` times that of `b` (two 100,000-grapheme texts are 10^10 steps). For input from outside,
 * pass `maxCells`: above it they return `ComparisonTooLarge` instead of computing.
 */
import type { FailureOf } from '@arki/failure';
import { defineFailure } from '@arki/failure';

import { STRING_ERROR_CODES, StringError } from './errors.js';
import { graphemes } from './unicode.js';

/** The strings are too long to compare within `maxCells`. No submitted input is exposed.
 * @fix Shorten or truncate the inputs, compare a prefix, or raise `maxCells`.
 * @verify bun run test -- src/distance.test.ts
 */
export const ComparisonTooLarge = /* @__PURE__ */ defineFailure('string.comparison_too_large', {
  status: 413,
  message: 'The strings are too long to compare within maxCells.',
  remediation: 'Shorten or truncate the inputs, compare a prefix, or raise maxCells.',
});

/** A bound on the work of a quadratic comparison. */
export type CellLimit = Readonly<{
  /**
   * The most cells (grapheme count of `a` × grapheme count of `b`) to compute. Above it the call
   * returns `ComparisonTooLarge`. A number of at least 0; `Infinity` means no limit. Leaving it
   * out computes at any size.
   */
  maxCells?: number;
}>;

/** No `maxCells`: the call always computes, and returns a number. */
type NoCellLimit = Readonly<{ maxCells?: undefined }>;

export type JaroWinklerOptions = Readonly<{
  /** Weight of the common prefix (at most 4 graphemes). Default 0.1; must stay at or below 0.25. */
  prefixScale?: number;
}>;

/** Whether `source × target` cells fit `options.maxCells`; throws on a `maxCells` that is not a number of at least 0. */
function withinLimit(source: readonly string[], target: readonly string[], options: CellLimit): boolean {
  const { maxCells } = options;
  if (maxCells === undefined) return true;
  if (!(maxCells >= 0)) {
    throw new StringError(
      STRING_ERROR_CODES.invalidArgument,
      `maxCells must be a number of at least 0, got ${String(maxCells)}`,
    );
  }
  return source.length * target.length <= maxCells;
}

/**
 * Minimum number of grapheme insertions, deletions, and substitutions turning `a` into `b`.
 *
 * Time grows with the grapheme count of `a` × that of `b`. With `maxCells`, a larger product
 * returns `ComparisonTooLarge` and nothing is computed. Equal strings return 0 at any length.
 *
 * @throws StringError `ARKI_STRING_E001` when `maxCells` is negative or `NaN`.
 */
export function levenshtein(a: string, b: string, options?: NoCellLimit): number;
export function levenshtein(a: string, b: string, options: CellLimit): number | FailureOf<typeof ComparisonTooLarge>;
export function levenshtein(
  a: string,
  b: string,
  options: CellLimit = {},
): number | FailureOf<typeof ComparisonTooLarge> {
  if (a === b) return 0;
  const source = [...graphemes(a)];
  const target = [...graphemes(b)];
  if (!withinLimit(source, target, options)) return ComparisonTooLarge();
  if (source.length === 0) return target.length;
  if (target.length === 0) return source.length;

  let previous = Array.from({ length: target.length + 1 }, (_, j) => j);
  let current = Array.from({ length: target.length + 1 }, () => 0);
  for (let i = 1; i <= source.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= target.length; j += 1) {
      const cost = source[i - 1] === target[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[target.length] ?? 0;
}

/**
 * Sørensen–Dice coefficient over grapheme bigrams, 0–1. Identical strings score 1; strings
 * shorter than two graphemes score 1 only when equal.
 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  const first = bigrams(a);
  const second = bigrams(b);
  if (first.size === 0 || second.size === 0) return 0;
  let shared = 0;
  let firstTotal = 0;
  let secondTotal = 0;
  for (const [bigram, count] of first) {
    firstTotal += count;
    shared += Math.min(count, second.get(bigram) ?? 0);
  }
  for (const count of second.values()) secondTotal += count;
  return (2 * shared) / (firstTotal + secondTotal);
}

function bigrams(text: string): Map<string, number> {
  const units = [...graphemes(text)];
  const counts = new Map<string, number>();
  for (let i = 1; i < units.length; i += 1) {
    const bigram = `${units[i - 1] ?? ''}${units[i] ?? ''}`;
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Jaro–Winkler similarity, 0–1: Jaro similarity boosted for a shared prefix. Suited to short
 * strings such as names. Both empty gives 1; one empty gives 0.
 *
 * Time grows with the grapheme count of `a` × that of `b`. With `maxCells`, a larger product
 * returns `ComparisonTooLarge` and nothing is computed. Equal strings return 1 at any length.
 *
 * @throws StringError `ARKI_STRING_E001` when `prefixScale` is outside 0–0.25, or `maxCells` is negative or `NaN`.
 */
export function jaroWinkler(a: string, b: string, options?: JaroWinklerOptions & NoCellLimit): number;
export function jaroWinkler(
  a: string,
  b: string,
  options: JaroWinklerOptions & CellLimit,
): number | FailureOf<typeof ComparisonTooLarge>;
export function jaroWinkler(
  a: string,
  b: string,
  options: JaroWinklerOptions & CellLimit = {},
): number | FailureOf<typeof ComparisonTooLarge> {
  const scale = options.prefixScale ?? 0.1;
  if (!(scale >= 0 && scale <= 0.25)) {
    throw new StringError(
      STRING_ERROR_CODES.invalidArgument,
      `prefixScale must be between 0 and 0.25, got ${String(options.prefixScale)}`,
    );
  }
  if (a === b) return 1;
  const source = [...graphemes(a)];
  const target = [...graphemes(b)];
  if (!withinLimit(source, target, options)) return ComparisonTooLarge();
  if (source.length === 0 || target.length === 0) return 0;

  const jaro = jaroSimilarity(source, target);
  let prefix = 0;
  while (prefix < 4 && prefix < source.length && prefix < target.length && source[prefix] === target[prefix]) {
    prefix += 1;
  }
  return jaro + prefix * scale * (1 - jaro);
}

function jaroSimilarity(source: readonly string[], target: readonly string[]): number {
  const window = Math.max(0, Math.floor(Math.max(source.length, target.length) / 2) - 1);
  const sourceMatched = Array.from({ length: source.length }, () => false);
  const targetMatched = Array.from({ length: target.length }, () => false);
  let matches = 0;

  for (const [i, unit] of source.entries()) {
    const from = Math.max(0, i - window);
    const to = Math.min(target.length - 1, i + window);
    for (let j = from; j <= to; j += 1) {
      if (targetMatched[j] === true || unit !== target[j]) continue;
      sourceMatched[i] = true;
      targetMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (const [i, unit] of source.entries()) {
    if (sourceMatched[i] !== true) continue;
    while (targetMatched[k] !== true) k += 1;
    if (unit !== target[k]) transpositions += 1;
    k += 1;
  }
  const halfTranspositions = transpositions / 2;
  return (matches / source.length + matches / target.length + (matches - halfTranspositions) / matches) / 3;
}
