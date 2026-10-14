/**
 * Case conversion built on one tokenizer (`caseWords`), so every case style
 * splits identifiers the same way. Tokens are letters, numbers, and attached
 * marks; everything else is a boundary. Casing is locale-independent unless a
 * `locale` is passed explicitly.
 */

import { boundaryAt } from './internal/graphemes.js';
import { lower, upper } from './internal/locale.js';

export type CaseOptions = Readonly<{ locale?: string }>;

const APOSTROPHE_BETWEEN_LETTERS = /(?<=\p{L})['’](?=\p{L})/gu;
const NON_TOKEN = /[^\p{L}\p{N}\p{M}]+/u;
/** `fooBar` → `foo`, `Bar`; `v2Beta` → `v2`, `Beta`. */
const LOWER_OR_DIGIT_TO_UPPER = /(?<=[\p{Ll}\p{N}\p{M}])(?=\p{Lu})/u;
/** `XMLHttp` → `XML`, `Http`. */
const UPPER_RUN_TO_CAPITALIZED = /(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

/** Splits `text` into the tokens every case function works on. */
export function caseWords(text: string): string[] {
  return isAscii(text) ? asciiWords(text) : unicodeWords(text);
}

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) if ((text.codePointAt(index) ?? 0) > 0x7f) return false;
  return true;
}

const OTHER = 0;
const LOWER = 1;
const UPPER = 2;
const DIGIT = 3;

function asciiKind(code: number): number {
  if (code >= 0x61 && code <= 0x7a) return LOWER;
  if (code >= 0x41 && code <= 0x5a) return UPPER;
  if (code >= 0x30 && code <= 0x39) return DIGIT;
  return OTHER;
}

/**
 * `unicodeWords` for ASCII text, in one pass over the character codes instead of five regular
 * expressions. ASCII is already NFC; the token rules are the same: letters and digits form tokens,
 * and a token splits before an uppercase letter that follows a lowercase letter or a digit, or that
 * follows an uppercase letter and precedes a lowercase one.
 */
function asciiWords(input: string): string[] {
  const text = input.includes("'") ? input.replaceAll(APOSTROPHE_BETWEEN_LETTERS, '') : input;
  const tokens: string[] = [];
  let start = -1;
  let previous = OTHER;
  for (let index = 0; index < text.length; index++) {
    const kind = asciiKind(text.codePointAt(index) ?? 0);
    if (kind === OTHER) {
      if (start !== -1) tokens.push(text.slice(start, index));
      start = -1;
    } else if (start === -1) {
      start = index;
    } else if (kind === UPPER && (previous !== UPPER || asciiKind(text.codePointAt(index + 1) ?? 0) === LOWER)) {
      tokens.push(text.slice(start, index));
      start = index;
    }
    previous = kind;
  }
  if (start !== -1) tokens.push(text.slice(start));
  return tokens;
}

/** The general tokenizer. `asciiWords` must give the same tokens as this on every ASCII input. */
function unicodeWords(text: string): string[] {
  const tokens: string[] = [];
  for (const chunk of text.normalize('NFC').replaceAll(APOSTROPHE_BETWEEN_LETTERS, '').split(NON_TOKEN)) {
    if (chunk === '') continue;
    for (const part of chunk.split(LOWER_OR_DIGIT_TO_UPPER)) {
      for (const token of part.split(UPPER_RUN_TO_CAPITALIZED)) {
        if (token !== '') tokens.push(token);
      }
    }
  }
  return tokens;
}

/** Uppercases the first grapheme and leaves the rest untouched. */
export function capitalize(text: string, options: CaseOptions = {}): string {
  return capitalizeIn(text, options.locale);
}

function capitalizeIn(text: string, locale: string | undefined): string {
  const end = boundaryAt(text, 1);
  if (end === undefined) return text;
  return upper(text.slice(0, end), locale) + text.slice(end);
}

/** Lowercases the first grapheme and leaves the rest untouched. */
export function uncapitalize(text: string, options: CaseOptions = {}): string {
  const end = boundaryAt(text, 1);
  if (end === undefined) return text;
  return lower(text.slice(0, end), options.locale) + text.slice(end);
}

function capitalizedToken(token: string, locale: string | undefined): string {
  return capitalizeIn(lower(token, locale), locale);
}

/** `fooBarBaz` */
export function camelCase(text: string, options: CaseOptions = {}): string {
  const tokens = caseWords(text);
  const locale = options.locale;
  let result = '';
  let first = true;
  for (const token of tokens) {
    result += first ? lower(token, locale) : capitalizedToken(token, locale);
    first = false;
  }
  return result;
}

/** `FooBarBaz` */
export function pascalCase(text: string, options: CaseOptions = {}): string {
  return caseWords(text)
    .map(token => capitalizedToken(token, options.locale))
    .join('');
}

/** `foo_bar_baz` */
export function snakeCase(text: string, options: CaseOptions = {}): string {
  return caseWords(text)
    .map(token => lower(token, options.locale))
    .join('_');
}

/** `foo-bar-baz` */
export function kebabCase(text: string, options: CaseOptions = {}): string {
  return caseWords(text)
    .map(token => lower(token, options.locale))
    .join('-');
}

/** `FOO_BAR_BAZ` */
export function constantCase(text: string, options: CaseOptions = {}): string {
  return caseWords(text)
    .map(token => upper(token, options.locale))
    .join('_');
}

/** `foo.bar.baz` */
export function dotCase(text: string, options: CaseOptions = {}): string {
  return caseWords(text)
    .map(token => lower(token, options.locale))
    .join('.');
}

/** `foo/bar/baz` */
export function pathCase(text: string, options: CaseOptions = {}): string {
  return caseWords(text)
    .map(token => lower(token, options.locale))
    .join('/');
}

/** `Foo Bar Baz` — every token capitalized, joined by spaces. Punctuation is discarded. */
export function titleCase(text: string, options: CaseOptions = {}): string {
  return caseWords(text)
    .map(token => capitalizedToken(token, options.locale))
    .join(' ');
}

/** `Foo bar baz` — tokens lowercased and joined by spaces, first grapheme capitalized. */
export function sentenceCase(text: string, options: CaseOptions = {}): string {
  const joined = caseWords(text)
    .map(token => lower(token, options.locale))
    .join(' ');
  return capitalize(joined, options);
}
