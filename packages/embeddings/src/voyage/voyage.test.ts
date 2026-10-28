import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import type { EmbedderOptions } from '../embedder.js';
import { embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { createVoyageModel } from './index.js';

/** Envelope shapes follow https://docs.voyageai.com/reference/embeddings-api (data[].index, usage.total_tokens). */
const fixture = (name: string): string => readFileSync(new URL(`__fixtures__/${name}`, import.meta.url), 'utf8');
const TWO = fixture('embeddings-two.json');
const REORDERED = fixture('embeddings-reordered.json');

const SIZE = 256;

/** The fixture with each row's vector replaced by `make(index)`, so rows match the 256-dim space. */
function withVectors(raw: string, make: (index: number) => number[]): Response {
  const parsed: unknown = JSON.parse(raw);
  const data = is(parsed, recordSchema) && Array.isArray(parsed['data']) ? parsed['data'] : [];
  const rows = data.map((row: unknown) => {
    const index = is(row, recordSchema) && typeof row['index'] === 'number' ? row['index'] : 0;
    return { ...(is(row, recordSchema) ? row : {}), embedding: make(index) };
  });
  return Response.json({ ...(is(parsed, recordSchema) ? parsed : {}), data: rows });
}

const floats = (index: number): number[] => Array.from({ length: SIZE }, (_, at) => (at === index ? 1 : 0));
const bytes = (index: number): number[] => Array.from({ length: SIZE / 8 }, (_, at) => (at === 0 ? index + 1 : 0));
const signed = (index: number): number[] => Array.from({ length: SIZE }, (_, at) => (at === 0 ? index + 1 : 3));

function stub(answer: () => Response) {
  const bodies: unknown[] = [];
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    bodies.push(typeof init.body === 'string' ? JSON.parse(init.body) : undefined);
    return Promise.resolve(answer());
  });
  return { fetch, bodies };
}

