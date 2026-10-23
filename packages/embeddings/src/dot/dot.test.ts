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

    const embedder = app.services.embedder;
    expect(embedder?.space).toMatchObject({ provider: 'fake', dimensions: 8 });
    const first = await embedder?.embed(['a'], {});
    const second = await embedder?.embed(['a'], {});
    expect(first).toMatchObject({ usage: { cacheHits: 0 } });
    expect(second).toMatchObject({ usage: { cacheHits: 1 } });
  });

  // A missing key must turn embeddings off, not stop the app from booting.
  it('a model that does not build provides null and logs once', async () => {
    using log = fakeLog();
    const app = await orThrow(
      defineApp('emb-none')
        .infra(embeddings({ model: () => ConfigurationFailure({ message: 'OLLAMA_BASE_URL is not set' }) }))
        .boot(),
    );

    expect(app.services.embedder).toBeNull();
    const warnings = log.records.filter(
      record => record.category === 'arki:embeddings' && record.template.startsWith('embeddings are off'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ code: 'embeddings.configuration' });
  });

  it('takes a factory, and a failure from it is the same null', async () => {
    using _log = fakeLog();
    const built = await orThrow(
      defineApp('emb-factory')
        .infra(embeddings({ model: () => fakeEmbedder({ dimensions: 4 }) }))
        .boot(),
    );
    const refused = await orThrow(
      defineApp('emb-refused')
        .infra(embeddings({ model: () => ConfigurationFailure({ message: 'no key' }) }))
        .boot(),
    );

    expect(built.services.embedder?.space.dimensions).toBe(4);
    expect(refused.services.embedder).toBeNull();
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
    expect(app.services.embedder?.space).toMatchObject({ provider: 'fake', dimensions: 4 });
  });

  it('publishes Embedder | null, so a feature must handle the unconfigured app', () => {
    expectTypeOf<Provided<ReturnType<typeof embeddings>['provides']['embedder']>>().toEqualTypeOf<Embedder | null>();
  });
});
