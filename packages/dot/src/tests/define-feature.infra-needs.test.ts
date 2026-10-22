/**
 * Infra receives the feature's needs — by binding, not by hand-passing
 * (RFC `docs/rfcs/2026-10-15-dot-feature-builder-nesting.md`, "infra needs").
 *
 * Why these tests exist: an infra unit declares its needs unbound
 * (`service<Db>()`); `.infra()` binds each alias to a sibling's key first,
 * then to the feature's need of the same alias. `.needs()` is the one door
 * for handles: what it lists is what every infra unit gets, so `db` is
 * named once and `fake(database.provides.db, x)` reaches every store.
 */
import { orThrow } from '@arki/failure';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DepsOf } from '../feature.js';
import type { UnitNeeds } from '../unit-contract.js';
import type { Db, Tx } from './fixtures/nested-digest/db.js';
import type { Repos } from './fixtures/nested-digest/digest/infra/store.js';
import { defineFeature, entrypointOnly, mountFeatures } from '../feature.js';
import { defineApp, infra, service } from '../index.js';
import { createDb, database } from './fixtures/nested-digest/db.js';
import { ranker } from './fixtures/nested-digest/digest/features/compile/infra/ranker.js';
import { store } from './fixtures/nested-digest/digest/infra/store.js';

type Witness = {
  readonly key?: string;
  readonly origin?: object;
  readonly lazy?: unknown;
  readonly entrypointOnly?: boolean;
};
const canonical = (w: Witness): object => w.origin ?? w;

/** The shape `advisoryLocks(options)` takes after the change: options only, `db` unbound. */
const locks = (options: { readonly namespace: string }) =>
  infra({
    name: 'locks',
    needs: { db: service<Db>() },
    provides: { locks: ({ db }) => ({ namespace: options.namespace, bound: typeof db.transaction === 'function' }) },
  });

/** A child whose infra unit (`ranker`) needs the parent's `repos` by alias; the child declares it, the parent remaps it. */
const compile = defineFeature('digest.compile')
  .needs({ repos: store.provides.repos })
  .infra(ranker)
  .usecases({ compiler: ({ ranker: ranking }) => ({ stored: ranking.stored }) })
  .provides({ compiler: ({ usecases }) => usecases.compiler })
  .entrypoints();

/** `digest`: `db` declared ONCE, entrypoint-only. `store` and `locks` take it by alias at `.infra()`. */
const digestDeps = defineFeature('digest')
  .needs({ db: entrypointOnly(database.provides.db) })
  .infra(store, locks({ namespace: 'probe' }))
  .features(compile);
const digest = digestDeps
  .usecases({
    digests: ({ locks: locker, repos }) => ({
      count: (tx: Tx) => repos.withTx(tx).digests.count(),
      namespace: locker.namespace,
    }),
  })
  .provides({ digests: ({ usecases }) => usecases.digests })
  .entrypoints();

