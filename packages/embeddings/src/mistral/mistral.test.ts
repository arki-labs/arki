import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import { createEmbedder } from '../embedder.js';
import { RateLimited } from '../failures.js';
import { createMistralModel } from './index.js';

type Call = { url: string; body: unknown };

/**
 * Answers in the real shape of https://docs.mistral.ai/api/endpoint/embeddings
 * (`{ id, object, model, data: [{ object, embedding, index }], usage: { prompt_tokens, ... } }`).
 */
function stubFetch(answer?: () => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (answer) return Promise.resolve(answer());
    const input = is(body, recordSchema) && Array.isArray(body['input']) ? body['input'] : [];
    return Promise.resolve(
      Response.json({
        id: 'emb-1',
        object: 'list',
        model: 'mistral-embed',
        data: input.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: 1024 }, () => 0.03) })),
        usage: { prompt_tokens: input.length * 5, total_tokens: input.length * 5, completion_tokens: 0, prompt_audio_seconds: null },
      }),
    );
  });
  return { fetch, calls };
}

function mistral(fetch: ReturnType<typeof stubFetch>['fetch']) {
  const model = createMistralModel({ apiKey: 'test-key', fetch });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model);
  if (isFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

describe('./mistral', () => {
  // The API has no purpose field; sending one would be a 422, and a prefix would change the space.
  it('ignores purpose', async () => {
    const stub = stubFetch();
    const batch = await mistral(stub.fetch).embed(['a', 'b'], { purpose: 'query' });
    expect(isFailure(batch)).toBe(false);
    const body = stub.calls[0]?.body;
    if (!is(body, recordSchema)) throw new Error('no body');
    expect(body['input']).toEqual(['a', 'b']);
    expect(Object.keys(body)).not.toContain('purpose');
    expect(JSON.stringify(body)).not.toMatch(/query|task/i);
  });

  // Cost reports rely on the provider's own count.
  it('reports usage tokens', async () => {
    const batch = await mistral(stubFetch().fetch).embed(['a', 'b'], {});
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.usage.tokens).toEqual({ basis: 'reported', count: 10 });
  });

  // Retries belong to withResilience, so the 429 must reach the caller with its wait time.
  it('429 is RateLimited', async () => {
    const stub = stubFetch(() =>
      Response.json({ message: 'rate limit', type: 'rate_limited' }, { status: 429, headers: { 'retry-after': '3' } }),
    );
    const result = await mistral(stub.fetch).embed(['a'], {});
    expect(isFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(3000);
    expect(stub.fetch).toHaveBeenCalledOnce();
  });

  // A bad key is the operator's fault to fix, not a transient error.
  it('401 is ConfigurationFailure', async () => {
    const stub = stubFetch(() => Response.json({ message: 'Unauthorized' }, { status: 401 }));
    const result = await mistral(stub.fetch).embed(['a'], {});
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
  });

  // A 404 means the id does not exist for this account; retrying cannot help.
  it('404 is ModelUnavailable unknown-model', async () => {
    const stub = stubFetch(() => Response.json({ message: 'not found' }, { status: 404 }));
    const result = await mistral(stub.fetch).embed(['a'], {});
    expect(isFailure(result) && result.data).toMatchObject({ reason: 'unknown-model' });
  });

  // The SDK rejects a bad body locally; an unknown id must fail before any request.
  it('an unknown model id is ConfigurationFailure', () => {
    const model = createMistralModel({ apiKey: 'k', id: 'codestral-embed' });
    expect(isFailure(model) && model.code).toBe('embeddings.configuration');
  });
});
