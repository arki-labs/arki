import { describe, expect, it } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import type { FetchLike } from '../http.js';
import type { ScoreRow } from '../tests/rerank-contract.js';
import { rerank } from '../rerank/index.js';
import { describeRerankerContract, stubRerankFetch } from '../tests/rerank-contract.js';
import { createTeiReranker } from './index.js';

/** https://huggingface.github.io/text-embeddings-inference/openapi.json (read 2026-10-23): a bare array of `{ index, score }`. */
const teiBody = (rows: readonly ScoreRow[]) => rows.map(row => ({ index: row.index, score: row.score }));

function tei(fetch: FetchLike) {
  const reranker = createTeiReranker({ id: 'BAAI/bge-reranker-v2-m3', baseURL: 'http://127.0.0.1:8080', fetch });
  if (isFailure(reranker)) throw new Error(reranker.message);
  return reranker;
}

describeRerankerContract({ name: 'tei', create: tei, respond: teiBody });

describe('./tei reranker', () => {
  // A server started with --auto-truncate would cut silently if `truncate` were left out.
  it('always sends truncate, false by default and true when rerank() truncates', async () => {
    const { fetch, calls } = stubRerankFetch(() => Response.json(teiBody([{ index: 0, score: 1 }])));
    orThrow(await rerank(tei(fetch), 'q', ['d'], { text: item => item }));
    orThrow(await rerank(tei(fetch), 'q', ['d'], { text: item => item, onTooLong: 'truncate' }));
    expect(calls[0]?.url).toBe('http://127.0.0.1:8080/rerank');
    expect(calls.map(call => call.body)).toEqual([
      { query: 'q', texts: ['d'], truncate: false, raw_scores: false, return_text: false },
      { query: 'q', texts: ['d'], truncate: true, raw_scores: false, return_text: false },
    ]);
  });

  // TEI tokenization.rs wording; the caller needs InputTooLong to split or truncate.
  it('the "must have less than N tokens" error is InputTooLong naming the longest document', async () => {
    const { fetch } = stubRerankFetch(() =>
      Response.json(
        { error: '`inputs` must have less than 512 tokens. Given: 900', error_type: 'Validation' },
        { status: 413 },
      ),
    );
    const result = await rerank(tei(fetch), 'q', ['short', 'a much longer document'], { text: item => item });
    expect(isFailure(result) && result.data).toMatchObject({ index: 1, max: 512 });
  });

  it('a batch-size refusal is UnsupportedInput, and x-compute-tokens is the reported cost', async () => {
    const refused = await tei(
      stubRerankFetch(() =>
        Response.json(
          { error: 'batch size 64 > maximum allowed batch size 32', error_type: 'Validation' },
          { status: 422 },
        ),
      ).fetch,
    ).rerank('q', ['d'], {});
    expect(isFailure(refused) && refused.data).toEqual({ index: -1, part: 'batch' });
    const counted = await tei(
      stubRerankFetch(() => Response.json(teiBody([{ index: 0, score: 1 }]), { headers: { 'x-compute-tokens': '9' } }))
        .fetch,
    ).rerank('q', ['d'], {});
    expect(isFailure(counted) ? counted.code : counted.usage.tokens).toEqual({ basis: 'reported', count: 9 });
  });
});
