/**
 * Case conversion built on one tokenizer (`caseWords`), so every case style
 * splits identifiers the same way. Tokens are letters, numbers, and attached
 * marks; everything else is a boundary. Casing is locale-independent unless a
 * `locale` is passed explicitly.
 */

import { lower, upper } from './internal/locale.js';
import { at, slice } from './unicode.js';

export type CaseOptions = Readonly<{ locale?: string }>;

const APOSTROPHE_BETWEEN_LETTERS = /(?<=\p{L})['’](?=\p{L})/gu;
const NON_TOKEN = /[^\p{L}\p{N}\p{M}]+/u;
/** `fooBar` → `foo`, `Bar`; `v2Beta` → `v2`, `Beta`. */
const LOWER_OR_DIGIT_TO_UPPER = /(?<=[\p{Ll}\p{N}\p{M}])(?=\p{Lu})/u;
/** `XMLHttp` → `XML`, `Http`. */
const UPPER_RUN_TO_CAPITALIZED = /(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

/** Splits `text` into the tokens every case function works on. */
export function caseWords(text: string): string[] {
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
  const first = at(text, 0);
  if (first === undefined) return text;
  return upper(first, options.locale) + slice(text, 1);
}

/** Lowercases the first grapheme and leaves the rest untouched. */
export function uncapitalize(text: string, options: CaseOptions = {}): string {
  const first = at(text, 0);
  if (first === undefined) return text;
  return lower(first, options.locale) + slice(text, 1);
}

function capitalizedToken(token: string, locale: string | undefined): string {
  return capitalize(lower(token, locale), { locale });
}

/** `fooBarBaz` */
export function camelCase(text: string, options: CaseOptions = {}): string {
  return caseWords(text)
    .map((token, index) => (index === 0 ? lower(token, options.locale) : capitalizedToken(token, options.locale)))
    .join('');
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
