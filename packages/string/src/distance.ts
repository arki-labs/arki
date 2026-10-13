/**
 * String similarity measured in graphemes, so `é` and a flag count as one unit whichever way they
 * are encoded. Compare case-insensitively or accent-insensitively by folding both inputs first
 * (`fold` in `./unicode`). All three are O(n·m) in the grapheme counts.
 */

import { graphemes } from './unicode.js';

export type JaroWinklerOptions = Readonly<{
  /** Weight of the common prefix (at most 4 graphemes). Default 0.1; must stay at or below 0.25. */
  prefixScale?: number;
}>;

/** Minimum number of grapheme insertions, deletions, and substitutions turning `a` into `b`. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const source = [...graphemes(a)];
  const target = [...graphemes(b)];
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
 */
export function jaroWinkler(a: string, b: string, options: JaroWinklerOptions = {}): number {
  const scale = options.prefixScale ?? 0.1;
  if (!(scale >= 0 && scale <= 0.25)) {
    throw new RangeError(`prefixScale must be between 0 and 0.25, got ${String(options.prefixScale)}`);
  }
  if (a === b) return 1;
  const source = [...graphemes(a)];
  const target = [...graphemes(b)];
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
