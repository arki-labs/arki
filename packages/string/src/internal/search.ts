/**
 * Literal search that only matches at grapheme boundaries, so searching for `e`
 * never matches the base letter of `é`. A native `indexOf` miss short-circuits
 * before any segmentation; callers that search repeatedly pass a shared
 * boundary set.
 */

import { graphemeBoundaries, isGraphemeBoundary } from './graphemes.js';

export function assertNeedle(needle: string, name = 'needle'): void {
  if (needle === '') throw new TypeError(`${name} must not be empty`);
}

export type FindOptions = Readonly<{
  from?: number;
  last?: boolean;
  /** Precomputed `boundarySet(text)` when the caller searches the same text more than once. */
  boundaries?: ReadonlySet<number>;
}>;

export function boundarySet(text: string): Set<number> {
  return new Set(graphemeBoundaries(text));
}

/** UTF-16 index of the first (or last) boundary-aligned occurrence of `needle`, or -1. */
export function findLiteral(text: string, needle: string, options: FindOptions = {}): number {
  assertNeedle(needle);
  let index = options.last === true ? text.lastIndexOf(needle) : text.indexOf(needle, options.from ?? 0);
  if (index === -1) return -1;

  const boundaries = options.boundaries ?? boundarySet(text);
  const aligned = (candidate: number): boolean =>
    boundaries.has(candidate) && boundaries.has(candidate + needle.length);

  if (options.last === true) {
    while (index !== -1) {
      if (aligned(index)) return index;
      index = index === 0 ? -1 : text.lastIndexOf(needle, index - 1);
    }
    return -1;
  }

  while (index !== -1) {
    if (aligned(index)) return index;
    index = text.indexOf(needle, index + 1);
  }
  return -1;
}

/** Whether `text` starts with `prefix` and the match ends on a grapheme boundary. */
export function hasPrefix(text: string, prefix: string): boolean {
  if (prefix === '') return true;
  return text.startsWith(prefix) && isGraphemeBoundary(text, prefix.length);
}

/** Whether `text` ends with `suffix` and the match starts on a grapheme boundary. */
export function hasSuffix(text: string, suffix: string): boolean {
  if (suffix === '') return true;
  return text.endsWith(suffix) && isGraphemeBoundary(text, text.length - suffix.length);
}
