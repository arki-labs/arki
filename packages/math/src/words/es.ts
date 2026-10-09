/**
 * Spanish number words (long scale: mil millones = 10^9, billón = 10^12).
 * `uno` apocopates to `un` before `mil` / `millón` (`veintiún mil`); the
 * feminine keeps `una` / `doscientas`. Ordinals are written as separate words
 * (`vigésimo primero`).
 */

import type { NumberWordsLocale } from '../words.js';
import { NumericRangeError } from '../errors.js';

const LIMIT = 1_000_000_000_000_000n;

/** 0–29 masculine, with `uno` / `veintiuno` in the last slot of each decade handled separately. */
const ONES = [
  'cero',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'veintiuno',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
];
const TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const HUNDREDS = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
];

type Agreement = {
  /** Feminine: `una`, `veintiuna`, `doscientas`. */
  feminine: boolean;
  /** `uno` becomes `un` (`veintiún`). Ignored when feminine. */
  apocope: boolean;
};

/** The word for a number ending in 1 (1, 21, 31 …). */
function one(n: number, agreement: Agreement): string {
  if (agreement.feminine) return n === 21 ? 'veintiuna' : 'una';
  if (agreement.apocope) return n === 21 ? 'veintiún' : 'un';
  return ONES[n]!;
}

/** 1–99. */
function belowHundred(n: number, agreement: Agreement): string {
  if (n < 30) return n % 10 === 1 && n !== 11 ? one(n, agreement) : ONES[n]!;
  const unit = n % 10;
  const tens = TENS[Math.floor(n / 10)]!;
  if (unit === 0) return tens;
  return `${tens} y ${unit === 1 ? one(1, agreement) : ONES[unit]}`;
}

/** 1–999. */
function belowThousand(n: number, agreement: Agreement): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return belowHundred(rest, agreement);
  if (hundreds === 1 && rest === 0) return 'cien';
  let head = HUNDREDS[hundreds]!;
  if (agreement.feminine && hundreds > 1) head = `${head.slice(0, -2)}as`;
  return rest === 0 ? head : `${head} ${belowHundred(rest, agreement)}`;
}

/**
 * 1–999 999. `units` is the agreement of the final group; the thousands group
 * is always apocopated unless feminine (`veintiún mil`, `veintiuna mil`).
 */
function belowMillion(n: number, units: Agreement, feminine: boolean): string {
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const words: string[] = [];
  if (thousands === 1) words.push('mil');
  else if (thousands > 1) words.push(`${belowThousand(thousands, { feminine, apocope: true })} mil`);
  if (rest > 0) words.push(belowThousand(rest, units));
  return words.join(' ');
}

function assertInRange(n: bigint): void {
  if (n >= LIMIT) throw new NumericRangeError(`${n} is beyond the largest supported Spanish number (10^15 − 1)`);
}

function spell(n: bigint, feminine: boolean): string {
  assertInRange(n);
  if (n === 0n) return ONES[0]!;
  const words: string[] = [];
  const billions = Number(n / 1_000_000_000_000n);
  const millions = Number((n / 1_000_000n) % 1_000_000n);
  const rest = Number(n % 1_000_000n);
  const masculineNoun: Agreement = { feminine: false, apocope: true };
  if (billions > 0) {
    words.push(billions === 1 ? 'un billón' : `${belowThousand(billions, masculineNoun)} billones`);
  }
  if (millions > 0) {
    words.push(millions === 1 ? 'un millón' : `${belowMillion(millions, masculineNoun, false)} millones`);
  }
  if (rest > 0) words.push(belowMillion(rest, { feminine, apocope: false }, feminine));
  return words.join(' ');
}

const UNIT_ORDINALS = ['', 'primero', 'segundo', 'tercero', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo', 'noveno'];
const TEEN_ORDINALS = [
  'décimo',
  'undécimo',
  'duodécimo',
  'decimotercero',
  'decimocuarto',
  'decimoquinto',
  'decimosexto',
  'decimoséptimo',
  'decimoctavo',
  'decimonoveno',
];
const TENS_ORDINALS = [
  '',
  '',
  'vigésimo',
  'trigésimo',
  'cuadragésimo',
  'quincuagésimo',
  'sexagésimo',
  'septuagésimo',
  'octogésimo',
  'nonagésimo',
];
const HUNDRED_ORDINALS = [
  '',
  'centésimo',
  'ducentésimo',
  'tricentésimo',
  'cuadringentésimo',
  'quingentésimo',
  'sexcentésimo',
  'septingentésimo',
  'octingentésimo',
  'noningentésimo',
];

/** Ordinal words for 1–999, masculine. */
function belowThousandOrdinal(n: number): string[] {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) words.push(HUNDRED_ORDINALS[hundreds]!);
  if (rest >= 10 && rest < 20) {
    words.push(TEEN_ORDINALS[rest - 10]!);
  } else if (rest > 0) {
    if (rest >= 20) words.push(TENS_ORDINALS[Math.floor(rest / 10)]!);
    if (rest % 10 > 0) words.push(UNIT_ORDINALS[rest % 10]!);
  }
  return words;
}

/** Ordinal words for 1–999 999: `dos milésimo trigésimo cuarto`. */
function belowMillionOrdinal(n: number): string[] {
  const thousands = Math.floor(n / 1000);
  const words: string[] = [];
  if (thousands === 1) words.push('milésimo');
  else if (thousands > 1) words.push(`${belowThousand(thousands, { feminine: false, apocope: true })} milésimo`);
  return [...words, ...belowThousandOrdinal(n % 1000)];
}

function spellOrdinal(n: bigint, feminine: boolean): string {
  assertInRange(n);
  const words: string[] = [];
  const billions = Number(n / 1_000_000_000_000n);
  const millions = Number((n / 1_000_000n) % 1_000_000n);
  const masculineNoun: Agreement = { feminine: false, apocope: true };
  if (billions > 0) {
    words.push(billions === 1 ? 'billonésimo' : `${belowThousand(billions, masculineNoun)} billonésimo`);
  }
  if (millions > 0) {
    words.push(millions === 1 ? 'millonésimo' : `${belowMillion(millions, masculineNoun, false)} millonésimo`);
  }
  words.push(...belowMillionOrdinal(Number(n % 1_000_000n)));
  // Only the ordinal words agree in gender; the count words ("dos", "cuatro") stay as they are.
  return words
    .map(phrase => {
      if (!feminine) return phrase;
      const space = phrase.lastIndexOf(' ') + 1;
      return `${phrase.slice(0, space)}${phrase.slice(space, -1)}a`;
    })
    .join(' ');
}

/** Spanish: `veintiún mil`, `mil millones`, `ciento uno`; ordinals `primero`, `vigésimo primero`. */
export const es: NumberWordsLocale = {
  code: 'es-ES',
  negative: 'menos',
  decimalSeparator: 'coma',
  spell: (n, context) => spell(n, context.gender === 'feminine'),
  // Neuter agrees as masculine.
  spellOrdinal: (n, context) => spellOrdinal(n, context.gender === 'feminine'),
  ordinal: (_n, digits, context) => `${digits}.${context.gender === 'feminine' ? 'ª' : 'º'}`,
};
