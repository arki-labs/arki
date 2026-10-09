/**
 * Italian number words (`@arki/math/words/it`).
 *
 * Everything below one million is a single word (`milleduecentotrentaquattro`);
 * `milione`, `miliardo` and `bilione` are separate words that agree in number
 * (`un milione`, `due milioni`). Style choice: a multiplier before `mila` keeps
 * `uno` (`ventunomila`), not the shortened `ventunmila`.
 */

import type { NumberWordsLocale, WordsContext } from '../words.js';
import { NumericRangeError } from '../errors.js';
import { thousandsGroups } from '../words.js';

const IT_ONES = [
  'zero',
  'uno',
  'due',
  'tre',
  'quattro',
  'cinque',
  'sei',
  'sette',
  'otto',
  'nove',
  'dieci',
  'undici',
  'dodici',
  'tredici',
  'quattordici',
  'quindici',
  'sedici',
  'diciassette',
  'diciotto',
  'diciannove',
];
const IT_TENS = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];
/** Scale words from 10^6: singular, plural. */
const IT_SCALES: readonly (readonly [string, string])[] = [
  ['', ''],
  ['mille', 'mila'],
  ['milione', 'milioni'],
  ['miliardo', 'miliardi'],
  ['bilione', 'bilioni'],
];
const IT_ORDINAL_IRREGULAR = [
  '',
  'primo',
  'secondo',
  'terzo',
  'quarto',
  'quinto',
  'sesto',
  'settimo',
  'ottavo',
  'nono',
  'decimo',
];

type Form = {
  /** Write `tré` (with the accent) when `tre` ends a compound word. */
  accent: boolean;
  /** Write `una` instead of `uno` as the final element. */
  feminine: boolean;
};

function itBelow100(n: number, form: Form): string {
  if (n < 20) {
    if (n === 1) return form.feminine ? 'una' : 'uno';
    if (n === 3 && form.accent) return 'tré';
    return IT_ONES[n]!;
  }
  const unit = n % 10;
  const tens = IT_TENS[Math.floor(n / 10)]!;
  if (unit === 0) return tens;
  // Tens drop their final vowel before `uno`/`una` and `otto`: ventuno, ventotto.
  const stem = unit === 1 || unit === 8 ? tens.slice(0, -1) : tens;
  return stem + itBelow100(unit, form);
}

function itBelow1000(n: number, form: Form): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = hundreds === 0 ? '' : hundreds === 1 ? 'cento' : `${IT_ONES[hundreds]}cento`;
  if (rest === 0) return head;
  const tail = itBelow100(rest, form);
  // `cento` loses its `o` before a word starting with `o`: centotto, centottanta.
  return head && tail.startsWith('o') ? head.slice(0, -1) + tail : head + tail;
}

/** Words for `n`, with `accent` deciding the `tré` spelling. */
function itCompose(n: bigint, accentFinal: boolean, feminine: boolean): string {
  if (n === 0n) return 'zero';
  const groups = thousandsGroups(n);
  if (groups.length > IT_SCALES.length) {
    throw new NumericRangeError(`${n} is beyond the largest Italian scale word (bilione)`);
  }
  const plain: Form = { accent: false, feminine: false };
  const words: string[] = [];
  // Everything below one million is one word: [thousands][units] glued together.
  let compound = '';
  for (const [index, group] of groups.entries()) {
    const scale = groups.length - 1 - index;
    if (group === 0) continue;
    if (scale >= 2) {
      words.push(group === 1 ? `un ${IT_SCALES[scale]![0]}` : `${itBelow1000(group, plain)} ${IT_SCALES[scale]![1]}`);
    } else if (scale === 1) {
      compound += group === 1 ? 'mille' : `${itBelow1000(group, plain)}mila`;
    } else {
      // `tré` needs something before it in the word, or a multi-digit group: ventitré, centotré, milletré.
      const accent =
        accentFinal && (group > 3 || compound !== '') && group % 10 === 3 && Math.floor(group / 10) % 10 !== 1;
      compound += itBelow1000(group, { accent, feminine });
    }
  }
  if (compound) words.push(compound);
  return words.join(' ');
}

function itSpell(n: bigint, context: WordsContext): string {
  return itCompose(n, true, context.gender === 'feminine');
}

/** `ventitre` + `esimo`: only a final vowel is dropped, and never from `tre` or `sei`. */
function itOrdinalWord(word: string): string {
  if (word.endsWith('mila')) return `${word.slice(0, -4)}millesimo`;
  if (word.endsWith('tre') || word.endsWith('sei')) return `${word}esimo`;
  return `${word.slice(0, -1)}esimo`;
}

function itSpellOrdinal(n: bigint, context: WordsContext): string {
  let result: string;
  if (n <= 10n) {
    result = IT_ORDINAL_IRREGULAR[Number(n)]!;
  } else {
    const words = itCompose(n, false, false).split(' ');
    const last = words.pop()!;
    if (IT_SCALES.some(([singular, plural]) => singular === last || plural === last) && last !== 'mille') {
      // `due milioni` → `duemilionesimo`, `un milione` → `milionesimo`.
      const multiplier = words.pop();
      words.push(
        `${multiplier && multiplier !== 'un' ? multiplier : ''}${itOrdinalWord(IT_SCALES.find(([s, p]) => s === last || p === last)![0])}`,
      );
    } else {
      words.push(itOrdinalWord(last));
    }
    result = words.join(' ');
  }
  return context.gender === 'feminine' ? `${result.slice(0, -1)}a` : result;
}

function itOrdinal(_n: bigint, digits: string, context: WordsContext): string {
  return context.gender === 'feminine' ? `${digits}ª` : `${digits}º`;
}

/** Italian (`ventuno`, `ventitré`, `un milione duecentomila`, `ventesimo`). Reads up to 10^15 − 1. */
export const it: NumberWordsLocale = {
  code: 'it-IT',
  negative: 'meno',
  decimalSeparator: 'virgola',
  spell: itSpell,
  spellOrdinal: itSpellOrdinal,
  ordinal: itOrdinal,
};
