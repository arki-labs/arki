/**
 * Strict parsing of money typed by people: `'1.234,56 €'` in German,
 * `'$1,234.56'` in English, `'₹1,23,456.78'` in Indian English.
 *
 * The locale's separators, digits, minus sign and currency symbols come from
 * `Intl.NumberFormat#formatToParts`. You always say which currency you expect,
 * so `'$10'` never has to guess between US, Canadian or Australian dollars.
 *
 * Strict means it refuses instead of guessing: grouping in the wrong place
 * (`'1,23,4'`), a decimal separator the locale does not use, two signs, mixed
 * digit scripts, a different currency's symbol, or any trailing text all return
 * the `InvalidMoneyText` failure. Text without grouping is always fine: `'1234.5'`.
 * Parsing never throws for bad text: it returns a failure from `failures.ts`.
 *
 * A locale tag the runtime rejects returns `UnsupportedLocale`. Runtimes without
 * `formatToParts` (React Native's Hermes on iOS) throw `UnsupportedFeatureError`;
 * pass `symbols` to parse without `Intl`.
 */

import type { RoundingMode } from '@arki/math/rounding';
import { UnsupportedFeatureError } from '@arki/math/errors';

import type { Currency, CurrencyLike } from './currency.js';
import { toCurrency } from './currency.js';
import { InputTooLarge, InvalidMoneyText, UnsupportedLocale } from './failures.js';
import { MAX_INPUT_LENGTH } from './internal/units.js';
import { checkScale, fromDecimalText } from './money.js';

export type ParseSymbols = {
  /** Decimal separator, such as `','`. */
  decimal: string;
  /** Group separator, such as `'.'`. Omit when the input never has grouping. */
  group?: string;
  /** Digits per group: `[3]` for most locales, `[3, 2]` for Indian grouping. Defaults to `[3]`. */
  groupSizes?: readonly [primary: number, secondary?: number];
  /** Currency marks to accept besides the code, such as `['€']`. */
  currency?: readonly string[];
};

export type ParseOptions = {
  /** BCP 47 locale. Defaults to `'en-US'`; there is no global locale. */
  locale?: string;
  /** How to drop digits beyond the scale. Without it, extra digits return `RoundingNecessary`. */
  rounding?: RoundingMode;
  /** Decimals to keep. Defaults to the currency's. */
  scale?: number;
  /** Separators to use instead of asking `Intl`, for runtimes without `formatToParts`. */
  symbols?: ParseSymbols;
};

export type MoneyParser<C extends string> = {
  /** The amount, or `InvalidMoneyText`, `InputTooLarge` or `RoundingNecessary` (too many decimals). Never throws for bad text. */
  parse(text: string): ReturnType<typeof parseWith<C>>;
};

type Grammar = {
  decimal: string;
  group: string | undefined;
  primary: number;
  secondary: number;
  /** The locale's ten digits, or `undefined` for ASCII digits. */
  digits: string | undefined;
  minus: readonly string[];
  /** Currency marks, longest first. */
  marks: readonly string[];
};

const SPACES = /\s/g;
const BIDI = /[\u061C\u200E\u200F]/g;
const ASCII_DIGITS = /^\d+$/;

function normalizeSpaces(text: string): string {
  return text.replaceAll(SPACES, ' ');
}

function grammarFromSymbols(currency: Currency, symbols: ParseSymbols): Grammar {
  const [primary, secondary] = symbols.groupSizes ?? [3];
  return {
    decimal: normalizeSpaces(symbols.decimal),
    group: symbols.group === undefined ? undefined : normalizeSpaces(symbols.group),
    primary,
    secondary: secondary ?? primary,
    digits: undefined,
    minus: ['-', '\u2212'],
    marks: sortMarks([currency.code, ...(symbols.currency ?? [])]),
  };
}

