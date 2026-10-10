/** English syllable heuristic, shared by readability formulas and text metrics. */

const LATIN_LETTERS_ONLY = /[^a-z]/g;
const COMBINING_MARKS = /\p{M}/gu;
/** `table`, `little`: consonant + `le` keeps its vowel. */
const CONSONANT_LE = /[^aeiou]le$/;
/** `jumped` → `jump`; `created`, `wanted` keep theirs. */
const SILENT_ED = /[^aeiotd]ed$/;
/** `cakes` → `cak`; `boxes`, `wishes`, `places` keep theirs. */
const SILENT_ES = /[^aeiosxzcgh]es$/;
/** `movement`, `lovely`, `something`: an `e` between vowel+consonant and these suffixes is silent. */
const SILENT_INTERIOR_E = /(?<=[aeiou][^aeiou])e(?=ly$|ness$|ment$|less$|ful$|thing$|where$)/;
/** `y` between two vowels is a consonant: `beyond`, `player`. */
const CONSONANT_Y = /(?<=[aeiou])y(?=[aeiou])/g;
/** Hiatus pairs that are two syllables: `poem`, `radio`, `piano`; not after `t`/`s`/`c` (`nation`, `special`). */
const HIATUS = /oe|(?<![tsc])i[ao]/g;
const VOWEL_GROUP = /[aeiouy]+/g;

/**
 * Approximate syllables in one word. Diacritics are folded, non-Latin letters are ignored, and a
 * word without Latin letters counts `0`. Meant for readability grades, not hyphenation or verse.
 */
export function wordSyllables(word: string): number {
  const lowered = word.toLowerCase();
  // `café`, `résumé`, `fiancé`: an accented final e is pronounced.
  const accentedFinalE = lowered.endsWith('é');
  let w = lowered.normalize('NFD').replaceAll(COMBINING_MARKS, '').replaceAll(LATIN_LETTERS_ONLY, '');
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;

  if (SILENT_ED.test(w)) w = w.slice(0, -2);
  else if (SILENT_ES.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('e') && !accentedFinalE && !CONSONANT_LE.test(w)) w = w.slice(0, -1);
  w = w.replace(SILENT_INTERIOR_E, '');
  w = w.replaceAll(CONSONANT_Y, '-').replaceAll(HIATUS, pair => `${pair[0]}-${pair[1]}`);

  return Math.max(1, w.match(VOWEL_GROUP)?.length ?? 0);
}

export type SyllableLanguage = 'en' | 'es' | 'de';

const ES_LETTERS_ONLY = /[^a-záéíóúüñ]/g;
/** Silent `u` in `que`, `qui`, `gue`, `gui`. */
const ES_SILENT_U = /([qg])u(?=[eéií])/g;
/** `y` is a vowel unless a vowel follows it (`hoy`, `rey` vs `yo`). */
const ES_VOWEL_Y = /y(?![aeiouáéíóú])/g;
const ES_VOWEL_GROUP = /[aeiouáéíóúü]+/g;
/** Strong vowels, plus accented weak ones, which break a diphthong (`río`, `país`). */
const ES_STRONG = /[aeoáéóíú]/;

/** Spanish: vowel groups, split at hiatus (two strong vowels, or an accented `i`/`u`). */
export function spanishSyllables(word: string): number {
  const w = word
    .toLowerCase()
    .replaceAll(ES_LETTERS_ONLY, '')
    .replaceAll(ES_SILENT_U, '$1')
    .replaceAll(ES_VOWEL_Y, 'i');
  if (w.length === 0) return 0;
  let count = 0;
  for (const group of w.match(ES_VOWEL_GROUP) ?? []) {
    count += 1;
    for (let i = 1; i < group.length; i += 1) {
      if (ES_STRONG.test(group.charAt(i - 1)) && ES_STRONG.test(group.charAt(i))) count += 1;
    }
  }
  return Math.max(1, count);
}

const DE_LETTERS_ONLY = /[^a-zäöüß]/g;
const DE_VOWEL_GROUP = /[aeiouyäöü]+/g;

/** German: one syllable per vowel group (`ei`, `eu`, `äu`, `ie` are single sounds). */
export function germanSyllables(word: string): number {
  const w = word.toLowerCase().replaceAll(DE_LETTERS_ONLY, '');
  if (w.length === 0) return 0;
  return Math.max(1, w.match(DE_VOWEL_GROUP)?.length ?? 0);
}

export function syllableCounter(language: SyllableLanguage): (word: string) => number {
  if (language === 'es') return spanishSyllables;
  if (language === 'de') return germanSyllables;
  return wordSyllables;
}
