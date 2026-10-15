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

import type { AnyFeature, ComposedRepos, Handle, ServicesBag, ServicesOf } from '../feature.js';
import {
  composeRepos,
  composeRouter,
  driven,
  driver,
  entrypointsOf,
  feature,
  FEATURE_ERROR_CODES,
  plug,
  providesOf,
  resolveNeeds,
  servicesOf,
  sliceOf,
  tokenOf,
} from '../feature.js';

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
  provides: { session: ({ db }) => ({ via: db.tag }) },
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
    const dbPlugin = plugin({ name: 'db', provides: { db: () => fakeDb } });
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
    const dbPlugin = plugin({ name: 'db', provides: { db: () => fakeDb } });
    const { manifest } = defineApp('order-test').use(dbPlugin).features([orders, billing]).configure();
    expect(manifest.plugins.map(p => p.name)).toEqual(['db', 'orders', 'billing']);
    expect(plug(orders).name).toBe('orders');
  });

  it('resolves endpoint-style slices with the feature needs at boot', async () => {
    const dbPlugin = plugin({ name: 'db', provides: { db: () => fakeDb } });
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
    provides: {
      entitlements: ({ db }) => createEntitlements(db),
      warmedAt: async () => {
        await Promise.resolve();
        return 42;
      },
    },
    boot: ({ entitlements, warmedAt }) => {
      expectTypeOf(entitlements).toEqualTypeOf<ReturnType<typeof createEntitlements>>();
      expectTypeOf(warmedAt).toEqualTypeOf<number>();
    },
  });

  const digest = feature('digest', {
    needs: { access: plans.provides.entitlements },
    provides: { digestPlan: ({ access }) => (userId: string) => access.planOf(userId) },
  });

  it('the graph is data: handle keys equal the factory keys and carry their provider before anything boots', () => {
    // dot explain and the kernel's configure-time checks read these keys
    // without booting — a handle minted only at boot would hide the graph.
    expect(Object.keys(plans.provides)).toEqual(['entitlements', 'warmedAt']);
    expect(plans.provides.entitlements).toMatchObject({ key: 'entitlements', provider: 'plans' });
    expect(plans.provides.warmedAt).toMatchObject({ key: 'warmedAt', provider: 'plans' });
    expectTypeOf(plans.provides.entitlements.provider).toEqualTypeOf<'plans'>();
  });

  it("types each factory from the feature's needs and each handle from the factory's return — nothing restated", () => {
    expectTypeOf(plans.provides.entitlements.key).toEqualTypeOf<'entitlements'>();
    // An async factory's handle carries the resolved value, not the promise.
    expectTypeOf(plans.provides.warmedAt).toEqualTypeOf<Handle<number, 'warmedAt', 'plans'>>();
    expectTypeOf<Parameters<typeof digest.factories.digestPlan>[0]['access']>().toEqualTypeOf<
      ReturnType<typeof createEntitlements>
    >();
  });

  it('wires the consumer to the instance the provider built, on the same wire key', async () => {
    const dbPlugin = plugin({ name: 'db', provides: { db: () => fakeDb } });
    const app = await defineApp('provides-test').use(dbPlugin).features([plans, digest]).boot();

    expect(app.services.digestPlan('usr_pro')).toBe('pro');
    expect(app.services.digestPlan('usr_free')).toBe('free');
    expect(app.services.entitlements.planOf('usr_pro')).toBe('pro');
    expect(app.services.warmedAt).toBe(42);
    await app.dispose();
  });

  it('keeps boot order honest: a consumer mounted before its provider fails to compile and to configure', () => {
    const dbPlugin = plugin({ name: 'db', provides: { db: () => fakeDb } });
    // @ts-expect-error — digest needs `entitlements`, which nothing mounted before it provides.
    const misordered = defineApp('provides-order-test').use(dbPlugin).features([digest, plans]);
    expect(() => misordered.configure()).toThrow(/entitlements/);
  });

  it('mints one stable handle per key', () => {
    expect(plans.provides.entitlements).toBe(plans.provides.entitlements);
  });
});

const createPlanLookup = () => ({ planOf: (userId: string) => (userId === 'usr_pro' ? 'pro' : 'free') });
const createScorer = () => ({ score: (text: string) => text.length });

