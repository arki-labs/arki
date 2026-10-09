/**
 * Literal search that only matches at grapheme boundaries, so searching for `e`
 * never matches the base letter of `é`.
 */

import { graphemeBoundaries } from './graphemes.js';

export function assertNeedle(needle: string, name = 'needle'): void {
  if (needle === '') throw new TypeError(`${name} must not be empty`);
}

/** UTF-16 index of the first (or last) boundary-aligned occurrence of `needle`, or -1. */
export function findLiteral(text: string, needle: string, options: { from?: number; last?: boolean } = {}): number {
  assertNeedle(needle);
  const boundaries = new Set(graphemeBoundaries(text));
  const aligned = (index: number): boolean => boundaries.has(index) && boundaries.has(index + needle.length);

  if (options.last === true) {
    let index = text.lastIndexOf(needle);
    while (index !== -1) {
      if (aligned(index)) return index;
      index = index === 0 ? -1 : text.lastIndexOf(needle, index - 1);
    }
    return -1;
  }

  let index = text.indexOf(needle, options.from ?? 0);
  while (index !== -1) {
    if (aligned(index)) return index;
    index = text.indexOf(needle, index + 1);
  }
  return -1;
}

/** Whether `text` starts with `prefix` and the match ends on a grapheme boundary. */
export function hasPrefix(text: string, prefix: string): boolean {
  if (prefix === '') return true;
  return text.startsWith(prefix) && graphemeBoundaries(text).includes(prefix.length);
}

/** Whether `text` ends with `suffix` and the match starts on a grapheme boundary. */
export function hasSuffix(text: string, suffix: string): boolean {
  if (suffix === '') return true;
  return text.endsWith(suffix) && graphemeBoundaries(text).includes(text.length - suffix.length);
}
