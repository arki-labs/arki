import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import type { EmbedderOptions } from '../embedder.js';
import { embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { createCohereModel } from './index.js';

/** Envelope shape follows https://docs.cohere.com/reference/embed (embeddings by type, meta.billed_units.input_tokens). */
const EMBED_TWO = readFileSync(new URL('__fixtures__/embed-two.json', import.meta.url), 'utf8');

const SIZE = 256;

/** The fixture with `embeddings` replaced by `{ [type]: one vector per row from make(row) }`. */
function answerWith(type: string, make: (row: number) => number[]): Response {
  const parsed: unknown = JSON.parse(EMBED_TWO);
  return Response.json({ ...(is(parsed, recordSchema) ? parsed : {}), embeddings: { [type]: [make(0), make(1)] } });
}

const floats = (row: number): number[] => Array.from({ length: SIZE }, (_, at) => (at === row ? 1 : 0));
const bytes = (row: number): number[] => Array.from({ length: SIZE / 8 }, (_, at) => (at === 0 ? row + 1 : 0));
const signed = (row: number): number[] => Array.from({ length: SIZE }, (_, at) => (at === 0 ? row + 1 : 3));

function stub(answer: () => Response) {
  const bodies: unknown[] = [];
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    bodies.push(typeof init.body === 'string' ? JSON.parse(init.body) : undefined);
    return Promise.resolve(answer());
  });
  return { fetch, bodies };
}

