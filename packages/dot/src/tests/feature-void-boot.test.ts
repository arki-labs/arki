/**
 * `boot` is side effects only; `provides` is the one way a feature
 * publishes. A seed-only feature (boot = seed, no factories) must plug in
 * as a plugin that provides `{}` — never an open record that "provides
 * every key" and collides with whatever is already mounted (`db`, `kv`, …).
 *
 * Found by the Drop Studio demo (catalog feature: boot = seed, no provides).
 */
import { defineApp } from '../define-app.js';
import { plugin, service } from '../plugin-contract.js';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ProvidedOf } from '../feature.js';
import { feature } from '../feature.js';

type Db = { readonly name: string };

const db = plugin({
  name: 'db',
  provides: { db: () => ({ name: 'pglite' }) },
});

describe('boot is side-effect only', () => {
  it('a seed feature provides {} and mounts after db without a collision', async () => {
    let seededWith: string | undefined;
    const catalog = feature('catalog', {
      needs: { db: service<Db>() },
      boot: async ({ db: handle }) => {
        await Promise.resolve();
        seededWith = handle.name;
      },
    });
    expect(Object.keys(catalog.provides)).toEqual([]);

    // Both forms must type-check: the guard tuple is `[]` when there is no error.
    const app = await defineApp('void-boot').use(db).features([catalog]).boot();
    const viaAll = await defineApp('void-boot-all').use(db).features([catalog]).boot();

    expect(seededWith).toBe('pglite');
    expect(Object.keys(app.services)).toEqual(['db', 'feature.catalog']);
    expect(Object.keys(viaAll.services)).toEqual(['db', 'feature.catalog']);
    await app.dispose();
    await viaAll.dispose();
  });

  it('publishes only through provides factories; boot runs after them and sees their values', async () => {
    const order: string[] = [];
    let bootSaw: { readonly index: string } | undefined;
    const search = feature('search', {
      needs: { db: service<Db>() },
      provides: {
        search: ({ db: handle }) => {
          order.push('factory');
          return { index: handle.name };
        },
      },
      boot: ({ search: built }) => {
        order.push('boot');
        bootSaw = built;
      },
    });
    const app = await defineApp('provides').use(db).features([search]).boot();
    expect(app.services.search).toEqual({ index: 'pglite' });
    expect(order).toEqual(['factory', 'boot']);
    // One instance: boot sees the very value the kernel publishes.
    expect(bootSaw).toBe(app.services.search);
    await app.dispose();
  });

  it('a value-returning boot does not compile — there is one way to publish', () => {
    feature('legacy', {
      needs: { db: service<Db>() },
      // @ts-expect-error -- boot returns void; publish through `provides` instead
      boot: ({ db: handle }) => ({ search: { index: handle.name } }),
    });
    feature('legacy-async', {
      // @ts-expect-error -- an async boot resolving to a value is the same mistake
      boot: async () => {
        await Promise.resolve();
        return { search: 1 };
      },
    });
    let seeds = 0;
    const seed = feature('seed', {
      boot: () => {
        seeds += 1;
      },
    });
    expect(seeds).toBe(0);
    // Empty, not the open `ServiceRecord` that would read as "provides every key".
    expectTypeOf<keyof ProvidedOf<typeof seed>>().toEqualTypeOf<never>();
    expect(Object.keys(seed.provides)).toEqual([]);
  });
});
