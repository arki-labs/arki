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
 * digit scripts, a different currency's symbol, or any trailing text all throw
 * `NumberFormatError`. Text without grouping is always fine: `'1234.5'`.
 *
 * Runtimes without `formatToParts` (React Native's Hermes on iOS) throw
 * `UnsupportedFeatureError`; pass `symbols` to parse without `Intl`.
 */

import type { RoundingMode } from '@arki/math/rounding';
import {
  NumberFormatError,
  ResourceLimitError,
  RoundingNecessaryError,
  UnsupportedFeatureError,
} from '@arki/math/errors';

import type { Currency, CurrencyLike } from './currency.js';
import { toCurrency } from './currency.js';
import { MAX_INPUT_LENGTH } from './internal/units.js';
import { Money } from './money.js';

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
  /** How to drop digits beyond the scale. Without it, extra digits throw `RoundingNecessaryError`. */
  rounding?: RoundingMode;
  /** Decimals to keep. Defaults to the currency's. */
  scale?: number;
  /** Separators to use instead of asking `Intl`, for runtimes without `formatToParts`. */
  symbols?: ParseSymbols;
};

export type MoneyParser<C extends string> = {
  /** Parses or throws `NumberFormatError` (bad text) or `RoundingNecessaryError` (too many decimals). */
  parse(text: string): Money<C>;
  /** Parses or returns `undefined`, for form validation. Still throws for runtime capability errors. */
  tryParse(text: string): Money<C> | undefined;
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

function grammarFromIntl(currency: Currency, locale: string): Grammar {
  let plain: Intl.NumberFormat;
  try {
    plain = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, useGrouping: true });
  } catch (error) {
    throw new UnsupportedFeatureError(`This runtime's Intl does not support the locale ${locale}`, { cause: error });
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

function fail(text: string, reason: string): never {
  throw new NumberFormatError(`Cannot read ${JSON.stringify(text.slice(0, 40))} as money: ${reason}`);
}

/** Turns locale text into plain `'-1234.56'`, or throws `NumberFormatError`. */
function toPlainDecimal(input: string, grammar: Grammar): string {
  if (input.length > MAX_INPUT_LENGTH) {
    throw new ResourceLimitError(`Money text is longer than ${MAX_INPUT_LENGTH} characters`);
  }
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
    if (sawMark) fail(input, 'the currency appears twice');
    text = text.slice(0, -trailing.length).trim();
  }
  if (sawSign && negative && input.trim().startsWith('(')) fail(input, 'it has both parentheses and a minus sign');

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
    if (local && ascii) fail(input, 'it mixes digit scripts');
    text = converted;
  }

  const pieces = text.split(grammar.decimal);
  if (pieces.length > 2) fail(input, `the decimal separator ${JSON.stringify(grammar.decimal)} appears twice`);
  const [whole = '', fraction] = pieces;
  if (fraction !== undefined && !ASCII_DIGITS.test(fraction)) fail(input, 'the decimals are not digits');

  const group = grammar.group;
  if (!ASCII_DIGITS.test(group === undefined ? whole : whole.replaceAll(group, ''))) {
    fail(input, 'it is not a number in this locale');
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
    if (!valid) fail(input, 'the digit grouping does not match the locale');
    digits = groups.join('');
  }
  if (!ASCII_DIGITS.test(digits)) fail(input, 'it is not a number in this locale');
  return `${negative ? '-' : ''}${digits}${fraction === undefined ? '' : `.${fraction}`}`;
}

/**
 * Prepares the locale's grammar once, for forms and imports:
 * `const parse = createMoneyParser('EUR', { locale: 'de-DE' }); parse.parse('1.234,56 €')`.
 */
export function createMoneyParser<const C extends string>(
  currency: CurrencyLike<C>,
  options: ParseOptions = {},
): MoneyParser<C> {
  const target = toCurrency(currency);
  const grammar =
    options.symbols === undefined
      ? grammarFromIntl(target, options.locale ?? 'en-US')
      : grammarFromSymbols(target, options.symbols);
  const settle = { rounding: options.rounding, scale: options.scale };
  const parse = (text: string): Money<C> => {
    if (typeof text !== 'string') throw new TypeError('Expected text to parse');
    return Money.of(toPlainDecimal(text, grammar), target, settle);
  };
  return {
    parse,
    tryParse(text) {
      try {
        return parse(text);
      } catch (error) {
        if (
          error instanceof NumberFormatError ||
          error instanceof RoundingNecessaryError ||
          error instanceof ResourceLimitError
        ) {
          return;
        }
        throw error;
      }
    },
  };
}

/** One-shot form of `createMoneyParser`: `parseMoney('1.234,56 €', 'EUR', { locale: 'de-DE' })`. */
export function parseMoney<const C extends string>(
  text: string,
  currency: CurrencyLike<C>,
  options?: ParseOptions,
): Money<C> {
  return createMoneyParser(currency, options).parse(text);
}
