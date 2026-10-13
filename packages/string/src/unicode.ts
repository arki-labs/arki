/**
 * Grapheme-aware positional operations.
 *
 * Native `String.prototype.length`, `slice`, and `at` count UTF-16 code units,
 * so `'👨‍👩‍👧'.length` is 8 and slicing can split an emoji in half. The
 * functions here count user-perceived characters (grapheme clusters) instead.
 * For UTF-16 units use the native methods; for bytes use `utf8Encode`.
 *
 * Non-negative positions are resolved by scanning only as far as needed;
 * negative positions (counted from the end) need the full boundary list.
 */

import { graphemeBoundaries, graphemeBreaks, graphemeCount, segmentGraphemes } from './internal/graphemes.js';

export { graphemeBoundaries } from './internal/graphemes.js';

/** Iterates the grapheme clusters of `text`. */
export function graphemes(text: string): IterableIterator<string> {
  return segmentGraphemes(text);
}

/** Number of grapheme clusters in `text`. */
export function length(text: string): number {
  return graphemeCount(text);
}

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer, got ${String(value)}`);
}

/** Normalizes a slice-style index (negative counts from the end, clamped to [0, count]). */
function resolveIndex(index: number, count: number): number {
  if (index < 0) return Math.max(count + index, 0);
  return Math.min(index, count);
}

/**
 * UTF-16 offsets of boundaries `first` and `second` (grapheme positions, `first <= second`) in one
 * forward scan. A position past the end resolves to `text.length`.
 */
function offsetsAt(text: string, first: number, second: number): [number, number] {
  let firstOffset = first === 0 ? 0 : -1;
  let position = 0;
  for (const offset of graphemeBreaks(text)) {
    position += 1;
    if (position === first) firstOffset = offset;
    if (position === second) return [firstOffset === -1 ? offset : firstOffset, offset];
  }
  return [firstOffset === -1 ? text.length : firstOffset, text.length];
}

/** Grapheme at `index` (negative counts from the end), or `undefined` when out of range. */
export function at(text: string, index: number): string | undefined {
  assertInteger(index, 'index');
  if (index >= 0) {
    let start = 0;
    let position = 0;
    for (const end of graphemeBreaks(text)) {
      if (position === index) return text.slice(start, end);
      start = end;
      position += 1;
    }
    return undefined;
  }
  const boundaries = graphemeBoundaries(text);
  const count = boundaries.length - 1;
  const resolved = count + index;
  if (resolved < 0) return undefined;
  return text.slice(boundaries[resolved], boundaries[resolved + 1]);
}

/** Grapheme-indexed slice with the same `start`/`end` semantics as `Array.prototype.slice`. */
export function slice(text: string, start = 0, end?: number): string {
  assertInteger(start, 'start');
  if (end !== undefined) assertInteger(end, 'end');
  if (start >= 0 && (end === undefined || end >= 0)) {
    if (end !== undefined && end <= start) return '';
    const [from, to] = offsetsAt(text, start, end ?? Number.POSITIVE_INFINITY);
    return text.slice(from, to);
  }
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
  const chunks: string[] = [];
  let start = 0;
  let position = 0;
  for (const end of graphemeBreaks(text)) {
    position += 1;
    if (position % size === 0) {
      chunks.push(text.slice(start, end));
      start = end;
    }
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

export type FoldOptions = Readonly<{
  /** BCP 47 tag for lowercasing (`'tr'` keeps dotless i). Default: locale-independent. */
  locale?: string;
}>;

/** Latin letters that have no canonical decomposition, so stripping marks leaves them alone. */
const UNDECOMPOSABLE = new Map([
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['ø', 'o'],
  ['đ', 'd'],
  ['ł', 'l'],
  ['ı', 'i'],
  ['ħ', 'h'],
  ['ŧ', 't'],
  ['ð', 'd'],
  ['þ', 'th'],
]);
const UNDECOMPOSABLE_RE = /[ßæœøđłıħŧðþ]/gu;
const MARKS = /\p{M}/gu;

/**
 * Search-key form of `text`: lowercased, accents and other combining marks removed, and the few
 * Latin letters without a decomposition (`ß`, `ø`, `ł`, …) spelled out. `fold('Émile Zola')` is
 * `'emile zola'`. Lighter than `transliterate` (no script conversion) and meant for matching, not
 * display.
 */
export function fold(text: string, options: FoldOptions = {}): string {
  const lowered = options.locale === undefined ? text.toLowerCase() : text.toLocaleLowerCase(options.locale);
  return lowered
    .normalize('NFD')
    .replaceAll(MARKS, '')
    .normalize('NFC')
    .replaceAll(UNDECOMPOSABLE_RE, letter => UNDECOMPOSABLE.get(letter) ?? letter);
}
