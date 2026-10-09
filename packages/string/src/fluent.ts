/**
 * Immutable fluent wrapper. Every string-producing function in this package is
 * available as a method; queries return plain values. `str('x')` never mutates.
 * Note: `Boolean(str(''))` is `true` like any object — use `isEmpty()`.
 */

import type { Base64Options } from './base64.js';
import type { CaseOptions } from './case.js';
import type { MaskOptions } from './edit.js';
import type { ExcerptOptions, InitialsOptions, TruncateOptions, WrapTextOptions } from './format.js';
import type { InterpolateOptions, TemplateValues } from './interpolate.js';
import type { Occurrence } from './search.js';
import type { SlugifyOptions, TransliterateOptions } from './slug.js';
import { fromBase64, toBase64 } from './base64.js';
import {
  camelCase,
  capitalize,
  caseWords,
  constantCase,
  dotCase,
  kebabCase,
  pascalCase,
  pathCase,
  sentenceCase,
  snakeCase,
  titleCase,
  uncapitalize,
} from './case.js';
import {
  deduplicate,
  ensureEnd,
  ensureStart,
  mask,
  padBoth,
  padEnd,
  padStart,
  replaceEnd,
  replaceFirst,
  replaceLast,
  replaceStart,
  swap,
  trimPrefix,
  trimSuffix,
  unwrap,
  wrap,
} from './edit.js';
import { escapeHtml, escapeRegExp } from './escape.js';
import { collapseWhitespace, excerpt, initials, squish, truncate, wrapText } from './format.js';
import { interpolate } from './interpolate.js';
import { after, before, between, containsAny, indexOf } from './search.js';
import { lines, paragraphs, sentences, wordCount, words } from './segment.js';
import { slugify, transliterate } from './slug.js';
import { at, chunk, graphemes, length, reverse, slice, splice, take } from './unicode.js';

export type NormalizationForm = 'NFC' | 'NFD' | 'NFKC' | 'NFKD';
export type Transform = (value: StringValue) => StringValue;

