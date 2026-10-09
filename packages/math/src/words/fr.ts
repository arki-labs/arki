/**
 * French number words in traditional (pre-1990) orthography: spaces between
 * groups, `et` only for 21–61 and 71, `quatre-vingts` / `deux cents` take an
 * `s` only when nothing follows them. Long scale (milliard = 10^9, billion = 10^12).
 */

import type { NumberWordsLocale } from '../words.js';
import { NumericRangeError } from '../errors.js';

const LIMIT = 1_000_000_000_000_000n;

/** 0–19 (masculine). */
const ONES = [
  'zéro',
  'un',
  'deux',
  'trois',
  'quatre',
  'cinq',
  'six',
  'sept',
  'huit',
  'neuf',
  'dix',
  'onze',
  'douze',
  'treize',
  'quatorze',
  'quinze',
  'seize',
  'dix-sept',
  'dix-huit',
  'dix-neuf',
];
const TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

type Style = {
  /** Feminine `une` where the number ends in 1. */
  feminine: boolean;
  /** Plural `s` on `quatre-vingts` / `cents` when nothing follows. Off for ordinals. */
  plural: boolean;
};

function small(n: number, feminine: boolean): string {
  return n === 1 && feminine ? 'une' : ONES[n]!;
}

/** 1–99. `plural` allows the final `s` of `quatre-vingts`. */
function belowHundred(n: number, style: Style): string {
  if (n < 20) return small(n, style.feminine);
  const tens = Math.floor(n / 10);
  const unit = n % 10;
  if (tens < 7) {
    if (unit === 0) return TENS[tens]!;
    return unit === 1 ? `${TENS[tens]} et ${small(1, style.feminine)}` : `${TENS[tens]}-${ONES[unit]}`;
  }
  if (tens < 8) {
    // 70–79: soixante + 10..19
    return unit === 1 ? `soixante et ${ONES[11]}` : `soixante-${ONES[10 + unit]}`;
  }
  // 80–99: quatre-vingt + 0..19
  const rest = n - 80;
  if (rest === 0) return style.plural ? 'quatre-vingts' : 'quatre-vingt';
  return `quatre-vingt-${small(rest, style.feminine)}`;
}

/** 1–999. `style.plural` means nothing follows, so `cents` / `quatre-vingts` keep their `s`. */
function belowThousand(n: number, style: Style): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return belowHundred(rest, style);
  const head = hundreds === 1 ? 'cent' : `${ONES[hundreds]} cent`;
  if (rest === 0) return hundreds > 1 && style.plural ? `${head}s` : head;
  return `${head} ${belowHundred(rest, style)}`;
}

const SCALES = [
  { value: 1_000_000_000_000n, singular: 'billion' },
  { value: 1_000_000_000n, singular: 'milliard' },
  { value: 1_000_000n, singular: 'million' },
] as const;

function assertInRange(n: bigint): void {
  if (n >= LIMIT) throw new NumericRangeError(`${n} is beyond the largest supported French number (10^15 − 1)`);
}

/**
 * Cardinal. Scale nouns (million, milliard, billion) are masculine and plural
 * when more than one; the thousands and units groups follow `feminine`.
 * `ordinal` suppresses every plural `s`.
 */
function spell(n: bigint, feminine: boolean, ordinal: boolean): string {
  assertInRange(n);
  if (n === 0n) return ONES[0]!;
  const words: string[] = [];
  let remainder = n;
  for (const scale of SCALES) {
    const count = Number(remainder / scale.value);
    remainder %= scale.value;
    if (count === 0) continue;
    // The count precedes a noun, so its own `cents` / `quatre-vingts` keep the s (except in ordinals).
    const countWords = belowThousand(count, { feminine: false, plural: !ordinal });
    words.push(`${countWords} ${scale.singular}${count > 1 && !ordinal ? 's' : ''}`);
  }
  const thousands = Number(remainder / 1000n);
  const units = Number(remainder % 1000n);
  if (thousands > 0) {
    // `mille` is invariable, so the count never takes a plural s.
    words.push(thousands === 1 ? 'mille' : `${belowThousand(thousands, { feminine, plural: false })} mille`);
  }
  if (units > 0) words.push(belowThousand(units, { feminine, plural: !ordinal }));
  return words.join(' ');
}

function ordinalOf(cardinal: string): string {
  if (cardinal.endsWith('cinq')) return `${cardinal.slice(0, -4)}cinquième`;
  if (cardinal.endsWith('neuf')) return `${cardinal.slice(0, -4)}neuvième`;
  if (cardinal.endsWith('e')) return `${cardinal.slice(0, -1)}ième`;
  return `${cardinal}ième`;
}

/** French: `vingt et un`, `quatre-vingt-dix-neuf`, `deux cents`; ordinals `premier`, `vingt et unième`. */
export const fr: NumberWordsLocale = {
  code: 'fr-FR',
  negative: 'moins',
  decimalSeparator: 'virgule',
  spell: (n, context) => spell(n, context.gender === 'feminine', false),
  spellOrdinal: (n, context) => {
    assertInRange(n);
    if (n === 1n) return context.gender === 'feminine' ? 'première' : 'premier';
    return ordinalOf(spell(n, false, true));
  },
  ordinal: (n, digits, context) => {
    if (n === 1n) return context.gender === 'feminine' ? `${digits}re` : `${digits}er`;
    return `${digits}e`;
  },
};