describe('binding: the feature need is what every infra unit gets', () => {
  it('binds by provenance: one handle object, every infra unit follows it; units and boot order unchanged', () => {
    const units = digest.units();
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

  it("remaps a child infra unit's alias need by identity: digest.repos, origin kept", () => {
    const rankerNeed = digest.units()[2].needs['repos'] as Witness;
    expect(rankerNeed.key).toBe('digest.repos');
    expect(rankerNeed.origin).toBe(store.provides.repos);
    expect(mountFeatures([digest]).features.map(f => f.name)).toEqual(['digest', 'digest.compile']);
  });

  it('boots on the real db: the store builds on the bound handle, the child reads through the parent store', async () => {
    const app = orThrow(await defineApp('probe').infra(database).features([digest]).start());
    expect(app.services.digests.namespace).toBe('probe');
    const db = app.services.db;
    expect(await db.transaction(tx => app.services.digests.count(tx))).toBe(0);
    await db.transaction(tx =>
      app.services['digest.repos'].withTx(tx).digests.create({ id: 'd1', userId: 'u', status: 'compiled', items: [] }),
    );
    expect(await db.transaction(tx => app.services['digest.compile.compiler'].stored(tx))).toBe(1);
    orThrow(await app.dispose());
  });

  it('one fake db reaches every infra unit through the one need', async () => {
    let calls = 0;
    const fakeDb: Db = {
      transaction: async fn => {
        calls += 1;
        return createDb().transaction(fn);
      },
    };
    const app = orThrow(await defineApp('fake')
      .infra(infra({ name: 'fake-db', provides: { db: () => fakeDb } }))
      .features([digest])
      .start());
    // The entrypoint side gets the same fake through the one need; it opens the transaction.
    const { db } = app.services['digest.services'];
    expect(db).toBe(fakeDb);
    await db.transaction(tx => app.services.digests.count(tx));
    expect(calls).toBe(1);
    orThrow(await app.dispose());
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
    expect(canonical(overridden.units()[0].needs['db'] as Witness)).toBe(database.provides.db);
    const app = orThrow(await defineApp('o').infra(database).features([overridden]).start());
    expect(await app.services.db.transaction(tx => app.services.digests.count(tx))).toBe(42);
    orThrow(await app.dispose());
  });
});

describe('refusals at .infra(), before boot (the type guard refuses them too)', () => {
  it('an undeclared need is refused, naming the alias', () => {
    // @ts-expect-error store needs `db`; the feature declares nothing
    expect(() => defineFeature('x').infra(store)).toThrow(/needs "db", which the feature does not declare/);
    const kv = infra({ name: 'kv', provides: { kv: () => new Map<string, string>() } });
    // @ts-expect-error store needs `db`; the feature declares `kv` only
    expect(() => defineFeature('b').needs({ kv: kv.provides.kv }).infra(store)).toThrow(/needs "db"/);
    // @ts-expect-error alias must match: the feature calls it `main`, store asks for `db`
    expect(() => defineFeature('f').needs({ main: database.provides.db }).infra(store)).toThrow(/needs "db"/);
  });

  it('two infra units providing the same key are refused, naming the key', () => {
    const s1 = infra({ name: 's1', provides: { repos: () => ({ a: 1 }) } });
    const s2 = infra({ name: 's2', provides: { repos: () => ({ a: 2 }), extra: () => 0 } });
    // @ts-expect-error s1 and s2 both provide "repos" — InfraProvides would merge them silently
    expect(() => defineFeature('f').infra(s1, s2)).toThrow(/infra service "repos" collides/);
    // The same two keys, three units deep: the fold sees past the first pair.
    const s3 = infra({ name: 's3', provides: { other: () => 'x' } });
    // @ts-expect-error "repos" is provided twice
    expect(() => defineFeature('g').infra(s1, s3, s2)).toThrow(/"repos" collides/);
    // Distinct keys compile and build.
    expect(
      defineFeature('h')
        .infra(s1, s3)
        .entrypoints()
        .units()
        .map(p => p.name),
    ).toEqual(['h/s1', 'h/s3', 'h']);
  });

  it('a unit bound to another handle is refused; bound to the same handle it is tolerated and rebound', () => {
    const other = infra({ name: 'other-db', provides: { db: (): Db => createDb() } });
    const boundElsewhere = infra({ name: 'bound', needs: { db: other.provides.db }, provides: { thing: () => 1 } });
    // @ts-expect-error -- `bound` binds `db` to "other-db"; the feature's `db` is `database`'s (round 9, A2)
    expect(() => defineFeature('y').needs({ db: database.provides.db }).infra(boundElsewhere)).toThrow(
      /binds "db" to a handle other than the feature's/,
    );
    // Migration tolerance: today's `repos(database.provides.db, …)` form passes when it binds the feature's own handle.
    const boundSame = infra({ name: 'bound-same', needs: { db: database.provides.db }, provides: { thing: () => 1 } });
    const tolerated = defineFeature('z')
      .needs({ db: entrypointOnly(database.provides.db) })
      .infra(boundSame)
      .usecases({})
      .entrypoints();
    expect(canonical(tolerated.units()[0].needs['db'] as Witness)).toBe(database.provides.db);
  });

  it('a lazy witness gets the lazy form of the feature handle', () => {
    const lazyUser = infra({
      name: 'lazy-user',
      needs: { db: service.lazy<Db>() },
      provides: { later: ({ db }) => db },
    });
    const lazyFeature = defineFeature('w')
      .needs({ db: database.provides.db })
      .infra(lazyUser)
      .usecases({})
      .entrypoints();
    const need = lazyFeature.units()[0].needs['db'] as Witness;
    expect(need.lazy).toBe(true);
    expect(need.key).toBe('db');
  });

  it('types: the wrong type, the lazy-vs-eager mismatch and a bare handle do not compile', () => {
    // @ts-expect-error store wants `Db`; the feature declares the lazy form (`Lazy<Db>`)
    defineFeature('c').needs({ db: database.provides.db.lazy }).infra(store);
    const wrongType = infra({ name: 'wrong', needs: { db: service<{ nope: true }>() }, provides: { w: () => 1 } });
    // @ts-expect-error the declared `db` is not a `{ nope: true }`
    defineFeature('d').needs({ db: database.provides.db }).infra(wrongType);
    // @ts-expect-error a bare handle is not a needs record (it would be read as { key, provider, lazy })
    expect(() => defineFeature('e').needs(database.provides.db)).toThrow(/not a bare handle/);
  });
});

describe('positives', () => {
  it("the feature's alias may differ from the handle's key: the unit's wire key is the handle's", () => {
    const mainUser = infra({ name: 'main-user', needs: { main: service<Db>() }, provides: { m: ({ main }) => main } });
    const aliased = defineFeature('g').needs({ main: database.provides.db }).infra(mainUser).usecases({}).entrypoints();
    type StoreUnit = ReturnType<typeof aliased.units>[0];
    expectTypeOf<keyof UnitNeeds<StoreUnit>>().toEqualTypeOf<'db'>();
    expect(aliased.units()[0].needs['main']).toMatchObject({ key: 'db' });
  });

  it('entrypoint-only db: the usecases deps have repos and locks and no db; entrypoints see db, provides do not', () => {
    const deps = defineFeature('h')
      .needs({ db: entrypointOnly(database.provides.db) })
      .infra(store);
    type Deps = DepsOf<typeof deps>;
    expectTypeOf<'db' extends keyof Deps ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'repos' extends keyof Deps ? true : false>().toEqualTypeOf<true>();
    deps.usecases({}).entrypoints({
      kind: 'probe',
      key: 'probe',
      actions: [],
      resolve: ({ db }) => ({ open: () => db.transaction(() => Promise.resolve(1)) }),
    });
    // @ts-expect-error TS2339: a provides factory sees only the usecases, not the entrypoint-only db
    deps.usecases({}).provides({ open: ({ db }) => db });
    // @ts-expect-error a usecase asking for db: the feature does not provide it to usecases
    deps.usecases({ bad: ({ db }: { db: Db }) => db });
  });

  it('a sibling key still wins over a declared need of the same alias (unchanged rule)', () => {
    const a = infra({ name: 'a', provides: { thing: () => 1 as const } });
    const b = infra({ name: 'b', needs: { thing: service<1>() }, provides: { twice: ({ thing }) => thing * 2 } });
    const f = defineFeature('i').infra(a, b).usecases({}).entrypoints();
    expect(f.units()[1].needs['thing']).toMatchObject({ key: 'i.thing' });
  });
});
