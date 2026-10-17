// Wrapper overhead: @arki/embeddings `embedMany` against a raw `fetch` and the AI SDK `embedMany`.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every row talks to the same in-process stub server, so no network or model time is measured:
// what is left is each library's own work (request building, JSON parsing, chunking, validation).
// The stub answers real qwen3-embedding:0.6b vectors recorded from Ollama (1024 dims), cycled by
// position, so every row must return exactly the same vectors for the same inputs.

import { readFileSync } from 'node:fs';

import { createOpenAI } from '@ai-sdk/openai';
import { embedMany as aiEmbedMany } from 'ai';

import type { CaseBuilder, CaseSpec } from '@arki/bench';
import type { EmbeddingModel, NativeRequest } from '@arki/embeddings';
import { compare, defineSuite, scenario } from '@arki/bench';
import { createEmbedder, embedMany, isEmbedFailure } from '@arki/embeddings';
import { createOllamaModel } from '@arki/embeddings/ollama';

const STUB = 'http://stub.local';

const recorded = JSON.parse(
  readFileSync(new URL('../src/ollama/__fixtures__/embed-two.json', import.meta.url), 'utf8'),
) as { embeddings: number[][]; model: string };
const tags = readFileSync(new URL('../src/ollama/__fixtures__/tags.json', import.meta.url), 'utf8');

/** The recorded vector for position `index` of a batch. Chunks are multiples of 2, so parity is global. */
const vectorAt = (index: number): number[] => recorded.embeddings[index % 2] ?? [];

/** Response bodies are built once per (shape, count): the stub's own cost stays out of the comparison. */
const bodies = new Map<string, string>();
function body(shape: 'ollama' | 'openai', count: number): string {
  const key = `${shape}:${count}`;
  const cached = bodies.get(key);
  if (cached !== undefined) return cached;
  const vectors = Array.from({ length: count }, (_, index) => vectorAt(index));
  const text =
    shape === 'ollama'
      ? JSON.stringify({ model: recorded.model, embeddings: vectors, load_duration: 0, prompt_eval_count: count * 2 })
      : JSON.stringify({
          object: 'list',
          data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: count * 2, total_tokens: count * 2 },
        });
  bodies.set(key, text);
  return text;
}

/** How many inputs a request carries: Ollama sends `input`, OpenAI sends `input` too. */
function countInputs(init: RequestInit | undefined): number {
  const parsed: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  const input = typeof parsed === 'object' && parsed !== null && 'input' in parsed ? parsed.input : undefined;
  return Array.isArray(input) ? input.length : 1;
}

/** Answers Ollama's `/api/tags` and `/api/embed` and OpenAI's `/v1/embeddings` from the recording. */
function stubFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers = { 'content-type': 'application/json' };
  if (url.endsWith('/api/tags')) return Promise.resolve(new Response(tags, { headers }));
  const shape = url.endsWith('/api/embed') ? 'ollama' : 'openai';
  return Promise.resolve(new Response(body(shape, countInputs(init)), { headers }));
}

// ---- @arki/embeddings: the Ollama record (qwen3 facts: 64 inputs per request, 2 chunks in flight).
const ollamaModel = createOllamaModel({ baseURL: STUB, fetch: stubFetch });
if (isEmbedFailure(ollamaModel)) throw new Error(ollamaModel.message);
const arki = createEmbedder(ollamaModel);
if (isEmbedFailure(arki)) throw new Error(arki.message);

// ---- AI SDK: @ai-sdk/openai pointed at the same stub, SDK retries off.
const openai = createOpenAI({ apiKey: 'sk-bench', baseURL: `${STUB}/v1`, fetch: stubFetch });
const aiModel = openai.embeddingModel('text-embedding-3-small');

