/**
 * Numbers as words and ordinals — the part of Laravel's `Number::spell` /
 * `ordinal` that `Intl` never shipped. Grammar lives in per-locale rule
 * objects; English is built in, other locales are opt-in subpath imports
 * (`@arki/math/words/ro`, `/de`, `/fr`, `/es`, `/it`) so an app only bundles
 * the languages it uses. There is no registry and no global locale: pass the
 * rules you imported.
 */

import type { DecimalInput } from './decimal.js';
import { Decimal } from './decimal.js';
import { InvalidArgumentError, NumericRangeError } from './errors.js';
import { formatNumber } from './format.js';

export type Gender = 'masculine' | 'feminine' | 'neuter';

export type WordsContext = {
  /** Grammatical gender of the thing being counted, where the language cares (`una`/`unu`, `première`/`premier`). */
  gender: Gender | undefined;
};

/**
 * The contract a locale implements. All inputs are non-negative integers;
 * the core handles sign, fractions and thresholds.
 *
 * Locales are objects you import (`import { ro } from '@arki/math/words/ro'`),
 * not Intl-style strings (`'ro'`). A string would need a registry that holds
 * every language's grammar, so every app would bundle all of them. An imported
 * object lets the bundler keep only the languages you actually reference.
 */
export type NumberWordsLocale = {
  /** BCP 47 tag, also used for digit formatting. */
  readonly code: string;
  /** The word placed before a negative number: `minus`. */
  readonly negative: string;
  /** The word read for the decimal separator: `point`, `virgulă`, `Komma`. */
  readonly decimalSeparator: string;
  /**
   * How many base-1000 groups the locale can spell (`en`: 12, up to 10^36 − 1).
   * The core rejects longer integers with `NumericRangeError` by digit count,
   * before any grouping work is done.
   */
  readonly maxGroups: number;
  /** Cardinal words for `n ≥ 0`. Throws `NumericRangeError` beyond the locale's largest scale word. */
  spell(n: bigint, context: WordsContext): string;
  /** Ordinal words for `n ≥ 1`: `twenty-first`, `al douăzeci și unulea`. */
  spellOrdinal(n: bigint, context: WordsContext): string;
  /** Ordinal with digits for `n ≥ 1`: `21st`, `21.`, `al 21-lea`. `digits` is `n` already formatted for the locale. */
  ordinal(n: bigint, digits: string, context: WordsContext): string;
};

export type SpellOptions = {
  locale?: NumberWordsLocale;
  gender?: Gender;
  /**
   * Numbers are spelled when `after < |value| ≤ until`; the rest come back as
   * formatted digits that keep the exact value (every fraction digit is kept).
   * `until` is the inclusive upper bound of the spelled range.
   */
  until?: number;
  /** The exclusive lower bound of the spelled range (see `until`). */
  after?: number;
};

export type OrdinalOptions = {
  locale?: NumberWordsLocale;
  gender?: Gender;
};

/**
 * Splits a non-negative integer into base-1000 groups, most significant
 * first: `1234567n` → `[1, 234, 567]`. The building block every locale uses.
 */
export function thousandsGroups(n: bigint): number[] {
  if (n < 0n) throw new InvalidArgumentError('thousandsGroups expects a non-negative integer');
  if (n === 0n) return [0];
  const groups: number[] = [];
  while (n > 0n) {
    groups.push(Number(n % 1000n));
    n /= 1000n;
  }
  return groups.toReversed();
}

/** Rejects an integer too long for the locale before any grouping work is done. */
function assertFits(n: bigint, locale: NumberWordsLocale): void {
  const limit = locale.maxGroups * 3;
  // Comparing against 10^limit is O(1) for a big input (the limit is tiny); no digit string is built.
  if (n >= 10n ** BigInt(limit)) {
    throw new NumericRangeError(
      `The number has more than ${limit} digits, beyond what the ${locale.code} words can spell`,
    );
  }
}

