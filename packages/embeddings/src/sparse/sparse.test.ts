import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

import type { FetchLike } from '../http.js';
import type { SparseModelOptions } from './index.js';
import {
  Cancelled,
  InputTooLong,
  InvalidOutput,
  ModelUnavailable,
  RateLimited,
  SpaceMismatch,
  UnsupportedInput,
} from '../failures.js';
import { createSparseModel, isSameSparseSpace, requireSparseSpace, sparseSpaceId } from './index.js';

/** A TEI `/embed_sparse` reply: one `[{ index, value }]` per input, rows unsorted as the server may send them. */
const TEI_REPLY = [
  [
    { index: 2054, value: 1.25 },
    { index: 101, value: 0.5 },
    { index: 7592, value: 0.75 },
  ],
  [{ index: 3000, value: 2 }],
];

function splade(fetch: FetchLike, options: Partial<SparseModelOptions> = {}) {
  const model = createSparseModel({
    id: 'naver/splade-v3',
    baseURL: 'http://tei.test/',
    dimensions: 30_522,
    fetch,
    ...options,
  });
  if (isFailure(model)) throw new Error(model.message);
  return model;
}

const answer = (body: unknown, init?: ResponseInit) => () => Promise.resolve(Response.json(body, init));
const teiError = (status: number, error: string, errorType: string) =>
  answer({ error, error_type: errorType }, { status });