function sortMarks(marks: readonly string[]): string[] {
  return [...new Set(marks.map(mark => normalizeSpaces(mark).trim()))]
    .filter(mark => mark !== '')
    .sort((a, b) => b.length - a.length);
}

function grammarFromIntl(currency: Currency, locale: string) {
  let plain: Intl.NumberFormat;
  try {
    plain = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, useGrouping: true });
  } catch (error) {
    // Intl throws RangeError for a tag it rejects; anything else means Intl itself is missing or broken.
    if (error instanceof RangeError) return UnsupportedLocale({ cause: error });
    throw new UnsupportedFeatureError('This runtime has no usable Intl.NumberFormat; pass options.symbols', {
      cause: error,
    });
  }
  if (typeof plain.formatToParts !== 'function') {
    throw new UnsupportedFeatureError('This runtime lacks Intl.NumberFormat#formatToParts; pass options.symbols');
  }
  const parts = plain.formatToParts(-1_234_567_890.5);
  const find = (type: Intl.NumberFormatPartTypes) => parts.find(part => part.type === type)?.value;
  const integers = parts.filter(part => part.type === 'integer').map(part => part.value.length);
  const primary = integers.at(-1) ?? 3;
  const secondary = integers.length > 2 ? (integers.at(-2) ?? primary) : primary;

  const digitFormat = new Intl.NumberFormat(locale, { useGrouping: false });
  const localDigits = Array.from({ length: 10 }, (_, digit) => digitFormat.format(digit)).join('');

  // The locale's symbols plus the English ones: people in Japan often type `¥` where Intl writes `￥`.
  // Safe, because the caller has already said which currency to expect.
  const marks: string[] = [currency.code];
  if (currency.iso) {
    for (const markLocale of [locale, 'en']) {
      for (const currencyDisplay of ['symbol', 'narrowSymbol'] as const) {
        try {
          const formatted = new Intl.NumberFormat(markLocale, {
            style: 'currency',
            currency: currency.code,
            currencyDisplay,
          });
          for (const part of formatted.formatToParts(1)) if (part.type === 'currency') marks.push(part.value);
        } catch {
          // A display the runtime lacks simply adds no mark; the ISO code is always accepted.
        }
      }
    }
  }

  const group = find('group');
  return {
    decimal: normalizeSpaces(find('decimal') ?? '.'),
    group: group === undefined ? undefined : normalizeSpaces(group),
    primary,
    secondary,
    digits: localDigits === '0123456789' ? undefined : localDigits,
    minus: [...new Set([find('minusSign') ?? '-', '-', '\u2212'])],
    marks: sortMarks(marks),
  };
}

