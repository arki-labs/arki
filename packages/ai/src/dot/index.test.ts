/**
 * The `vectorIndex` Dot plugin: a feature gets an index sized by the embedding
 * space at boot, resolved ONCE from the thunks; with no space the app still
 * boots and the index says so; tests inject the provider and never pick real
 * Qdrant. The embedder is `embeddings()` from `@arki/embeddings/dot`.
 */
import { describe, expect, it, vi } from 'vitest';

import { runDoctor, runExplain } from '@arki/dot/cli';
import { defineApp } from '@arki/dot/plugin';
import { fakeEmbedder } from '@arki/embeddings/testing';
import { isFailure, orThrow } from '@arki/failure';

import { ProviderUnavailable } from '../failures';
import { createFakeLLMProvider } from '../testing';
import { MockVectorProvider } from '../vector-search/providers/mock';
import { llm, vectorIndex } from './index';

type Payload = { userId: string; kind: 'item'; model: string; dimensions: number };

describe('vectorIndex()', () => {
  const space = {
    provider: 'fake',
    model: 'fake-4',
    dimensions: 4,
    normalized: true,
    quantization: 'float32',
    instructionVersion: 0,
  } as const;

  it('boots a mock index sized by the embedder space, reading the thunks once', async () => {
    const env = vi.fn(() => ({}));
    const embedder = fakeEmbedder({ dimensions: 4 });
    const spaceOf = vi.fn(() => embedder);
    const app = await orThrow(
      defineApp('vi-mock')
        .use(vectorIndex<Payload>({ collection: 'test', payloadIndexes: ['userId', 'kind'], space: spaceOf, env }))
        .boot(),
    );

    expect(env).toHaveBeenCalledTimes(1);
    expect(spaceOf).toHaveBeenCalledTimes(1);
    const index = app.services.vectorIndex;
    expect(index.provider).toBeInstanceOf(MockVectorProvider);
    expect(index.durable).toBe(false);
    // The index is sized by the embedder's space, so stored and query vectors agree.
    expect(index.provider?.space).toEqual(embedder.space);
  });

  it('no longer publishes embedder: that is embeddings() from @arki/embeddings/dot', async () => {
    const app = await orThrow(
      defineApp('vi-only-index')
        .use(vectorIndex<Payload>({ collection: 'test', payloadIndexes: [], space }))
        .boot(),
    );

    expect(Object.keys(app.services)).not.toContain('embedder');
    expect(app.services.vectorIndex.provider?.space).toEqual(space);
  });

  it('boots with no space (no embedding provider): index provider null', async () => {
    const app = await orThrow(
      defineApp('vi-none')
        .use(vectorIndex<Payload>({ collection: 'test', payloadIndexes: ['userId'], space: () => null }))
        .boot(),
    );

    expect(app.services.vectorIndex).toEqual({ provider: null, durable: false });
  });

  it('takes an injected provider, never building one', async () => {
    const env = vi.fn(() => ({ QDRANT_URL: 'http://q:6333' }));
    const provider = new MockVectorProvider<Payload>({ space });
    const app = await orThrow(
      defineApp('vi-injected')
        .use(
          vectorIndex<Payload>({
            collection: 'test',
            payloadIndexes: ['userId'],
            space,
            env,
            provider,
            durable: true,
          }),
        )
        .boot(),
    );

    expect(app.services.vectorIndex.provider).toBe(provider);
    expect(app.services.vectorIndex.durable).toBe(true);
    expect(env).not.toHaveBeenCalled();
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
