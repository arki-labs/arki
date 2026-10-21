import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import type { NativeRequest } from './types.js';
import { embedMany } from './embed.js';
import { createEmbedder } from './embedder.js';
import { InputTooLong } from './failures.js';
import { createOllamaModel } from './ollama/index.js';
import { createOpenAICompatibleModel } from './openai-compatible/index.js';
import { echoTexts, stubModel } from './tests/stub-model.js';
import { countTokens } from './tokens.js';

const fixture = (name: string): string => readFileSync(new URL(`ollama/__fixtures__/${name}`, import.meta.url), 'utf8');

/** An embedder over the stub model with a 10-token input limit, recording what reached the provider. */
function limited() {
  const calls: NativeRequest[] = [];
  const model = stubModel(
    request => {
      calls.push(request);
      return echoTexts(request);
    },
    { maxInputTokens: 10 },
  );
  const embedder = createEmbedder(model);
  if (isFailure(embedder)) throw new Error(embedder.message);
  return { model, embedder, calls };
}

describe('countTokens', () => {
  // A tokenizer, when the record has one, beats the estimate; the basis says which one it was.
  it('is counted with a tokenizer and estimated without', () => {
    const { model } = limited();
    expect(countTokens(model, 'twelve chars')).toEqual({ basis: 'estimated', count: 3 });
    expect(countTokens({ ...model, countTokens: () => 7 }, 'twelve chars')).toEqual({ basis: 'counted', count: 7 });
  });
});

describe('onTooLong', () => {
  // The caller must learn which input to split and how sure the count is, before paying for a request.
  it('InputTooLong carries index and basis', async () => {
    const { embedder, calls } = limited();
    const result = await embedMany(embedder, ['short', 'x'.repeat(41)], { concurrency: 1 });
    expect(InputTooLong.is(result) && result.data).toEqual({
      index: 1,
      tokens: { basis: 'estimated', count: 11 },
      max: 10,
    });
    expect(calls).toHaveLength(0);
  });

  // Chunks are embedded one request each: the index must still count within the caller's inputs.
  it('the index counts within all inputs, not within a chunk', async () => {
    const { embedder } = limited();
    const inputs = ['a', 'b', 'c', 'x'.repeat(41)];
    const result = await embedMany(embedder, inputs, { concurrency: 1 });
    expect(InputTooLong.is(result) && result.data.index).toBe(3);
  });

  it('truncate sends the input and tells the provider to cut it', async () => {
    const { embedder, calls } = limited();
    const result = await embedMany(embedder, ['x'.repeat(41)], { onTooLong: 'truncate' });
    expect(isFailure(result)).toBe(false);
    expect(calls[0]?.truncate).toBe(true);
  });

  // Ollama with truncate false answers 400 for an over-long input; that must be InputTooLong, not InvalidOutput.
  it('Ollama truncate false surfaces InputTooLong from a 400', async () => {
    const fetch = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/api/tags')
          ? new Response(fixture('tags.json'))
          : new Response(fixture('embed-too-long.json'), { status: 400 }),
      ),
    );
    // The estimate passes (the 2048 limit is far) but the server's own count does not.
    const model = createOllamaModel({ id: 'embeddinggemma', fetch });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    const result = await embedder.embed(['short', 'the longest of the two'], {});
    expect(InputTooLong.is(result) && result.data).toMatchObject({
      index: 1,
      tokens: { basis: 'estimated' },
      max: 2048,
    });
  });

  it('Ollama truncate is sent as truncate true', async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn((url: string, init: RequestInit) => {
      if (url.endsWith('/api/tags')) return Promise.resolve(new Response(fixture('tags.json')));
      bodies.push(typeof init.body === 'string' ? JSON.parse(init.body) : undefined);
      return Promise.resolve(Response.json({ embeddings: [Array.from({ length: 768 }, () => 0.1)] }));
    });
    const model = createOllamaModel({ id: 'embeddinggemma', fetch });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    await embedder.embed(['x'.repeat(10_000)], { onTooLong: 'truncate' });
    expect(bodies[0]).toMatchObject({ truncate: true });
  });

  // The OpenAI protocol has no truncate flag, so the cut happens here, at the character estimate.
  it('openai-compatible truncate cuts at maxInputTokens * 4 characters', async () => {
    const sent: unknown[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      sent.push(body);
      const input = is(body, recordSchema) && Array.isArray(body['input']) ? body['input'] : [];
      return Promise.resolve(Response.json({ data: input.map((_, index) => ({ index, embedding: [0.5, 0.5] })) }));
    });
    const model = createOpenAICompatibleModel({
      id: 'm',
      baseURL: 'http://x/v1',
      dimensions: 2,
      maxInputTokens: 5,
      fetch,
    });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    await embedder.embed(['y'.repeat(100)], { onTooLong: 'truncate' });
    expect(sent[0]).toMatchObject({ input: ['y'.repeat(20)] });
  });
});
