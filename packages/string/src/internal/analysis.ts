/**
 * One lazily computed analysis record per text. Readability, vocabulary, and metrics functions
 * all read from it, so a composite such as `textMetrics` tokenizes, lowercases, and syllabifies
 * the text once instead of once per statistic. Every field is computed on first access.
 */

import { sentences, words } from '../segment.js';
import { lower } from './locale.js';
import { wordSyllables } from './syllables.js';

const LETTER = /\p{L}/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

export class TextAnalysis {
  readonly text: string;
  readonly locale: string | undefined;
  #words: string[] | undefined;
  #lowerWords: string[] | undefined;
  #frequencies: Map<string, number> | undefined;
  #sentences: string[] | undefined;
  #syllables: number[] | undefined;
  #letters: number | undefined;
  #lettersAndDigits: number | undefined;

  constructor(text: string, locale?: string) {
    this.text = text;
    this.locale = locale;
  }

  /** Prose words, original case. */
  get words(): string[] {
    this.#words ??= words(this.text);
    return this.#words;
  }

  /** Prose words lowercased (locale-sensitive only when a locale was given). */
  get lowerWords(): string[] {
    this.#lowerWords ??= words(lower(this.text, this.locale));
    return this.#lowerWords;
  }

  /** Count per lowercased word. */
  get frequencies(): Map<string, number> {
    this.#frequencies ??= countItems(this.lowerWords);
    return this.#frequencies;
  }

  get sentences(): string[] {
    this.#sentences ??= sentences(this.text);
    return this.#sentences;
  }

  /** Raw syllable count per word (`0` for words without Latin letters). */
  get syllables(): number[] {
    this.#syllables ??= this.words.map(word => wordSyllables(word));
    return this.#syllables;
  }

  get letters(): number {
    this.#letters ??= this.text.match(LETTER)?.length ?? 0;
    return this.#letters;
  }

  get lettersAndDigits(): number {
    this.#lettersAndDigits ??= this.text.match(LETTER_OR_DIGIT)?.length ?? 0;
    return this.#lettersAndDigits;
  }
}

export function analyze(text: string, locale?: string): TextAnalysis {
  return new TextAnalysis(text, locale);
}

/** A text to analyze, or an analysis already made so several functions share one tokenization. */
export type TextInput = string | TextAnalysis;

/** An existing analysis is used as is; its own locale wins over `locale`. */
export function toAnalysis(input: TextInput, locale?: string): TextAnalysis {
  return typeof input === 'string' ? analyze(input, locale) : input;
}

export function countItems<T>(items: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}
