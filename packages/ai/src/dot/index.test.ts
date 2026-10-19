/**
 * The `vectorIndex` Dot plugin: a feature gets an embedder and an index at
 * boot, resolved ONCE from the env thunk; with nothing configured the app
 * still boots and both services say so; tests inject the runtime and the
 * provider and never pick real Qdrant.
 */
import { describe, expect, it, vi } from 'vitest';

import { defineApp } from '@arki/dot/plugin';
import { orThrow } from '@arki/failure';

import { createEmbeddingRuntime } from '../embeddings/runtime';
import { MockVectorProvider } from '../vector-search/providers/mock';
import { vectorIndex } from './index';

type Payload = { userId: string; kind: 'item'; model: string; dimensions: number };

describe('vectorIndex()', () => {
  it('boots an embedder and a mock index from the env thunk, reading it once', async () => {
    const env = vi.fn(() => ({ EMBEDDING_PROVIDER: 'mock', EMBEDDING_DIMENSIONS: '4' }));
    const app = await orThrow(
      defineApp('vi-mock')
        .use(vectorIndex<Payload>({ collection: 'test', payloadIndexes: ['userId', 'kind'], env }))
        .boot(),
    );

    expect(env).toHaveBeenCalledTimes(1);
    const index = app.services.vectorIndex;
    expect(index.provider).toBeInstanceOf(MockVectorProvider);
    expect(index.durable).toBe(false);
    // The index is sized by the runtime's space, so stored and query vectors agree.
    expect(index.provider?.space).toMatchObject({ provider: 'fake', dimensions: 4 });
    const embedding = await app.services.embedder.embedQuery('q');
    expect(embedding?.vector).toHaveLength(4);
  });

  it('boots with no provider configured: index provider null, embedder answers null', async () => {
    const app = await orThrow(
      defineApp('vi-none')
        .use(vectorIndex<Payload>({ collection: 'test', payloadIndexes: ['userId'], env: () => ({}) }))
        .boot(),
    );

    expect(app.services.vectorIndex).toEqual({ provider: null, durable: false });
    await expect(app.services.embedder.embedQuery('q')).resolves.toBeNull();
  });

  it('takes an injected runtime and provider, never touching env', async () => {
    const env = vi.fn(() => ({ QDRANT_URL: 'http://q:6333' }));
    const runtime = await createEmbeddingRuntime({ EMBEDDING_PROVIDER: 'mock' });
    if (!runtime) throw new Error('mock runtime expected');
    const space = {
      provider: 'fake',
      model: runtime.selection.model,
      dimensions: runtime.selection.dimensions,
      normalized: false,
      quantization: 'float32',
      instructionVersion: 0,
    } as const;
    const provider = new MockVectorProvider<Payload>({ space });
    const app = await orThrow(
      defineApp('vi-injected')
        .use(
          vectorIndex<Payload>({
            collection: 'test',
            payloadIndexes: ['userId'],
            env,
            runtime,
            provider,
            durable: true,
          }),
        )
        .boot(),
    );

    expect(app.services.vectorIndex.provider).toBe(provider);
    expect(app.services.vectorIndex.durable).toBe(true);
    expect(app.services.embedder.runtime).toBe(runtime);
    expect(env).toHaveBeenCalledTimes(1); // the thunk is read, but nothing of it is used
  });
});
