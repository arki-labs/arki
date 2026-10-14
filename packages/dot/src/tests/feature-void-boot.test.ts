/**
 * Regression: a feature whose `boot` returns nothing must plug in as a
 * plugin that *provides nothing*. Before the fix, `feature` inferred
 * `TProvides` as its open constraint (`ServiceRecord`), so `plug(feature)`
 * looked like it provided every key and `.use()` rejected it with a
 * collision against whatever was already mounted (`db`, `kv`, …).
 *
 * Found by the Drop Studio demo (catalog feature: boot = seed, no provides).
 */
import { defineApp } from '../define-app.js';
import { plugin, service } from '../plugin-contract.js';
import { describe, expect, it } from 'vitest';

import { feature } from '../feature.js';

type Db = { readonly name: string };

const db = plugin({
  name: 'db',
  boot: () => ({ db: { name: 'pglite' } }),
});

describe('void-boot features', () => {
  it('a feature that only seeds provides nothing and mounts after db without a collision', async () => {
    let seededWith: string | undefined;
    const catalog = feature('catalog', {
      needs: { db: service<Db>() },
      boot: async ({ db: handle }) => {
        await Promise.resolve();
        seededWith = handle.name;
      },
    });

    // Both forms must type-check: the guard tuple is `[]` when there is no error.
    const app = await defineApp('void-boot').use(db).features([catalog]).boot();
    const viaAll = await defineApp('void-boot-all').use(db).features([catalog]).boot();

    expect(seededWith).toBe('pglite');
    expect(Object.keys(app.services)).toEqual(['db', 'feature.catalog']);
    expect(Object.keys(viaAll.services)).toEqual(['db', 'feature.catalog']);
    await app.dispose();
    await viaAll.dispose();
  });

  it('a feature with a real provides record still publishes it', async () => {
    const search = feature('search', {
      needs: { db: service<Db>() },
      boot: ({ db: handle }) => ({ search: { index: handle.name } }),
    });
    const app = await defineApp('provides').use(db).features([search]).boot();
    expect(app.services.search).toEqual({ index: 'pglite' });
    await app.dispose();
  });
});
