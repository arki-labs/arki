/**
 * Keyword and key-phrase frequency for SEO-style analysis. Phrases are built from whitespace
 * tokens so they never cross clause punctuation; stop words and short words never take part.
 */

import { lower } from './internal/locale.js';
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

const TOKEN = /\S+/gu;
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const ENDS_CLAUSE = /[.!?…,;:][\p{Pf}\p{Pe}"']*$/u;

/**
 * Most frequent words or phrases (`length` words each), lowercased, most frequent first; ties sort
 * alphabetically. `percentage` is the share among all candidate phrases of that length.
 */
export function keywords(text: string, options: KeywordOptions = {}): Keyword[] {
  const phraseLength = options.length ?? 1;
  if (!Number.isInteger(phraseLength) || phraseLength < 1) {
    throw new RangeError(`length must be a positive integer, got ${String(phraseLength)}`);
  }
  const minWordLength = options.minWordLength ?? 3;
  const minOccurrences = options.minOccurrences ?? 1;
  const stopWords = new Set(options.stopWords === undefined ? ENGLISH_STOP_WORDS : (options.stopWords ?? []));

  const tokens = [...lower(text, options.locale).matchAll(TOKEN)].map(match => {
    const word = match[0].replaceAll(EDGE_PUNCTUATION, '');
    const usable = word !== '' && length(word) >= minWordLength && !stopWords.has(word);
    return { word, usable, endsClause: ENDS_CLAUSE.test(match[0]) };
  });

  const counts = new Map<string, number>();
  let total = 0;
  for (let start = 0; start + phraseLength <= tokens.length; start += 1) {
    const span = tokens.slice(start, start + phraseLength);
    if (!span.every(token => token.usable)) continue;
    if (span.slice(0, -1).some(token => token.endsClause)) continue;
    const phrase = span.map(token => token.word).join(' ');
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    total += 1;
  }

  const result = [...counts]
    .filter(([, occurrences]) => occurrences >= minOccurrences)
    .map(([keyword, occurrences]) => ({ keyword, occurrences, percentage: (occurrences / total) * 100 }))
    // eslint-disable-next-line unicorn/no-array-sort -- the array is freshly built; no ES2023 toSorted for older engines
    .sort((a, b) => b.occurrences - a.occurrences || (a.keyword < b.keyword ? -1 : 1));
  return options.limit === undefined ? result : result.slice(0, options.limit);
}
