/**
 * Infra receives the feature's needs — by binding, not by hand-passing
 * (RFC `docs/rfcs/2026-10-15-dot-feature-builder-nesting.md`, "infra needs").
 *
 * Why these tests exist: an infra plugin declares its needs unbound
 * (`service<Db>()`); `.infra()` binds each alias to a sibling's key first,
 * then to the feature's need of the same alias. `.needs()` is the one door
 * for handles: what it lists is what every infra plugin gets, so `db` is
 * named once and `fake(database.provides.db, x)` reaches every store.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DepsOf } from '../feature.js';
import type { PluginNeeds } from '../plugin-contract.js';
import type { Db } from './fixtures/nested-digest/db.js';
import type { Repos } from './fixtures/nested-digest/digest/infra/store.js';
import { defineFeature, entrypointOnly, mountFeatures } from '../feature.js';
import { defineApp, plugin, service } from '../index.js';
import { createDb, database } from './fixtures/nested-digest/db.js';
import { ranker } from './fixtures/nested-digest/digest/features/compile/infra/ranker.js';
import { store } from './fixtures/nested-digest/digest/infra/store.js';

type Witness = { readonly key?: string; readonly origin?: object; readonly lazy?: unknown; readonly entrypointOnly?: boolean };
const canonical = (w: Witness): object => w.origin ?? w;

/** The shape `advisoryLocks(options)` takes after the change: options only, `db` unbound. */
const locks = (options: { readonly namespace: string }) =>
  plugin({
    name: 'locks',
    needs: { db: service<Db>() },
    provides: { locks: ({ db }) => ({ namespace: options.namespace, bound: typeof db.transaction === 'function' }) },
  });

/** A child whose infra plugin (`ranker`) needs the parent's `repos` by alias; the child declares it, the parent remaps it. */
const compile = defineFeature('digest.compile')
  .needs({ repos: store.provides.repos })
  .infra(ranker)
  .usecases({})
  .provides({ compiler: ({ ranker: ranking }) => ({ stored: ranking.stored }) })
  .entrypoints();

/** `digest`: `db` declared ONCE, entrypoint-only. `store` and `locks` take it by alias at `.infra()`. */
const digestDeps = defineFeature('digest')
  .needs({ db: entrypointOnly(database.provides.db) })
  .infra(store, locks({ namespace: 'probe' }))
  .features(compile);
const digest = digestDeps
  .usecases({})
  .provides({
    digests: ({ db, locks: locker, repos }) => ({
      count: () => db.transaction(tx => repos.withTx(tx).digests.count()),
      namespace: locker.namespace,
    }),
  })
  .entrypoints();

describe('binding: the feature need is what every infra plugin gets', () => {
  it('binds by provenance: one handle object, every infra plugin follows it; units and boot order unchanged', () => {
    const units = digest.plugins();
    expect(units.map(u => u.name)).toEqual([
      'digest/store',
      'digest/locks',
      'digest.compile/ranker',
      'digest.compile',
      'digest',
    ]);
    const storeNeed = units[0].needs['db'] as Witness;
    const locksNeed = units[1].needs['db'] as Witness;
    expect(storeNeed.key).toBe('db');
    expect(canonical(storeNeed)).toBe(database.provides.db);
    expect(locksNeed).toBe(storeNeed);
    // The flag rides along; the kernel only reads `key`.
    expect(storeNeed.entrypointOnly).toBe(true);
  });

  it("remaps a child infra plugin's alias need by identity: digest.repos, origin kept", () => {
    const rankerNeed = digest.plugins()[2].needs['repos'] as Witness;
    expect(rankerNeed.key).toBe('digest.repos');
    expect(rankerNeed.origin).toBe(store.provides.repos);
    expect(mountFeatures([digest]).features.map(f => f.name)).toEqual(['digest', 'digest.compile']);
  });

  it('boots on the real db: the store builds on the bound handle, the child reads through the parent store', async () => {
    const app = await defineApp('probe').infra(database).features([digest]).start();
    expect(app.services.digests.namespace).toBe('probe');
    expect(await app.services.digests.count()).toBe(0);
    const db = app.services.db;
    await db.transaction(tx => app.services['digest.repos'].withTx(tx).digests.create({ id: 'd1', userId: 'u', status: 'compiled', items: [] }));
    expect(await db.transaction(tx => app.services['digest.compile.compiler'].stored(tx))).toBe(1);
    await app.dispose();
  });

  it('one fake db reaches every infra plugin through the one need', async () => {
    let calls = 0;
    const fakeDb: Db = {
      transaction: async fn => {
        calls += 1;
        return createDb().transaction(fn);
      },
    };
    const app = await defineApp('fake').infra(plugin({ name: 'fake-db', provides: { db: () => fakeDb } })).features([digest]).start();
    await app.services.digests.count();
    expect(calls).toBe(1);
    await app.dispose();
  });

  it('override() keeps the bound need and replaces the service', async () => {
    const fakeRepos: Repos = {
      withTx: () => ({
        digests: {
          create: () => Promise.resolve('x'),
          get: () => Promise.resolve(null),
          markSent: () => Promise.resolve(true),
          count: () => Promise.resolve(42),
        },
      }),
    };
    const overridden = digest.override({ repos: fakeRepos });
    expect(canonical(overridden.plugins()[0].needs['db'] as Witness)).toBe(database.provides.db);
    const app = await defineApp('o').infra(database).features([overridden]).start();
    expect(await app.services.digests.count()).toBe(42);
    await app.dispose();
  });
});

