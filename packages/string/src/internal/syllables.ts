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