/** Raw `fetch`: one `/api/embed` request for the whole batch, the body parsed and nothing checked. */
async function rawFetch(texts: readonly string[]): Promise<unknown> {
  const response = await stubFetch(`${STUB}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-embedding:0.6b', input: texts, truncate: false }),
  });
  const parsed: unknown = await response.json();
  return typeof parsed === 'object' && parsed !== null && 'embeddings' in parsed ? parsed.embeddings : undefined;
}

/** FNV-1a over the float32 bits of every vector: equal fingerprints mean bit-identical float32 output. */
function fingerprint(vectors: unknown): string {
  if (!Array.isArray(vectors)) return 'not an array';
  let hash = 0x81_1C_9D_C5;
  let dims = 0;
  for (const vector of vectors) {
    if (!(vector instanceof Float32Array) && !Array.isArray(vector)) return 'not a vector';
    const floats = vector instanceof Float32Array ? vector : Float32Array.from(vector, Number);
    dims = floats.length;
    for (const word of new Uint32Array(floats.buffer, floats.byteOffset, floats.length)) {
      hash = Math.imul(hash ^ word, 0x01_00_01_93) >>> 0;
    }
  }
  return `${vectors.length}x${dims}:${hash.toString(16)}`;
}

/** Three different text sets of `size` inputs, so timing cycles through varying inputs. */
function batches(size: number): string[][] {
  return [0, 1, 2].map(set => Array.from({ length: size }, (_, index) => `set ${set} document ${index}: ${'lorem '.repeat(8)}`));
}

function rows(c: CaseBuilder<string[]>): Record<string, CaseSpec<string[], unknown, unknown>> {
  return {
    arki: c({
      label: '@arki/embeddings embedMany (./ollama)',
      package: '@arki/embeddings',
      run: async texts => {
        const batch = await embedMany(arki, texts);
        if (isEmbedFailure(batch)) throw new Error(batch.message);
        return batch.vectors;
      },
      normalize: fingerprint,
    }),
    fetch: c({
      label: 'raw fetch to /api/embed (no checks)',
      run: rawFetch,
      normalize: fingerprint,
    }),
    aiSdk: c({
      label: 'AI SDK embedMany (@ai-sdk/openai)',
      package: 'ai',
      run: async texts => {
        const { embeddings } = await aiEmbedMany({ model: aiModel, values: texts, maxRetries: 0 });
        return embeddings;
      },
      normalize: fingerprint,
    }),
  };
}

const expected = (texts: readonly string[]): string => fingerprint(texts.map((_, index) => vectorAt(index)));

function group(size: number) {
  return compare<string[]>({
    id: `embed-many-${size}`,
    title: `embedMany, batch of ${size} (1024 dims, recorded vectors)`,
    contract: {
      id: `embeddings-overhead-${size}/v1`,
      description: 'the recorded qwen3 vectors, bit-identical as float32, in input order',
    },
    inputs: batches(size),
    expected,
    baseline: 'arki',
    mode: 'async',
    cases: c => rows(c),
  });
}

// ---- Validation alone: the embedder over a model whose native call hands back parsed vectors.
const parsed256 = Array.from({ length: 256 }, (_, index) => vectorAt(index));
const inMemory: EmbeddingModel = {
  ...ollamaModel,
  maxBatch: 256,
  embedTexts: (_request: NativeRequest) => Promise.resolve({ vectors: parsed256, tokens: { basis: 'unknown' } }),
};
const inMemoryEmbedder = createEmbedder(inMemory);
if (isEmbedFailure(inMemoryEmbedder)) throw new Error(inMemoryEmbedder.message);
const texts256 = batches(256)[0] ?? [];

export default defineSuite({
  id: '@arki/embeddings',
  intro:
    'Each row embeds the same texts against the same in-process stub server, which answers vectors recorded from a real Ollama (`qwen3-embedding:0.6b`, 1024 dims). No network and no model time: the numbers are each library’s own work. Each table only ranks rows that returned bit-identical float32 vectors.',
  notes: [
    '`@arki/embeddings` packs inputs by the model’s limits: qwen3 is 64 inputs per request, so a batch of 256 is 4 requests (2 in flight). The raw `fetch` row sends one request for the whole batch; the AI SDK row sends one request (its OpenAI limit is 2048).',
    '`@arki/embeddings` also checks every response (count, dimensions, finite values, non-zero norm) and converts each vector to a `Float32Array`. The raw `fetch` row checks nothing and returns plain arrays.',
    'The AI SDK row speaks the OpenAI wire format to the same stub, with the same vectors. Its retries are off (`maxRetries: 0`).',
    'Hashing (the cache key of `withCache`) has no group yet: `withCache` arrives in slice 2.',
  ],
  groups: [
    group(1),
    group(32),
    group(256),
    scenario({
      id: 'validation-256',
      title: 'Validation and conversion alone, 256 × 1024 (no I/O, no JSON)',
      note: 'The embedder over a model whose native call returns already-parsed vectors, next to the bare conversion to `Float32Array`. The gap is the cost of the checks. Different work, so no ratio.',
      mode: 'async',
      cases: {
        validated: {
          label: '@arki/embeddings embedder.embed (checks + conversion)',
          run: () => inMemoryEmbedder.embed(texts256, {}),
        },
        conversion: {
          label: 'Float32Array.from per vector (conversion only)',
          run: () => parsed256.map(vector => Float32Array.from(vector)),
        },
      },
    }),
  ],
});
