/**
 * German number words (long scale: Milliarde = 10^9, Billion = 10^12).
 * Everything below one million is a single word (`eintausendzweihundertvierunddreißig`);
 * Million and above are separate, agreeing words (`zwei Millionen`).
 */

import type { Gender, NumberWordsLocale } from '../words.js';
import { NumericRangeError } from '../errors.js';

const LIMIT = 1_000_000_000_000_000n;

const ONES = [
  'null',
  'eins',
  'zwei',
  'drei',
  'vier',
  'fünf',
  'sechs',
  'sieben',
  'acht',
  'neun',
  'zehn',
  'elf',
  'zwölf',
  'dreizehn',
  'vierzehn',
  'fünfzehn',
  'sechzehn',
  'siebzehn',
  'achtzehn',
  'neunzehn',
];
const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

/** Digit word as used inside a compound: `eins` becomes `ein`. */
function compoundOne(n: number): string {
  return n === 1 ? 'ein' : ONES[n]!;
}

/** 0–99. `standalone` keeps `eins`; inside a compound it is `ein`. */
function belowHundred(n: number, standalone: boolean): string {
  if (n < 20) return n === 1 && !standalone ? 'ein' : ONES[n]!;
  const unit = n % 10;
  const tens = TENS[Math.floor(n / 10)]!;
  return unit === 0 ? tens : `${compoundOne(unit)}und${tens}`;
}

/** 0–999 as one word. */
function belowThousand(n: number, standalone: boolean): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return belowHundred(rest, standalone);
  const head = `${compoundOne(hundreds)}hundert`;
  return rest === 0 ? head : head + belowHundred(rest, standalone);
}

/** 1–999 999 as one word. A trailing 1 stays `eins` (`tausendeins`). */
function belowMillion(n: number): string {
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = thousands > 0 ? `${belowThousand(thousands, false)}tausend` : '';
  return rest === 0 ? head : head + belowThousand(rest, true);
}

const SCALES = [
  { value: 1_000_000_000_000n, singular: 'Billion', plural: 'Billionen' },
  { value: 1_000_000_000n, singular: 'Milliarde', plural: 'Milliarden' },
  { value: 1_000_000n, singular: 'Million', plural: 'Millionen' },
] as const;

function assertInRange(n: bigint): void {
  if (n >= LIMIT) throw new NumericRangeError(`${n} is beyond the largest supported German number (10^15 − 1)`);
}

/** Count word before a feminine scale noun: a trailing `ein` becomes `eine` (`einhunderteine Million`). */
function scaleCount(count: number): string {
  const word = belowThousand(count, false);
  return word.endsWith('ein') ? `${word}e` : word;
}

function spell(n: bigint): string {
  assertInRange(n);
  if (n === 0n) return ONES[0]!;
  const words: string[] = [];
  let remainder = n;
  for (const scale of SCALES) {
    const count = Number(remainder / scale.value);
    remainder %= scale.value;
    if (count === 0) continue;
    words.push(`${scaleCount(count)} ${count === 1 ? scale.singular : scale.plural}`);
  }
  if (remainder > 0n) words.push(belowMillion(Number(remainder)));
  return words.join(' ');
}

/** Turns the last word of a cardinal into its ordinal stem (ending in `e`). */
function ordinalWord(word: string): string {
  // "einhundert" / "eintausend" lose their "ein": "hundertste", "tausendste".
  const bare = /^ein(?:hundert|tausend)/.test(word) ? word.slice(3) : word;
  if (bare.endsWith('eins')) return `${bare.slice(0, -4)}erste`;
  if (bare.endsWith('drei')) return `${bare.slice(0, -4)}dritte`;
  if (bare.endsWith('sieben')) return `${bare.slice(0, -6)}siebte`;
  if (bare.endsWith('acht')) return `${bare}e`;
  if (bare.endsWith('ig') || bare.endsWith('hundert') || bare.endsWith('tausend')) return `${bare}ste`;
  return `${bare}te`;
}

function withGender(stem: string, gender: Gender | undefined): string {
  // Every stem ends in "e" (feminine / default form).
  if (gender === 'masculine') return `${stem.slice(0, -1)}er`;
  if (gender === 'neuter') return `${stem.slice(0, -1)}es`;
  return stem;
}

function spellOrdinal(n: bigint, gender: Gender | undefined): string {
  assertInRange(n);
  // Exact multiples of a scale word end in the noun: "millionste", "zweimillionste".
  for (const scale of SCALES.toReversed()) {
    if (n % scale.value !== 0n || (n / scale.value) % 1000n === 0n) continue;
    const count = Number((n / scale.value) % 1000n);
    const before = n - BigInt(count) * scale.value;
    const noun = `${scale.singular.toLowerCase()}ste`;
    const word = count === 1 ? noun : `${belowThousand(count, false)}${noun}`;
    return withGender(before > 0n ? `${spell(before)} ${word}` : word, gender);
  }
  const cardinal = spell(n);
  const split = cardinal.lastIndexOf(' ') + 1;
  return withGender(cardinal.slice(0, split) + ordinalWord(cardinal.slice(split)), gender);
}

/** German: `einundzwanzig`, `eine Million`, `zwei Milliarden`; ordinals `erste`, `einundzwanzigste`. */
export const de: NumberWordsLocale = {
  code: 'de-DE',
  negative: 'minus',
  decimalSeparator: 'Komma',
  spell: n => spell(n),
  spellOrdinal: (n, context) => spellOrdinal(n, context.gender),
  ordinal: (_n, digits) => `${digits}.`,
};
