import { APICallError } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

type EmbedManyArgs = { maxRetries?: number; values: string[]; providerOptions?: unknown };

/** Mocks both peers; `embedMany` is the spy every test inspects. Import the module under test after this. */
async function load(embedMany: (args: EmbedManyArgs) => Promise<unknown>) {
  vi.resetModules();
  vi.doMock('ai', async importOriginal => ({ ...(await importOriginal<object>()), embedMany }));
  vi.doMock('@ai-sdk/openai', () => ({
    createOpenAI: () => ({ embeddingModel: (id: string) => ({ modelId: id }) }),
  }));
  const { createOpenAIModel } = await import('./index.js');
  const { createEmbedder } = await import('../embedder.js');
  const model = createOpenAIModel({ apiKey: 'sk-test' });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model);
  if (isFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

const vectors = (values: string[]): number[][] => values.map(() => Array.from({ length: 1536 }, () => 0.02));

afterEach(() => {
  vi.doUnmock('ai');
  vi.doUnmock('@ai-sdk/openai');
});

describe('./openai', () => {
  // Retries belong to withResilience, where each attempt is charged once.
  it('passes maxRetries 0', async () => {
    const spy = vi.fn(({ values }: EmbedManyArgs) => Promise.resolve({ embeddings: vectors(values), usage: { tokens: 3 } }));
    const embedder = await load(spy);
    const batch = await embedder.embed(['a', 'b'], {});
    expect(isFailure(batch)).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ maxRetries: 0, values: ['a', 'b'] });
    expect(!isFailure(batch) && batch.usage.tokens).toEqual({ basis: 'reported', count: 3 });
  });

  // A NaN token count presented as a number would corrupt every budget that sums it.
  it('NaN usage becomes unknown', async () => {
    const embedder = await load(({ values }) => Promise.resolve({ embeddings: vectors(values), usage: { tokens: Number.NaN } }));
    const batch = await embedder.embed(['a'], {});
    expect(!isFailure(batch) && batch.usage.tokens).toEqual({ basis: 'unknown' });
  });

  it('429 becomes RateLimited with retryAfterMs', async () => {
    const embedder = await load(() => {
      return Promise.reject(new APICallError({
        message: 'Rate limit reached',
        url: 'https://api.openai.com/v1/embeddings',
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { 'retry-after': '3' },
        isRetryable: true,
      }));
    });
    const result = await embedder.embed(['a'], {});
    expect(isFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect(isFailure(result) && result.data).toEqual({ retryAfterMs: 3000 });
  });

  // The peer is optional; an app without it must get a value it can branch on, not a crash.
  it('missing peer is ModelUnavailable not a throw', async () => {
    vi.resetModules();
    vi.doMock('ai', () => {
      throw new Error("Cannot find package 'ai'");
    });
    const { createOpenAIModel } = await import('./index.js');
    const { createEmbedder } = await import('../embedder.js');
    const model = createOpenAIModel({ apiKey: 'sk-test' });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    const result = await embedder.embed(['a'], {});
    expect(isFailure(result) && result.data).toEqual({ model: 'text-embedding-3-small', reason: 'peer-missing' });
  });
});
