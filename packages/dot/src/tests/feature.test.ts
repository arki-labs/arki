/**
 * The feature contract: declarations are inert data; `.features()` publishes
 * slice payloads under the derived key, attributes slice actions to the
 * feature, and merges its provides; the builder keeps the hexagon's
 * direction (driven → core → driving). These encode WHY the module exists
 * — each would break if the declaration/mount split or the phase order
 * regressed.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { orThrow, UnexpectedDefect } from '@arki/failure';

import type { Provided, ServicesBag, ServicesOf } from '../feature.js';
import { defineFeature } from '../define-feature.js';
import {
  entrypoint,
  entrypointsOf,
  FEATURE_ERROR_CODES,
  providesOf,
  resolveNeeds,
  servicesOf,
  sliceOf,
} from '../feature.js';
import { defineApp, infra, service } from '../index.js';
import { DotLifecycleErrorCode } from '../lifecycle.js';
import { unit } from '../unit-contract.js';

type FakeDb = { readonly tag: 'db' };
const fakeDb: FakeDb = { tag: 'db' };

const queueSlice = {
  kind: 'queue',
  key: 'queue',
  actions: [{ id: 'orders:sync.consume', binding: 'queue', direction: 'in' as const, address: 'orders:sync' }],
  resolve: () => ({ sync: 'job' }),
};

const orders = defineFeature('orders').entrypoints(queueSlice);

const billing = defineFeature('billing').entrypoints();

const authish = defineFeature('authish')
  .needs({ db: service<FakeDb>() })
  .provides({ identity: ({ db }) => ({ via: db.tag }) })
  .entrypoints();

const slice = (key: string) => ({ kind: key, key, actions: [], resolve: () => ({}) });

describe('slice keys', () => {
  it('rejects two slices under one key: the second would silently replace the first when plugged', () => {
    expect(() => defineFeature('twice').entrypoints(slice('routes'), slice('jobs'), slice('routes'))).toThrow(
      expect.objectContaining({
        code: FEATURE_ERROR_CODES.duplicateSliceKey,
        message: expect.stringMatching(/"twice" declares two "routes" entrypoints/),
      }),
    );
  });

  it('accepts slices with distinct keys and the same key in different features', () => {
    expect(() => defineFeature('one').entrypoints(slice('routes'), slice('jobs'))).not.toThrow();
    expect(() => defineFeature('two').entrypoints(slice('routes'))).not.toThrow();
  });
});

describe('mounting features (.features)', () => {
  it('publishes slice payloads under the derived feature token and merges boot provides', async () => {
    const dbUnit = infra({ name: 'db', provides: { db: () => fakeDb } });
    const app = orThrow(await defineApp('feature-test').infra(dbUnit).features([orders, billing, authish]).boot());

    const manifest = app.manifest;
    const ordersUnit = manifest.plugins.find(p => p.name === 'orders');
    expect(ordersUnit).toBeDefined();
    expect(manifest.actions.map(a => a.id)).toContain('orders:sync.consume');

    const services = app.services as Record<string, unknown>;
    expect(services['feature.orders']).toEqual({ queue: { sync: 'job' } });
    expect(services['feature.billing']).toEqual({});
    expect(services['identity']).toEqual({ via: 'db' });

    orThrow(await app.dispose());
  });

  it('mounts features in list order (boot order is the list order)', () => {
    const dbUnit = infra({ name: 'db', provides: { db: () => fakeDb } });
    const { manifest } = orThrow(defineApp('order-test').infra(dbUnit).features([orders, billing]).configure());
    expect(manifest.plugins.map(p => p.name)).toEqual(['db', 'orders', 'billing']);
  });

  it('resolves endpoint-style slices with the feature needs at boot', async () => {
    const dbUnit = infra({ name: 'db', provides: { db: () => fakeDb } });
    const serving = defineFeature('serving')
      .needs({ db: service<FakeDb>() })
      .entrypoints({
        kind: 'routes',
        key: 'routes',
        actions: [],
        resolve: ({ db }: { db: FakeDb }) => ({ boundTo: db.tag }),
      });

    const app = orThrow(await defineApp('slice-services-test').infra(dbUnit).features([serving]).boot());
    const services = app.services as Record<string, unknown>;
    expect(services['feature.serving']).toEqual({ routes: { boundTo: 'db' } });
    orThrow(await app.dispose());
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

  const plans = defineFeature('plans')
    .needs({ db: service<FakeDb>() })
    .provides({
      entitlements: ({ db }) => createEntitlements(db),
      warmedAt: async () => {
        await Promise.resolve();
        return 42;
      },
    })
    .entrypoints();

  const digest = defineFeature('digest')
    .needs({ access: plans.provides.entitlements })
    .provides({
      digestPlan:
        ({ access }) =>
        (userId: string) =>
          access.planOf(userId),
    })
    .entrypoints();

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
    expectTypeOf<Provided<typeof plans.provides.warmedAt>>().toEqualTypeOf<number>();
    // The consumer's factory saw the provider's type through the handle: its result is computed from `access`.
    expectTypeOf<Provided<typeof digest.provides.digestPlan>>().toEqualTypeOf<(userId: string) => 'free' | 'pro'>();
  });

  it('wires the consumer to the instance the provider built, on the same wire key', async () => {
    const dbUnit = infra({ name: 'db', provides: { db: () => fakeDb } });
    const app = orThrow(await defineApp('provides-test').infra(dbUnit).features([plans, digest]).boot());

    expect(app.services.digestPlan('usr_pro')).toBe('pro');
    expect(app.services.digestPlan('usr_free')).toBe('free');
    expect(app.services.entitlements.planOf('usr_pro')).toBe('pro');
    expect(app.services.warmedAt).toBe(42);
    orThrow(await app.dispose());
  });

  it('keeps boot order honest: a consumer mounted before its provider fails to compile and to configure', () => {
    const dbUnit = infra({ name: 'db', provides: { db: () => fakeDb } });
    // @ts-expect-error — digest needs `entitlements`, which nothing mounted before it provides.
    const misordered = defineApp('provides-order-test').infra(dbUnit).features([digest, plans]);
    expect(misordered.configure()).toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.ProviderMountedLater,
        message: expect.stringContaining('entitlements'),
      },
    });
  });

  it('mints one stable handle per key', () => {
    expect(plans.provides.entitlements).toBe(plans.provides.entitlements);
  });
});

const createPlanLookup = () => ({ planOf: (userId: string) => (userId === 'usr_pro' ? 'pro' : 'free') });
const createScorer = () => ({ score: (text: string) => text.length });

describe('services in the request context (gateway → bag → resolveNeeds)', () => {
  const plans = defineFeature('plans').provides({ entitlements: createPlanLookup }).entrypoints();
  const scoring = defineFeature('scoring').provides({ scorer: createScorer }).entrypoints();
  // `needs` lives in its own module in an app (feature.ts and router.ts both
  // import it); a procedure narrows the opaque bag with it.
  const companionNeeds = { access: plans.provides.entitlements, db: service<FakeDb>() };
  const companion = defineFeature('companion').needs(companionNeeds).entrypoints();
  const features = [plans, scoring, companion] as const;

  const gateway = defineFeature('gateway')
    .needs({ ...providesOf(features) })
    .provides({ bag: ctx => servicesOf(ctx, features) as ServicesBag })
    .entrypoints();

  it('ServicesOf is the merged provides of the tuple — named once, never restated', () => {
    type Services = ServicesOf<typeof features>;
    expectTypeOf<keyof Services>().toEqualTypeOf<'entitlements' | 'scorer'>();
    expectTypeOf<Services['entitlements']>().toEqualTypeOf<ReturnType<typeof createPlanLookup>>();
    expectTypeOf<Services['scorer']>().toEqualTypeOf<ReturnType<typeof createScorer>>();
    expect(Object.keys(providesOf(features))).toEqual(['entitlements', 'scorer']);
  });

  it('the gateway is mounted after every provider, or the app does not compile — it never sees a half-built bag', () => {
    const dbUnit = infra({ name: 'db', provides: { db: () => fakeDb } });
    // @ts-expect-error — the gateway spreads every capability into its needs; scoring is mounted after it.
    const halfBuilt = defineApp('half-built').infra(dbUnit).features([plans, gateway, scoring, companion]);
    expect(halfBuilt.configure()).toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.ProviderMountedLater,
        message: expect.stringContaining('scorer'),
      },
    });
  });

  it('a procedure resolves its capability to the very instance the app published — one DI system', async () => {
    const dbUnit = infra({ name: 'db', provides: { db: () => fakeDb } });
    const app = orThrow(
      await defineApp('bag')
        .infra(dbUnit)
        .features([...features, gateway])
        .boot(),
    );
    const resolved = resolveNeeds(app.services.bag, companionNeeds);
    // Infra services (`db`) are not capabilities: they stay on the context explicitly.
    expectTypeOf(resolved).toEqualTypeOf<{ access: ReturnType<typeof createPlanLookup> }>();
    expect(Object.keys(resolved)).toEqual(['access']);
    expect(resolved.access).toBe(app.services.entitlements);
    orThrow(await app.dispose());
  });

  it('a capability missing from the bag throws ARKI_DOT_E026 naming alias, key, provider and the fix', () => {
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

describe('the hexagon: .infra → .features → .entrypoints', () => {
  const dbUnit = infra({ name: 'db', provides: { db: () => fakeDb } });

  // A driving adapter in miniature: it reads each mounted feature's slice
  // record through the feature token, exactly as http/queue workers do.
  const collector = entrypoint.fromFeatures(features =>
    unit({
      name: 'collector',
      provides: { collected: ctx => features.map(f => [f.name, Object.keys(sliceOf(ctx, f))] as const) },
    }),
  );

  it('binds a driver to the mounted features — the app never lists them twice', async () => {
    const app = orThrow(
      await defineApp('serve-test').infra(dbUnit).features([orders, billing]).entrypoints(collector).boot(),
    );
    expect(app.services.collected).toEqual([
      ['orders', ['queue']],
      ['billing', []],
    ]);
    expect(app.manifest.plugins.map(p => p.name)).toEqual(['db', 'orders', 'billing', 'collector']);
    orThrow(await app.dispose());
  });

  it('mounts a plain unit in .entrypoints() unchanged', async () => {
    const health = entrypoint({
      name: 'health',
      needs: { db: service<FakeDb>() },
      provides: { health: ({ db }) => db.tag },
    });
    const app = orThrow(await defineApp('serve-plain').infra(dbUnit).features([billing]).entrypoints(health).boot());
    expect(app.services.health).toBe('db');
    orThrow(await app.dispose());
  });

  it('rejects infrastructure after the domain, and the domain outside .features()', () => {
    const kv = infra({ name: 'kv', provides: { kv: () => 'kv' } });
    const afterDomain = defineApp('phase').infra(dbUnit).features([authish]);
    // @ts-expect-error — driven adapters cannot follow the domain: infra never depends on a feature
    afterDomain.infra(kv);
    // @ts-expect-error — one .features() call per app: the domain is declared in one list
    afterDomain.features([billing]);
    // @ts-expect-error — a driving adapter calls into the features, so it cannot sit in .infra()
    defineApp('driver-in-use').infra(dbUnit).infra(collector);
    defineApp('driven-in-serve')
      .infra(dbUnit)
      .features([billing])
      // @ts-expect-error — a driven adapter cannot sit in .entrypoints(): it would boot after the domain
      .entrypoints(infra.fromFeatures(() => unit({ name: 'late' })));
    // @ts-expect-error — a feature is not a unit; it is mounted only through .features()
    defineApp('not-a-unit').infra(dbUnit).infra(authish);
    // @ts-expect-error — authish needs db, which nothing before it provides
    defineApp('missing').features([authish]);
    expect(afterDomain).toBeDefined();
  });

  it('lets a later feature need what an earlier feature provides', async () => {
    const profile = defineFeature('profile')
      .needs({ identity: service<{ via: 'db' }>() })
      .provides({ profile: ({ identity }) => `profile:${identity.via}` })
      .entrypoints();
    const app = orThrow(await defineApp('chain').infra(dbUnit).features([authish, profile]).boot());
    expectTypeOf(app.services.profile).toEqualTypeOf<string>();
    expect(app.services.profile).toBe('profile:db');
    // @ts-expect-error — profile needs identity, which authish only provides if it comes first
    defineApp('chain-wrong').infra(dbUnit).features([profile, authish]);
    orThrow(await app.dispose());
  });
});

describe('a driven adapter that reads the features (.infra(driven))', () => {
  // The journal's shape in miniature: it must know every feature's handler
  // declarations when it is built, AND features must be able to write
  // through it — so it boots before them and reads only static declarations.
  const registry = infra.fromFeatures(features =>
    unit({
      name: 'registry',
      provides: {
        registry: () => ({
          handlers: features.flatMap(f => entrypointsOf(f).map(s => `${f.name}:${s.key}`)),
        }),
      },
    }),
  );

  it('sees the final feature list, boots before the features, and serves them as a dependency', async () => {
    const writer = defineFeature('writer')
      .needs({ registry: service<{ handlers: readonly string[] }>() })
      .provides({ seenAtBoot: ({ registry: r }) => r.handlers })
      .entrypoints();
    const app = orThrow(await defineApp('driven-binding').infra(registry).features([orders, writer]).boot());
    expect(app.services.seenAtBoot).toEqual(['orders:queue']);
    expect(app.manifest.plugins.map(p => [p.name, p.role])).toEqual([
      ['registry', 'infra'],
      ['orders', 'feature'],
      ['writer', 'feature'],
    ]);
    orThrow(await app.dispose());
  });

  it('gets no slice records: those exist only once the features boot', async () => {
    const peeking = infra.fromFeatures(features =>
      unit({ name: 'peeking', provides: { peek: ctx => features.map(f => sliceOf(ctx, f)) } }),
    );
    const failure = await defineApp('peek').infra(peeking).features([orders]).boot();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    expect(failure).toMatchObject({
      cause: { code: 'ARKI_DOT_E025', message: expect.stringContaining('slice record') },
    });
  });
});
