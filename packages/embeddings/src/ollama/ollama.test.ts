import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import { embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { resolveSpace } from '../resolve.js';
import { NO_INSTRUCTION } from '../instructions.js';
import { createOllamaModel } from './index.js';

/** Real answers recorded from Ollama 2026-10-17 (`qwen3-embedding:0.6b`, inputs "hello" and "world"). */
const fixture = (name: string): string => readFileSync(new URL(`__fixtures__/${name}`, import.meta.url), 'utf8');
const EMBED_TWO = fixture('embed-two.json');
const TAGS = fixture('tags.json');

type Call = { url: string; body: unknown };

/** A fetch stub that answers `/api/tags` from the fixture and `/api/embed` with `answer`. */
function stubFetch(answer: (body: { input: string[] }) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/api/tags')) return Promise.resolve(new Response(TAGS));
    const input = is(body, recordSchema) && Array.isArray(body['input']) ? body['input'].map(String) : [];
    return Promise.resolve(answer({ input }));
  });
  return { fetch, calls, embedCalls: () => calls.filter(call => call.url.endsWith('/api/embed')) };
}

/** Repeats the recorded pair so any input count gets real 1024-dim vectors. */
function recorded({ input }: { input: string[] }): Response {
  const parsed = JSON.parse(EMBED_TWO) as { embeddings: number[][] };
  const embeddings = input.map((_, index) => parsed.embeddings[index % 2]);
  return Response.json({ ...parsed, embeddings, prompt_eval_count: input.length * 2 });
}

function ollama(fetch: ReturnType<typeof stubFetch>['fetch']) {
  const model = createOllamaModel({ fetch });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model);
  if (isFailure(embedder)) throw new Error(embedder.message);
  return { model, embedder };
}

describe('./ollama dimensions for a known model', () => {
  // A collection made at a Matryoshka size must get vectors of that size, not the native 1024.
  it('a Matryoshka size is recorded and sent to Ollama', async () => {
    const stub = stubFetch(({ input }) =>
      Response.json({ embeddings: input.map(() => Array.from({ length: 512 }, () => 0.1)) }),
    );
    const model = createOllamaModel({ fetch: stub.fetch, dimensions: 512 });
    if (isFailure(model)) throw new Error(model.message);
    expect(model.dimensions).toBe(512);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    const batch = await embedMany(embedder, ['hello']);
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.space.dimensions).toBe(512);
    expect(stub.embedCalls()[0]?.body).toMatchObject({ dimensions: 512 });
  });

  // A size the model cannot make was silently dropped, so the store and the vectors disagreed.
  it('a size the model cannot make is ConfigurationFailure naming both sizes', () => {
    const model = createOllamaModel({ dimensions: 2560 });
    expect(isFailure(model) && model.code).toBe('embeddings.configuration');
    expect(isFailure(model) && model.message).toMatch(/1024.*2560/);
  });
});

