import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import type { FetchLike } from '../http.js';
import type { ScoreRow } from '../tests/rerank-contract.js';
import { describeRerankerContract, stubRerankFetch } from '../tests/rerank-contract.js';
import { createJinaReranker } from './index.js';

/** https://api.jina.ai/redoc (read 2026-10-23): `results` and `usage.total_tokens`. */
const jinaBody = (rows: readonly ScoreRow[]) => ({
  model: 'jina-reranker-v2-base-multilingual',
  usage: { total_tokens: 15 },
  results: rows.map(row => ({ index: row.index, relevance_score: row.score })),
});

function jina(fetch: FetchLike) {
  const reranker = createJinaReranker({ apiKey: 'test-key', fetch });
  if (isFailure(reranker)) throw new Error(reranker.message);
  return reranker;
}

describeRerankerContract({ name: 'jina', create: jina, respond: jinaBody });

describe('./jina reranker', () => {
  it('sends model, query and documents, and asks for no echoed text', async () => {
    const { fetch, calls } = stubRerankFetch(() => Response.json(jinaBody([{ index: 0, score: 1 }])));
    const result = await jina(fetch).rerank('q', ['d'], {});
    expect(calls[0]?.url).toBe('https://api.jina.ai/v1/rerank');
    expect(calls[0]?.body).toEqual({
      model: 'jina-reranker-v2-base-multilingual',
      query: 'q',
      documents: ['d'],
      return_documents: false,
    });
    expect(isFailure(result) ? result.code : result.usage.tokens).toEqual({ basis: 'reported', count: 15 });
  });

  it('an id outside the facts table is ConfigurationFailure', () => {
    const result = createJinaReranker({ apiKey: 'k', id: 'jina-nope' });
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
  });
});