describe('./sparse', () => {
  it('posts inputs[] and an explicit truncate flag to baseURL/embed_sparse', async () => {
    const fetch = vi.fn<FetchLike>(answer(TEI_REPLY));
    const model = splade(fetch, { apiKey: 'key' });
    await model.embed(['a', 'b'], {});
    await model.embed(['a', 'b'], { onTooLong: 'truncate' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://tei.test/embed_sparse');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer key');
    const bodies = fetch.mock.calls.map(([, call]) => JSON.parse(typeof call.body === 'string' ? call.body : '{}'));
    // `truncate: false` is sent too: a server started with `--auto-truncate` would otherwise cut silently.
    expect(bodies).toEqual([
      { inputs: ['a', 'b'], truncate: false },
      { inputs: ['a', 'b'], truncate: true },
    ]);
  });

  // Qdrant and dot products expect ascending, unique indices; TEI promises no order.
  it('sorts each row by index into typed arrays', async () => {
    const batch = await splade(answer(TEI_REPLY, { headers: { 'x-compute-tokens': '7' } })).embed(['a', 'b'], {});
    if (isFailure(batch)) throw new Error(batch.message);
    expect([...(batch.vectors[0]?.indices ?? [])]).toEqual([101, 2054, 7592]);
    expect([...(batch.vectors[0]?.values ?? [])]).toEqual([0.5, 1.25, 0.75]);
    expect(batch.vectors[0]?.indices).toBeInstanceOf(Uint32Array);
    expect(batch.vectors[0]?.values).toBeInstanceOf(Float32Array);
    expect(batch.space.vocabulary).toBe('naver/splade-v3');
    expect(batch.usage).toEqual({ tokens: { basis: 'reported', count: 7 }, requests: 1, cacheHits: 0 });
  });

  it('usage without x-compute-tokens is unknown', async () => {
    const batch = await splade(answer(TEI_REPLY)).embed(['a', 'b'], {});
    expect(isFailure(batch) ? undefined : batch.usage.tokens).toEqual({ basis: 'unknown' });
  });

  // A bad row would score the wrong tokens or attach a vector to the wrong document.
  it('a bad payload is InvalidOutput', async () => {
    for (const body of [
      { data: [] },
      [[{ index: 1, value: 1 }]],
      [[{ index: -1, value: 1 }], []],
      [[{ index: 1.5, value: 1 }], []],
      [[{ index: 1, value: 'high' }], []],
      [
        [
          { index: 4, value: 1 },
          { index: 4, value: 2 },
        ],
        [],
      ],
      [[{ index: 30_522, value: 1 }], []],
      [[{ index: 1, value: 1e300 }], []],
    ]) {
      const batch = await splade(answer(body)).embed(['a', 'b'], {});
      expect(InvalidOutput.is(batch)).toBe(true);
    }
    const malformed = await splade(() => Promise.resolve(new Response('{'))).embed(['a'], {});
    expect(InvalidOutput.is(malformed)).toBe(true);
  });

  it('maps TEI errors to failures', async () => {
    const overloaded = await splade(teiError(429, 'Model is overloaded', 'overloaded')).embed(['a'], {});
    expect(RateLimited.is(overloaded)).toBe(true);
    const tooLong = await splade(
      teiError(422, '`inputs` must have less than 512 tokens. Given: 600', 'validation'),
    ).embed(['short', 'a much longer text'], {});
    expect(InputTooLong.is(tooLong)).toBe(true);
    if (InputTooLong.is(tooLong)) expect(tooLong.data).toMatchObject({ index: 1, max: 512 });
    const batchSize = await splade(teiError(422, 'batch size 40 > maximum allowed batch size 32', 'validation')).embed(
      ['a'],
      {},
    );
    expect(UnsupportedInput.is(batchSize)).toBe(true);
    const backend = await splade(teiError(424, 'splade pooling is not supported', 'backend')).embed(['a'], {});
    expect(InvalidOutput.is(backend)).toBe(true);
    const unhealthy = await splade(teiError(503, 'unhealthy', 'unhealthy')).embed(['a'], {});
    expect(ModelUnavailable.is(unhealthy)).toBe(true);
    const down = await splade(() => Promise.reject(new TypeError('fetch failed'))).embed(['a'], {});
    expect(ModelUnavailable.is(down)).toBe(true);
  });

  it('more than maxBatch texts is UnsupportedInput before any fetch', async () => {
    const fetch = vi.fn<FetchLike>(answer([]));
    const batch = await splade(fetch, { maxBatch: 1 }).embed(['a', 'b'], {});
    expect(UnsupportedInput.is(batch)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an aborted signal is Cancelled', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<FetchLike>(() => {
      controller.abort();
      return Promise.reject(new Error('aborted'));
    });
    const batch = await splade(fetch).embed(['a'], { signal: controller.signal });
    expect(Cancelled.is(batch)).toBe(true);
    expect(Cancelled.is(await splade(fetch).embed(['a'], { signal: controller.signal }))).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // Index 2054 is "what" in one tokenizer and something else in another: such scores mean nothing.
  it('vocabulary mismatch is SpaceMismatch', () => {
    const stored = splade(answer([])).space;
    const retokenized = splade(answer([]), { vocabulary: 'bert-base-multilingual-cased' }).space;
    expect(isSameSparseSpace(stored, splade(answer([])).space)).toBe(true);
    expect(requireSparseSpace(stored, stored)).toBeUndefined();
    expect(SpaceMismatch.is(requireSparseSpace(stored, retokenized))).toBe(true);
    expect(sparseSpaceId(stored)).not.toBe(sparseSpaceId(retokenized));
    expect(sparseSpaceId(stored)).toBe('tei/naver/splade-v3/30522/raw/f32/i0/v:naver/splade-v3');
  });

  it('a bad baseURL, dimensions or vocabulary is ConfigurationFailure, before any fetch', () => {
    const fetch = vi.fn<FetchLike>();
    const base = { id: 'm', baseURL: 'http://x', dimensions: 4, fetch };
    expect(isFailure(createSparseModel({ ...base, baseURL: 'tei' }))).toBe(true);
    expect(isFailure(createSparseModel({ ...base, dimensions: 0 }))).toBe(true);
    expect(isFailure(createSparseModel({ ...base, vocabulary: '' }))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.env['SPARSE_LIVE'] !== '1')('./sparse live (SPARSE_LIVE=1, SPARSE_BASE_URL)', () => {
  it('a running TEI answers sorted sparse vectors', async () => {
    const model = createSparseModel({
      id: 'naver/splade-v3',
      baseURL: process.env['SPARSE_BASE_URL'] ?? 'http://127.0.0.1:8080',
      dimensions: 30_522,
    });
    if (isFailure(model)) throw new Error(model.message);
    const batch = await model.embed(['what is a sparse vector?', 'SPLADE expands terms'], {});
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.vectors).toHaveLength(2);
    for (const { indices } of batch.vectors) {
      expect(indices.length).toBeGreaterThan(0);
      expect([...indices]).toEqual([...indices].toSorted((left, right) => left - right));
    }
  });
});
