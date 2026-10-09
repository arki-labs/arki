/**
 * Grapheme-aware positional operations.
 *
 * Native `String.prototype.length`, `slice`, and `at` count UTF-16 code units,
 * so `'👨‍👩‍👧'.length` is 8 and slicing can split an emoji in half. The
 * functions here count user-perceived characters (grapheme clusters) instead.
 * For UTF-16 units use the native methods; for bytes use `utf8Encode`.
 */

import { graphemeBoundaries, segmentGraphemes } from './internal/graphemes.js';

export { graphemeBoundaries } from './internal/graphemes.js';

/** Iterates the grapheme clusters of `text`. */
export function graphemes(text: string): IterableIterator<string> {
  return segmentGraphemes(text);
}

/** Number of grapheme clusters in `text`. */
export function length(text: string): number {
  return graphemeBoundaries(text).length - 1;
}

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer, got ${String(value)}`);
}

/** Normalizes a slice-style index (negative counts from the end, clamped to [0, count]). */
function resolveIndex(index: number, count: number): number {
  if (index < 0) return Math.max(count + index, 0);
  return Math.min(index, count);
}

/** Grapheme at `index` (negative counts from the end), or `undefined` when out of range. */
export function at(text: string, index: number): string | undefined {
  assertInteger(index, 'index');
  const boundaries = graphemeBoundaries(text);
  const count = boundaries.length - 1;
  const resolved = index < 0 ? count + index : index;
  if (resolved < 0 || resolved >= count) return undefined;
  return text.slice(boundaries[resolved], boundaries[resolved + 1]);
}

/** Grapheme-indexed slice with the same `start`/`end` semantics as `Array.prototype.slice`. */
export function slice(text: string, start = 0, end?: number): string {
  assertInteger(start, 'start');
  if (end !== undefined) assertInteger(end, 'end');
  const boundaries = graphemeBoundaries(text);
  const count = boundaries.length - 1;
  const from = resolveIndex(start, count);
  const to = end === undefined ? count : resolveIndex(end, count);
  if (to <= from) return '';
  return text.slice(boundaries[from], boundaries[to]);
}

/** The first `count` graphemes; a negative `count` takes from the end. */
export function take(text: string, count: number): string {
  assertInteger(count, 'count');
  if (count === 0) return '';
  return count > 0 ? slice(text, 0, count) : slice(text, count);
}

/** Reverses the grapheme sequence, keeping each grapheme intact. */
export function reverse(text: string): string {
  // eslint-disable-next-line unicorn/no-array-reverse -- fresh copy; ES2023 toReversed is missing on older engines
  return [...graphemes(text)].reverse().join('');
}

/** Immutable grapheme-indexed splice: removes `deleteCount` graphemes at `start` and inserts `insert`. */
export function splice(text: string, start: number, deleteCount: number, insert = ''): string {
  assertInteger(start, 'start');
  assertInteger(deleteCount, 'deleteCount');
  if (deleteCount < 0) throw new RangeError(`deleteCount must be >= 0, got ${String(deleteCount)}`);
  const boundaries = graphemeBoundaries(text);
  const count = boundaries.length - 1;
  const from = resolveIndex(start, count);
  const to = Math.min(from + deleteCount, count);
  return text.slice(0, boundaries[from]) + insert + text.slice(boundaries[to]);
}

/** Splits `text` into chunks of `size` graphemes; the last chunk may be shorter. */
export function chunk(text: string, size: number): string[] {
  assertInteger(size, 'size');
  if (size <= 0) throw new RangeError(`size must be > 0, got ${String(size)}`);
  const boundaries = graphemeBoundaries(text);
  const count = boundaries.length - 1;
  const chunks: string[] = [];
  for (let from = 0; from < count; from += size) {
    const to = Math.min(from + size, count);
    chunks.push(text.slice(boundaries[from], boundaries[to]));
  }
  return chunks;
}
