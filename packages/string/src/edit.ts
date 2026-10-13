/**
 * Literal editing, affixes, and grapheme-aware padding. Search strings are literal
 * and only match on grapheme boundaries; replacement strings are literal too, so
 * `$&` stays `$&`.
 */

import { escapeRegExp } from './escape.js';
import { graphemeBoundaries, segmentGraphemes } from './internal/graphemes.js';
import { assertNeedle, boundarySet, findLiteral, hasPrefix, hasSuffix } from './internal/search.js';
import { length } from './unicode.js';

export type MaskOptions = Readonly<{
  /** Grapheme index to start masking from; negative counts from the end. Defaults to 0. */
  start?: number;
  /** Grapheme index to stop before; negative counts from the end. Defaults to the end. */
  end?: number;
  /** Replacement for each masked grapheme. Defaults to `*`. */
  glyph?: string;
}>;

/** Replaces the first literal occurrence of `search`. */
export function replaceFirst(text: string, search: string, replacement: string): string {
  const index = findLiteral(text, search);
  return index === -1 ? text : text.slice(0, index) + replacement + text.slice(index + search.length);
}

/** Replaces the last literal occurrence of `search`. */
export function replaceLast(text: string, search: string, replacement: string): string {
  const index = findLiteral(text, search, { last: true });
  return index === -1 ? text : text.slice(0, index) + replacement + text.slice(index + search.length);
}

/** Replaces every literal occurrence of `search`, left to right without overlap. */
export function replaceAll(text: string, search: string, replacement: string): string {
  assertNeedle(search, 'search');
  if (!text.includes(search)) return text;
  const boundaries = boundarySet(text);
  let output = '';
  let cursor = 0;
  let index = findLiteral(text, search, { boundaries });
  while (index !== -1) {
    output += text.slice(cursor, index) + replacement;
    cursor = index + search.length;
    index = findLiteral(text, search, { from: cursor, boundaries });
  }
  return output + text.slice(cursor);
}

/** Replaces `search` only when `text` starts with it. */
export function replaceStart(text: string, search: string, replacement: string): string {
  assertNeedle(search, 'search');
  return hasPrefix(text, search) ? replacement + text.slice(search.length) : text;
}

/** Replaces `search` only when `text` ends with it. */
export function replaceEnd(text: string, search: string, replacement: string): string {
  assertNeedle(search, 'search');
  return hasSuffix(text, search) ? text.slice(0, text.length - search.length) + replacement : text;
}

/**
 * Simultaneous literal substitutions in one pass over `text`. At each position
 * the longest matching key wins, and inserted values are never re-scanned.
 */
export function swap(text: string, replacements: Readonly<Record<string, string>>): string {
  // eslint-disable-next-line unicorn/no-array-sort -- fresh array; ES2023 toSorted is missing on older engines
  const keys = Object.keys(replacements).sort((a, b) => b.length - a.length);
  for (const key of keys) assertNeedle(key, 'replacement key');
  if (keys.length === 0) return text;

  const boundaries = boundarySet(text);
  let output = '';
  let index = 0;
  while (index < text.length) {
    const key = boundaries.has(index)
      ? keys.find(candidate => text.startsWith(candidate, index) && boundaries.has(index + candidate.length))
      : undefined;
    if (key === undefined) {
      output += text[index] ?? '';
      index += 1;
    } else {
      output += replacements[key] ?? '';
      index += key.length;
    }
  }
  return output;
}

/** Collapses adjacent repeats of `token` (default: a space) into one. */
export function deduplicate(text: string, token = ' '): string {
  assertNeedle(token, 'token');
  const pattern = new RegExp(`(?:${escapeRegExp(token)}){2,}`, 'gu');
  return text.replaceAll(pattern, () => token);
}

/** Surrounds `text` with `opening` and `closing` (defaults to `opening`). */
export function wrap(text: string, opening: string, closing: string = opening): string {
  return opening + text + closing;
}

