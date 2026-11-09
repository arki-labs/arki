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

  // Why: the error body is the server's answer, which is outside text. A long body of `max` with no `.` made the
  // context-length pattern read on from every `max`; it must take one pass and still find `max … tokens`.
  it('a large 400 body of max words is read in one pass', async () => {
    const flood = 'max '.repeat(250_000);
    const started = performance.now();
    const results = await Promise.all(
      [flood, `${flood}tokens`].map(body =>
        rerank(compatible(stubRerankFetch(() => new Response(body, { status: 400 })).fetch), 'q', ['d'], {
          text: item => item,
        }),
      ),
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(results.map(result => isFailure(result) && result.code)).toEqual([
      'embeddings.invalid_output',
      'embeddings.input_too_long',
    ]);
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

const answer = (response: () => Response) => stubRerankFetch(response).fetch;
const dropped: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
const scores = (indices: readonly number[]) => ({ results: indices.map(index => ({ index, relevance_score: 0.5 })) });

// Why: a caller decides retry, fix-config, back-off or split from the code alone. Each failure the protocol
// reranker returns is kept here by its exact code, for both factories, through the same scripted fetch.
describe.each([
  { name: 'createCohereReranker', make: (fetch: FetchLike) => cohere(fetch) },
  { name: 'createCohereCompatibleReranker', make: compatible },
])('$name exact failure codes', ({ make }) => {
  const documents = ['a', 'b'];
  const codeOf = async (fetch: FetchLike, signal?: AbortSignal) => {
    const result = await make(fetch).rerank('q', documents, signal === undefined ? {} : { signal });
    return isFailure(result) ? { code: result.code, data: result.data } : 'ok';
  };

  it('429 is embeddings.rate_limited with the Retry-After wait', async () => {
    const fetch = answer(() => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }));
    expect(await codeOf(fetch)).toEqual({ code: 'embeddings.rate_limited', data: { retryAfterMs: 3000 } });
  });

  it('401 and 403 are embeddings.configuration', async () => {
    for (const status of [401, 403]) {
      expect(await codeOf(answer(() => new Response('denied', { status })))).toMatchObject({
        code: 'embeddings.configuration',
      });
    }
  });

  it('404 is embeddings.model_unavailable unknown-model', async () => {
    expect(await codeOf(answer(() => new Response('no such model', { status: 404 })))).toMatchObject({
      code: 'embeddings.model_unavailable',
      data: { reason: 'unknown-model' },
    });
  });

  it('503, 500, 502 and a dropped connection are embeddings.model_unavailable unreachable', async () => {
    const fetches = [503, 500, 502].map(status => answer(() => new Response('down', { status })));
    for (const fetch of [...fetches, dropped]) {
      expect(await codeOf(fetch)).toMatchObject({
        code: 'embeddings.model_unavailable',
        data: { reason: 'unreachable' },
      });
    }
  });

  it('an abort while the request is in flight is embeddings.cancelled', async () => {
    const controller = new AbortController();
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        controller.abort();
      });
    expect(await codeOf(hanging, controller.signal)).toMatchObject({ code: 'embeddings.cancelled' });
  });

  it('malformed JSON, a wrong shape, a short, repeated or out-of-range index, and a 418 are embeddings.invalid_output', async () => {
    const bodies = [
      () => new Response('{"results": [', { status: 200, headers: { 'content-type': 'application/json' } }),
      () => Response.json({ results: [{ index: 'zero', relevance_score: 1 }] }),
      () => Response.json(scores([0])),
      () => Response.json(scores([0, 0])),
      () => Response.json(scores([0, 2])),
      () => new Response('teapot', { status: 418 }),
    ];
    for (const body of bodies) {
      expect(await codeOf(answer(body))).toMatchObject({ code: 'embeddings.invalid_output' });
    }
  });

  it('more documents than maxDocuments is embeddings.unsupported_input on the batch, with no request', async () => {
    const { fetch, calls } = stubRerankFetch(() => Response.json({ results: [] }));
    const reranker = make(fetch);
    const result = await reranker.rerank(
      'q',
      Array.from({ length: reranker.maxDocuments + 1 }, () => 'x'),
      {},
    );
    expect(isFailure(result) && { code: result.code, data: result.data }).toEqual({
      code: 'embeddings.unsupported_input',
      data: { index: reranker.maxDocuments, part: 'batch' },
    });
    expect(calls).toHaveLength(0);
  });
});