function voyage(fetch: ReturnType<typeof stub>['fetch'], options?: EmbedderOptions) {
  const model = createVoyageModel({ apiKey: 'key', fetch });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model, options ?? { dimensions: SIZE });
  if (isFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

describe('./voyage', () => {
  // Voyage prepends its own prompt from input_type; a wrong or missing value silently hurts recall.
  it('maps purpose to the provider field', async () => {
    const { fetch, bodies } = stub(() => withVectors(TWO, floats));
    const embedder = voyage(fetch);
    orThrow(await embedMany(embedder, ['a', 'b'], { purpose: 'query' }));
    orThrow(await embedMany(embedder, ['a', 'b'], { purpose: 'document' }));
    orThrow(await embedMany(embedder, ['a', 'b'], { purpose: 'clustering' }));
    orThrow(await embedMany(embedder, ['a', 'b']));
    expect(bodies.map(body => (is(body, recordSchema) ? body['input_type'] : 'missing'))).toEqual([
      'query',
      'document',
      null,
      null,
    ]);
  });

  // Each dtype must be asked by its Voyage name, and the typed array must hold what came back unchanged.
  it('quantized output round-trips', async () => {
    const int8 = stub(() => withVectors(TWO, signed));
    const asInt8 = await embedMany(voyage(int8.fetch, { dimensions: SIZE, quantization: 'int8' }), ['a', 'b']);
    if (isFailure(asInt8)) throw new Error(asInt8.message);
    expect(int8.bodies[0]).toMatchObject({ output_dtype: 'int8', output_dimension: SIZE });
    expect(asInt8.vectors[1]).toBeInstanceOf(Int8Array);
    expect(asInt8.vectors[1]?.[0]).toBe(2);

    const binary = stub(() => withVectors(TWO, bytes));
    const asBinary = await embedMany(voyage(binary.fetch, { dimensions: SIZE, quantization: 'binary' }), ['a', 'b']);
    if (isFailure(asBinary)) throw new Error(asBinary.message);
    // Signed `binary` is offset-encoded and would be wrong in a Uint8Array, so we ask for `ubinary`.
    expect(binary.bodies[0]).toMatchObject({ output_dtype: 'ubinary' });
    expect(asBinary.vectors[0]).toBeInstanceOf(Uint8Array);
    expect(asBinary.vectors[0]).toHaveLength(SIZE / 8);
    expect(asBinary.vectors[1]?.[0]).toBe(2);
  });

  // Voyage cuts over-long text silently by default; the library default is to fail loudly instead.
  it('truncation is false unless asked', async () => {
    const { fetch, bodies } = stub(() => withVectors(TWO, floats));
    const embedder = voyage(fetch);
    orThrow(await embedMany(embedder, ['a', 'b']));
    orThrow(await embedMany(embedder, ['a', 'b'], { onTooLong: 'truncate' }));
    expect(bodies.map(body => (is(body, recordSchema) ? body['truncation'] : 'missing'))).toEqual([false, true]);
  });

  // A row at the wrong position would attach a vector to the wrong document without any error.
  it('a reordered or missing index is InvalidOutput', async () => {
    const reordered = stub(() => withVectors(REORDERED, floats));
    const sorted = await embedMany(voyage(reordered.fetch), ['a', 'b']);
    if (isFailure(sorted)) throw new Error(sorted.message);
    // Rows answered out of order are put back by index.
    expect(sorted.vectors[1]?.[1]).toBe(1);

    const missing = stub(() =>
      Response.json({
        data: [
          { embedding: floats(0), index: 0 },
          { embedding: floats(1), index: 5 },
        ],
        usage: { total_tokens: 1 },
      }),
    );
    const result = await embedMany(voyage(missing.fetch), ['a', 'b']);
    expect(isFailure(result) && result.code).toBe('embeddings.invalid_output');
  });

  it('429 is RateLimited', async () => {
    const { fetch } = stub(
      () => new Response('{"detail":"slow down"}', { status: 429, headers: { 'retry-after': '3' } }),
    );
    const result = await embedMany(voyage(fetch), ['a']);
    expect(isFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect(isFailure(result) && result.data).toEqual({ retryAfterMs: 3000 });
  });

  // A bad key is the caller's setup mistake, not a retryable outage.
  it('401 is ConfigurationFailure, 404 is unknown-model, a network error is unreachable', async () => {
    const denied = await embedMany(voyage(stub(() => new Response('{}', { status: 401 })).fetch), ['a']);
    expect(isFailure(denied) && denied.code).toBe('embeddings.configuration');
    const missing = await embedMany(voyage(stub(() => new Response('{}', { status: 404 })).fetch), ['a']);
    expect(isFailure(missing) && missing.data).toEqual({ model: 'voyage-3.5', reason: 'unknown-model' });
    const refused = vi.fn((): Promise<Response> => Promise.reject(new TypeError('fetch failed')));
    const down = await embedMany(voyage(refused), ['a']);
    expect(isFailure(down) && down.data).toEqual({ model: 'voyage-3.5', reason: 'unreachable' });
  });

  // With truncation off, Voyage answers 400 for a long text; the caller needs InputTooLong, not a raw error.
  it('a 400 about length is InputTooLong', async () => {
    const { fetch } = stub(
      () => new Response('{"detail":"Input text is longer than the context length"}', { status: 400 }),
    );
    const result = await embedMany(voyage(fetch), ['a']);
    expect(isFailure(result) && result.code).toBe('embeddings.input_too_long');
  });

  // The token count Voyage bills is exact; it beats any estimate for budgets.
  it('reports usage.total_tokens as reported tokens', async () => {
    const { fetch } = stub(() => withVectors(TWO, floats));
    const batch = await embedMany(voyage(fetch), ['a', 'b']);
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.usage.tokens).toEqual({ basis: 'reported', count: 10 });
  });

  // An id outside the facts table has unknown limits, so refuse it rather than guess.
  it('an unknown model id is ConfigurationFailure', () => {
    const result = createVoyageModel({ id: 'voyage-nope', apiKey: 'key' });
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
  });
});
