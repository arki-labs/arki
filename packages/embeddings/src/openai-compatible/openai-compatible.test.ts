import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import type { FetchLike } from '../http.js';
import { embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { InputTooLong, InvalidOutput, RateLimited } from '../failures.js';
import { NO_INSTRUCTION, QWEN3_INSTRUCTION } from '../instructions.js';
import { createOpenAICompatibleModel } from './index.js';

/** The reply shape of an OpenAI-compatible server (Nebius Token Factory), vectors cut to 4 dims. */
const fixture = (name: string): string => readFileSync(new URL(`__fixtures__/${name}`, import.meta.url), 'utf8');
const REORDERED = fixture('embeddings-reordered.json');
const NO_USAGE = fixture('embeddings-no-usage.json');

function nebius(fetch: FetchLike) {
  const model = createOpenAICompatibleModel({
    id: 'Qwen/Qwen3-Embedding-8B',
    baseURL: 'https://api.tokenfactory.nebius.com/v1/',
    apiKey: 'key',
    dimensions: 4,
    label: 'nebius',
    fetch,
  });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model);
  if (isFailure(embedder)) throw new Error(embedder.message);
  return { model, embedder };
}

/** Answers the reordered fixture with its `data` rows replaced. */
const withRows = (rows: readonly unknown[]): Response =>
  Response.json({ ...(JSON.parse(REORDERED) as Record<string, unknown>), data: rows });

const row = (index: number) => ({ object: 'embedding', index, embedding: [1, 0, 0, 0] });

describe('./openai-compatible', () => {
  it('posts model and input[] to baseURL/embeddings with a bearer key', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(new Response(REORDERED)));
    const { embedder } = nebius(fetch);
    orThrow(await embedMany(embedder, ['a', 'b', 'c']));
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.tokenfactory.nebius.com/v1/embeddings');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')).toEqual({
      model: 'Qwen/Qwen3-Embedding-8B',
      input: ['a', 'b', 'c'],
    });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer key');
  });

  // Servers may answer rows in any order; `index` is the only link back to the input.
  it('reorders by index', async () => {
    const { embedder } = nebius(() => Promise.resolve(new Response(REORDERED)));
    const batch = await embedMany(embedder, ['first', 'second', 'third']);
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.vectors.map(vector => [...vector])).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ]);
    expect(batch.usage.tokens).toEqual({ basis: 'reported', count: 9 });
  });

  // A shifted vector would attach to the wrong document and corrupt the index silently.
  it('duplicate or missing index is InvalidOutput', async () => {
    for (const rows of [
      [row(0), row(0), row(2)],
      [row(0), row(1)],
      [row(0), row(1), row(3)],
    ]) {
      const { embedder } = nebius(() => Promise.resolve(withRows(rows)));
      const batch = await embedMany(embedder, ['a', 'b', 'c']);
      expect(InvalidOutput.is(batch)).toBe(true);
    }
  });

  // A 400 does not say which input is too long; the adapter names the one with the most tokens.
  it('a 400 about length is InputTooLong naming the longest input', async () => {
    const { embedder } = nebius(() =>
      Promise.resolve(new Response('{"error":"input exceeds the maximum context length"}', { status: 400 })),
    );
    const batch = await embedMany(embedder, ['b', 'a'.repeat(40)]);
    expect(InputTooLong.is(batch)).toBe(true);
    if (InputTooLong.is(batch))
      expect(batch.data).toMatchObject({ index: 1, tokens: { basis: 'estimated', count: 10 } });
  });

  it('maps 429 with retry-after', async () => {
    const { embedder } = nebius(() =>
      Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '3' } })),
    );
    const batch = await embedMany(embedder, ['a']);
    expect(RateLimited.is(batch)).toBe(true);
    if (RateLimited.is(batch)) expect(batch.data.retryAfterMs).toBe(3000);
  });

  it('usage absent is unknown', async () => {
    const { embedder } = nebius(() => Promise.resolve(new Response(NO_USAGE)));
    const batch = await embedMany(embedder, ['a']);
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.usage.tokens).toEqual({ basis: 'unknown' });
  });

  // The instruction is part of the space: a corpus embedded without a prefix must keep querying without one.
  it('Qwen3 ids get the Qwen3 instruction unless one is passed', () => {
    const base = { baseURL: 'http://localhost:8080', dimensions: 4 };
    const qwen = createOpenAICompatibleModel({ ...base, id: 'Qwen/Qwen3-Embedding-8B' });
    const plain = createOpenAICompatibleModel({ ...base, id: 'Qwen/Qwen3-Embedding-8B', instruction: NO_INSTRUCTION });
    const other = createOpenAICompatibleModel({ ...base, id: 'bge-m3' });
    expect(isFailure(qwen) ? undefined : qwen.instruction).toBe(QWEN3_INSTRUCTION);
    // Equal, not the same object: the options schema returns a copy of the instruction the caller passed.
    expect(isFailure(plain) ? undefined : plain.instruction).toEqual(NO_INSTRUCTION);
    expect(isFailure(other) ? undefined : other.instruction).toBe(NO_INSTRUCTION);
  });

  it('a bad baseURL or dimensions is ConfigurationFailure, before any fetch', () => {
    const fetch = vi.fn<FetchLike>();
    expect(isFailure(createOpenAICompatibleModel({ id: 'm', baseURL: 'nebius', dimensions: 4, fetch }))).toBe(true);
    expect(isFailure(createOpenAICompatibleModel({ id: 'm', baseURL: 'http://x', dimensions: 0, fetch }))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
