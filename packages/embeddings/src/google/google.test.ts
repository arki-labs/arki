import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import { createEmbedder } from '../embedder.js';
import { RateLimited } from '../failures.js';
import { norm } from '../vector.js';
import { createGoogleModel } from './index.js';

type Call = { url: string; body: unknown };

/**
 * Answers in the real REST shape of https://ai.google.dev/gemini-api/docs/embeddings
 * (`:batchEmbedContents` -> `{ embeddings: [{ values }] }`, `:embedContent` -> `{ embedding: { values } }`).
 * The API sends no usage field, which is what `google: undefined usage is unknown` relies on.
 */
function stubFetch(answer?: () => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (answer) return Promise.resolve(answer());
    const requests = is(body, recordSchema) && Array.isArray(body['requests']) ? body['requests'].length : 1;
    const size = sizeOf(body);
    const values = Array.from({ length: size }, (_, index) => (index === 0 ? 3 : index === 1 ? 4 : 0.5));
    return Promise.resolve(
      url.endsWith(':embedContent')
        ? Response.json({ embedding: { values } })
        : Response.json({ embeddings: Array.from({ length: requests }, () => ({ values })) }),
    );
  });
  return { fetch, calls };
}

/** The `outputDimensionality` the request asked for; the native 3072 when it asked for none. */
function sizeOf(body: unknown): number {
  if (!is(body, recordSchema)) return 3072;
  const first = Array.isArray(body['requests']) ? body['requests'][0] : body;
  return is(first, recordSchema) && typeof first['outputDimensionality'] === 'number' ? first['outputDimensionality'] : 3072;
}

function google(fetch: ReturnType<typeof stubFetch>['fetch'], id?: string, dimensions?: number) {
  const model = createGoogleModel({ apiKey: 'test-key', fetch, ...(id === undefined ? {} : { id }) });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model, dimensions === undefined ? {} : { dimensions });
  if (isFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

/** The first request body, as the record it must be. */
function firstRequest(calls: Call[]): Record<string, unknown> {
  const body = calls[0]?.body;
  if (!is(body, recordSchema)) throw new Error('no request body');
  const first = Array.isArray(body['requests']) ? body['requests'][0] : body;
  if (!is(first, recordSchema)) throw new Error('no request entry');
  return first;
}

describe('./google', () => {
  // Gemini ranks queries and documents differently only when told which is which.
  it('maps purpose to the provider field', async () => {
    const pairs = [
      ['query', 'RETRIEVAL_QUERY'],
      ['document', 'RETRIEVAL_DOCUMENT'],
      ['similarity', 'SEMANTIC_SIMILARITY'],
      ['classification', 'CLASSIFICATION'],
      ['clustering', 'CLUSTERING'],
    ] as const;
    for (const [purpose, taskType] of pairs) {
      const stub = stubFetch();
      const batch = await google(stub.fetch).embed(['a', 'b'], { purpose });
      expect(isFailure(batch)).toBe(false);
      expect(firstRequest(stub.calls)['taskType']).toBe(taskType);
    }
    const stub = stubFetch();
    await google(stub.fetch).embed(['a', 'b'], {});
    expect(firstRequest(stub.calls)).not.toHaveProperty('taskType');
  });

  // gemini-embedding-2 rejects task types; its purpose lives in the text prefix instead.
  it('gemini-embedding-2 sends no taskType and prefixes the text', async () => {
    const stub = stubFetch();
    await google(stub.fetch, 'gemini-embedding-2').embed(['a', 'b'], { purpose: 'query' });
    const request = firstRequest(stub.calls);
    expect(request).not.toHaveProperty('taskType');
    expect(JSON.stringify(request)).toContain('task: search result | query: a');
  });

  // The space claims normalized: true; Google only normalises the full 3072 output for 001.
  it('a truncated size comes back unit length', async () => {
    const stub = stubFetch();
    const batch = await google(stub.fetch, undefined, 768).embed(['a', 'b'], {});
    if (isFailure(batch)) throw new Error(batch.message);
    expect(firstRequest(stub.calls)['outputDimensionality']).toBe(768);
    for (const vector of batch.vectors) {
      expect(vector).toHaveLength(768);
      expect(norm(vector)).toBeCloseTo(1, 5);
    }
  });

  // Sending outputDimensionality for the native size would make every call look like a new space.
  it('omits outputDimensionality at the native size', async () => {
    const stub = stubFetch();
    await google(stub.fetch).embed(['a', 'b'], {});
    expect(firstRequest(stub.calls)).not.toHaveProperty('outputDimensionality');
  });

  // The API returns no usage; claiming a count would make cost reports wrong.
  it('google: undefined usage is unknown', async () => {
    const batch = await google(stubFetch().fetch).embed(['a', 'b'], {});
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.usage.tokens).toEqual({ basis: 'unknown' });
  });

  // Retries belong to withResilience, so the 429 must reach the caller with its wait time.
  it('429 is RateLimited', async () => {
    const stub = stubFetch(() =>
      Response.json({ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } }, { status: 429, headers: { 'retry-after': '2' } }),
    );
    const result = await google(stub.fetch).embed(['a', 'b'], {});
    expect(isFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(2000);
    expect(stub.fetch).toHaveBeenCalledOnce();
  });

  // A bad key is the operator's fault to fix, not a transient error.
  it('403 is ConfigurationFailure', async () => {
    const stub = stubFetch(() => Response.json({ error: { code: 403, message: 'bad key', status: 'PERMISSION_DENIED' } }, { status: 403 }));
    const result = await google(stub.fetch).embed(['a', 'b'], {});
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
  });

  // An id the facts table does not know must fail before any request.
  it('an unknown model id is ConfigurationFailure', () => {
    const model = createGoogleModel({ apiKey: 'k', id: 'nope' });
    expect(isFailure(model) && model.code).toBe('embeddings.configuration');
  });
});
