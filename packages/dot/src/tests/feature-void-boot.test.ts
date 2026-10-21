/**
 * A feature that provides nothing must plug in as a unit that provides `{}`
 * — never an open record that "provides every key" and collides with
 * whatever is already mounted (`db`, `kv`, …). `provides` is the one way a
 * feature publishes, and its factories run with the feature's needs.
 *
 * Found by the Drop Studio demo (catalog feature: no provides).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { ProvidedOf } from '../feature.js';
import { defineApp } from '../define-app.js';
import { defineFeature } from '../define-feature.js';
import { infra, service } from '../unit-contract.js';

type Db = { readonly name: string };

const db = infra({
  name: 'db',
  provides: { db: () => ({ name: 'pglite' }) },
});

describe('a feature with no provides', () => {
  it('provides {} and mounts after db without a collision', async () => {
    const catalog = defineFeature('catalog').needs({ db: service<Db>() }).entrypoints();
    expect(Object.keys(catalog.provides)).toEqual([]);
    // Empty, not the open `ServiceRecord` that would read as "provides every key".
    expectTypeOf<keyof ProvidedOf<typeof catalog>>().toEqualTypeOf<never>();

    const app = orThrow(await defineApp('void-boot').infra(db).features([catalog]).boot());
    const again = orThrow(await defineApp('void-boot-again').infra(db).features([catalog]).boot());

    expect(Object.keys(app.services)).toEqual(['db', 'catalog.usecases', 'catalog.services', 'feature.catalog']);
    expect(Object.keys(again.services)).toEqual(['db', 'catalog.usecases', 'catalog.services', 'feature.catalog']);
    orThrow(await app.dispose());
    orThrow(await again.dispose());
  });

  it('publishes only through provides factories, built from the feature needs', async () => {
    const order: string[] = [];
    const search = defineFeature('search')
      .needs({ db: service<Db>() })
      .provides({
        search: ({ db: handle }) => {
          order.push('factory');
          return { index: handle.name };
        },
      })
      .entrypoints();
    const app = orThrow(await defineApp('provides').infra(db).features([search]).boot());
    expect(app.services.search).toEqual({ index: 'pglite' });
    expect(order).toEqual(['factory']);
    orThrow(await app.dispose());
  });
});
