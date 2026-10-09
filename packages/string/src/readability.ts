/**
 * How hard and how long a text is to read: an English syllable heuristic, the classic readability
 * formulas, and time estimates. Pure functions over `words()` and `sentences()` from `./segment`.
 */

import { sum } from './internal/math.js';
import { sentenceCount, words } from './segment.js';
import { length } from './unicode.js';

export type ReadabilityLevel =
  'Very Easy' | 'Easy' | 'Fairly Easy' | 'Standard' | 'Fairly Difficult' | 'Difficult' | 'Very Confusing';

export type ReadabilityScores = Readonly<{
  /** 0–100; higher is easier. Clamped. */
  fleschReadingEase: number;
  /** US school grade. */
  fleschKincaidGrade: number;
  /** Years of formal education. */
  gunningFog: number;
  /** Years of education; the formula is specified for 30+ sentences and is approximate below that. */
  smogIndex: number;
  /** US school grade, from letters and sentences per 100 words. */
  colemanLiauIndex: number;
  /** US school grade, from characters per word and words per sentence. */
  automatedReadabilityIndex: number;
  /** Läsbarhetsindex: words per sentence plus the percentage of words over six letters. */
  lix: number;
  /** Label for `fleschReadingEase`. */
  fleschReadingEaseLevel: ReadabilityLevel;
}>;

export type TimeOptions = Readonly<{ wordsPerMinute?: number }>;

export type ReadingTime = Readonly<{ words: number; seconds: number; minutes: number }>;

// ---------------------------------------------------------------------------------------------
// Syllables (English heuristic)
// ---------------------------------------------------------------------------------------------

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
 * Approximate syllables in every word of `text`, summed. Tuned for English; diacritics are folded,
 * non-Latin letters are ignored, and a word without Latin letters counts `0`. Meant for readability
 * grades, not for hyphenation or verse.
 */
export function syllableCount(text: string): number {
  let total = 0;
  for (const word of words(text)) total += wordSyllables(word);
  return total;
}