/** Turns locale text into plain `'-1234.56'`, or returns `InvalidMoneyText` or `InputTooLarge`. */
function toPlainDecimal(input: string, grammar: Grammar) {
  if (input.length > MAX_INPUT_LENGTH) return InputTooLarge();
  let text = normalizeSpaces(input.replaceAll(BIDI, '')).trim();
  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  // Leading sign and currency mark, in either order; a trailing currency mark.
  let sawSign = false;
  let sawMark = false;
  for (let round = 0; round < 2; round++) {
    const sign = [...grammar.minus, '+'].find(candidate => text.startsWith(candidate));
    if (sign !== undefined && !sawSign) {
      sawSign = true;
      if (sign !== '+') negative = !negative;
      text = text.slice(sign.length).trim();
    }
    const mark = grammar.marks.find(candidate => text.startsWith(candidate));
    if (mark !== undefined && !sawMark) {
      sawMark = true;
      text = text.slice(mark.length).trim();
    }
  }
  const trailing = grammar.marks.find(candidate => text.endsWith(candidate));
  if (trailing !== undefined) {
    if (sawMark) return InvalidMoneyText(); // the currency appears twice
    text = text.slice(0, -trailing.length).trim();
  }
  if (sawSign && negative && input.trim().startsWith('(')) return InvalidMoneyText(); // it has both parentheses and a minus sign

  // Local digits → ASCII, refusing a mix of scripts.
  if (grammar.digits !== undefined) {
    let local = false;
    let ascii = false;
    let converted = '';
    for (const char of text) {
      const index = grammar.digits.indexOf(char);
      if (index === -1) {
        if (char >= '0' && char <= '9') ascii = true;
        converted += char;
      } else {
        local = true;
        converted += String(index);
      }
    }
    if (local && ascii) return InvalidMoneyText(); // it mixes digit scripts
    text = converted;
  }

  const pieces = text.split(grammar.decimal);
  if (pieces.length > 2) return InvalidMoneyText(); // the decimal separator appears twice
  const [whole = '', fraction] = pieces;
  if (fraction !== undefined && !ASCII_DIGITS.test(fraction)) return InvalidMoneyText(); // the decimals are not digits

  const group = grammar.group;
  if (!ASCII_DIGITS.test(group === undefined ? whole : whole.replaceAll(group, ''))) {
    return InvalidMoneyText(); // it is not a number in this locale
  }
  let digits = whole;
  if (group !== undefined && whole.includes(group)) {
    const groups = whole.split(group);
    const last = groups.length - 1;
    const valid = groups.every((group, index) => {
      if (!ASCII_DIGITS.test(group)) return false;
      if (index === last) return group.length === grammar.primary;
      if (index === 0) return group.length <= (last === 1 ? grammar.primary : grammar.secondary);
      return group.length === grammar.secondary;
    });
    if (!valid) return InvalidMoneyText(); // the digit grouping does not match the locale
    digits = groups.join('');
  }
  if (!ASCII_DIGITS.test(digits)) return InvalidMoneyText(); // it is not a number in this locale
  return `${negative ? '-' : ''}${digits}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** Reads one text with a prepared grammar. Its return type is `MoneyParser#parse`'s. */
function parseWith<C extends string>(
  text: string,
  grammar: Grammar,
  currency: Currency<C>,
  scale: number,
  rounding: RoundingMode | undefined,
) {
  // Plain JavaScript and untyped payloads can pass anything.
  if (typeof text !== 'string') return InvalidMoneyText();
  const plain = toPlainDecimal(text, grammar);
  if (typeof plain !== 'string') return plain;
  return fromDecimalText(plain, currency, scale, rounding);
}

/**
 * Prepares the locale's grammar once, for forms and imports:
 * `const parser = createMoneyParser('EUR', { locale: 'de-DE' }); parser.parse('1.234,56 €')`.
 * Returns `UnsupportedLocale` when the runtime rejects `options.locale`, which often comes from
 * outside (`Accept-Language`). The currency and scale are your code's: an unknown code or a
 * bad scale throws.
 */
export function createMoneyParser<const C extends string>(currency: CurrencyLike<C>, options: ParseOptions = {}) {
  const target = toCurrency(currency);
  const scale = options.scale === undefined ? target.scale : checkScale(options.scale);
  const rounding = options.rounding;
  const grammar =
    options.symbols === undefined
      ? grammarFromIntl(target, options.locale ?? 'en-US')
      : grammarFromSymbols(target, options.symbols);
  if (UnsupportedLocale.is(grammar)) return grammar;
  const parser: MoneyParser<C> = { parse: text => parseWith(text, grammar, target, scale, rounding) };
  return parser;
}

/**
 * One-shot form of `createMoneyParser`: `parseMoney('1.234,56 €', 'EUR', { locale: 'de-DE' })`.
 * Returns the amount or a failure (`InvalidMoneyText`, `InputTooLarge`, `RoundingNecessary`,
 * `UnsupportedLocale`); it never throws for bad text.
 */
export function parseMoney<const C extends string>(text: string, currency: CurrencyLike<C>, options?: ParseOptions) {
  const parser = createMoneyParser(currency, options);
  return UnsupportedLocale.is(parser) ? parser : parser.parse(text);
}