export class StringValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  // Extraction

  value(): string {
    return this.#value;
  }
  toString(): string {
    return this.#value;
  }
  valueOf(): string {
    return this.#value;
  }
  toJSON(): string {
    return this.#value;
  }
  [Symbol.toPrimitive](): string {
    return this.#value;
  }
  /** Iterates graphemes, unlike native string iteration (code points). */
  [Symbol.iterator](): IterableIterator<string> {
    return graphemes(this.#value);
  }

  // Unicode positional

  /** Grapheme count. */
  get length(): number {
    return length(this.#value);
  }
  at(index: number): string | undefined {
    return at(this.#value, index);
  }
  slice(start?: number, end?: number): StringValue {
    return str(slice(this.#value, start, end));
  }
  take(count: number): StringValue {
    return str(take(this.#value, count));
  }
  reverse(): StringValue {
    return str(reverse(this.#value));
  }
  splice(start: number, deleteCount: number, insert?: string): StringValue {
    return str(splice(this.#value, start, deleteCount, insert));
  }
  chunk(size: number): string[] {
    return chunk(this.#value, size);
  }

  // Native, chainable

  trim(): StringValue {
    return str(this.#value.trim());
  }
  trimStart(): StringValue {
    return str(this.#value.trimStart());
  }
  trimEnd(): StringValue {
    return str(this.#value.trimEnd());
  }
  upper(locale?: string): StringValue {
    return str(locale === undefined ? this.#value.toUpperCase() : this.#value.toLocaleUpperCase(locale));
  }
  lower(locale?: string): StringValue {
    return str(locale === undefined ? this.#value.toLowerCase() : this.#value.toLocaleLowerCase(locale));
  }
  normalize(form: NormalizationForm = 'NFC'): StringValue {
    return str(this.#value.normalize(form));
  }
  append(suffix: string): StringValue {
    return str(this.#value + suffix);
  }
  prepend(prefix: string): StringValue {
    return str(prefix + this.#value);
  }
  repeat(count: number): StringValue {
    return str(this.#value.repeat(count));
  }
  replaceAll(search: string, replacement: string): StringValue {
    return str(this.#value.replaceAll(search, replacement));
  }
  split(separator: string | RegExp, limit?: number): string[] {
    return this.#value.split(separator, limit);
  }
  includes(needle: string): boolean {
    return this.#value.includes(needle);
  }
  startsWith(prefix: string): boolean {
    return this.#value.startsWith(prefix);
  }
  endsWith(suffix: string): boolean {
    return this.#value.endsWith(suffix);
  }

  // Predicates and combinators

  isEmpty(): boolean {
    return this.#value === '';
  }
  isBlank(): boolean {
    return this.#value.trim() === '';
  }
  equals(other: string | StringValue): boolean {
    return this.#value === (typeof other === 'string' ? other : other.value());
  }
  /** Tests `pattern` without touching the caller's `lastIndex`. */
  test(pattern: RegExp): boolean {
    return new RegExp(pattern.source, pattern.flags).test(this.#value);
  }
  /** Iterates every match of `pattern` using a cloned global expression. */
  scan(pattern: RegExp): IterableIterator<RegExpMatchArray> {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return this.#value.matchAll(new RegExp(pattern.source, flags));
  }
  map(fn: (text: string) => string): StringValue {
    return str(fn(this.#value));
  }
  pipe<T>(fn: (value: StringValue) => T): T {
    return fn(this);
  }
  tap(fn: (value: StringValue) => void): StringValue {
    fn(this);
    return this;
  }
  when(condition: boolean | ((value: StringValue) => boolean), then: Transform, otherwise?: Transform): StringValue {
    const matched = typeof condition === 'function' ? condition(this) : condition;
    if (matched) return then(this);
    return otherwise === undefined ? this : otherwise(this);
  }
  whenEmpty(fn: Transform): StringValue {
    return this.isEmpty() ? fn(this) : this;
  }

  // Case

  caseWords(): string[] {
    return caseWords(this.#value);
  }
  camelCase(options?: CaseOptions): StringValue {
    return str(camelCase(this.#value, options));
  }
  pascalCase(options?: CaseOptions): StringValue {
    return str(pascalCase(this.#value, options));
  }
  snakeCase(options?: CaseOptions): StringValue {
    return str(snakeCase(this.#value, options));
  }
  kebabCase(options?: CaseOptions): StringValue {
    return str(kebabCase(this.#value, options));
  }
  constantCase(options?: CaseOptions): StringValue {
    return str(constantCase(this.#value, options));
  }
  dotCase(options?: CaseOptions): StringValue {
    return str(dotCase(this.#value, options));
  }
  pathCase(options?: CaseOptions): StringValue {
    return str(pathCase(this.#value, options));
  }
  titleCase(options?: CaseOptions): StringValue {
    return str(titleCase(this.#value, options));
  }
  sentenceCase(options?: CaseOptions): StringValue {
    return str(sentenceCase(this.#value, options));
  }
  capitalize(options?: CaseOptions): StringValue {
    return str(capitalize(this.#value, options));
  }
  uncapitalize(options?: CaseOptions): StringValue {
    return str(uncapitalize(this.#value, options));
  }

  // Text

  collapseWhitespace(): StringValue {
    return str(collapseWhitespace(this.#value));
  }
  squish(): StringValue {
    return str(squish(this.#value));
  }
  lines(): string[] {
    return lines(this.#value);
  }
  words(): string[] {
    return words(this.#value);
  }
  wordCount(): number {
    return wordCount(this.#value);
  }
  sentences(): string[] {
    return sentences(this.#value);
  }
  paragraphs(): string[] {
    return paragraphs(this.#value);
  }
  initials(options?: InitialsOptions): StringValue {
    return str(initials(this.#value, options));
  }
  truncate(maxLength: number, options?: TruncateOptions): StringValue {
    return str(truncate(this.#value, maxLength, options));
  }
  excerpt(needle: string, options?: ExcerptOptions): string | undefined {
    return excerpt(this.#value, needle, options);
  }
  wrapText(width: number, options?: WrapTextOptions): StringValue {
    return str(wrapText(this.#value, width, options));
  }

  // Search and affixes

  before(delimiter: string, occurrence?: Occurrence): StringValue {
    return str(before(this.#value, delimiter, occurrence));
  }
  after(delimiter: string, occurrence?: Occurrence): StringValue {
    return str(after(this.#value, delimiter, occurrence));
  }
  between(opening: string, closing: string): StringValue {
    return str(between(this.#value, opening, closing));
  }
  ensureStart(prefix: string): StringValue {
    return str(ensureStart(this.#value, prefix));
  }
  ensureEnd(suffix: string): StringValue {
    return str(ensureEnd(this.#value, suffix));
  }
  trimPrefix(prefix: string): StringValue {
    return str(trimPrefix(this.#value, prefix));
  }
  trimSuffix(suffix: string): StringValue {
    return str(trimSuffix(this.#value, suffix));
  }
  containsAny(needles: readonly string[]): boolean {
    return containsAny(this.#value, needles);
  }
  indexOf(needle: string, from?: number): number {
    return indexOf(this.#value, needle, from);
  }

  // Edit

  replaceFirst(search: string, replacement: string): StringValue {
    return str(replaceFirst(this.#value, search, replacement));
  }
  replaceLast(search: string, replacement: string): StringValue {
    return str(replaceLast(this.#value, search, replacement));
  }
  replaceStart(search: string, replacement: string): StringValue {
    return str(replaceStart(this.#value, search, replacement));
  }
  replaceEnd(search: string, replacement: string): StringValue {
    return str(replaceEnd(this.#value, search, replacement));
  }
  swap(replacements: Readonly<Record<string, string>>): StringValue {
    return str(swap(this.#value, replacements));
  }
  deduplicate(token?: string): StringValue {
    return str(deduplicate(this.#value, token));
  }
  wrap(opening: string, closing?: string): StringValue {
    return str(wrap(this.#value, opening, closing));
  }
  unwrap(opening: string, closing?: string): StringValue {
    return str(unwrap(this.#value, opening, closing));
  }
  mask(options?: MaskOptions): StringValue {
    return str(mask(this.#value, options));
  }
  padStart(targetLength: number, fill?: string): StringValue {
    return str(padStart(this.#value, targetLength, fill));
  }
  padEnd(targetLength: number, fill?: string): StringValue {
    return str(padEnd(this.#value, targetLength, fill));
  }
  padBoth(targetLength: number, fill?: string): StringValue {
    return str(padBoth(this.#value, targetLength, fill));
  }

  // Slugs

  slugify(options?: SlugifyOptions): StringValue {
    return str(slugify(this.#value, options));
  }
  transliterate(options?: TransliterateOptions): StringValue {
    return str(transliterate(this.#value, options));
  }

  // Escaping, templating, encoding

  escapeHtml(): StringValue {
    return str(escapeHtml(this.#value));
  }
  escapeRegExp(): StringValue {
    return str(escapeRegExp(this.#value));
  }
  /** Treats the value as a `{{ name }}` template. */
  interpolate(values: TemplateValues, options?: InterpolateOptions): StringValue {
    return str(interpolate(this.#value, values, options));
  }
  toBase64(options?: Base64Options): StringValue {
    return str(toBase64(this.#value, options));
  }
  fromBase64(options?: Base64Options): StringValue {
    return str(fromBase64(this.#value, options));
  }
}

/** Wraps `text` in an immutable fluent `StringValue`. */
export function str(text: string | StringValue): StringValue {
  return typeof text === 'string' ? new StringValue(text) : text;
}
