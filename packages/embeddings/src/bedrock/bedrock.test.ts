import { describe, expect, it, vi } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import { embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { createBedrockModel } from './index.js';

type Call = { url: string; body: unknown };

/**
 * Answers in the real shape of https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-titan-embed-text.html
 * (V2 response: `embedding`, `inputTextTokenCount`, `embeddingsByType.float`). Titan takes one text per call.
 */
function stubFetch(answer?: (call: number) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (answer) return Promise.resolve(answer(calls.length));
    const size = is(body, recordSchema) && typeof body['dimensions'] === 'number' ? body['dimensions'] : 1024;
    const embedding = Array.from({ length: size }, (_, index) => (index === 0 ? 1 : 0));
    return Promise.resolve(
      Response.json({ embedding, inputTextTokenCount: 5, embeddingsByType: { float: embedding } }),
    );
  });
  return { fetch, calls };
}

function bedrock(fetch: ReturnType<typeof stubFetch>['fetch'], dimensions?: number) {
  // An API key selects bearer auth, so no AWS credentials are read from the environment.
  const model = createBedrockModel({ region: 'us-east-1', apiKey: 'test-key', fetch });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model, dimensions === undefined ? {} : { dimensions });
  if (isFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

const bodyOf = (calls: Call[], at: number): Record<string, unknown> => {
  const body = calls[at]?.body;
  if (!is(body, recordSchema)) throw new Error('no request body');
  return body;
};

describe('./bedrock', () => {
  // Titan takes one text per call and has no task field: every purpose sends the same plain body.
  it('sends one inputText per call, normalized, with no purpose field', async () => {
    const { fetch, calls } = stubFetch();
    const batch = await embedMany(bedrock(fetch), ['a', 'b'], { purpose: 'query' });
    if (isFailure(batch)) throw new Error(batch.message);
    expect(calls).toHaveLength(2);
    expect(calls.map(call => bodyOf(calls, calls.indexOf(call))['inputText']).toSorted()).toEqual(['a', 'b']);
    expect(bodyOf(calls, 0)).toMatchObject({ normalize: true });
    expect(bodyOf(calls, 0)).not.toHaveProperty('dimensions');
    expect(calls[0]?.url).toContain('/model/amazon.titan-embed-text-v2%3A0/invoke');
  });

  // The vectors must fit the space the caller keyed on, so the size has to reach Titan.
  it('sends the Matryoshka size when it differs from native', async () => {
    const { fetch, calls } = stubFetch();
    const batch = await embedMany(bedrock(fetch, 256), ['a']);
    if (isFailure(batch)) throw new Error(batch.message);
    expect(bodyOf(calls, 0)).toMatchObject({ dimensions: 256, normalize: true });
    expect(batch.vectors[0]).toHaveLength(256);
  });

  // Titan has no truncate flag, so the default refuses a long text before any call and only an explicit choice cuts it.
  it('does not truncate unless asked', async () => {
    const long = 'x'.repeat(8192 * 4 + 40);
    const kept = stubFetch();
    const refused = await embedMany(bedrock(kept.fetch), [long]);
    expect(isFailure(refused) && refused.code).toBe('embeddings.input_too_long');
    expect(kept.calls).toHaveLength(0);
    const cut = stubFetch();
    orThrow(await embedMany(bedrock(cut.fetch), [long], { onTooLong: 'truncate' }));
    expect(String(bodyOf(cut.calls, 0)['inputText'])).toHaveLength(8192 * 4);
  });

  // Parallel calls finish in any order; a vector at the wrong position would attach to the wrong document.
  it('keeps input order when calls answer out of order', async () => {
    const slow = vi.fn(async (_url: string, init: RequestInit) => {
      const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      const text = is(body, recordSchema) ? body['inputText'] : '';
      if (text === 'a') await new Promise(resolve => setTimeout(resolve, 20));
      const embedding = Array.from({ length: 1024 }, (_, index) => (index === 0 ? (text === 'a' ? 1 : 2) : 0));
      return Response.json({ embedding, inputTextTokenCount: 1 });
    });
    const batch = await embedMany(bedrock(slow), ['a', 'b']);
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.vectors.map(vector => vector[0])).toEqual([1, 2]);
  });

  it('429 is RateLimited', async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ message: 'Too many requests' }, { status: 429, headers: { 'retry-after': '2' } }),
    );
    const result = await embedMany(bedrock(fetch), ['a']);
    expect(isFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect(isFailure(result) && result.data).toEqual({ retryAfterMs: 2000 });
  });

  // Bad or missing credentials are the caller's setup mistake, not a retryable outage.
  it('401 and 403 are ConfigurationFailure, 404 is unknown-model, a network error is unreachable', async () => {
    for (const status of [401, 403]) {
      const { fetch } = stubFetch(() => Response.json({ message: 'denied' }, { status }));
      const denied = await embedMany(bedrock(fetch), ['a']);
      expect(isFailure(denied) && denied.code).toBe('embeddings.configuration');
    }
    const missing = await embedMany(bedrock(stubFetch(() => Response.json({ message: 'no' }, { status: 404 })).fetch), [
      'a',
    ]);
    expect(isFailure(missing) && missing.data).toEqual({
      model: 'amazon.titan-embed-text-v2:0',
      reason: 'unknown-model',
    });
    const refused = vi.fn((): Promise<Response> => Promise.reject(new TypeError('fetch failed')));
    const down = await embedMany(bedrock(refused), ['a']);
    expect(isFailure(down) && down.code).toBe('embeddings.model_unavailable');
  });

  // The SDK throws before any request when it finds no credentials; retrying that as an outage never helps.
  it('missing AWS credentials are ConfigurationFailure, not unreachable', async () => {
    for (const name of [
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]) {
      // Recorded for unstubAllEnvs, then removed: the SDK reads an empty string as a credential.
      vi.stubEnv(name, '');
      Reflect.deleteProperty(process.env, name);
    }
    const { fetch, calls } = stubFetch();
    const model = createBedrockModel({ region: 'us-east-1', fetch });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    const result = await embedMany(embedder, ['a']);
    vi.unstubAllEnvs();
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
    expect(calls).toHaveLength(0);
  });

  // Titan answers 400 for a long text; the caller needs InputTooLong so it can split and retry.
  it('a 400 about length is InputTooLong', async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ message: 'Validation Error: Too many input tokens. Max input tokens: 8192' }, { status: 400 }),
    );
    const result = await embedMany(bedrock(fetch), ['a']);
    expect(isFailure(result) && result.code).toBe('embeddings.input_too_long');
  });

  // Titan reports the exact token count of each text; the sum beats any estimate for budgets.
  it('sums inputTextTokenCount as reported tokens', async () => {
    const { fetch } = stubFetch();
    const batch = await embedMany(bedrock(fetch), ['a', 'b']);
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.usage.tokens).toEqual({ basis: 'reported', count: 10 });
  });

  // An id outside the facts table has unknown limits, so refuse it rather than guess.
  it('an unknown model id is ConfigurationFailure', () => {
    const result = createBedrockModel({ id: 'amazon.titan-nope' });
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
  });
});
