import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

import type { EmbedFailure } from './failures.js';
import type { Embedder, NativeEmbeddings, NativeRequest } from './types.js';
import { embed, embedMany } from './embed.js';
import { createEmbedder } from './embedder.js';
import { InputTooLong, RateLimited } from './failures.js';
import { echoTexts, stubModel } from './tests/stub-model.js';

type Native = (request: NativeRequest) => Promise<NativeEmbeddings | EmbedFailure>;

function embedderOver(native: Native, facts: Parameters<typeof stubModel>[1] = {}) {
  const embedder = createEmbedder(stubModel(native, facts));
  if (isFailure(embedder)) throw new Error('stub embedder refused its defaults');
  return embedder;
}

const texts = (count: number): string[] => Array.from({ length: count }, (_, index) => `t${index}`);

/** Rate limited on the chunk holding t4; every other chunk succeeds. */
const failsOnT4: Native = request =>
  request.texts.includes('t4') ? Promise.resolve(RateLimited({ retryAfterMs: 50 })) : echoTexts(request);

/** Succeeds but cannot say what it cost. */
const unknownTokens: Native = async request => {
  const { vectors } = await echoTexts(request);
  return { vectors, tokens: { basis: 'unknown' } };
};

describe('embedMany', () => {
  // Chunk boundaries decide request count and cost; order decides which vector belongs to which row.
  it('packs by count and by tokens and keeps input order', async () => {
    const chunks: string[][] = [];
    const native = vi.fn(async (request: NativeRequest) => {
      chunks.push([...request.texts]);
      return echoTexts(request);
    });
    const byCount = await embedMany(embedderOver(native, { maxBatch: 3 }), texts(7), { concurrency: 3 });
    if (isFailure(byCount)) throw new Error(byCount.message);
    expect(chunks.map(chunk => chunk.length)).toEqual([3, 3, 1]);
    expect(byCount.vectors.map(vector => vector[0])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(byCount.usage.requests).toBe(3);

    chunks.length = 0;
    // 40 chars ≈ 10 estimated tokens each; 25 tokens per request fits two.
    const long = Array.from({ length: 5 }, (_, index) => `${'x'.repeat(38)}t${index}`);
    const byTokens = await embedMany(embedderOver(native, { maxBatchTokens: 25 }), long);
    if (isFailure(byTokens)) throw new Error(byTokens.message);
    expect(chunks.map(chunk => chunk.length)).toEqual([2, 2, 1]);
    expect(byTokens.vectors.map(vector => vector[0])).toEqual([1, 2, 3, 4, 5]);

    const tooLong = await embedMany(embedderOver(native, { maxBatchTokens: 5 }), ['short', 'x'.repeat(40)]);
    expect(isFailure(tooLong) && tooLong.code).toBe('embeddings.input_too_long');
    expect(InputTooLong.is(tooLong) && tooLong.data.index).toBe(1);
  });

  // A half-indexed corpus is worse than none: the caller must see the failure and no vectors.
  it('a failing chunk returns the failure and no vectors', async () => {
    const result = await embedMany(embedderOver(failsOnT4, { maxBatch: 2 }), texts(6), { concurrency: 1 });
    expect(isFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect('vectors' in result).toBe(false);
  });

  // Chunks after a failure would be paid for and thrown away.
  it('cancels the remaining chunks after the first failure', async () => {
    const started: string[] = [];
    const native: Native = async request => {
      started.push(request.texts[0] ?? '');
      if (request.texts[0] === 't0') return RateLimited({});
      await new Promise(resolve => setTimeout(resolve, 5));
      return request.signal?.aborted ? RateLimited({}) : echoTexts(request);
    };
    const result = await embedMany(embedderOver(native, { maxBatch: 1 }), texts(10), { concurrency: 2 });
    expect(isFailure(result)).toBe(true);
    // t0 fails at once; t1 was already in flight. Nothing after them is dispatched.
    expect(started).toEqual(['t0', 't1']);
  });

  it('abort signal yields Cancelled and dispatches nothing more', async () => {
    const controller = new AbortController();
    const native = vi.fn(async (request: NativeRequest) => {
      controller.abort();
      return echoTexts(request);
    });
    const result = await embedMany(embedderOver(native, { maxBatch: 1 }), texts(5), {
      concurrency: 1,
      signal: controller.signal,
    });
    expect(isFailure(result) && result.code).toBe('embeddings.cancelled');
    expect(native).toHaveBeenCalledTimes(1);

    const before = await embedMany(embedderOver(native), texts(2), { signal: controller.signal });
    expect(isFailure(before) && before.code).toBe('embeddings.cancelled');
    expect(native).toHaveBeenCalledTimes(1);
  });

  // Billing and budgets must never present an estimate as a provider-reported number.
  it('usage basis is the weakest seen', async () => {
    let call = 0;
    const native: Native = async request => {
      const {vectors} = await echoTexts(request);
      call++;
      return { vectors, tokens: call === 1 ? { basis: 'reported', count: 3 } : { basis: 'estimated', count: 2 } };
    };
    const mixed = await embedMany(embedderOver(native, { maxBatch: 1 }), texts(2), { concurrency: 1 });
    if (isFailure(mixed)) throw new Error(mixed.message);
    expect(mixed.usage.tokens).toEqual({ basis: 'estimated', count: 5 });

    const withUnknown = await embedMany(embedderOver(unknownTokens), texts(1));
    expect(!isFailure(withUnknown) && withUnknown.usage.tokens).toEqual({ basis: 'unknown' });
  });

  it('onProgress reports done and total', async () => {
    const progress: [number, number][] = [];
    const result = await embedMany(embedderOver(echoTexts, { maxBatch: 2 }), texts(5), {
      concurrency: 1,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(isFailure(result)).toBe(false);
    expect(progress).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  // A bad concurrency once started no worker and answered a "successful" batch with zero vectors.
  // The options schema now refuses it, so it is a caller bug that throws, never an empty success.
  it.each([Number.NaN, 0, -2, Number.POSITIVE_INFINITY])(
    'concurrency %s is refused instead of returning an empty success',
    async concurrency => {
      await expect(embedMany(embedderOver(echoTexts, { maxBatch: 2 }), texts(5), { concurrency })).rejects.toThrow(
        'concurrency',
      );
    },
  );

  // A batch shorter than its inputs would leave rows with no vector; it must never look like success.
  it('an embedder that answers too few vectors is InvalidOutput, not a short batch', async () => {
    const base = embedderOver(echoTexts);
    const short: Embedder = {
      ...base,
      embed: async (inputs, options) => {
        const batch = await base.embed(inputs, options);
        return isFailure(batch) ? batch : { ...batch, vectors: batch.vectors.slice(1) };
      },
    };
    const result = await embedMany(short, texts(3));
    expect(isFailure(result) && result.code).toBe('embeddings.invalid_output');
  });

  // A throw is a bug in user code: it must stop the other chunks and surface only once they settle,
  // so no request keeps running after the caller has already seen the error.
  it('a throwing embedder aborts its siblings and rejects only after they settle', async () => {
    const base = embedderOver(echoTexts, { maxBatch: 1 });
    const siblingSignals: AbortSignal[] = [];
    let settled = 0;
    const throwing: Embedder = {
      ...base,
      embed: async (inputs, options) => {
        if (inputs[0] === 't0') throw new Error('embedder bug');
        if (options.signal) siblingSignals.push(options.signal);
        await new Promise(resolve => setTimeout(resolve, 20));
        settled += 1;
        return base.embed(inputs, options);
      },
    };
    await expect(embedMany(throwing, texts(3), { concurrency: 3 })).rejects.toThrow('embedder bug');
    expect(settled).toBe(2);
    expect(siblingSignals).toHaveLength(2);
    expect(siblingSignals.every(signal => signal.aborted)).toBe(true);
  });

  it('an empty input list is an empty batch with no request', async () => {
    const native = vi.fn(echoTexts);
    const result = await embedMany(embedderOver(native), []);
    expect(!isFailure(result) && result.usage.requests).toBe(0);
    expect(native).not.toHaveBeenCalled();
  });
});

describe('embed', () => {
  it('embeds one input as one Embedding', async () => {
    const result = await embed(embedderOver(echoTexts), 't3');
    if (isFailure(result)) throw new Error(result.message);
    expect(result.vector[0]).toBe(4);
    expect(result.usage.requests).toBe(1);
  });
});
