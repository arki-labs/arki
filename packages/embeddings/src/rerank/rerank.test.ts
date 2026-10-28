import { describe, expect, it, vi } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import type { Reranker } from './index.js';
import { memoryCacheStore } from '../cache.js';
import { InputTooLong } from '../failures.js';
import { fakeReranker } from '../testing/index.js';
import { rerank, withRerankCache } from './index.js';

type Hit = { readonly id: string; readonly body: string };
const hit = (id: string, body = id): Hit => ({ id, body });
const text = (item: Hit) => item.body;

/** Scores 1 for a document holding `needle`, else 0.5 for `short`, else 0; refuses what does not fit, like a real one. */
function needleReranker(maxInputTokens: number): Reranker {
  const fake = fakeReranker({ maxInputTokens });
  return {
    ...fake,
    async rerank(query, documents, options) {
      const checked = await fake.rerank(query, documents, options);
      if (isFailure(checked)) return checked;
      const hits = documents
        .map((document, index) => ({ index, score: document.includes('needle') ? 1 : document === 'short' ? 0.5 : 0 }))
        .toSorted((left, right) => right.score - left.score);
      return { hits, usage: checked.usage };
    },
  };
}

describe('rerank()', () => {
  it('splits over maxDocuments and merges in score order', async () => {
    const reranker = fakeReranker({ scores: { a: 0.1, b: 0.5, c: 0.9, d: 0.3, e: 0.7 }, maxDocuments: 2 });
    const spy = vi.spyOn(reranker, 'rerank');
    const items = ['a', 'b', 'c', 'd', 'e'].map(id => hit(id));
    const ranked = await rerank(reranker, 'q', items, { text });
    if (isFailure(ranked)) throw new Error(ranked.message);
    expect(spy.mock.calls.map(call => call[1])).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(ranked.hits.map(entry => entry.item.id)).toEqual(['c', 'e', 'b', 'd', 'a']);
    // The caller gets its own objects back, so it can carry ids and payloads through the ranking.
    expect(ranked.hits[0]?.item).toBe(items[2]);
    expect(ranked.hits[0]?.index).toBe(2);
    expect(ranked.usage.requests).toBe(3);
  });

  // A top-K taken inside each request keeps each request's local winners, not the global ones.
  it('topK is applied after the merge', async () => {
    const reranker = fakeReranker({ scores: { a: 0.2, b: 0.1, c: 0.9, d: 0.8 }, maxDocuments: 2 });
    const ranked = await rerank(
      reranker,
      'q',
      ['a', 'b', 'c', 'd'].map(id => hit(id)),
      { text, topK: 2 },
    );
    if (isFailure(ranked)) throw new Error(ranked.message);
    expect(ranked.hits.map(entry => entry.item.id)).toEqual(['c', 'd']);
  });

  it('equal scores keep input order', async () => {
    const reranker = fakeReranker({ scores: { a: 0.5, b: 0.5, c: 0.5 } });
    const ranked = await rerank(
      reranker,
      'q',
      ['a', 'b', 'c'].map(id => hit(id)),
      { text },
    );
    if (isFailure(ranked)) throw new Error(ranked.message);
    expect(ranked.hits.map(entry => entry.item.id)).toEqual(['a', 'b', 'c']);
  });

  describe('long documents follow the chunk policy named in the README', () => {
    const long = `${'word '.repeat(60)}needle ${'word '.repeat(60)}`;

    // The default never loses text silently: the caller learns which hit is too long, before any request.
    it("'fail' (default): InputTooLong names the item and nothing is sent", async () => {
      const reranker = needleReranker(40);
      const spy = vi.spyOn(reranker, 'rerank');
      const result = await rerank(reranker, 'q', [hit('short'), hit('long', long)], { text });
      expect(InputTooLong.is(result) && result.data.index).toBe(1);
      expect(spy).not.toHaveBeenCalled();
    });

    it("'truncate': the whole document is sent and the provider is told to cut", async () => {
      const reranker = needleReranker(40);
      const spy = vi.spyOn(reranker, 'rerank');
      const ranked = await rerank(reranker, 'q', [hit('long', long)], { text, onTooLong: 'truncate' });
      expect(isFailure(ranked)).toBe(false);
      expect(spy.mock.calls[0]?.[1]).toEqual([long]);
      expect(spy.mock.calls[0]?.[2]).toMatchObject({ truncate: true });
    });

    // A long answer is as relevant as its most relevant passage, wherever that passage sits.
    it("'split': every window fits and the item takes its best window's score", async () => {
      const reranker = needleReranker(40);
      const spy = vi.spyOn(reranker, 'rerank');
      const ranked = await rerank(reranker, 'q', [hit('short'), hit('long', long)], { text, onTooLong: 'split' });
      if (isFailure(ranked)) throw new Error(ranked.message);
      expect(ranked.hits.map(entry => [entry.item.id, entry.score])).toEqual([
        ['long', 1],
        ['short', 0.5],
      ]);
      // The fake refuses an over-long pair, so a passing call proves each window fit; none was truncated.
      expect(spy.mock.calls.every(call => call[2].truncate !== true)).toBe(true);
    });

    // Without overlap a phrase on a window edge is in no window whole, and its document scores as if it lacked it.
    it("'split': a phrase cut at one window's edge is whole in the next", async () => {
      const reranker = needleReranker(10);
      // Query 'q' leaves 9 tokens = 36 characters per window, stride 27: 'needle' straddles the first edge.
      const edge = `${'x'.repeat(33)}needle${'y'.repeat(40)}`;
      const ranked = await rerank(reranker, 'q', [hit('edge', edge)], { text, onTooLong: 'split' });
      if (isFailure(ranked)) throw new Error(ranked.message);
      expect(ranked.hits[0]?.score).toBe(1);
    });
  });

  // A surrogate pair cut in half is not text; an empty window would be sent and refused by the provider.
  it("'split' never cuts an emoji in half and never sends an empty window", async () => {
    const reranker = fakeReranker({ maxInputTokens: 2 });
    const spy = vi.spyOn(reranker, 'rerank');
    const ranked = await rerank(reranker, 'q', [hit('emoji', '😀'.repeat(12))], { text, onTooLong: 'split' });
    if (isFailure(ranked)) throw new Error(ranked.message);
    const sent = spy.mock.calls.flatMap(call => call[1]);
    expect(sent.length).toBeGreaterThan(1);
    for (const window of sent) {
      expect(window).not.toBe('');
      expect(window).toMatch(/^😀+$/u);
    }
  });

  // Misuse, not an expected outcome: a custom reranker with no batch size would loop forever.
  it('a reranker with maxDocuments 0 throws instead of looping', async () => {
    const reranker = { ...fakeReranker(), maxDocuments: 0 };
    await expect(rerank(reranker, 'q', [hit('a')], { text })).rejects.toThrow(/maxDocuments/);
  });

  it('a query that leaves no room for a document is InputTooLong at index -1', async () => {
    const result = await rerank(fakeReranker({ maxInputTokens: 2 }), 'a long query', [hit('a')], { text });
    expect(InputTooLong.is(result) && result.data.index).toBe(-1);
  });

  // An index inside a later request would otherwise point at the wrong hit.
  it('InputTooLong from the reranker names the caller’s item, not its place in the request', async () => {
    const base = fakeReranker({ maxDocuments: 2 });
    const reranker: Reranker = {
      ...base,
      rerank: (query, documents, options) =>
        documents.includes('bad')
          ? Promise.resolve(InputTooLong({ index: documents.indexOf('bad'), tokens: { basis: 'unknown' }, max: 1 }))
          : base.rerank(query, documents, options),
    };
    const result = await rerank(
      reranker,
      'q',
      ['a', 'b', 'c', 'bad'].map(id => hit(id)),
      { text },
    );
    expect(InputTooLong.is(result) && result.data.index).toBe(3);
  });

  // A hole or a duplicate would rank a hit the model never scored.
  it('a reranker answering a duplicate index is InvalidOutput', async () => {
    const base = fakeReranker();
    const reranker: Reranker = {
      ...base,
      rerank: () =>
        Promise.resolve({
          hits: [
            { index: 0, score: 1 },
            { index: 0, score: 0.5 },
          ],
          usage: { tokens: { basis: 'unknown' }, requests: 1, cacheHits: 0 },
        }),
    };
    const result = await rerank(reranker, 'q', [hit('a'), hit('b')], { text });
    expect(isFailure(result) && result.code).toBe('embeddings.invalid_output');
  });

  it('an aborted signal is Cancelled before any request', async () => {
    const reranker = fakeReranker();
    const spy = vi.spyOn(reranker, 'rerank');
    const result = await rerank(reranker, 'q', [hit('a')], { text, signal: AbortSignal.abort() });
    expect(isFailure(result) && result.code).toBe('embeddings.cancelled');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('withRerankCache', () => {
  // The cache exists to skip paid calls: a repeat query must cost zero requests and the same order.
  it('a repeat call is answered from the store with the same scores', async () => {
    const base = fakeReranker({ scores: { a: 0.2, b: 0.9 } });
    const spy = vi.spyOn(base, 'rerank');
    const cached = withRerankCache(base, memoryCacheStore());
    const first = await rerank(cached, 'q', [hit('a'), hit('b')], { text });
    const second = await rerank(cached, 'q', [hit('a'), hit('b')], { text });
    if (isFailure(first) || isFailure(second)) throw new Error('rerank failed');
    expect(spy).toHaveBeenCalledOnce();
    expect(second.hits).toEqual(first.hits);
    expect(second.usage).toMatchObject({ requests: 0, cacheHits: 2 });
  });

  it('only the documents not in the store are sent, and indices map back', async () => {
    const base = fakeReranker({ scores: { a: 0.2, b: 0.9, c: 0.5 } });
    const cached = withRerankCache(base, memoryCacheStore());
    orThrow(await rerank(cached, 'q', [hit('b')], { text }));
    const spy = vi.spyOn(base, 'rerank');
    const ranked = await rerank(cached, 'q', [hit('a'), hit('b'), hit('c')], { text });
    if (isFailure(ranked)) throw new Error(ranked.message);
    expect(spy.mock.calls[0]?.[1]).toEqual(['a', 'c']);
    expect(ranked.hits.map(entry => entry.item.id)).toEqual(['b', 'c', 'a']);
    expect(ranked.usage.cacheHits).toBe(1);
  });

  // A score from one model is meaningless for another; sharing a store must not mix them.
  it('another model or query misses', async () => {
    const store = memoryCacheStore();
    const first = fakeReranker({ scores: { a: 0.2 } });
    orThrow(await rerank(withRerankCache(first, store), 'q', [hit('a')], { text }));
    const other = { ...fakeReranker({ scores: { a: 0.7 } }), id: 'other-model' };
    const spy = vi.spyOn(other, 'rerank');
    const ranked = await rerank(withRerankCache(other, store), 'q', [hit('a')], { text });
    orThrow(await rerank(withRerankCache(first, store), 'another query', [hit('a')], { text }));
    if (isFailure(ranked)) throw new Error(ranked.message);
    expect(spy).toHaveBeenCalledOnce();
    expect(ranked.hits[0]?.score).toBe(0.7);
  });

  it('a store that throws is a miss, not a failure', async () => {
    const broken = { get: () => Promise.reject(new Error('down')), set: () => Promise.reject(new Error('down')) };
    const ranked = await rerank(withRerankCache(fakeReranker({ scores: { a: 0.4 } }), broken), 'q', [hit('a')], {
      text,
    });
    expect(isFailure(ranked) ? ranked.code : ranked.hits[0]?.score).toBe(0.4);
  });
});
