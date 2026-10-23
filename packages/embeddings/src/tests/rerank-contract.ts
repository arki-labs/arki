import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

import type { FetchLike } from '../http.js';
import type { Reranker } from '../rerank/index.js';
import { rerank } from '../rerank/index.js';

/** One captured request: the URL and the parsed JSON body. */
export type RerankCall = { readonly url: string; readonly body: unknown };

/** A score per document index; the adapter's `respond` writes them in its provider's wire shape. */
export type ScoreRow = { readonly index: number; readonly score: number };

export type RerankContract = {
  readonly name: string;
  readonly create: (fetch: FetchLike) => Reranker;
  /** The provider's success body for these rows, in the shape its API reference shows. */
  readonly respond: (rows: readonly ScoreRow[]) => unknown;
};

/** A fetch that records every call and answers `answer(callNumber)`, or the rows given. */
export function stubRerankFetch(answer: (call: number, body: unknown) => Response) {
  const calls: RerankCall[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    return Promise.resolve(answer(calls.length, body));
  });
  return { fetch, calls };
}

/**
 * What every reranker promises, whatever its wire shape. Zero apps use the rerankers yet, so these
 * tests are their users: `rerank()` and `withRerankCache` rely on each line here.
 */
export function describeRerankerContract(contract: RerankContract): void {
  const { name, create, respond } = contract;
  const documents = ['about cats', 'about dogs', 'about tax'];

  describe(`${name} reranker contract`, () => {
    // Providers answer sorted or not; a hit must point at the document it scored, not at its row.
    it('scores are descending and indices map to inputs', async () => {
      const rows = [
        { index: 1, score: 0.07 },
        { index: 2, score: 0.91 },
        { index: 0, score: 0.42 },
      ];
      const { fetch } = stubRerankFetch(() => Response.json(respond(rows)));
      const ranked = await rerank(create(fetch), 'tax', documents, { text: document => document });
      if (isFailure(ranked)) throw new Error(ranked.message);
      expect(ranked.hits.map(hit => [hit.item, hit.score])).toEqual([
        ['about tax', 0.91],
        ['about cats', 0.42],
        ['about dogs', 0.07],
      ]);
    });

    // A hole or a duplicate would rank a document the model never read.
    it('a missing or repeated index is InvalidOutput', async () => {
      for (const rows of [
        [
          { index: 0, score: 0.5 },
          { index: 1, score: 0.4 },
        ],
        [
          { index: 0, score: 0.5 },
          { index: 0, score: 0.4 },
          { index: 1, score: 0.3 },
        ],
        [
          { index: 0, score: 0.5 },
          { index: 1, score: 0.4 },
          { index: 9, score: 0.3 },
        ],
      ]) {
        const { fetch } = stubRerankFetch(() => Response.json(respond(rows)));
        const result = await create(fetch).rerank('tax', documents, {});
        expect(isFailure(result) && result.code).toBe('embeddings.invalid_output');
      }
    });

    it('429 is RateLimited with the wait the server asked for', async () => {
      const { fetch } = stubRerankFetch(
        () => new Response('{"message":"slow down"}', { status: 429, headers: { 'retry-after': '2' } }),
      );
      const result = await create(fetch).rerank('tax', documents, {});
      expect(isFailure(result) && result.data).toEqual({ retryAfterMs: 2000 });
    });

    // A bad key is the caller's setup mistake, not an outage to retry.
    it('401 is ConfigurationFailure; a network error is unreachable', async () => {
      const denied = await create(stubRerankFetch(() => new Response('denied', { status: 401 })).fetch).rerank(
        'tax',
        documents,
        {},
      );
      expect(isFailure(denied) && denied.code).toBe('embeddings.configuration');
      const down = await create(() => Promise.reject(new TypeError('fetch failed'))).rerank('tax', documents, {});
      expect(isFailure(down) && down.data).toMatchObject({ reason: 'unreachable' });
    });

    it('more than maxDocuments is refused before any request', async () => {
      const { fetch, calls } = stubRerankFetch(() => Response.json(respond([])));
      const reranker = create(fetch);
      const result = await reranker.rerank(
        'tax',
        Array.from({ length: reranker.maxDocuments + 1 }, () => 'x'),
        {},
      );
      expect(isFailure(result) && result.code).toBe('embeddings.unsupported_input');
      expect(calls).toHaveLength(0);
    });

    it('an aborted signal is Cancelled and sends nothing', async () => {
      const { fetch, calls } = stubRerankFetch(() => Response.json(respond([])));
      const result = await create(fetch).rerank('tax', documents, { signal: AbortSignal.abort() });
      expect(isFailure(result) && result.code).toBe('embeddings.cancelled');
      expect(calls).toHaveLength(0);
    });

    it('a body in another shape is InvalidOutput, not a throw', async () => {
      const { fetch } = stubRerankFetch(() => Response.json({ unexpected: true }));
      const result = await create(fetch).rerank('tax', documents, {});
      expect(isFailure(result) && result.code).toBe('embeddings.invalid_output');
    });
  });
}
