/**
 * Keyword and key-phrase frequency for SEO-style analysis. Words come from the package's one
 * word definition (`words()`), phrases never cross clause punctuation, and stop words or short
 * words never take part.
 */

import { lower } from './internal/locale.js';
import { wordSpans } from './internal/words.js';
import { length } from './unicode.js';

export type Keyword = Readonly<{
  /** Lowercased word or phrase. */
  keyword: string;
  occurrences: number;
  /** Share of all candidate phrases of the same length, 0–100. */
  percentage: number;
}>;

export type KeywordOptions = Readonly<{
  /** Words per phrase. Default `1`. */
  length?: number;
  /** Maximum entries returned. Default: all. */
  limit?: number;
  /** Words shorter than this (in graphemes) never form keywords. Default `3`. */
  minWordLength?: number;
  /** Phrases seen fewer times than this are dropped. Default `1`. */
  minOccurrences?: number;
  /** Lowercased words that never form keywords. Default `ENGLISH_STOP_WORDS`; pass `null` to disable. */
  stopWords?: Iterable<string> | null;
  /** BCP 47 tag for lowercasing. Default: locale-independent. */
  locale?: string;
}>;

/** English function words that never form keywords. */
export const ENGLISH_STOP_WORDS: readonly string[] = Object.freeze([
  'a',
  'about',
  'above',
  'after',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'down',
  'during',
  'each',
  'either',
  'every',
  'few',
  'for',
  'from',
  'get',
  'got',
  'had',
  'has',
  'have',
  'he',
  'her',
  'hers',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'least',
  'less',
  'like',
  'many',
  'may',
  'me',
  'might',
  'mine',
  'more',
  'most',
  'much',
  'must',
  'neither',
  'no',
  'not',
  'of',
  'off',
  'on',
  'one',
  'only',
  'onto',
  'or',
  'other',
  'our',
  'ours',
  'out',
  'over',
  'several',
  'shall',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'up',
  'upon',
  'us',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'within',
  'without',
  'would',
  'yes',
  'you',
  'your',
  'yours',
]);

/** Text between two words that ends a clause, so no phrase may span it. */
const CLAUSE_BREAK = /[.!?…,;:()[\]{}"“”„]|\s[-–—]\s|\n/u;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${String(resolved)}`);
  }
  return resolved;
}

/**
 * Most frequent words or phrases (`length` words each), lowercased, most frequent first; ties sort
 * alphabetically. `percentage` is the share among all candidate phrases of that length.
 */
export function keywords(text: string, options: KeywordOptions = {}): Keyword[] {
  const phraseLength = positiveInteger(options.length, 1, 'length');
  const minWordLength = positiveInteger(options.minWordLength, 3, 'minWordLength');
  const minOccurrences = positiveInteger(options.minOccurrences, 1, 'minOccurrences');
  const limit = options.limit === undefined ? undefined : positiveInteger(options.limit, 1, 'limit');
  const stopWords = new Set(options.stopWords === undefined ? ENGLISH_STOP_WORDS : (options.stopWords ?? []));

  const lowered = lower(text, options.locale);
  const spans = wordSpans(lowered);
  const usable = spans.map(({ word }) => length(word) >= minWordLength && !stopWords.has(word));
  /** `breakAfter[i]`: clause punctuation separates word `i` from word `i + 1` (or `i` is the last word). */
  const breakAfter = spans.map((span, index) => {
    const next = spans[index + 1];
    return next === undefined || CLAUSE_BREAK.test(lowered.slice(span.end, next.start));
  });

  const counts = new Map<string, number>();
  let total = 0;
  for (let start = 0; start + phraseLength <= spans.length; start += 1) {
    let valid = true;
    for (let offset = 0; offset < phraseLength && valid; offset += 1) {
      const index = start + offset;
      const lastInPhrase = offset === phraseLength - 1;
      if (!(usable[index] ?? false) || (!lastInPhrase && (breakAfter[index] ?? true))) valid = false;
    }
    if (!valid) continue;
    const phrase = spans
      .slice(start, start + phraseLength)
      .map(span => span.word)
      .join(' ');
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    total += 1;
  }

  const result = [...counts]
    .filter(([, occurrences]) => occurrences >= minOccurrences)
    .map(([keyword, occurrences]) => ({ keyword, occurrences, percentage: (occurrences / total) * 100 }))
    // eslint-disable-next-line unicorn/no-array-sort -- the array is freshly built; no ES2023 toSorted for older engines
    .sort((a, b) => b.occurrences - a.occurrences || (a.keyword < b.keyword ? -1 : 1));
  return limit === undefined ? result : result.slice(0, limit);
}
