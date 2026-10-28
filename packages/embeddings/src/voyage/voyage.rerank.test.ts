import { describe, expect, it } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import type { FetchLike } from '../http.js';
import type { ScoreRow } from '../tests/rerank-contract.js';
import { rerank } from '../rerank/index.js';
import { describeRerankerContract, stubRerankFetch } from '../tests/rerank-contract.js';
import { createVoyageReranker } from './index.js';

/** https://docs.voyageai.com/reference/reranker-api (read 2026-10-23): `data`, not `results`. */
const voyageBody = (rows: readonly ScoreRow[]) => ({
  object: 'list',
  data: rows.map(row => ({ index: row.index, relevance_score: row.score })),
  model: 'rerank-2.5',
  usage: { total_tokens: 37 },
});

function voyage(fetch: FetchLike) {
  const reranker = createVoyageReranker({ apiKey: 'test-key', fetch });
  if (isFailure(reranker)) throw new Error(reranker.message);
  return reranker;
}

describeRerankerContract({ name: 'voyage', create: voyage, respond: voyageBody });

describe('./voyage reranker', () => {
  // Voyage truncates by default; the default here must refuse instead, so text is never lost silently.
  it('sends truncation: false unless rerank() was told to truncate', async () => {
    const { fetch, calls } = stubRerankFetch(() => Response.json(voyageBody([{ index: 0, score: 1 }])));
    orThrow(await rerank(voyage(fetch), 'q', ['d'], { text: item => item }));
    orThrow(await rerank(voyage(fetch), 'q', ['d'], { text: item => item, onTooLong: 'truncate' }));
    expect(calls[0]?.url).toBe('https://api.voyageai.com/v1/rerank');
    expect(calls.map(call => call.body)).toEqual([
      { model: 'rerank-2.5', query: 'q', documents: ['d'], truncation: false },
      { model: 'rerank-2.5', query: 'q', documents: ['d'], truncation: true },
    ]);
  });

  it('reports usage.total_tokens', async () => {
    const { fetch } = stubRerankFetch(() => Response.json(voyageBody([{ index: 0, score: 1 }])));
    const result = await voyage(fetch).rerank('q', ['d'], {});
    expect(isFailure(result) ? result.code : result.usage.tokens).toEqual({ basis: 'reported', count: 37 });
  });

  it('an id outside the facts table is ConfigurationFailure', () => {
    const result = createVoyageReranker({ apiKey: 'k', id: 'rerank-nope' });
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
  });
});
