import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import type { EmbedderOptions } from '../embedder.js';
import { embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { createJinaModel } from './index.js';

/** Envelope shapes follow https://api.jina.ai/openapi.json (data[].index, usage.total_tokens). */
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

function stub(answer: () => Response) {
  const bodies: unknown[] = [];
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    bodies.push(typeof init.body === 'string' ? JSON.parse(init.body) : undefined);
    return Promise.resolve(answer());
  });
  return { fetch, bodies };
}

function jina(fetch: ReturnType<typeof stub>['fetch'], options?: EmbedderOptions) {
  const model = createJinaModel({ apiKey: 'key', fetch });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model, options ?? { dimensions: SIZE });
  if (isFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

const field = (body: unknown, name: string): unknown => (is(body, recordSchema) ? body[name] : 'missing');

describe('./jina', () => {
  // Jina picks a different adapter per task; a wrong or missing value silently hurts recall.
  it('maps purpose to the task field', async () => {
    const pairs = [
      ['query', 'retrieval.query'],
      ['document', 'retrieval.passage'],
      ['similarity', 'text-matching'],
      ['classification', 'classification'],
      ['clustering', 'separation'],
    ] as const;
    for (const [purpose, task] of pairs) {
      const { fetch, bodies } = stub(() => withVectors(TWO, floats));
      await embedMany(jina(fetch), ['a', 'b'], { purpose });
      expect(field(bodies[0], 'task')).toBe(task);
    }
    const none = stub(() => withVectors(TWO, floats));
    await embedMany(jina(none.fetch), ['a', 'b']);
    expect(is(none.bodies[0], recordSchema) && 'task' in none.bodies[0]).toBe(false);
  });

  // Asking for a smaller size must reach Jina, or the vectors would not fit the space the caller keyed on.
  it('sends the Matryoshka size only when it differs from native', async () => {
    const small = stub(() => withVectors(TWO, floats));
    await embedMany(jina(small.fetch), ['a', 'b']);
    expect(small.bodies[0]).toMatchObject({ model: 'jina-embeddings-v3', dimensions: SIZE, normalized: true });
    const native = stub(() => withVectors(TWO, floats));
    const full = jina(native.fetch, {});
    await full.embed(['a', 'b'], {});
    expect(is(native.bodies[0], recordSchema) && 'dimensions' in native.bodies[0]).toBe(false);
  });

  // Jina errors on a long text by default only when truncate is false; the library default is to fail loudly.
  it('truncate is false unless asked', async () => {
    const { fetch, bodies } = stub(() => withVectors(TWO, floats));
    const embedder = jina(fetch);
    await embedMany(embedder, ['a', 'b']);
    await embedMany(embedder, ['a', 'b'], { onTooLong: 'truncate' });
    expect(bodies.map(body => field(body, 'truncate'))).toEqual([false, true]);
  });

  // A row at the wrong position would attach a vector to the wrong document without any error.
  it('rows are put back by index, a missing index is InvalidOutput', async () => {
    const reordered = stub(() => withVectors(REORDERED, floats));
    const sorted = await embedMany(jina(reordered.fetch), ['a', 'b']);
    if (isFailure(sorted)) throw new Error(sorted.message);
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
    const result = await embedMany(jina(missing.fetch), ['a', 'b']);
    expect(isFailure(result) && result.code).toBe('embeddings.invalid_output');
  });

  it('429 is RateLimited', async () => {
    const { fetch } = stub(
      () => new Response('{"detail":"slow down"}', { status: 429, headers: { 'retry-after': '3' } }),
    );
    const result = await embedMany(jina(fetch), ['a']);
    expect(isFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect(isFailure(result) && result.data).toEqual({ retryAfterMs: 3000 });
  });

  // A bad key is the caller's setup mistake, not a retryable outage.
  it('401 is ConfigurationFailure, 404 is unknown-model, a network error is unreachable', async () => {
    const denied = await embedMany(jina(stub(() => new Response('{}', { status: 401 })).fetch), ['a']);
    expect(isFailure(denied) && denied.code).toBe('embeddings.configuration');
    const missing = await embedMany(jina(stub(() => new Response('{}', { status: 404 })).fetch), ['a']);
    expect(isFailure(missing) && missing.data).toEqual({ model: 'jina-embeddings-v3', reason: 'unknown-model' });
    const refused = vi.fn((): Promise<Response> => Promise.reject(new TypeError('fetch failed')));
    const down = await embedMany(jina(refused), ['a']);
    expect(isFailure(down) && down.data).toEqual({ model: 'jina-embeddings-v3', reason: 'unreachable' });
  });

  // With truncate off, Jina answers 400 for a long text; the caller needs InputTooLong, not a raw error.
  it('a 400 about length is InputTooLong', async () => {
    const { fetch } = stub(
      () => new Response('{"detail":"Input is too long for the model context length"}', { status: 400 }),
    );
    const result = await embedMany(jina(fetch), ['a']);
    expect(isFailure(result) && result.code).toBe('embeddings.input_too_long');
  });

  // The token count Jina bills is exact; it beats any estimate for budgets.
  it('reports usage.total_tokens as reported tokens', async () => {
    const { fetch } = stub(() => withVectors(TWO, floats));
    const batch = await embedMany(jina(fetch), ['a', 'b']);
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.usage.tokens).toEqual({ basis: 'reported', count: 12 });
  });

  // An id outside the facts table has unknown limits, so refuse it rather than guess.
  it('an unknown model id or an empty key is ConfigurationFailure', () => {
    const unknown = createJinaModel({ id: 'jina-nope', apiKey: 'key' });
    expect(isFailure(unknown) && unknown.code).toBe('embeddings.configuration');
    const empty = createJinaModel({ apiKey: '' });
    expect(isFailure(empty) && empty.code).toBe('embeddings.configuration');
  });
});