/** The number as digits, exactly: every fraction digit is kept (Intl allows at most 100). */
function digitsOf(d: Decimal, locale: NumberWordsLocale): string {
  const fractionDigits = Math.min(d.scale, 100);
  return formatNumber(d, {
    locale: locale.code,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function toInteger(value: DecimalInput | bigint, name: string): bigint {
  if (typeof value === 'bigint') return value;
  const d = Decimal.from(value);
  if (!d.isInteger()) throw new InvalidArgumentError(`${name} must be an integer, got ${d.toString()}`);
  return d.toBigInt();
}

/**
 * `spellNumber(102)` → `'one hundred two'`; `spellNumber('3.14')` →
 * `'three point one four'`; `spellNumber(-5)` → `'minus five'`.
 * Fractions are read digit by digit, as people do. Numbers are read through
 * `decimal()`, so `0.1` is "zero point one", never its binary expansion.
 */
export function spellNumber(value: DecimalInput, options: SpellOptions = {}): string {
  const locale = options.locale ?? en;
  const context: WordsContext = { gender: options.gender };
  const d = Decimal.from(value).trim();
  const magnitude = d.abs();
  if (options.until !== undefined && magnitude.gt(options.until)) return digitsOf(d, locale);
  if (options.after !== undefined && magnitude.lte(options.after)) return digitsOf(d, locale);

  const integer = magnitude.toScale(0, 'down').toBigInt();
  assertFits(integer, locale);
  const words = [locale.spell(integer, context)];
  if (magnitude.scale > 0) {
    const text = magnitude.toString();
    const fraction = text.slice(text.indexOf('.') + 1);
    words.push(locale.decimalSeparator, ...[...fraction].map(digit => locale.spell(BigInt(digit), context)));
  }
  if (d.isNegative()) words.unshift(locale.negative);
  return words.join(' ');
}

/** `spellOrdinal(21)` → `'twenty-first'`. Positive integers only. */
export function spellOrdinal(value: DecimalInput, options: OrdinalOptions = {}): string {
  const n = toInteger(value, 'value');
  if (n < 1n) throw new InvalidArgumentError(`Ordinals start at 1, got ${n}`);
  const locale = options.locale ?? en;
  assertFits(n, locale);
  return locale.spellOrdinal(n, { gender: options.gender });
}

/** `formatOrdinal(21)` → `'21st'`; `formatOrdinal(1000)` → `'1,000th'`. Positive integers only. */
export function formatOrdinal(value: DecimalInput, options: OrdinalOptions = {}): string {
  const n = toInteger(value, 'value');
  if (n < 1n) throw new InvalidArgumentError(`Ordinals start at 1, got ${n}`);
  const locale = options.locale ?? en;
  return locale.ordinal(n, formatNumber(n, { locale: locale.code }), { gender: options.gender });
}

// ---------------------------------------------------------------------------
// English (built in)
// ---------------------------------------------------------------------------

const EN_ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** Short scale, up to 10^36 − 1. */
const EN_SCALES = [
  '',
  'thousand',
  'million',
  'billion',
  'trillion',
  'quadrillion',
  'quintillion',
  'sextillion',
  'septillion',
  'octillion',
  'nonillion',
  'decillion',
];
const EN_ORDINAL_IRREGULAR: Record<string, string> = {
  one: 'first',
  two: 'second',
  three: 'third',
  five: 'fifth',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
};

function enBelowHundred(n: number): string {
  if (n < 20) return EN_ONES[n]!;
  const unit = n % 10;
  return unit === 0 ? EN_TENS[Math.floor(n / 10)]! : `${EN_TENS[Math.floor(n / 10)]}-${EN_ONES[unit]}`;
}

function enGroup(n: number, and: boolean): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return enBelowHundred(rest);
  if (rest === 0) return `${EN_ONES[hundreds]} hundred`;
  return `${EN_ONES[hundreds]} hundred ${and ? 'and ' : ''}${enBelowHundred(rest)}`;
}

function enSpell(n: bigint, and: boolean): string {
  if (n === 0n) return 'zero';
  const groups = thousandsGroups(n);
  if (groups.length > EN_SCALES.length) {
    throw new NumericRangeError(`${n} is beyond the largest English scale word (decillion)`);
  }
  const words: string[] = [];
  for (const [index, group] of groups.entries()) {
    if (group === 0) continue;
    const isLast = index === groups.length - 1;
    const needsAnd = and && isLast && words.length > 0 && group < 100;
    const scale = EN_SCALES[groups.length - 1 - index]!;
    words.push(`${needsAnd ? 'and ' : ''}${enGroup(group, and)}${scale ? ` ${scale}` : ''}`);
  }
  return words.join(' ');
}

function enOrdinalWord(word: string): string {
  const irregular = EN_ORDINAL_IRREGULAR[word];
  if (irregular) return irregular;
  if (word.endsWith('y')) return `${word.slice(0, -1)}ieth`;
  return `${word}th`;
}

function enSpellOrdinal(n: bigint, and: boolean): string {
  const cardinal = enSpell(n, and);
  // Only the last word changes: "twenty-one" → "twenty-first", "one hundred" → "one hundredth".
  const separator = Math.max(cardinal.lastIndexOf(' '), cardinal.lastIndexOf('-'));
  return cardinal.slice(0, separator + 1) + enOrdinalWord(cardinal.slice(separator + 1));
}

const EN_SUFFIX: Record<Intl.LDMLPluralRule, string> = {
  one: 'st',
  two: 'nd',
  few: 'rd',
  other: 'th',
  zero: 'th',
  many: 'th',
};
const enPlural = new Intl.PluralRules('en', { type: 'ordinal' });

function enOrdinal(n: bigint, digits: string): string {
  // PluralRules takes a number; only the last two digits decide the suffix.
  return `${digits}${EN_SUFFIX[enPlural.select(Number(n % 100n))]}`;
}

/** American English: `one hundred two`, `two thousand twenty-six`. */
export const en: NumberWordsLocale = {
  code: 'en-US',
  negative: 'minus',
  decimalSeparator: 'point',
  maxGroups: 12,
  spell: n => enSpell(n, false),
  spellOrdinal: n => enSpellOrdinal(n, false),
  ordinal: (n, digits) => enOrdinal(n, digits),
};

/** British English: `one hundred and two`, `one thousand and five`. */
export const enGB: NumberWordsLocale = {
  code: 'en-GB',
  negative: 'minus',
  decimalSeparator: 'point',
  maxGroups: 12,
  spell: n => enSpell(n, true),
  spellOrdinal: n => enSpellOrdinal(n, true),
  ordinal: (n, digits) => enOrdinal(n, digits),
};
