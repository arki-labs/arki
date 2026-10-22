// The quality eval's arithmetic: exact dense search, a BM25 baseline, the ranking metrics as
// `kind: 'code'` scorers, Spearman for RO-STS, and gate D1. No model computes any of it.

import type { Score } from '@arki/testing/ai';
import { defineScorer } from '@arki/testing/ai';

import type { Passage, Query, RetrievalSet } from './beir.js';

/** Top `k` passage ids per query by dot product. Vectors must be unit length, so this is cosine. */
export function searchDense(
  ids: readonly string[],
  passages: readonly Float32Array[],
  queries: readonly Float32Array[],
  k: number,
): string[][] {
  const dims = passages[0]?.length ?? 0;
  const matrix = new Float32Array(passages.length * dims);
  for (const [index, vector] of passages.entries()) matrix.set(vector, index * dims);
  const scores = new Float64Array(passages.length);
  return queries.map(query => {
    for (let row = 0; row < passages.length; row++) {
      let dot = 0;
      const base = row * dims;
      for (let dim = 0; dim < dims; dim++) dot += (query[dim] ?? 0) * (matrix[base + dim] ?? 0);
      scores[row] = dot;
    }
    return topK(ids, scores, k);
  });
}

/** Highest scores first; equal scores keep corpus order, so a run is repeatable. */
function topK(ids: readonly string[], scores: Float64Array, k: number): string[] {
  const order = [...ids.keys()].toSorted((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b);
  return order.slice(0, k).map(index => ids[index] ?? '');
}

const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Okapi BM25 with Lucene's defaults (k1 1.2, b 0.75), lower-cased Unicode words, no stemming and no
 * stop words. BEIR's published BM25 used Elasticsearch's English analyzer, so it scores a little higher.
 */
export function bm25(
  passages: readonly Passage[],
  { k1 = 1.2, b = 0.75 } = {},
): (query: string, k: number) => string[] {
  const postings = new Map<string, { index: number; count: number }[]>();
  const lengths = passages.map((passage, index) => {
    const counts = new Map<string, number>();
    const words = tokens(passage.text);
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const [word, count] of counts) {
      const list = postings.get(word) ?? [];
      list.push({ index, count });
      postings.set(word, list);
    }
    return words.length;
  });
  const average = lengths.reduce((sum, length) => sum + length, 0) / Math.max(lengths.length, 1);
  const ids = passages.map(passage => passage.id);
  return (query, k) => {
    const scores = new Float64Array(passages.length);
    for (const word of new Set(tokens(query))) {
      const list = postings.get(word);
      if (list === undefined) continue;
      const idf = Math.log(1 + (passages.length - list.length + 0.5) / (list.length + 0.5));
      for (const { index, count } of list) {
        const norm = k1 * (1 - b + (b * (lengths[index] ?? 0)) / average);
        scores[index] = (scores[index] ?? 0) + (idf * count * (k1 + 1)) / (count + norm);
      }
    }
    return topK(ids, scores, k);
  };
}

const relevant = (judged: ReadonlyMap<string, number>): string[] =>
  [...judged].filter(([, grade]) => grade > 0).map(([id]) => id);

/** nDCG with linear gain (the grade itself), as `pytrec_eval` and BEIR compute it. */
export function ndcgAt(ranked: readonly string[], judged: ReadonlyMap<string, number>, k: number): number {
  let dcg = 0;
  for (const [index, id] of ranked.slice(0, k).entries()) dcg += (judged.get(id) ?? 0) / Math.log2(index + 2);
  const ideal = [...judged.values()]
    .filter(grade => grade > 0)
    .toSorted((a, b) => b - a)
    .slice(0, k);
  let best = 0;
  for (const [index, grade] of ideal.entries()) best += grade / Math.log2(index + 2);
  return best === 0 ? 0 : dcg / best;
}