describe('refusals at .infra(), before boot (the type guard refuses them too)', () => {
  it('an undeclared need is refused, naming the alias', () => {
    // @ts-expect-error store needs `db`; the feature declares nothing
    expect(() => defineFeature('x').infra(store)).toThrow(/needs "db", which the feature does not declare/);
    const kv = plugin({ name: 'kv', provides: { kv: () => new Map<string, string>() } });
    // @ts-expect-error store needs `db`; the feature declares `kv` only
    expect(() => defineFeature('b').needs({ kv: kv.provides.kv }).infra(store)).toThrow(/needs "db"/);
    // @ts-expect-error alias must match: the feature calls it `main`, store asks for `db`
    expect(() => defineFeature('f').needs({ main: database.provides.db }).infra(store)).toThrow(/needs "db"/);
  });

  it('a plugin bound to another handle is refused; bound to the same handle it is tolerated and rebound', () => {
    const other = plugin({ name: 'other-db', provides: { db: (): Db => createDb() } });
    const boundElsewhere = plugin({ name: 'bound', needs: { db: other.provides.db }, provides: { thing: () => 1 } });
    expect(() => defineFeature('y').needs({ db: database.provides.db }).infra(boundElsewhere)).toThrow(
      /binds "db" to a handle other than the feature's/,
    );
    // Migration tolerance: today's `repos(database.provides.db, …)` form passes when it binds the feature's own handle.
    const boundSame = plugin({ name: 'bound-same', needs: { db: database.provides.db }, provides: { thing: () => 1 } });
    const tolerated = defineFeature('z').needs({ db: entrypointOnly(database.provides.db) }).infra(boundSame).usecases({}).entrypoints();
    expect(canonical(tolerated.plugins()[0].needs['db'] as Witness)).toBe(database.provides.db);
  });

  it('a lazy witness gets the lazy form of the feature handle', () => {
    const lazyUser = plugin({ name: 'lazy-user', needs: { db: service.lazy<Db>() }, provides: { later: ({ db }) => db } });
    const lazyFeature = defineFeature('w').needs({ db: database.provides.db }).infra(lazyUser).usecases({}).entrypoints();
    const need = lazyFeature.plugins()[0].needs['db'] as Witness;
    expect(need.lazy).toBe(true);
    expect(need.key).toBe('db');
  });

  it('types: the wrong type, the lazy-vs-eager mismatch and a bare handle do not compile', () => {
    // @ts-expect-error store wants `Db`; the feature declares the lazy form (`Lazy<Db>`)
    defineFeature('c').needs({ db: database.provides.db.lazy }).infra(store);
    const wrongType = plugin({ name: 'wrong', needs: { db: service<{ nope: true }>() }, provides: { w: () => 1 } });
    // @ts-expect-error the declared `db` is not a `{ nope: true }`
    defineFeature('d').needs({ db: database.provides.db }).infra(wrongType);
    // @ts-expect-error a bare handle is not a needs record (it would be read as { key, provider, lazy })
    expect(() => defineFeature('e').needs(database.provides.db)).toThrow(/not a bare handle/);
  });
});

describe('positives', () => {
  it("the feature's alias may differ from the handle's key: the unit's wire key is the handle's", () => {
    const mainUser = plugin({ name: 'main-user', needs: { main: service<Db>() }, provides: { m: ({ main }) => main } });
    const aliased = defineFeature('g').needs({ main: database.provides.db }).infra(mainUser).usecases({}).entrypoints();
    type StoreUnit = ReturnType<typeof aliased.plugins>[0];
    expectTypeOf<keyof PluginNeeds<StoreUnit>>().toEqualTypeOf<'db'>();
    expect(aliased.plugins()[0].needs['main']).toMatchObject({ key: 'db' });
  });

  it('entrypoint-only db: the usecases deps have repos and locks and no db; provides and entrypoints see db', () => {
    const deps = defineFeature('h').needs({ db: entrypointOnly(database.provides.db) }).infra(store);
    type Deps = DepsOf<typeof deps>;
    expectTypeOf<'db' extends keyof Deps ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'repos' extends keyof Deps ? true : false>().toEqualTypeOf<true>();
    deps.usecases({}).provides({ open: ({ db }) => db.transaction(() => Promise.resolve(1)) }).entrypoints();
    // @ts-expect-error a usecase asking for db: the feature does not provide it to usecases
    deps.usecases({ bad: ({ db }: { db: Db }) => db });
  });

  it('a sibling key still wins over a declared need of the same alias (unchanged rule)', () => {
    const a = plugin({ name: 'a', provides: { thing: () => 1 as const } });
    const b = plugin({ name: 'b', needs: { thing: service<1>() }, provides: { twice: ({ thing }) => thing * 2 } });
    const f = defineFeature('i').infra(a, b).usecases({}).entrypoints();
    expect(f.plugins()[1].needs['thing']).toMatchObject({ key: 'i.thing' });
  });
});
