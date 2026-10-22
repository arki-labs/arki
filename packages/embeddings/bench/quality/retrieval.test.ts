import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadRetrievalSet } from './beir.js';
import { bm25, gateD1, mrrAt, ndcgAt, recallAt, scoreGroup, searchDense, spearman } from './retrieval.js';

const judged = (entries: Record<string, number>) => new Map(Object.entries(entries));
const query = (id: string) => ({ id, text: id, slices: [] });

describe('ranking metrics', () => {
  it('nDCG uses the grade as the gain and discounts by rank, as BEIR does', () => {
    // DCG = 2/log2(3) + 1/log2(4); ideal = 2/log2(2) + 1/log2(3).
    expect(ndcgAt(['a', 'b', 'c'], judged({ b: 2, c: 1 }), 10)).toBeCloseTo(0.669_67, 4);
    // The better passage first is a perfect ranking, so a swap is visible in the number.
    expect(ndcgAt(['b', 'c', 'a'], judged({ b: 2, c: 1 }), 10)).toBe(1);
  });

  it('a passage judged 0 is not relevant for recall or MRR', () => {
    expect(recallAt(['x', 'a', 'b'], judged({ a: 1, b: 1, x: 0 }), 2)).toBe(0.5);
    expect(mrrAt(['x', 'c', 'a'], judged({ a: 1, x: 0 }), 10)).toBeCloseTo(1 / 3);
  });

  it('only the top k counts', () => {
    expect(mrrAt(['x', 'y', 'a'], judged({ a: 1 }), 2)).toBe(0);
    expect(ndcgAt(['x', 'a'], judged({ a: 1 }), 1)).toBe(0);
  });
});

describe('scoreGroup', () => {
  it('leaves a query with nothing relevant out of the mean instead of counting a zero', async () => {
    const group = await scoreGroup(
      {
        queries: [query('q1'), query('q2')],
        qrels: new Map([
          ['q1', judged({ a: 1 })],
          ['q2', judged({ a: 0 })],
        ]),
      },
      new Map([
        ['q1', ['a']],
        ['q2', ['a']],
      ]),
    );
    expect(group).toMatchObject({ queries: 1, unscorable: 1 });
    expect(group.means['ndcg@10']).toBe(1);
  });
});

describe('searchDense', () => {
  it('ranks by cosine and keeps corpus order on a tie, so runs repeat', () => {
    const passages = [Float32Array.of(1, 0), Float32Array.of(0, 1), Float32Array.of(0, 1)];
    expect(searchDense(['p1', 'p2', 'p3'], passages, [Float32Array.of(0.6, 0.8)], 3)).toEqual([['p2', 'p3', 'p1']]);
  });
});

describe('bm25', () => {
  it('ranks the passage holding the rare query word first', () => {
    const search = bm25([
      { id: 'cat', text: 'the cat sat on the mat' },
      { id: 'dog', text: 'the dog sat on the mat' },
    ]);
    expect(search('Dog sat', 2)[0]).toBe('dog');
  });

  // Otherwise a grading pool fills up with passages ranked only by their place in the file.
  it('returns nothing for a passage that shares no word with the query', () => {
    const search = bm25([
      { id: 'cat', text: 'the cat sat' },
      { id: 'rain', text: 'rain falls' },
    ]);
    expect(search('cat', 2)).toEqual(['cat']);
  });

  it('treats cedilla and comma diacritics as different words, so the RO slice can show it', () => {
    const search = bm25([
      { id: 'comma', text: 'școală' },
      { id: 'cedilla', text: 'şcoală' },
    ]);
    expect(search('şcoală', 1)).toEqual(['cedilla']);
  });
});

describe('spearman', () => {
  it('is 1 for the same order, -1 for the reverse, and averages ties', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 2, 2, 3], [1, 2, 3, 4])).toBeCloseTo(4.5 / Math.sqrt(22.5));
  });
});

describe('gateD1', () => {
  const current = { novelette: 0.5, 'text-bible': 0.5, ekuation: 0.5 };

  it('allows a drop of exactly 0.01 and blocks anything more', () => {
    expect(gateD1(current, { ...current, novelette: 0.49 }).pass).toBe(true);
    expect(gateD1(current, { ...current, novelette: 0.489 })).toEqual({
      pass: false,
      reasons: ['novelette: nDCG@10 drops 0.0110'],
    });
  });

  it('blocks a swap when a protected domain was never measured', () => {
    const { ekuation: _ekuation, ...withoutEkuation } = current;
    expect(gateD1(current, withoutEkuation)).toEqual({ pass: false, reasons: ['ekuation: not measured'] });
  });

  it('an improvement everywhere passes', () => {
    expect(gateD1(current, { novelette: 0.6, 'text-bible': 0.7, ekuation: 0.51 }).pass).toBe(true);
  });
});

describe('loadRetrievalSet', () => {
  // SciFact's qrels file ends lines with CRLF; reading it as LF-only rejected the header.
  it('reads CRLF files and keeps only queries with a relevant passage', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'beir-'));
    await mkdir(path.join(folder, 'qrels'));
    await writeFile(path.join(folder, 'qrels', 'test.tsv'), 'query-id\tcorpus-id\tscore\r\nq1\td1\t1\r\nq2\td1\t0\r\n');
    await writeFile(path.join(folder, 'corpus.jsonl'), '{"_id":"d1","title":"T","text":"body"}\r\n');
    await writeFile(path.join(folder, 'queries.jsonl'), '{"_id":"q1","text":"a"}\r\n{"_id":"q2","text":"b"}\r\n');
    const set = await loadRetrievalSet(folder);
    expect(set.corpus).toEqual([{ id: 'd1', text: 'T body' }]);
    expect(set.queries.map(item => item.id)).toEqual(['q1']);
    // A grading pool needs the queries nobody has graded yet.
    const all = await loadRetrievalSet(folder, { unjudged: true });
    expect(all.queries.map(item => item.id)).toEqual(['q1', 'q2']);
  });
});