function cohere(fetch: ReturnType<typeof stub>['fetch'], options?: EmbedderOptions) {
  const model = createCohereModel({ apiKey: 'key', fetch });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model, options ?? { dimensions: SIZE });
  if (isFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

const field = (body: unknown, name: string): unknown => (is(body, recordSchema) ? body[name] : 'missing');

describe('./cohere', () => {
  // Cohere requires input_type from v3 on; a wrong value shifts the vectors away from the corpus.
  it('maps purpose to the provider field', async () => {
    const { fetch, bodies } = stub(() => answerWith('float', floats));
    const embedder = cohere(fetch);
    for (const purpose of ['query', 'document', 'classification', 'clustering', 'similarity'] as const) {
      orThrow(await embedMany(embedder, ['a', 'b'], { purpose }));
    }
    expect(bodies.map(body => field(body, 'input_type'))).toEqual([
      'search_query',
      'search_document',
      'classification',
      'clustering',
      'search_document',
    ]);
  });

  // Leaving input_type to a default would let a corpus and its queries drift apart without any error.
  it('document intent is sent explicitly', async () => {
    const { fetch, bodies } = stub(() => answerWith('float', floats));
    orThrow(await embedMany(cohere(fetch), ['a', 'b']));
    expect(field(bodies[0], 'input_type')).toBe('search_document');
  });

  // Each dtype must be asked by its Cohere name and read from the matching key of `embeddings`.
  it('quantized output round-trips', async () => {
    const int8 = stub(() => answerWith('int8', signed));
    const asInt8 = await embedMany(cohere(int8.fetch, { dimensions: SIZE, quantization: 'int8' }), ['a', 'b']);
    if (isFailure(asInt8)) throw new Error(asInt8.message);
    expect(int8.bodies[0]).toMatchObject({ embedding_types: ['int8'], output_dimension: SIZE });
    expect(asInt8.vectors[1]).toBeInstanceOf(Int8Array);
    expect(asInt8.vectors[1]?.[0]).toBe(2);

    const binary = stub(() => answerWith('ubinary', bytes));
    const asBinary = await embedMany(cohere(binary.fetch, { dimensions: SIZE, quantization: 'binary' }), ['a', 'b']);
    if (isFailure(asBinary)) throw new Error(asBinary.message);
    expect(binary.bodies[0]).toMatchObject({ embedding_types: ['ubinary'] });
    expect(asBinary.vectors[0]).toBeInstanceOf(Uint8Array);
    expect(asBinary.vectors[0]).toHaveLength(SIZE / 8);
    expect(asBinary.vectors[1]?.[0]).toBe(2);
  });

  // Cohere cuts over-long text by default (END); the library default is to fail loudly instead.
  it('truncate is NONE unless asked', async () => {
    const { fetch, bodies } = stub(() => answerWith('float', floats));
    const embedder = cohere(fetch);
    orThrow(await embedMany(embedder, ['a', 'b']));
    orThrow(await embedMany(embedder, ['a', 'b'], { onTooLong: 'truncate' }));
    expect(bodies.map(body => field(body, 'truncate'))).toEqual(['NONE', 'END']);
  });

  it('429 is RateLimited', async () => {
    const { fetch } = stub(
      () => new Response('{"message":"slow down"}', { status: 429, headers: { 'retry-after': '3' } }),
    );
    const result = await embedMany(cohere(fetch), ['a']);
    expect(isFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect(isFailure(result) && result.data).toEqual({ retryAfterMs: 3000 });
  });

  // A bad key is the caller's setup mistake, not a retryable outage.
  it('401 is ConfigurationFailure, 404 is unknown-model, a network error is unreachable', async () => {
    const denied = await embedMany(cohere(stub(() => new Response('{}', { status: 401 })).fetch), ['a']);
    expect(isFailure(denied) && denied.code).toBe('embeddings.configuration');
    const missing = await embedMany(cohere(stub(() => new Response('{}', { status: 404 })).fetch), ['a']);
    expect(isFailure(missing) && missing.data).toEqual({ model: 'embed-v4.0', reason: 'unknown-model' });
    const refused = vi.fn((): Promise<Response> => Promise.reject(new TypeError('fetch failed')));
    const down = await embedMany(cohere(refused), ['a']);
    expect(isFailure(down) && down.data).toEqual({ model: 'embed-v4.0', reason: 'unreachable' });
  });

  // With truncate NONE Cohere answers 400 for a long text; the caller needs InputTooLong, not a raw error.
  it('a 400 about length is InputTooLong', async () => {
    const { fetch } = stub(
      () =>
        new Response('{"message":"too many tokens: total number of tokens exceeds the limit of 512"}', { status: 400 }),
    );
    const result = await embedMany(cohere(fetch), ['a']);
    expect(isFailure(result) && result.code).toBe('embeddings.input_too_long');
  });

  // Cohere bills exact tokens; they beat any estimate. Missing meta falls back to unknown.
  it('reports billed input tokens, else unknown', async () => {
    const billed = await embedMany(cohere(stub(() => answerWith('float', floats)).fetch), ['a', 'b']);
    if (isFailure(billed)) throw new Error(billed.message);
    expect(billed.usage.tokens).toEqual({ basis: 'reported', count: 6 });
    const bare = stub(() => Response.json({ embeddings: { float: [floats(0), floats(1)] } }));
    const unbilled = await embedMany(cohere(bare.fetch), ['a', 'b']);
    if (isFailure(unbilled)) throw new Error(unbilled.message);
    expect(unbilled.usage.tokens).toEqual({ basis: 'unknown' });
  });

  // The wanted type missing from the answer (e.g. float only) must not be mistaken for vectors.
  it('an answer without the requested embedding type is InvalidOutput', async () => {
    const { fetch } = stub(() => answerWith('float', floats));
    const result = await embedMany(cohere(fetch, { dimensions: SIZE, quantization: 'int8' }), ['a', 'b']);
    expect(isFailure(result) && result.code).toBe('embeddings.invalid_output');
  });

  // The v3 models have no output_dimension, so asking for a size is refused before any request.
  it('a v3 model refuses a smaller size', () => {
    const model = createCohereModel({ id: 'embed-english-v3.0', apiKey: 'key' });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model, { dimensions: 512 });
    expect(isFailure(embedder) && embedder.code).toBe('embeddings.unsupported_input');
  });
});
