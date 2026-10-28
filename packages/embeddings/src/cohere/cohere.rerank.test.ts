import { describe, expect, it } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import type { FetchLike } from '../http.js';
import type { ScoreRow } from '../tests/rerank-contract.js';
import { rerank } from '../rerank/index.js';
import { describeRerankerContract, stubRerankFetch } from '../tests/rerank-contract.js';
import { createCohereCompatibleReranker, createCohereReranker } from './index.js';

/** https://docs.cohere.com/reference/rerank (read 2026-10-23): `results` plus `meta.billed_units`. */
const cohereBody = (rows: readonly ScoreRow[]) => ({
  id: 'b2e0c7d1',
  results: rows.map(row => ({ index: row.index, relevance_score: row.score })),
  meta: { api_version: { version: '2' }, billed_units: { search_units: 1 } },
});

/** Infinity's OpenAPI (read 2026-10-23); vLLM adds `document`, which is ignored. */
const infinityBody = (rows: readonly ScoreRow[]) => ({
  object: 'rerank',
  results: rows.map(row => ({ index: row.index, relevance_score: row.score, document: null })),
  model: 'BAAI/bge-reranker-v2-m3',
  usage: { prompt_tokens: 21, total_tokens: 21 },
  id: 'infinity-1',
  created: 1_761_200_000,
});

function cohere(fetch: FetchLike, id?: string) {
  const reranker = createCohereReranker({ apiKey: 'test-key', fetch, ...(id === undefined ? {} : { id }) });
  if (isFailure(reranker)) throw new Error(reranker.message);
  return reranker;
}

function compatible(fetch: FetchLike) {
  const reranker = createCohereCompatibleReranker({
    baseURL: 'http://127.0.0.1:7997/',
    id: 'BAAI/bge-reranker-v2-m3',
    fetch,
  });
  if (isFailure(reranker)) throw new Error(reranker.message);
  return reranker;
}

describeRerankerContract({ name: 'cohere', create: fetch => cohere(fetch), respond: cohereBody });
describeRerankerContract({ name: 'cohere-compatible', create: compatible, respond: infinityBody });

describe('./cohere rerankers', () => {
  // Cohere reads 4096 tokens of a document unless told more; a v4 model would lose the rest silently.
  it('Cohere is sent model, query, documents and the model’s whole context as max_tokens_per_doc', async () => {
    const { fetch, calls } = stubRerankFetch(() => Response.json(cohereBody([{ index: 0, score: 1 }])));
    orThrow(await cohere(fetch, 'rerank-v4.0-fast').rerank('q', ['d'], {}));
    expect(calls[0]?.url).toBe('https://api.cohere.com/v2/rerank');
    expect(calls[0]?.body).toEqual({
      model: 'rerank-v4.0-fast',
      query: 'q',
      documents: ['d'],
      max_tokens_per_doc: 32_000,
    });
  });

  it('an id outside the facts table is ConfigurationFailure, since its limits are unknown', () => {
    const result = createCohereReranker({ apiKey: 'k', id: 'rerank-nope' });
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
  });

  it('a compatible server gets /rerank on its root and reports usage tokens', async () => {
    const { fetch, calls } = stubRerankFetch(() => Response.json(infinityBody([{ index: 0, score: 0.3 }])));
    const result = await compatible(fetch).rerank('q', ['d'], {});
    if (isFailure(result)) throw new Error(result.message);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7997/rerank');
    expect(calls[0]?.body).toEqual({ model: 'BAAI/bge-reranker-v2-m3', query: 'q', documents: ['d'] });
    expect(result.usage.tokens).toEqual({ basis: 'reported', count: 21 });
  });

  // vLLM refuses a pair over the context with 400; the caller needs InputTooLong to split or truncate.
  it('a 400 about context length is InputTooLong naming the longest document', async () => {
    const { fetch } = stubRerankFetch(
      () =>
        new Response("This model's maximum context length is 512 tokens. However, you requested 900 tokens.", {
          status: 400,
        }),
    );
    const result = await rerank(compatible(fetch), 'q', ['short', 'a much longer document'], { text: item => item });
    expect(isFailure(result) && result.code).toBe('embeddings.input_too_long');
    expect(isFailure(result) && result.data).toMatchObject({ index: 1 });
  });

  it('a compatible server without a URL scheme or with an empty key is refused at create', () => {
    for (const options of [
      { baseURL: '127.0.0.1:7997', id: 'm' },
      { baseURL: 'http://x', id: 'm', apiKey: '' },
      { baseURL: 'http://x', id: 'm', maxDocuments: 0 },
    ]) {
      const result = createCohereCompatibleReranker(options);
      expect(isFailure(result) && result.code).toBe('embeddings.configuration');
    }
  });
});
