/**
 * How hard and how long a text is to read: syllable heuristics, the classic readability formulas,
 * and time estimates. Every function accepts either a string or a `TextAnalysis` from
 * `analyze()` (in `./metrics`), so several scores can share one analysis and a custom formula
 * is just a function of that analysis. `readability()` computes the score set for a language:
 * English by default, Spanish (`fernandezHuerta`, `szigrisztPazos`) or German (`fleschAmstad`,
 * `wienerSachtextformel`) with `{ language }`.
 */

import type { TextInput } from './internal/analysis.js';
import type { ReadabilityScores } from './internal/readability.js';
import type { SyllableLanguage } from './internal/syllables.js';
import { toAnalysis } from './internal/analysis.js';
import { sum } from './internal/math.js';
import {
  automatedReadabilityIndexOf,
  colemanLiauIndexOf,
  fernandezHuertaOf,
  fleschAmstadOf,
  fleschKincaidGradeOf,
  fleschReadingEaseOf,
  gunningFogOf,
  lixOf,
  readabilityOf,
  smogIndexOf,
  szigrisztPazosOf,
  wienerSachtextformelOf,
} from './internal/readability.js';
import { syllableCounter } from './internal/syllables.js';

export type { ReadabilityLevel, ReadabilityScores } from './internal/readability.js';
export type { SyllableLanguage } from './internal/syllables.js';
export { fleschReadingEaseLevel } from './internal/readability.js';

export type TimeOptions = Readonly<{ wordsPerMinute?: number }>;

export type SyllableOptions = Readonly<{
  /** Counting rules to apply. Default `'en'`. */
  language?: SyllableLanguage;
}>;

export type ReadabilityOptions = Readonly<{
  /** Which language's formulas to compute. Default `'en'`. */
  language?: SyllableLanguage;
}>;

export type SpanishReadabilityScores = Readonly<{ fernandezHuerta: number; szigrisztPazos: number }>;
export type GermanReadabilityScores = Readonly<{ fleschAmstad: number; wienerSachtextformel: number }>;

export type ReadingTime = Readonly<{ words: number; seconds: number; minutes: number }>;

/**
 * Approximate syllables in every word of `text`, summed. English by default (diacritics folded,
 * non-Latin letters ignored, a word without Latin letters counts `0`); `language: 'es' | 'de'`
 * switches rules. Meant for readability grades, not for hyphenation or verse.
 */
export function syllableCount(text: TextInput, options: SyllableOptions = {}): number {
  const language = options.language ?? 'en';
  const analysis = toAnalysis(text);
  if (language === 'en') return sum(analysis.syllables);
  const count = syllableCounter(language);
  return sum(analysis.words.map(word => count(word)));
}

/** Flesch Reading Ease, 0–100 (clamped). Text without words scores 100. */
export function fleschReadingEase(text: TextInput): number {
  return fleschReadingEaseOf(toAnalysis(text));
}

export function fleschKincaidGrade(text: TextInput): number {
  return fleschKincaidGradeOf(toAnalysis(text));
}

export function gunningFog(text: TextInput): number {
  return gunningFogOf(toAnalysis(text));
}

export function smogIndex(text: TextInput): number {
  return smogIndexOf(toAnalysis(text));
}

export function colemanLiauIndex(text: TextInput): number {
  return colemanLiauIndexOf(toAnalysis(text));
}

export function automatedReadabilityIndex(text: TextInput): number {
  return automatedReadabilityIndexOf(toAnalysis(text));
}

export function lix(text: TextInput): number {
  return lixOf(toAnalysis(text));
}

/** Spanish Flesch adaptation (Fernández Huerta), 0–100; higher is easier. */
export function fernandezHuerta(text: TextInput): number {
  return fernandezHuertaOf(toAnalysis(text));
}

/** Spanish INFLESZ scale (Szigriszt Pazos), 0–100; higher is easier. */
export function szigrisztPazos(text: TextInput): number {
  return szigrisztPazosOf(toAnalysis(text));
}

/** German Flesch adaptation (Amstad), 0–100; higher is easier. */
export function fleschAmstad(text: TextInput): number {
  return fleschAmstadOf(toAnalysis(text));
}

/** First Wiener Sachtextformel: German school grade (4–15). */
export function wienerSachtextformel(text: TextInput): number {
  return wienerSachtextformelOf(toAnalysis(text));
}

/** Every score for the language from one analysis of the text. English unless `language` says otherwise. */
export function readability(text: TextInput): ReadabilityScores;
export function readability(text: TextInput, options: Readonly<{ language?: 'en' }>): ReadabilityScores;
export function readability(text: TextInput, options: Readonly<{ language: 'es' }>): SpanishReadabilityScores;
export function readability(text: TextInput, options: Readonly<{ language: 'de' }>): GermanReadabilityScores;
export function readability(
  text: TextInput,
  options: ReadabilityOptions,
): ReadabilityScores | SpanishReadabilityScores | GermanReadabilityScores;
export function readability(
  text: TextInput,
  options: ReadabilityOptions = {},
): ReadabilityScores | SpanishReadabilityScores | GermanReadabilityScores {
  const analysis = toAnalysis(text);
  switch (options.language ?? 'en') {
    case 'es': {
      return { fernandezHuerta: fernandezHuertaOf(analysis), szigrisztPazos: szigrisztPazosOf(analysis) };
    }
    case 'de': {
      return { fleschAmstad: fleschAmstadOf(analysis), wienerSachtextformel: wienerSachtextformelOf(analysis) };
    }
    default: {
      return readabilityOf(analysis);
    }
  }
}

/** Time to read `text` silently. Default 238 words per minute (adult average, Brysbaert 2019). */
export function readingTime(text: TextInput, options: TimeOptions = {}): ReadingTime {
  return estimate(toAnalysis(text).words.length, options.wordsPerMinute ?? 238);
}

/** Time to read `text` aloud. Default 150 words per minute. */
export function speakingTime(text: TextInput, options: TimeOptions = {}): ReadingTime {
  return estimate(toAnalysis(text).words.length, options.wordsPerMinute ?? 150);
}

function estimate(wordCount: number, wordsPerMinute: number): ReadingTime {
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) {
    throw new RangeError(`wordsPerMinute must be a positive finite number, got ${String(wordsPerMinute)}`);
  }
  const minutes = wordCount / wordsPerMinute;
  return { words: wordCount, seconds: minutes * 60, minutes };
}
