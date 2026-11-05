// What an operator reads when embedding or reranking breaks: one span per model call, the failure
// code, and an error status only for a fault (model down, bad output), never for a refused input or a
// rate limit the caller retries. The input texts, the query, the documents, the vectors and the API
// key must never be attributes, whatever `withTelemetry` records in logs.
// The servers are remote (paid) models, so their HTTP answers are scripted; the provider modules,
// the embedder and the reranker are the real ones.
import { SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { isFailure, orThrow } from '@arki/failure';
import { captureSpans } from '@arki/testing/otel';

import type { FetchLike } from './http.js';
import { embeddings } from './dot/index.js';
import { createEmbedder } from './embedder.js';
import { createOpenAICompatibleModel } from './openai-compatible/index.js';
import { rerank } from './rerank/index.js';
import { createSparseModel } from './sparse/index.js';
import { createTeiReranker } from './tei/index.js';

/** The part of a TEI `/rerank` request the scripted server reads: one score per text it was sent. */
const teiRequestSchema = z.object({ texts: z.array(z.string()) });

const SECRETS = ['ana@example.com', 'sk-secret-token', 'what is my password', '0.25'];

/** Every attribute an embeddings span may carry. Anything else is a leak. Dot's own spans are not checked here. */
const ALLOWED = new Set([
  'embeddings.provider',
  'embeddings.model',
  'embeddings.inputs',
  'embeddings.documents',
  'embeddings.dimensions',
  'failure.code',
]);

function expectNoContent(spans: ReturnType<typeof captureSpans>): void {
  for (const span of spans.finished.filter(finished => finished.name.startsWith('embeddings.'))) {
    expect(Object.keys(span.attributes).filter(key => !ALLOWED.has(key))).toEqual([]);
    const text = JSON.stringify(span.attributes);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  }
}

/** An OpenAI-compatible server that answers each request with the next scripted response. */
function scripted(...answers: (() => Response)[]): FetchLike {
  return () => {
    const next = answers.shift();
    if (next === undefined) throw new Error('no scripted answer left');
    return Promise.resolve(next());
  };
}

const vectors = (count: number) => () =>
  Response.json({
    data: Array.from({ length: count }, (_, index) => ({ index, embedding: [0.25, 0.5, 0.75, 1] })),
    usage: { prompt_tokens: 3 },
  });

const embedderOver = (fetch: FetchLike) =>
  orThrow(
    createEmbedder(
      orThrow(
        createOpenAICompatibleModel({
          id: 'acme-embed',
          baseURL: 'https://embed.example.test/v1',
          apiKey: 'sk-secret-token',
          dimensions: 4,
          fetch,
        }),
      ),
    ),
  );

describe('embeddings spans', () => {
  it('each embed call is one embeddings.embed span with bounded attributes, and counted', async () => {
    using spans = captureSpans();
    const embedder = embedderOver(scripted(vectors(2)));
    const batch = await embedder.embed(['ana@example.com', 'what is my password'], {});

    expect(isFailure(batch)).toBe(false);
    const span = spans.named('embeddings.embed');
    expect(span.attributes).toEqual({
      'embeddings.provider': 'openai-compatible',
      'embeddings.model': 'acme-embed',
      'embeddings.inputs': 2,
      'embeddings.dimensions': 4,
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expectNoContent(spans);
    const collected = await spans.collectMetrics();
    const counter = collected.find(metric => metric.descriptor.name === 'embeddings.operations');
    expect(counter?.dataPoints.map(point => [point.attributes, point.value])).toEqual([
      [{ operation: 'embed', provider: 'openai-compatible', outcome: 'success' }, 1],
    ]);
  });

  it('a model that is down is a fault; a rate limit is not', async () => {
    using spans = captureSpans();
    const embedder = embedderOver(
      scripted(
        () => new Response('upstream down', { status: 503 }),
        () => new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
      ),
    );

    expect(isFailure(await embedder.embed(['ana@example.com'], {}))).toBe(true);
    expect(isFailure(await embedder.embed(['ana@example.com'], {}))).toBe(true);

    const [down, limited] = spans.finished;
    expect(down?.attributes['failure.code']).toBe('embeddings.model_unavailable');
    expect(down?.status.code).toBe(SpanStatusCode.ERROR);
    expect(limited?.attributes['failure.code']).toBe('embeddings.rate_limited');
    expect(limited?.status.code).toBe(SpanStatusCode.UNSET);
    expectNoContent(spans);
  });

  it('each reranker request is one embeddings.rerank span; rerank() splits a long list into several', async () => {
    using spans = captureSpans();
    const reranker = orThrow(
      createTeiReranker({
        id: 'acme-rerank',
        baseURL: 'https://rerank.example.test',
        apiKey: 'sk-secret-token',
        maxDocuments: 2,
        maxInputTokens: 512,
        fetch: (_url, init) => {
          const sent = teiRequestSchema.parse(JSON.parse(z.string().parse(init.body)));
          return Promise.resolve(Response.json(sent.texts.map((_, index) => ({ index, score: 0.25 }))));
        },
      }),
    );
    const documents = ['ana@example.com', 'second', 'third'];
    const ranked = await rerank(reranker, 'what is my password', documents, { text: document => document });

    expect(isFailure(ranked)).toBe(false);
    expect(spans.finished.map(span => span.name)).toEqual(['embeddings.rerank', 'embeddings.rerank']);
    expect(spans.finished.map(span => span.attributes['embeddings.documents'])).toEqual([2, 1]);
    expect(spans.finished[0]?.attributes['embeddings.provider']).toBe('tei');
    expectNoContent(spans);
  });

  it('a sparse embed is one embeddings.sparse_embed span; a refused batch is not a fault', async () => {
    using spans = captureSpans();
    const sparse = orThrow(
      createSparseModel({
        id: 'acme-splade',
        baseURL: 'https://sparse.example.test',
        dimensions: 30_522,
        maxBatch: 1,
        fetch: () => Promise.resolve(Response.json([[{ index: 7, value: 0.25 }]])),
      }),
    );

    expect(isFailure(await sparse.embed(['ana@example.com'], {}))).toBe(false);
    expect(isFailure(await sparse.embed(['ana@example.com', 'two'], {}))).toBe(true);

    const [ok, refused] = spans.finished;
    expect(ok?.name).toBe('embeddings.sparse_embed');
    expect(ok?.attributes['failure.code']).toBeUndefined();
    expect(refused?.attributes['failure.code']).toBe('embeddings.unsupported_input');
    expect(refused?.status.code).toBe(SpanStatusCode.UNSET);
    expectNoContent(spans);
  });

  it('in a Dot app the embed span nests under the usecase span that called it', async () => {
    using spans = captureSpans();
    const plugin = embeddings({ model: embedderOver(scripted(vectors(1))) });
    const search = defineFeature('search')
      .needs({ embedder: plugin.provides.embedder })
      .usecases({
        index:
          ({ embedder }) =>
          (text: string) =>
            embedder.embed([text], {}),
      })
      .entrypoints();
    const app = orThrow(await defineApp('emb-spans').infra(plugin).features([search]).start());

    const batch = await app.services['search.usecases'].index('ana@example.com');
    orThrow(await app.dispose());

    expect(isFailure(batch)).toBe(false);
    expect(spans.named('embeddings.embed').parent?.name).toBe('feature.search.index');
    expectNoContent(spans);
  });
});