/** Removes one complete `opening`/`closing` pair; returns `text` unchanged when the pair is incomplete. */
export function unwrap(text: string, opening: string, closing: string = opening): string {
  if (text.length < opening.length + closing.length) return text;
  if (!hasPrefix(text, opening) || !hasSuffix(text, closing)) return text;
  return text.slice(opening.length, text.length - closing.length);
}

function resolveIndex(index: number, count: number): number {
  if (index < 0) return Math.max(count + index, 0);
  return Math.min(index, count);
}

const STARTS_WITH_MARK = /^\p{M}/u;

/**
 * Replaces every grapheme in the `[start, end)` range with `glyph`, so the masked length stays
 * visible. `glyph` may not start with a combining mark (it would attach to the previous grapheme).
 */
export function mask(text: string, options: MaskOptions = {}): string {
  const glyph = options.glyph ?? '*';
  if (STARTS_WITH_MARK.test(glyph)) throw new RangeError('glyph must not start with a combining mark');
  const boundaries = graphemeBoundaries(text);
  const count = boundaries.length - 1;
  const start = options.start ?? 0;
  const end = options.end ?? count;
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new RangeError('start and end must be integers');
  const from = resolveIndex(start, count);
  const to = resolveIndex(end, count);
  if (to <= from) return text;
  return text.slice(0, boundaries[from]) + glyph.repeat(to - from) + text.slice(boundaries[to]);
}

/** `needed` graphemes cycled from `fill`; rejects fills whose repeats merge (marks, flag halves). */
function padding(fill: string, needed: number): string {
  if (fill === '') throw new TypeError('fill must not be empty');
  const fillGraphemes = [...segmentGraphemes(fill)];
  let output = '';
  for (let index = 0; index < needed; index += 1) output += fillGraphemes[index % fillGraphemes.length] ?? '';
  if (STARTS_WITH_MARK.test(output) || length(output) !== needed) {
    throw new RangeError(`fill ${JSON.stringify(fill)} does not repeat into separate graphemes`);
  }
  return output;
}

function assertTargetLength(targetLength: number): void {
  if (!Number.isInteger(targetLength) || targetLength < 0) {
    throw new RangeError(`targetLength must be a non-negative integer, got ${String(targetLength)}`);
  }
}

/** Pads the start until `text` has `targetLength` graphemes. Never shortens. */
export function padStart(text: string, targetLength: number, fill = ' '): string {
  assertTargetLength(targetLength);
  const needed = targetLength - length(text);
  return needed <= 0 ? text : padding(fill, needed) + text;
}

/** Pads the end until `text` has `targetLength` graphemes. Never shortens. */
export function padEnd(text: string, targetLength: number, fill = ' '): string {
  assertTargetLength(targetLength);
  const needed = targetLength - length(text);
  return needed <= 0 ? text : text + padding(fill, needed);
}

/** Pads both sides to centre `text`; an odd extra grapheme goes on the right. */
export function padBoth(text: string, targetLength: number, fill = ' '): string {
  assertTargetLength(targetLength);
  const needed = targetLength - length(text);
  if (needed <= 0) return text;
  const left = Math.floor(needed / 2);
  return padding(fill, left) + text + padding(fill, needed - left);
}

/** Adds `prefix` unless `text` already starts with it. */
export function ensureStart(text: string, prefix: string): string {
  return hasPrefix(text, prefix) ? text : prefix + text;
}

/** Adds `suffix` unless `text` already ends with it. */
export function ensureEnd(text: string, suffix: string): string {
  return hasSuffix(text, suffix) ? text : text + suffix;
}

/** Removes one leading `prefix` when present. */
export function trimPrefix(text: string, prefix: string): string {
  return hasPrefix(text, prefix) ? text.slice(prefix.length) : text;
}

/** Removes one trailing `suffix` when present. */
export function trimSuffix(text: string, suffix: string): string {
  return hasSuffix(text, suffix) ? text.slice(0, text.length - suffix.length) : text;
}
