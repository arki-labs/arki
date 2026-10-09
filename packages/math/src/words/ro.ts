/**
 * Romanian number words (`@arki/math/words/ro`).
 *
 * Agreement: `unu`/`una` and `doi`/`două` follow the gender of the thing
 * counted. A multiplier in front of a feminine noun (`mii`) takes the feminine
 * form (`două mii`, `douăzeci și una de mii`); in front of a neuter noun
 * (`milioane`) it takes the neuter form (`două milioane`, `douăzeci și unu de
 * milioane`). The linking `de` follows the DOOM rule used below.
 */

import type { Gender, NumberWordsLocale, WordsContext } from '../words.js';
import { NumericRangeError } from '../errors.js';
import { thousandsGroups } from '../words.js';

const RO_ONES = [
  'zero',
  'unu',
  'doi',
  'trei',
  'patru',
  'cinci',
  'șase',
  'șapte',
  'opt',
  'nouă',
  'zece',
  'unsprezece',
  'doisprezece',
  'treisprezece',
  'paisprezece',
  'cincisprezece',
  'șaisprezece',
  'șaptesprezece',
  'optsprezece',
  'nouăsprezece',
];
const RO_TENS = [
  '',
  '',
  'douăzeci',
  'treizeci',
  'patruzeci',
  'cincizeci',
  'șaizeci',
  'șaptezeci',
  'optzeci',
  'nouăzeci',
];
const RO_SCALES_SINGULAR = ['', 'mie', 'milion', 'miliard', 'trilion'];
const RO_SCALES_PLURAL = ['', 'mii', 'milioane', 'miliarde', 'trilioane'];
/** Grammatical gender of each scale noun's multiplier: `mie` is feminine, the rest agree like neuter nouns. */
const RO_SCALE_GENDER: Gender[] = ['masculine', 'feminine', 'neuter', 'neuter', 'neuter'];

/** One digit-ish word (0–19) in the requested gender. */
function roOne(n: number, gender: Gender): string {
  if (gender !== 'masculine') {
    if (n === 1) return gender === 'feminine' ? 'una' : 'unu';
    if (n === 2) return 'două';
    if (n === 12) return 'douăsprezece';
  }
  return RO_ONES[n]!;
}

function roBelow100(n: number, gender: Gender): string {
  if (n < 20) return roOne(n, gender);
  const unit = n % 10;
  const tens = RO_TENS[Math.floor(n / 10)]!;
  return unit === 0 ? tens : `${tens} și ${roOne(unit, gender)}`;
}

/** 1–999. Hundreds are feminine (`o sută`, `două sute`). */
function roGroup(n: number, gender: Gender): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const words: string[] = [];
  if (hundreds === 1) words.push('o sută');
  else if (hundreds > 1) words.push(`${roOne(hundreds, 'feminine')} sute`);
  if (rest > 0) words.push(roBelow100(rest, gender));
  return words.join(' ');
}

/**
 * DOOM rule followed here: `de` joins a multiplier and its scale noun when the
 * multiplier is 20 or more and its last two digits are `00` or `20`–`99`. A
 * multiplier ending in `01`–`19` takes no `de` (so 101 000 is `o sută una mii`
 * and 119 000 is `o sută nouăsprezece mii`).
 */
function needsDe(multiplier: number): boolean {
  const lastTwo = multiplier % 100;
  return multiplier >= 20 && (lastTwo === 0 || lastTwo >= 20);
}

function roSpell(n: bigint, context: WordsContext): string {
  const gender = context.gender ?? 'masculine';
  if (n === 0n) return RO_ONES[0]!;
  const groups = thousandsGroups(n);
  if (groups.length > RO_SCALES_SINGULAR.length) {
    throw new NumericRangeError(`${n} is beyond the largest Romanian scale word (trilion)`);
  }
  const words: string[] = [];
  for (const [index, group] of groups.entries()) {
    if (group === 0) continue;
    const scale = groups.length - 1 - index;
    if (scale === 0) {
      words.push(roGroup(group, gender));
    } else if (group === 1) {
      words.push(`${scale === 1 ? 'o' : 'un'} ${RO_SCALES_SINGULAR[scale]}`);
    } else {
      words.push(`${roGroup(group, RO_SCALE_GENDER[scale]!)}${needsDe(group) ? ' de' : ''} ${RO_SCALES_PLURAL[scale]}`);
    }
  }
  return words.join(' ');
}

const RO_VOWELS = 'aeiouăâî';

/** Masculine ordinal ending: `doi` → `doilea`, `opt` → `optulea`, `unu` → `unulea`. */
function roMasculineWord(word: string): string {
  return RO_VOWELS.includes(word.slice(-1)) ? `${word}lea` : `${word}ulea`;
}

/** Feminine ordinal ending: `două` → `doua`, `zece` → `zecea`, `cinci` → `cincea`, `trei` → `treia`, `mie` → `mia`. */
function roFeminineWord(word: string): string {
  if (word.endsWith('ă')) return `${word.slice(0, -1)}a`;
  if (word.endsWith('ie')) return `${word.slice(0, -1)}a`;
  if (word.endsWith('e')) return `${word}a`;
  if (word.endsWith('ci')) return `${word.slice(0, -1)}ea`;
  if (word.endsWith('i')) return `${word}a`;
  if (word.endsWith('ru')) return `${word.slice(0, -1)}a`;
  if (word.endsWith('ion')) return `${word.slice(0, -2)}oana`;
  if (word.endsWith('a')) return word;
  return `${word}a`;
}

function roSpellOrdinal(n: bigint, context: WordsContext): string {
  const feminine = context.gender === 'feminine';
  if (n === 1n) return feminine ? 'prima' : 'primul';
  const cardinal = roSpell(n, { gender: feminine ? 'feminine' : 'masculine' });
  const separator = cardinal.lastIndexOf(' ');
  const head = cardinal.slice(0, separator + 1);
  const last = cardinal.slice(separator + 1);
  return feminine ? `a ${head}${roFeminineWord(last)}` : `al ${head}${roMasculineWord(last)}`;
}

function roOrdinal(n: bigint, digits: string, context: WordsContext): string {
  const feminine = context.gender === 'feminine';
  if (n === 1n) return feminine ? `${digits}-a` : `${digits}-ul`;
  return feminine ? `a ${digits}-a` : `al ${digits}-lea`;
}

/** Romanian (`unu`, `una`, `douăzeci și una de mii`, `al douăzecilea`). Reads up to 10^15 − 1. */
export const ro: NumberWordsLocale = {
  code: 'ro-RO',
  negative: 'minus',
  decimalSeparator: 'virgulă',
  spell: roSpell,
  spellOrdinal: roSpellOrdinal,
  ordinal: roOrdinal,
};
