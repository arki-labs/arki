// Cross-runtime smoke test. Runs under Node, Bun and Deno via `bun run test:runtimes`, and is
// bundled for the browser and Hermes targets. It drives the root with the fake embedder and the
// `./ollama` record against an in-process fetch stub, so no server is needed on any runtime.

import { cosine, createEmbedder, embed, embedMany, spaceId, withCache } from '../dist/index.js';
import { kvCacheStore } from '../dist/kv/index.js';
import { createOllamaModel } from '../dist/ollama/index.js';
import { createOpenAICompatibleModel } from '../dist/openai-compatible/index.js';
import { fakeEmbedder } from '../dist/testing/index.js';

/** Answers `/api/tags` and `/api/embed` the way Ollama does, with 4-dim vectors. */
async function ollamaStub(url, init) {
  if (url.endsWith('/api/tags')) {
    return new Response(JSON.stringify({ models: [{ name: 'tiny:latest', digest: 'abc123' }] }));
  }
  const { input } = JSON.parse(init.body);
  const embeddings = input.map((_, index) => [0.5, 0.5, 0.5, index % 2 === 0 ? 0.5 : -0.5]);
  return new Response(JSON.stringify({ embeddings, prompt_eval_count: input.length }));
}

/** Answers `/embeddings` the way an OpenAI-compatible server may: rows in reverse order, keyed by `index`. */
async function openAICompatibleStub(_url, init) {
  const { input } = JSON.parse(init.body);
  const data = input.map((_, index) => ({ index, embedding: [index + 1, 0, 0, 0] })).reverse();
  return new Response(JSON.stringify({ data, usage: { prompt_tokens: input.length } }));
}

async function main() {
  const fake = fakeEmbedder({ dimensions: 8, seed: 1 });
  const first = await embed(fake, 'a');
  const second = await embed(fake, 'a');

  const model = createOllamaModel({ id: 'tiny', dimensions: 4, fetch: ollamaStub });
  const ollama = createEmbedder(model);
  const batch = await embedMany(ollama, ['x', 'y', 'z']);

  const compatible = createOpenAICompatibleModel({
    id: 'tiny',
    baseURL: 'http://localhost:8080/v1',
    dimensions: 4,
    normalized: false,
    fetch: openAICompatibleStub,
  });
  const reordered = await embedMany(createEmbedder(compatible), ['p', 'q']);

  // Web Crypto keys and base64 values: what the cache needs from every runtime.
  const entries = new Map();
  const kv = { get: async key => entries.get(key), set: async (key, value) => void entries.set(key, value) };
  const cached = withCache(fakeEmbedder({ dimensions: 8, seed: 1 }), kvCacheStore(kv));
  await embed(cached, 'a');
  const hit = await embed(cached, 'a');

  const checks = [
    ['cache answers the second call', hit.usage?.cacheHits, 1],
    ['cached vector is the same vector', cosine(hit.vector, first.vector), 1],
    ['fake vector has 8 dims', first.vector?.length, 8],
    ['same text gives cosine 1', cosine(first.vector, second.vector), 1],
    ['ollama batch has 3 vectors', batch.vectors?.length, 3],
    ['ollama tokens are reported', batch.usage?.tokens.basis, 'reported'],
    ['openai-compatible puts rows back by index', reordered.vectors?.[1]?.[0], 2],
    ['ollama space carries the digest', batch.space && spaceId(batch.space), 'ollama/tiny@abc123/4/l2/f32/i0'],
  ];

  let failedChecks = 0;
  for (const [name, actual, expected] of checks) {
    if (actual === expected) continue;
    failedChecks++;
    console.log(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  const runtime =
    typeof HermesInternal !== 'undefined'
      ? 'hermes'
      : typeof Deno !== 'undefined'
        ? 'deno'
        : typeof Bun !== 'undefined'
          ? 'bun'
          : typeof window !== 'undefined'
            ? 'browser'
            : 'node';
  if (failedChecks > 0) {
    console.log(`${runtime}: ${failedChecks} smoke checks FAILED`);
    throw new Error('smoke failed');
  }
  console.log(`${runtime}: ${checks.length} smoke checks passed`);
}

await main();
