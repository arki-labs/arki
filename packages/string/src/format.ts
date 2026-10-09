/**
 * Whitespace cleanup and display formatting: initials, truncation, excerpts, wrapping.
 */

import { graphemeBoundaries } from './internal/graphemes.js';
import { findLiteral } from './internal/search.js';
import { lines } from './segment.js';
import { at, chunk, length, slice, take } from './unicode.js';

export type TruncateOptions = Readonly<{
  /** Marker appended when text is cut. Defaults to `…`. Counts toward `maxLength`. */
  ellipsis?: string;
  /** `grapheme` cuts anywhere; `word-before` backs up to the previous word boundary. */
  boundary?: 'grapheme' | 'word-before';
}>;

export type InitialsOptions = Readonly<{
  /** Maximum number of initials. Defaults to 2. */
  max?: number;
  /** With more components than `max`, keep the first ones or the first and last. Defaults to `first-last`. */
  pick?: 'first' | 'first-last';
  locale?: string;
}>;

export type ExcerptOptions = Readonly<{
  /** Graphemes kept on each side of the match. Defaults to 40. */
  radius?: number;
  ellipsis?: string;
}>;

export type WrapTextOptions = Readonly<{
  /** Cut words longer than `width` instead of overflowing. Defaults to false. */
  breakWords?: boolean;
  /** Line separator for the output. Defaults to `\n`. */
  newline?: string;
}>;

const WHITESPACE_RUN = /\s+/gu;

/** Collapses every whitespace run to one space. Leading/trailing runs become one space each. */
export function collapseWhitespace(text: string): string {
  return text.replaceAll(WHITESPACE_RUN, ' ');
}

/** Collapses whitespace and trims both ends. */
export function squish(text: string): string {
  return collapseWhitespace(text).trim();
}

/** Uppercase first graphemes of the name components in `text`. Empty input gives `''`. */
export function initials(text: string, options: InitialsOptions = {}): string {
  const max = options.max ?? 2;
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`max must be a positive integer, got ${String(max)}`);
  const components = squish(text)
    .split(' ')
    .filter(component => component !== '');
  if (components.length === 0) return '';

  const picked =
    components.length > max && (options.pick ?? 'first-last') === 'first-last'
      ? [...components.slice(0, max - 1), components.at(-1) ?? '']
      : components.slice(0, max);

  return picked
    .map(component => at(component, 0) ?? '')
    .map(initial => (options.locale === undefined ? initial.toUpperCase() : initial.toLocaleUpperCase(options.locale)))
    .join('');
}

/** Cuts `text` to at most `maxLength` graphemes including the ellipsis. Returns the original when it fits. */
export function truncate(text: string, maxLength: number, options: TruncateOptions = {}): string {
  if (!Number.isInteger(maxLength) || maxLength < 0) {
    throw new RangeError(`maxLength must be a non-negative integer, got ${String(maxLength)}`);
  }
  if (maxLength === 0) return '';
  const total = length(text);
  if (total <= maxLength) return text;

  const ellipsis = options.ellipsis ?? '…';
  const ellipsisLength = length(ellipsis);
  if (ellipsisLength >= maxLength) return take(ellipsis, maxLength);

  const budget = maxLength - ellipsisLength;
  let cut = take(text, budget);

  if (options.boundary === 'word-before') {
    const next = at(text, budget) ?? '';
    if (!/^\s$/u.test(next)) {
      const lastSpace = cut.search(/\s+\S*$/u);
      if (lastSpace > 0) cut = cut.slice(0, lastSpace);
    }
    cut = cut.trimEnd();
  }

  return cut + ellipsis;
}

/** Context around the first match of `needle`, or `undefined` when absent. */
export function excerpt(text: string, needle: string, options: ExcerptOptions = {}): string | undefined {
  const radius = options.radius ?? 40;
  if (!Number.isInteger(radius) || radius < 0) {
    throw new RangeError(`radius must be a non-negative integer, got ${String(radius)}`);
  }
  const index = findLiteral(text, needle);
  if (index === -1) return undefined;

  const boundaries = graphemeBoundaries(text);
  const count = boundaries.length - 1;
  const startGrapheme = boundaries.indexOf(index);
  const endGrapheme = boundaries.indexOf(index + needle.length);
  const from = Math.max(startGrapheme - radius, 0);
  const to = Math.min(endGrapheme + radius, count);
  const ellipsis = options.ellipsis ?? '…';

  return (from > 0 ? ellipsis : '') + slice(text, from, to) + (to < count ? ellipsis : '');
}

function wrapLine(line: string, width: number, breakWords: boolean): string[] {
  const wrapped: string[] = [];
  let current = '';
  let currentLength = 0;

  const pieces = line.split(/[ \t]+/u).filter(part => part !== '');
  const units = breakWords ? pieces.flatMap(word => (length(word) > width ? chunk(word, width) : [word])) : pieces;

  for (const word of units) {
    const wordLength = length(word);
    if (current === '') {
      current = word;
      currentLength = wordLength;
    } else if (currentLength + 1 + wordLength <= width) {
      current = `${current} ${word}`;
      currentLength += 1 + wordLength;
    } else {
      wrapped.push(current);
      current = word;
      currentLength = wordLength;
    }
  }
  if (current !== '' || wrapped.length === 0) wrapped.push(current);
  return wrapped;
}

/** Greedy word wrap measured in graphemes. Existing line breaks are preserved. */
export function wrapText(text: string, width: number, options: WrapTextOptions = {}): string {
  if (!Number.isInteger(width) || width < 1)
    throw new RangeError(`width must be a positive integer, got ${String(width)}`);
  return lines(text)
    .flatMap(line => wrapLine(line, width, options.breakWords === true))
    .join(options.newline ?? '\n');
}