function wordSyllables(word: string): number {
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

// ---------------------------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------------------------

type Sample = Readonly<{
  words: string[];
  sentenceCount: number;
  /** Per word, at least 1. */
  syllables: number[];
  letters: number;
  lettersAndDigits: number;
}>;

const LETTER = /\p{L}/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;
const STARTS_UPPERCASE = /^\p{Lu}/u;

function sample(text: string): Sample {
  const tokens = words(text);
  return {
    words: tokens,
    sentenceCount: sentenceCount(text),
    syllables: tokens.map(word => Math.max(1, wordSyllables(word))),
    letters: text.match(LETTER)?.length ?? 0,
    lettersAndDigits: text.match(LETTER_OR_DIGIT)?.length ?? 0,
  };
}

function isEmpty(s: Sample): boolean {
  return s.words.length === 0 || s.sentenceCount === 0;
}

function fleschFrom(s: Sample): number {
  if (isEmpty(s)) return 100;
  const score = 206.835 - 1.015 * (s.words.length / s.sentenceCount) - 84.6 * (sum(s.syllables) / s.words.length);
  return Math.min(100, Math.max(0, score));
}

function fleschKincaidFrom(s: Sample): number {
  if (isEmpty(s)) return 0;
  return Math.max(0, 0.39 * (s.words.length / s.sentenceCount) + 11.8 * (sum(s.syllables) / s.words.length) - 15.59);
}

function gunningFogFrom(s: Sample): number {
  if (isEmpty(s)) return 0;
  let complex = 0;
  for (const [index, word] of s.words.entries()) {
    // Gunning excludes proper nouns and hyphenated compounds from "complex" (3+ syllable) words.
    if ((s.syllables[index] ?? 1) >= 3 && !STARTS_UPPERCASE.test(word) && !word.includes('-')) complex += 1;
  }
  return 0.4 * (s.words.length / s.sentenceCount + (complex / s.words.length) * 100);
}

function smogFrom(s: Sample): number {
  if (isEmpty(s)) return 0;
  const polysyllables = s.syllables.filter(count => count >= 3).length;
  return 1.043 * Math.sqrt(polysyllables * (30 / s.sentenceCount)) + 3.1291;
}

function colemanLiauFrom(s: Sample): number {
  if (isEmpty(s)) return 0;
  const lettersPer100Words = (s.letters / s.words.length) * 100;
  const sentencesPer100Words = (s.sentenceCount / s.words.length) * 100;
  return Math.max(0, 0.0588 * lettersPer100Words - 0.296 * sentencesPer100Words - 15.8);
}

function ariFrom(s: Sample): number {
  if (isEmpty(s)) return 0;
  return Math.max(0, 4.71 * (s.lettersAndDigits / s.words.length) + 0.5 * (s.words.length / s.sentenceCount) - 21.43);
}

function lixFrom(s: Sample): number {
  if (isEmpty(s)) return 0;
  const long = s.words.filter(word => length(word) > 6).length;
  return s.words.length / s.sentenceCount + (long / s.words.length) * 100;
}

/** Flesch Reading Ease, 0–100 (clamped). Text without words scores 100. */
export function fleschReadingEase(text: string): number {
  return fleschFrom(sample(text));
}

export function fleschKincaidGrade(text: string): number {
  return fleschKincaidFrom(sample(text));
}

export function gunningFog(text: string): number {
  return gunningFogFrom(sample(text));
}

export function smogIndex(text: string): number {
  return smogFrom(sample(text));
}

export function colemanLiauIndex(text: string): number {
  return colemanLiauFrom(sample(text));
}

export function automatedReadabilityIndex(text: string): number {
  return ariFrom(sample(text));
}

export function lix(text: string): number {
  return lixFrom(sample(text));
}

export function fleschReadingEaseLevel(fleschScore: number): ReadabilityLevel {
  if (fleschScore >= 90) return 'Very Easy';
  if (fleschScore >= 80) return 'Easy';
  if (fleschScore >= 70) return 'Fairly Easy';
  if (fleschScore >= 60) return 'Standard';
  if (fleschScore >= 50) return 'Fairly Difficult';
  if (fleschScore >= 30) return 'Difficult';
  return 'Very Confusing';
}

/** Every score from one pass over the text. */
export function readability(text: string): ReadabilityScores {
  const s = sample(text);
  const flesch = fleschFrom(s);
  return {
    fleschReadingEase: flesch,
    fleschKincaidGrade: fleschKincaidFrom(s),
    gunningFog: gunningFogFrom(s),
    smogIndex: smogFrom(s),
    colemanLiauIndex: colemanLiauFrom(s),
    automatedReadabilityIndex: ariFrom(s),
    lix: lixFrom(s),
    fleschReadingEaseLevel: fleschReadingEaseLevel(flesch),
  };
}

// ---------------------------------------------------------------------------------------------
// Time estimates
// ---------------------------------------------------------------------------------------------

/** Time to read `text` silently. Default 238 words per minute (adult average, Brysbaert 2019). */
export function readingTime(text: string, options: TimeOptions = {}): ReadingTime {
  return estimate(words(text).length, options.wordsPerMinute ?? 238);
}

/** Time to read `text` aloud. Default 150 words per minute. */
export function speakingTime(text: string, options: TimeOptions = {}): ReadingTime {
  return estimate(words(text).length, options.wordsPerMinute ?? 150);
}

function estimate(wordCount: number, wordsPerMinute: number): ReadingTime {
  if (!(wordsPerMinute > 0)) throw new RangeError(`wordsPerMinute must be positive, got ${String(wordsPerMinute)}`);
  const minutes = wordCount / wordsPerMinute;
  return { words: wordCount, seconds: minutes * 60, minutes };
}