describe('./ollama', () => {
  // The per-text fan-out in ai-sdk-ollama was the 40× loss; one request carries a whole chunk.
  it('sends one request per chunk with input[] and truncate false', async () => {
    const stub = stubFetch(recorded);
    const { embedder } = ollama(stub.fetch);
    const inputs = Array.from({ length: 130 }, (_, index) => `text ${index}`);
    const batch = await embedMany(embedder, inputs, { concurrency: 1 });
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.vectors).toHaveLength(130);
    expect(batch.vectors[0]).toHaveLength(1024);
    const embeds = stub.embedCalls();
    expect(embeds).toHaveLength(3);
    expect(embeds[0]?.body).toMatchObject({ model: 'qwen3-embedding:0.6b', truncate: false });
    const first = embeds[0]?.body;
    expect(is(first, recordSchema) && Array.isArray(first['input']) ? first['input'].length : 0).toBe(64);
  });

  it('maps 404 to ModelUnavailable', async () => {
    const stub = stubFetch(() => Response.json({ error: "model 'nope-model' not found" }, { status: 404 }));
    const result = await embedMany(ollama(stub.fetch).embedder, ['a']);
    expect(isFailure(result) && result.data).toEqual({ model: 'qwen3-embedding:0.6b', reason: 'not-pulled' });
  });

  it('maps 429 to RateLimited', async () => {
    const stub = stubFetch(() => new Response('busy', { status: 429, headers: { 'retry-after': '2' } }));
    const result = await embedMany(ollama(stub.fetch).embedder, ['a']);
    expect(isFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect(isFailure(result) && result.data).toEqual({ retryAfterMs: 2000 });
  });

  // Ollama counts the tokens it really evaluated; that number beats any estimate for budgets.
  it('reports prompt_eval_count as reported tokens', async () => {
    const stub = stubFetch(recorded);
    const batch = await embedMany(ollama(stub.fetch).embedder, ['hello', 'world']);
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.usage.tokens).toEqual({ basis: 'reported', count: 4 });
    expect(batch.usage.loadMs).toBeCloseTo(2066.199_417);
  });

  // The digest pins the exact weights; an index must record it, but resolving must not fetch it.
  it('revision is the digest after the first call', async () => {
    const stub = stubFetch(recorded);
    const { model, embedder } = ollama(stub.fetch);
    expect(model.revision).toBeUndefined();
    expect(stub.calls).toHaveLength(0);
    const batch = await embedMany(embedder, ['hello']);
    if (isFailure(batch)) throw new Error(batch.message);
    const digest = (JSON.parse(TAGS) as { models: { digest: string }[] }).models[0]?.digest;
    expect(model.revision).toBe(digest);
    expect(batch.space.revision).toBe(digest);
    await embedMany(embedder, ['world']);
    expect(stub.calls.filter(call => call.url.endsWith('/api/tags'))).toHaveLength(1);
  });

  it('an unreachable server is ModelUnavailable, not a throw', async () => {
    const refused = vi.fn((): Promise<Response> => Promise.reject(new TypeError('fetch failed')));
    const model = createOllamaModel({ fetch: refused });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    const result = await embedMany(embedder, ['a']);
    expect(isFailure(result) && result.data).toEqual({ model: 'qwen3-embedding:0.6b', reason: 'unreachable' });
  });

  it('an unknown model id without dimensions is ConfigurationFailure', () => {
    const result = createOllamaModel({ id: 'my-custom-embedder' });
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
  });

  // A corpus embedded without the Qwen3 prefix must keep being queried without it, or recall drops silently.
  it('instruction overrides the facts table prefix', async () => {
    const stub = stubFetch(recorded);
    const model = createOllamaModel({ fetch: stub.fetch, instruction: NO_INSTRUCTION });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    await embedMany(embedder, ['who is the shepherd'], { purpose: 'query' });
    expect(stub.embedCalls()[0]?.body).toMatchObject({ input: ['who is the shepherd'] });
  });
});

describe('resolveSpace with Ollama', () => {
  // A job that asks "which rows are stale?" before it embeds anything must compare against the
  // digest, or every stored row (written with the digest) looks stale.
  it('learns the digest without embedding', async () => {
    const stub = stubFetch(recorded);
    const { embedder } = ollama(stub.fetch);
    const space = await resolveSpace(embedder);
    if (isFailure(space)) throw new Error(space.message);
    const digest = (JSON.parse(TAGS) as { models: { digest: string }[] }).models[0]?.digest;
    expect(space.revision).toBe(digest);
    expect(stub.embedCalls()).toHaveLength(0);
  });

  it('a model the server has not pulled is ModelUnavailable not-pulled', async () => {
    const fetch = vi.fn((): Promise<Response> => Promise.resolve(Response.json({ models: [] })));
    const model = createOllamaModel({ fetch });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    const space = await resolveSpace(embedder);
    expect(isFailure(space) && space.data).toEqual({ model: 'qwen3-embedding:0.6b', reason: 'not-pulled' });
  });

  it('an unreachable server is ModelUnavailable unreachable', async () => {
    const refused = vi.fn((): Promise<Response> => Promise.reject(new TypeError('fetch failed')));
    const model = createOllamaModel({ fetch: refused });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    const space = await resolveSpace(embedder);
    expect(isFailure(space) && space.data).toEqual({ model: 'qwen3-embedding:0.6b', reason: 'unreachable' });
  });
});
