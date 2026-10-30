import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Provided } from '@arki/dot/unit';
import { defineApp } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';
import { fakeLog } from '@arki/log/testing';

import type { Embedder } from '../types.js';
import { ConfigurationFailure } from '../failures.js';
import { fakeEmbedder } from '../testing/index.js';
import { embeddings } from './index.js';

describe('embeddings()', () => {
  it('boots with a fake model and provides embedder', async () => {
    const fake = fakeEmbedder({ dimensions: 8 });
    const app = await orThrow(
      defineApp('emb-fake')
        .infra(embeddings({ model: fake.model, cache: true }))
        .boot(),
    );

    const { embedder } = app.services;
    expect(embedder?.space).toMatchObject({ provider: 'fake', dimensions: 8 });
    const first = await embedder.embed(['a'], {});
    const second = await embedder.embed(['a'], {});
    expect(first).toMatchObject({ usage: { cacheHits: 0 } });
    expect(second).toMatchObject({ usage: { cacheHits: 1 } });
  });

  // A missing key is a configuration fault: the boot returns it, the app never runs with embeddings silently off.
  it('a model that does not build stops the boot with the ConfigurationFailure and logs it once', async () => {
    using log = fakeLog();

    const booted = await defineApp('emb-none')
      .infra(embeddings({ model: () => ConfigurationFailure({ message: 'OLLAMA_BASE_URL is not set' }) }))
      .boot();

    expect(ConfigurationFailure.is(booted)).toBe(true);
    expect(booted).toMatchObject({ data: { message: 'OLLAMA_BASE_URL is not set' } });
    const errors = log.records.filter(
      record => record.category === 'arki:embeddings' && record.template.startsWith('embeddings could not start'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({ code: 'embeddings.configuration' });
  });

  it('a bad option stops the boot with a ConfigurationFailure too', async () => {
    using _log = fakeLog();

    // @ts-expect-error: a number is not a model
    const booted = await defineApp('emb-bad-option').infra(embeddings({ model: 42 })).boot();

    expect(ConfigurationFailure.is(booted)).toBe(true);
  });

  it('takes a factory that builds a model', async () => {
    const built = await orThrow(
      defineApp('emb-factory')
        .infra(embeddings({ model: () => fakeEmbedder({ dimensions: 4 }) }))
        .boot(),
    );

    expect(built.services.embedder.space.dimensions).toBe(4);
  });

  // The app reads its env inside the function, so defining the plugin at import never touches it.
  it('runs the model function once, at boot, not when the plugin is defined', async () => {
    let builds = 0;
    const plugin = embeddings({
      model: () => {
        builds++;
        return fakeEmbedder({ dimensions: 4 }).model;
      },
    });
    expect(builds).toBe(0);

    const app = await orThrow(defineApp('emb-boot').infra(plugin).boot());

    expect(builds).toBe(1);
    expect(app.services.embedder.space).toMatchObject({ provider: 'fake', dimensions: 4 });
  });

  it('publishes Embedder: an unconfigured app fails to boot rather than getting null', () => {
    expectTypeOf<Provided<ReturnType<typeof embeddings>['provides']['embedder']>>().toEqualTypeOf<Embedder>();
  });
});
