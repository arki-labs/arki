/**
 * How hard and how long a text is to read: an English syllable heuristic, the classic readability
 * formulas, and time estimates. Each function analyzes its text once; `readability()` computes
 * every score from a single analysis.
 */

import type { ReadabilityScores } from './internal/readability.js';
import { analyze } from './internal/analysis.js';
import { sum } from './internal/math.js';
import {
  automatedReadabilityIndexOf,
  colemanLiauIndexOf,
  fleschKincaidGradeOf,
  fleschReadingEaseOf,
  gunningFogOf,
  lixOf,
  readabilityOf,
  smogIndexOf,
} from './internal/readability.js';
import { words } from './segment.js';

export type { ReadabilityLevel, ReadabilityScores } from './internal/readability.js';
export { fleschReadingEaseLevel } from './internal/readability.js';

export type TimeOptions = Readonly<{ wordsPerMinute?: number }>;

export type ReadingTime = Readonly<{ words: number; seconds: number; minutes: number }>;

/**
 * Approximate syllables in every word of `text`, summed. Tuned for English; diacritics are folded,
 * non-Latin letters are ignored, and a word without Latin letters counts `0`. Meant for readability
 * grades, not for hyphenation or verse.
 */
export function syllableCount(text: string): number {
  return sum(analyze(text).syllables);
}

/** Flesch Reading Ease, 0–100 (clamped). Text without words scores 100. */
export function fleschReadingEase(text: string): number {
  return fleschReadingEaseOf(analyze(text));
}

export function fleschKincaidGrade(text: string): number {
  return fleschKincaidGradeOf(analyze(text));
}

export function gunningFog(text: string): number {
  return gunningFogOf(analyze(text));
}

export function smogIndex(text: string): number {
  return smogIndexOf(analyze(text));
}

export function colemanLiauIndex(text: string): number {
  return colemanLiauIndexOf(analyze(text));
}

export function automatedReadabilityIndex(text: string): number {
  return automatedReadabilityIndexOf(analyze(text));
}

export function lix(text: string): number {
  return lixOf(analyze(text));
}

/** Every score from one analysis of the text. */
export function readability(text: string): ReadabilityScores {
  return readabilityOf(analyze(text));
}

/** Time to read `text` silently. Default 238 words per minute (adult average, Brysbaert 2019). */
export function readingTime(text: string, options: TimeOptions = {}): ReadingTime {
  return estimate(words(text).length, options.wordsPerMinute ?? 238);
}

/** Time to read `text` aloud. Default 150 words per minute. */
export function speakingTime(text: string, options: TimeOptions = {}): ReadingTime {
  return estimate(words(text).length, options.wordsPerMinute ?? 150);
}

function estimate(wordCount: number, wordsPerMinute: number): ReadingTime {
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) {
    throw new RangeError(`wordsPerMinute must be a positive finite number, got ${String(wordsPerMinute)}`);
  }
  const minutes = wordCount / wordsPerMinute;
  return { words: wordCount, seconds: minutes * 60, minutes };
}
