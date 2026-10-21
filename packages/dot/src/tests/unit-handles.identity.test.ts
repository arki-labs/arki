/**
 * A handle carries the identity of the service it names: its `key` and the
 * `provider` that publishes it, both as literals. `infra()` stamps the
 * provider from `name`, `rename()` from its new name, and a `Unit<N, P>`
 * annotation erases it to `string` — "unknown", never "any". The feature
 * builder's identity checks (define-feature.identity.test.ts) read these.
 *
 * The needs shape travels with the unit too (`UnitProviderIdentities`),
 * so a unit whose needs are handles restates no type: its factories see
 * the handles' service types, and the feature that owns it checks identities.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { CtxOf, EmptyShape, Handle, NeedsShape, Unit, UnitProviderIdentities } from '../unit-contract.js';
import { defineFeature } from '../define-feature.js';
import { infra, rename } from '../unit-contract.js';

type Db = { readonly query: (sql: string) => Promise<readonly string[]> };
type Clusters = { readonly list: () => readonly string[] };

const database = infra({ name: 'database', provides: { db: (): Db => ({ query: sql => Promise.resolve([sql]) }) } });
const dedup = infra({ name: 'dedup', provides: { clusterDetails: (): Clusters => ({ list: () => ['c1'] }) } });

describe('handles carry the provider as a literal', () => {
  it('infra() stamps its name on every handle and its lazy form', () => {
    expectTypeOf(database.provides.db.provider).toEqualTypeOf<'database'>();
    expectTypeOf(database.provides.db.key).toEqualTypeOf<'db'>();
    expectTypeOf(database.provides.db.lazy.provider).toEqualTypeOf<'database'>();
    expect(database.provides.db.provider).toBe('database');
  });

  it('rename() stamps the new name, or keeps the old one without a new name', () => {
    const replica = rename(database, { db: 'replica' }, 'replica');
    expectTypeOf(replica.provides.replica.provider).toEqualTypeOf<'replica'>();
    expectTypeOf(replica.provides.replica.key).toEqualTypeOf<'replica'>();
    expect(replica.provides.replica.provider).toBe('replica');

    const sameName = rename(database, { db: 'reportsDb' });
    expectTypeOf(sameName.provides.reportsDb.provider).toEqualTypeOf<'database'>();
    expect(sameName.provides.reportsDb.provider).toBe('database');
  });

  it('a Unit<N, P> annotation erases the provider to string and the shape to unknown', () => {
    const erased: Unit<EmptyShape, { readonly db: Db }> = database;
    expectTypeOf(erased.provides.db.provider).toEqualTypeOf<string>();
    expectTypeOf<UnitProviderIdentities<typeof erased>>().toEqualTypeOf<NeedsShape>();
  });
});

describe('a unit whose needs are handles restates no type', () => {
  const store = infra({
    name: 'store',
    needs: { db: database.provides.db, clusters: dedup.provides.clusterDetails },
    provides: { repos: ({ db, clusters }) => ({ first: () => db.query(clusters.list()[0] ?? '') }) },
  });

  it('keeps the needs shape, with each handle’s identity', () => {
    expectTypeOf<UnitProviderIdentities<typeof store>>().toEqualTypeOf<{
      db: Handle<Db, 'db', 'database'>;
      clusters: Handle<Clusters, 'clusterDetails', 'dedup'>;
    }>();
    expectTypeOf<CtxOf<UnitProviderIdentities<typeof store>>>().toEqualTypeOf<{ db: Db; clusters: Clusters }>();
  });

  it('is accepted by a feature that declares the same handles', () => {
    const owner = defineFeature('owner')
      .needs({ db: database.provides.db, clusters: dedup.provides.clusterDetails })
      .infra(store)
      .entrypoints();
    expect(owner.units().map(p => p.name)).toEqual(['owner/store', 'owner']);
  });
});