export function recallAt(ranked: readonly string[], judged: ReadonlyMap<string, number>, k: number): number {
  const wanted = relevant(judged);
  if (wanted.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  return wanted.filter(id => top.has(id)).length / wanted.length;
}

export function mrrAt(ranked: readonly string[], judged: ReadonlyMap<string, number>, k: number): number {
  const index = ranked.slice(0, k).findIndex(id => (judged.get(id) ?? 0) > 0);
  return index === -1 ? 0 : 1 / (index + 1);
}

/** A ranking metric as a scorer. A query with nothing relevant judged is unscorable, never a zero. */
function rankingScorer(
  name: string,
  metric: (ranked: readonly string[], judged: ReadonlyMap<string, number>) => number,
) {
  return defineScorer<readonly string[], unknown, ReadonlyMap<string, number>>({
    name,
    kind: 'code',
    version: '1',
    score: ({ output, expected }) => {
      const value = metric(output, expected);
      const score: Score =
        relevant(expected).length === 0
          ? { name, status: 'unscorable', reason: 'no relevant passage is judged for this query' }
          : { name, status: 'scored', value, pass: value > 0, reason: `${name} ${value.toFixed(4)}` };
      return Promise.resolve(score);
    },
  });
}

export const RETRIEVAL_SCORERS = [
  rankingScorer('ndcg@10', (ranked, judged) => ndcgAt(ranked, judged, 10)),
  rankingScorer('recall@10', (ranked, judged) => recallAt(ranked, judged, 10)),
  rankingScorer('recall@50', (ranked, judged) => recallAt(ranked, judged, 50)),
  rankingScorer('mrr@10', (ranked, judged) => mrrAt(ranked, judged, 10)),
] as const;

export type MetricName = (typeof RETRIEVAL_SCORERS)[number]['name'];
/** Mean of each metric over the scored queries of one group. */
export type GroupScores = {
  readonly queries: number;
  readonly unscorable: number;
  readonly means: Readonly<Record<string, number>>;
};

/** Every scorer over the queries `include` keeps; `rankings` holds each query's ranked passage ids. */
export async function scoreGroup(
  set: Pick<RetrievalSet, 'queries' | 'qrels'>,
  rankings: ReadonlyMap<string, readonly string[]>,
  include: (query: Query) => boolean = () => true,
): Promise<GroupScores> {
  const sums: Record<string, number> = {};
  let queries = 0;
  let unscorable = 0;
  for (const query of set.queries.filter(query => include(query))) {
    const expected = set.qrels.get(query.id) ?? new Map<string, number>();
    const output = rankings.get(query.id) ?? [];
    const scores = await Promise.all(
      RETRIEVAL_SCORERS.map(scorer => scorer.score({ output, input: query, expected }, {})),
    );
    if (scores.some(score => score.status === 'unscorable')) {
      unscorable++;
      continue;
    }
    queries++;
    for (const score of scores) if (score.status === 'scored') sums[score.name] = (sums[score.name] ?? 0) + score.value;
  }
  const means = Object.fromEntries(Object.entries(sums).map(([name, sum]) => [name, sum / Math.max(queries, 1)]));
  return { queries, unscorable, means };
}

/** Average ranks, ties sharing the mean of the ranks they span. */
function ranks(values: readonly number[]): number[] {
  const order = [...values.keys()].toSorted((a, b) => (values[a] ?? 0) - (values[b] ?? 0));
  const result = Array.from({ length: values.length }, () => 0);
  for (let start = 0; start < order.length;) {
    let end = start;
    while (end + 1 < order.length && values[order[end + 1] ?? 0] === values[order[start] ?? 0]) end++;
    for (let index = start; index <= end; index++) result[order[index] ?? 0] = (start + end) / 2 + 1;
    start = end + 1;
  }
  return result;
}

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Spearman's rho: Pearson's correlation of the two rank lists. */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  const a = ranks(xs);
  const b = ranks(ys);
  const [meanA, meanB] = [mean(a), mean(b)];
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (const [index, value] of a.entries()) {
    const da = value - meanA;
    const db = (b[index] ?? 0) - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  return covariance / Math.sqrt(varianceA * varianceB);
}

/** Founder decision D1 (2026-10-17): the domains a default swap may not hurt. */
export const PROTECTED_DOMAINS = ['novelette', 'text-bible', 'ekuation'] as const;
export const D1_MAX_DROP = 0.01;

/**
 * Gate D1: a swap from `current` to `candidate` is blocked when any protected domain's nDCG@10
 * drops by more than 0.01, or was not measured for both. Inputs map domain → nDCG@10.
 */
export function gateD1(
  current: Readonly<Record<string, number>>,
  candidate: Readonly<Record<string, number>>,
): { readonly pass: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  for (const domain of PROTECTED_DOMAINS) {
    const before = current[domain];
    const after = candidate[domain];
    if (before === undefined || after === undefined) {
      reasons.push(`${domain}: not measured`);
      continue;
    }
    // The epsilon keeps an exact 0.01 drop (0.5 → 0.49 is 0.0100000…09 in floats) on the allowed side.
    if (before - after > D1_MAX_DROP + 1e-9) reasons.push(`${domain}: nDCG@10 drops ${(before - after).toFixed(4)}`);
  }
  return { pass: reasons.length === 0, reasons };
}
