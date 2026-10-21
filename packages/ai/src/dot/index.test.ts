/**
 * The `vectorIndex` Dot plugin: a feature gets an embedder and an index at
 * boot, resolved ONCE from the env thunk; with nothing configured the app
 * still boots and both services say so; tests inject the runtime and the
 * provider and never pick real Qdrant.
 */
import { describe, expect, it, vi } from 'vitest';

import { runDoctor, runExplain } from '@arki/dot/cli';
import { defineApp } from '@arki/dot/plugin';
import { isFailure, orThrow } from '@arki/failure';

import { createEmbeddingRuntime } from '../embeddings/runtime';
import { ProviderUnavailable } from '../failures';
import { createFakeLLMProvider } from '../testing';
import { MockVectorProvider } from '../vector-search/providers/mock';
import { llm, vectorIndex } from './index';

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

describe('llm()', () => {
  const ollamaDown = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
  const ollamaUp = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ models: [{ name: 'gemma4:latest' }] })));

  it('is listed by `dot explain` as the plugin that provides `llm` (lib-gaps 28)', async () => {
    // WHY: an agent reading `dot explain --json` must see that the app depends on a model provider.
    const manifest = await runExplain(
      orThrow(
        defineApp('llm-explain')
          .use(llm({ probe: false }))
          .configure(),
      ),
    );

    expect(JSON.stringify(manifest)).toContain('"llm"');
  });

  it('fails boot with ProviderUnavailable when the probe fails, and `dot doctor` marks the plugin failed', async () => {
    // WHY: "Ollama is not running" must surface at boot as a typed, fixable failure and in
    // `dot doctor --json`, not as the first user request failing.
    const builder = defineApp('llm-down').use(llm({ provider: 'ollama', model: 'gemma4', fetch: ollamaDown }));

    const booted = await builder.boot();
    const report = await runDoctor(builder);

    expect(ProviderUnavailable.is(booted) && booted.data).toEqual({
      provider: 'ollama',
      model: 'gemma4',
      problem: 'unreachable',
    });
    expect(isFailure(report) && report.data).toMatchObject({ plugins: [{ plugin: 'llm', status: 'failed' }] });
  });

  it('boots and publishes the provider when the probe passes', async () => {
    // WHY: a healthy provider must cost the app nothing but the probe at boot.
    const app = await orThrow(
      defineApp('llm-up')
        .use(llm({ provider: 'ollama', model: 'gemma4', fetch: ollamaUp }))
        .boot(),
    );

    expect(app.services.llm).toMatchObject({ provider: 'ollama', model: 'gemma4' });
  });

  it('boots without probing when `probe: false`, and publishes an injected instance as is', async () => {
    // WHY: an app with a "set up a provider" screen must boot without a model, and tests swap
    // in the fake provider without touching env or the network.
    const fake = createFakeLLMProvider({ answers: ['ok'] });
    const unprobed = await orThrow(
      defineApp('llm-unprobed')
        .use(llm({ provider: 'ollama', probe: false, fetch: ollamaDown }))
        .boot(),
    );
    const injected = await orThrow(
      defineApp('llm-fake')
        .use(llm(() => ({ instance: fake })))
        .boot(),
    );

    expect(unprobed.services.llm.provider).toBe('ollama');
    expect(injected.services.llm).toBe(fake);
    await expect(injected.services.llm.generateText('hi')).resolves.toBe('ok');
  });
});