describe('services in the request context (gateway → bag → resolveNeeds)', () => {
  const plans = feature('plans', { provides: { entitlements: createPlanLookup } });
  const scoring = feature('scoring', { provides: { scorer: createScorer } });
  // `needs` lives in its own module in an app (feature.ts and router.ts both
  // import it); a procedure narrows the opaque bag with it.
  const companionNeeds = { access: plans.provides.entitlements, db: service<FakeDb>() };
  const companion = feature('companion', { needs: companionNeeds });
  const features = [plans, scoring, companion] as const;

  const gateway = feature('gateway', {
    needs: { ...providesOf(features) },
    provides: { bag: ctx => servicesOf(ctx, features) as ServicesBag },
  });

  it('ServicesOf is the merged provides of the tuple — named once, never restated', () => {
    type Services = ServicesOf<typeof features>;
    expectTypeOf<keyof Services>().toEqualTypeOf<'entitlements' | 'scorer'>();
    expectTypeOf<Services['entitlements']>().toEqualTypeOf<ReturnType<typeof createPlanLookup>>();
    expectTypeOf<Services['scorer']>().toEqualTypeOf<ReturnType<typeof createScorer>>();
    expect(Object.keys(providesOf(features))).toEqual(['entitlements', 'scorer']);
  });

  it('the gateway is mounted after every provider, or the app does not compile — it never sees a half-built bag', () => {
    const dbPlugin = plugin({ name: 'db', provides: { db: () => fakeDb } });
    // @ts-expect-error — the gateway spreads every capability into its needs; scoring is mounted after it.
    const halfBuilt = defineApp('half-built').use(dbPlugin).features([plans, gateway, scoring, companion]);
    expect(() => halfBuilt.configure()).toThrow(/DOT_LIFECYCLE_E020|"scorer"/);
  });

  it('a procedure resolves its capability to the very instance the app published — one DI system', async () => {
    const dbPlugin = plugin({ name: 'db', provides: { db: () => fakeDb } });
    const app = await defineApp('bag').use(dbPlugin).features([...features, gateway]).boot();
    const resolved = resolveNeeds(app.services.bag, companionNeeds);
    // Driven services (`db`) are not capabilities: they stay on the context explicitly.
    expectTypeOf(resolved).toEqualTypeOf<{ access: ReturnType<typeof createPlanLookup> }>();
    expect(Object.keys(resolved)).toEqual(['access']);
    expect(resolved.access).toBe(app.services.entitlements);
    await app.dispose();
  });

  it('a capability missing from the bag throws FEATURE_E005 naming alias, key, provider and the fix', () => {
    expect(() => resolveNeeds({}, companionNeeds)).toThrow(
      expect.objectContaining({
        code: FEATURE_ERROR_CODES.missingCapability,
        message:
          '[feature] "access" (capability "entitlements" from feature "plans") is not in the request context\'s services bag.',
        remediation:
          "Spread providesOf(features) into the gateway's needs and pass servicesOf(ctx, features) to createContext.",
      }),
    );
  });
});

describe('the hexagon: .use → .features → .serve', () => {
  const dbPlugin = plugin({ name: 'db', provides: { db: () => fakeDb } });

  // A driving adapter in miniature: it reads each mounted feature's slice
  // record through the feature token, exactly as http/queue workers do.
  const collector = driver(features =>
    plugin({
      name: 'collector',
      provides: { collected: ctx => features.map(f => [f.name, Object.keys(sliceOf(ctx, f))] as const) },
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
    const health = plugin({ name: 'health', needs: { db: service<FakeDb>() }, provides: { health: ({ db }) => db.tag } });
    const app = await defineApp('serve-plain').use(dbPlugin).features([billing]).serve(health).boot();
    expect(app.services.health).toBe('db');
    await app.dispose();
  });

  it('rejects infrastructure after the domain, and the domain outside .features()', () => {
    const kv = plugin({ name: 'kv', provides: { kv: () => 'kv' } });
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
      provides: { profile: ({ session }) => `profile:${session.via}` },
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
      provides: {
        registry: () => ({
          handlers: features.flatMap(f => entrypointsOf(f).map(s => `${f.name}:${s.key}`)),
        }),
      },
    }),
  );

  it('sees the final feature list, boots before the features, and serves them as a dependency', async () => {
    const writer = feature('writer', {
      needs: { registry: service<{ handlers: readonly string[] }>() },
      provides: { seenAtBoot: ({ registry: r }) => r.handlers },
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
    const peeking = driven(features => plugin({ name: 'peeking', provides: { peek: ctx => features.map(f => sliceOf(ctx, f)) } }));
    await expect(defineApp('peek').use(peeking).features([orders]).boot()).rejects.toThrow(/FEATURE_E004|slice record/);
  });
});
