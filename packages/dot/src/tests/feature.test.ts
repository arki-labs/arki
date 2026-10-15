/**
 * The feature contract: declarations are inert data whose compile-time
 * fragments fold without any kernel; `.features()` publishes slice
 * payloads under the derived token, attributes slice actions to the
 * feature, and merges the boot escape hatch; the builder keeps the
 * hexagon's direction (driven → core → driving). These encode WHY the
 * module exists — each would break if the declaration/mount split or the
 * phase order regressed.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { defineApp, plugin, service } from '../index.js';

import type { AnyFeature, ComposedRepos } from '../feature.js';
import { composeRepos, composeRouter, driven, driver, feature, FEATURE_ERROR_CODES, plug, sliceOf, tokenOf } from '../feature.js';

type FakeDb = { readonly tag: 'db' };
const fakeDb: FakeDb = { tag: 'db' };

const ordersRouter = { list: 'orders.list' } as const;
const billingRouter = { charge: 'billing.charge' } as const;

const orders = feature('orders', {
  router: { orders: ordersRouter },
  repos: { orders: (db: FakeDb) => ({ db, kind: 'orders-repo' as const }) },
  use: [
    {
      key: 'queue',
      actions: [{ id: 'orders:sync.consume', binding: 'queue', direction: 'in' as const, address: 'orders:sync' }],
      resolve: () => ({ sync: 'job' }),
    },
  ],
});

const billing = feature('billing', {
  router: { billing: billingRouter },
  repos: { billing: (db: FakeDb) => ({ db, kind: 'billing-repo' as const }) },
});

const authish = feature('authish', {
  needs: { db: service<FakeDb>() },
  boot: ({ db }) => ({ session: { via: db.tag } }),
});

describe('compile-time folds (no kernel involved)', () => {
  it('composeRouter merges fragments and preserves each fragment type', () => {
    const router = composeRouter([orders, billing]);
    expect(new Set(Object.keys(router))).toEqual(new Set(['billing', 'orders']));
    expectTypeOf(router.orders).toEqualTypeOf<typeof ordersRouter>();
    expectTypeOf(router.billing).toEqualTypeOf<typeof billingRouter>();
  });

  it('composeRouter rejects two features claiming one mount key: a compile error, and a coded throw behind it', () => {
    // The second fragment would silently replace the first, so the mistake
    // must stop the build; the throw catches code that skips the types.
    const clash = feature('clash', { router: { orders: {} } });
    // @ts-expect-error -- "orders" is claimed twice
    expect(() => composeRouter([orders, clash])).toThrow(
      expect.objectContaining({ code: FEATURE_ERROR_CODES.duplicateRouterKey, message: expect.stringMatching(/router mount key "orders"/) }),
    );
  });

  it('composeRouter accepts features without routers and features typed with a wide router record', () => {
    const bare = feature('bare', {});
    const wide: AnyFeature = feature('wide', { router: {} });
    expect(Object.keys(composeRouter([orders, bare, wide, bare]))).toEqual(['orders']);
  });

  it('composeRepos folds factories over one db handle, typed by the factories', () => {
    const db: FakeDb = { tag: 'db' };
    const repos = composeRepos([orders, billing], db);
    expect(repos.orders.kind).toBe('orders-repo');
    expect(repos.billing.db).toBe(db);
    expectTypeOf<ComposedRepos<readonly [typeof orders, typeof billing]>>().toEqualTypeOf<typeof repos>();
  });

  it('composeRepos rejects two features claiming one repo key: a compile error, and a coded throw behind it', () => {
    const clash = feature('repo-clash', { repos: { orders: (db: FakeDb) => db } });
    // @ts-expect-error -- "orders" is claimed twice
    expect(() => composeRepos([orders, clash], { tag: 'db' })).toThrow(
      expect.objectContaining({ code: FEATURE_ERROR_CODES.duplicateRepoKey, message: expect.stringMatching(/repo key "orders"/) }),
    );
  });
});

const slice = (key: string) => ({ key, actions: [], resolve: () => ({}) });

describe('slice keys', () => {
  it('rejects two slices under one key: the second would silently replace the first when plugged', () => {
    expect(() => feature('twice', { use: [slice('routes'), slice('jobs'), slice('routes')] })).toThrow(
      expect.objectContaining({
        code: FEATURE_ERROR_CODES.duplicateSliceKey,
        message: expect.stringMatching(/feature "twice" declares two "routes" slices/),
      }),
    );
  });

  it('accepts slices with distinct keys and the same key in different features', () => {
    expect(() => feature('one', { use: [slice('routes'), slice('jobs')] })).not.toThrow();
    expect(() => feature('two', { use: [slice('routes')] })).not.toThrow();
  });
});

describe('mounting features (.features)', () => {
  it('publishes slice payloads under the derived feature token and merges boot provides', async () => {
    const dbPlugin = plugin({ name: 'db', boot: () => ({ db: fakeDb }) });
    const app = await defineApp('feature-test')
      .use(dbPlugin)
      .features([orders, billing, authish])
      .boot();

    const manifest = app.manifest;
    const ordersUnit = manifest.plugins.find(p => p.name === 'orders');
    expect(ordersUnit).toBeDefined();
    expect(manifest.actions.map(a => a.id)).toContain('orders:sync.consume');

    const services = app.services as Record<string, unknown>;
    expect(services['feature.orders']).toEqual({ queue: { sync: 'job' } });
    expect(services['feature.billing']).toEqual({});
    expect(services['session']).toEqual({ via: 'db' });

    await app.dispose();
  });

  it('derives key-stable tokens without shared state', () => {
    expect(tokenOf(orders).key).toBe('feature.orders');
    expect(tokenOf(billing).key).toBe('feature.billing');
    // Two independent derivations resolve the same wire key — the
    // provide/collect handshake is by key string, not object identity.
    expect(tokenOf(orders).key).toBe(tokenOf(orders).key);
  });

  it('mounts features in list order (boot order is the list order)', () => {
    const dbPlugin = plugin({ name: 'db', boot: () => ({ db: fakeDb }) });
    const { manifest } = defineApp('order-test').use(dbPlugin).features([orders, billing]).configure();
    expect(manifest.plugins.map(p => p.name)).toEqual(['db', 'orders', 'billing']);
    expect(plug(orders).name).toBe('orders');
  });

  it('resolves endpoint-style slices with the feature needs at boot', async () => {
    const dbPlugin = plugin({ name: 'db', boot: () => ({ db: fakeDb }) });
    const serving = feature('serving', {
      needs: { db: service<FakeDb>() },
      use: [{ key: 'routes', actions: [], resolve: ({ db }: { db: FakeDb }) => ({ boundTo: db.tag }) }],
    });

    const app = await defineApp('slice-services-test').use(dbPlugin).features([serving]).boot();
    const services = app.services as Record<string, unknown>;
    expect(services['feature.serving']).toEqual({ routes: { boundTo: 'db' } });
    await app.dispose();
  });
});

describe('provides handles (a feature depends on a capability, not a feature)', () => {
  // The provider writes its implementation once; consumers name the
  // capability by handle and get its type inferred. Restating the type
  // (service<Entitlements>()) is exactly the drift this exists to remove.
  const createEntitlements = (db: FakeDb) => ({
    source: db.tag,
    planOf: (userId: string) => (userId === 'usr_pro' ? ('pro' as const) : ('free' as const)),
  });

  const plans = feature('plans', {
    needs: { db: service<FakeDb>() },
    boot: ({ db }) => ({ entitlements: createEntitlements(db) }),
  });

  const digest = feature('digest', {
    needs: { access: plans.provides.entitlements },
    boot: ({ access }) => ({ digestPlan: (userId: string) => access.planOf(userId) }),
  });

  it("types the handle from the provider's boot return — nothing restated", () => {
    expectTypeOf(plans.provides.entitlements.key).toEqualTypeOf<'entitlements'>();
    expectTypeOf<Parameters<NonNullable<typeof digest.boot>>[0]['access']>().toEqualTypeOf<
      ReturnType<typeof createEntitlements>
    >();
  });

  it('wires the consumer to the instance the provider booted, on the same wire key', async () => {
    const dbPlugin = plugin({ name: 'db', boot: () => ({ db: fakeDb }) });
    const app = await defineApp('provides-test').use(dbPlugin).features([plans, digest]).boot();

    expect(plans.provides.entitlements.key).toBe('entitlements');
    expect(app.services.digestPlan('usr_pro')).toBe('pro');
    expect(app.services.digestPlan('usr_free')).toBe('free');
    expect(app.services.entitlements.planOf('usr_pro')).toBe('pro');
    await app.dispose();
  });

  it('keeps boot order honest: a consumer mounted before its provider fails to compile and to boot', async () => {
    const dbPlugin = plugin({ name: 'db', boot: () => ({ db: fakeDb }) });
    // @ts-expect-error — digest needs `entitlements`, which nothing mounted before it provides.
    const misordered = defineApp('provides-order-test').use(dbPlugin).features([digest, plans]);
    await expect(misordered.boot()).rejects.toThrow(/entitlements/);
  });

  it('mints one stable handle per key', () => {
    expect(plans.provides.entitlements).toBe(plans.provides.entitlements);
  });
});

describe('the hexagon: .use → .features → .serve', () => {
  const dbPlugin = plugin({ name: 'db', boot: () => ({ db: fakeDb }) });

  // A driving adapter in miniature: it reads each mounted feature's slice
  // record through the feature token, exactly as http/queue workers do.
  const collector = driver(features =>
    plugin({
      name: 'collector',
      boot: ctx => ({ collected: features.map(f => [f.name, Object.keys(sliceOf(ctx, f))] as const) }),
    }),
  );

  it('binds a driver to the mounted features — the app never lists them twice', async () => {
    const app = await defineApp('serve-test').use(dbPlugin).features([orders, billing]).serve(collector).boot();
    expect(app.services.collected).toEqual([
      ['orders', ['queue']],
      ['billing', []],
    ]);
    expect(app.manifest.plugins.map(p => p.name)).toEqual(['db', 'orders', 'billing', 'collector']);
    await app.dispose();
  });

  it('mounts a plain plugin in .serve() unchanged', async () => {
    const health = plugin({ name: 'health', needs: { db: service<FakeDb>() }, boot: ({ db }) => ({ health: db.tag }) });
    const app = await defineApp('serve-plain').use(dbPlugin).features([billing]).serve(health).boot();
    expect(app.services.health).toBe('db');
    await app.dispose();
  });

  it('rejects infrastructure after the domain, and the domain outside .features()', () => {
    const kv = plugin({ name: 'kv', boot: () => ({ kv: 'kv' }) });
    const afterDomain = defineApp('phase').use(dbPlugin).features([authish]);
    // @ts-expect-error — driven adapters cannot follow the domain: infra never depends on a feature
    afterDomain.use(kv);
    // @ts-expect-error — one .features() call per app: the domain is declared in one list
    afterDomain.features([billing]);
    // @ts-expect-error — a driving adapter calls into the features, so it cannot sit in .use()
    defineApp('driver-in-use').use(dbPlugin).use(collector);
    // @ts-expect-error — a driven adapter cannot sit in .serve(): it would boot after the domain
    defineApp('driven-in-serve').use(dbPlugin).features([billing]).serve(driven(() => plugin({ name: 'late' })));
    // @ts-expect-error — a feature is not a plugin; it is mounted only through .features()
    defineApp('not-a-plugin').use(dbPlugin).use(authish);
    // @ts-expect-error — authish needs db, which nothing before it provides
    defineApp('missing').features([authish]);
    expect(afterDomain).toBeDefined();
  });

  it('lets a later feature need what an earlier feature provides', async () => {
    const profile = feature('profile', {
      needs: { session: service<{ via: 'db' }>() },
      boot: ({ session }) => ({ profile: `profile:${session.via}` }),
    });
    const app = await defineApp('chain').use(dbPlugin).features([authish, profile]).boot();
    expectTypeOf(app.services.profile).toEqualTypeOf<string>();
    expect(app.services.profile).toBe('profile:db');
    // @ts-expect-error — profile needs session, which authish only provides if it comes first
    defineApp('chain-wrong').use(dbPlugin).features([profile, authish]);
    await app.dispose();
  });
});

describe('a driven adapter that reads the features (.use(driven))', () => {
  // The journal's shape in miniature: it must know every feature's handler
  // declarations when it is built, AND features must be able to write
  // through it — so it boots before them and reads only static declarations.
  const registry = driven(features =>
    plugin({
      name: 'registry',
      boot: () => ({
        registry: {
          handlers: features.flatMap(f => f.use.map(s => `${f.name}:${s.key}`)),
        },
      }),
    }),
  );

  it('sees the final feature list, boots before the features, and serves them as a dependency', async () => {
    const writer = feature('writer', {
      needs: { registry: service<{ handlers: readonly string[] }>() },
      boot: ({ registry: r }) => ({ seenAtBoot: r.handlers }),
    });
    const app = await defineApp('driven-binding').use(registry).features([orders, writer]).boot();
    expect(app.services.seenAtBoot).toEqual(['orders:queue']);
    expect(app.manifest.plugins.map(p => [p.name, p.role])).toEqual([
      ['registry', undefined],
      ['orders', 'feature'],
      ['writer', 'feature'],
    ]);
    await app.dispose();
  });

  it('gets no slice records: those exist only once the features boot', async () => {
    const peeking = driven(features => plugin({ name: 'peeking', boot: ctx => ({ peek: features.map(f => sliceOf(ctx, f)) }) }));
    await expect(defineApp('peek').use(peeking).features([orders]).boot()).rejects.toThrow(/FEATURE_E004|slice record/);
  });
});
