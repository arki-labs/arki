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

  it('missing config provides null and logs once', async () => {
    using log = fakeLog();
    const app = await orThrow(
      defineApp('emb-none')
        .infra(embeddings({ env: () => ({}) }))
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

  it('resolves a ref through resolveEmbeddingModel, reading env only at boot', async () => {
    let reads = 0;
    const plugin = embeddings({
      model: 'ollama:nomic-embed-text',
      env: () => {
        reads++;
        return { OLLAMA_BASE_URL: 'http://127.0.0.1:1' };
      },
    });
    expect(reads).toBe(0);

    const app = await orThrow(defineApp('emb-ref').infra(plugin).boot());

    expect(reads).toBe(1);
    expect(app.services.embedder?.space).toMatchObject({ provider: 'ollama', model: 'nomic-embed-text' });
  });

  it('publishes Embedder | null, so a feature must handle the unconfigured app', () => {
    expectTypeOf<Provided<ReturnType<typeof embeddings>['provides']['embedder']>>().toEqualTypeOf<Embedder | null>();
  });
});
