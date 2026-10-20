import { describe, expect, expectTypeOf, it } from 'vitest';

/**
 * `defineFeature` — the chain form of a feature (RFC 2026-10-15-dot-feature-builder).
 *
 * Why these tests exist: a feature is written once, as a chain, and every
 * later consumer — the kernel, the app builder's guard, `dot explain`,
 * request handlers, schedules, journal collectors, tests — reads that one
 * declaration. Each test below pins one promise of the design; most of them
 * failed on the Revision 1 prototype (see "regressions" at the bottom).
 */
import { orThrow, UnexpectedDefect } from '@arki/failure';

import type {
  AnyFeatureCore,
  DepsOf,
  Entrypoint,
  Provided,
  RpcEntrypoint,
  ServicesBag,
  UsecaseGuard,
} from '../feature.js';
import type { SupervisedUsecase, SupervisedUsecases } from '../kernel/usecase.js';
import { renderExplainText } from '../cli/render-explain.js';
import { textUi } from '../cli/tests/text-ui.js';
import {
  defineFeature,
  driven,
  driver,
  entrypointsOf,
  feature,
  FEATURE_ERROR_CODES,
  resolveNeeds,
  routerFor,
  sliceOf,
} from '../feature.js';
import { defineApp, plugin, testApp } from '../index.js';

/* ---- app infra ---- */

type Db = { readonly query: (sql: string) => Promise<number> };
const database = plugin({ name: 'database', provides: { db: (): Db => ({ query: async sql => sql.length }) } });
const billing = plugin({
  name: 'billing',
  provides: { entitlements: () => ({ planOf: async (userId: string) => (userId === 'u1' ? 'pro' : 'free') }) },
});

/* ---- the digest feature: infra/, usecases/, entrypoints/ ---- */

type Digest = { readonly id: string; readonly userId: string; readonly items: readonly string[] };

/** infra/: the feature's own store — two services, so overriding one must keep the other. */
const store = plugin({
  name: 'store',
  needs: { db: database.provides.db },
  provides: {
    store: ({ db }) => ({
      pendingFor: async (userId: string): Promise<Digest | null> => ({
        id: `d_${await db.query(userId)}`,
        userId,
        items: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
    }),
    stats: ({ db }) => ({ count: async () => db.query('count') }),
  },
});

/** infra/: needs its sibling by the sibling's local handle; the feature qualifies both sides. */
const mailer = plugin({
  name: 'mailer',
  needs: { store: store.provides.store },
  provides: {
    mailer: ({ store }) => ({
      sendPending: async (userId: string) => {
        const pending = await store.pendingFor(userId);
        return `mailed ${pending?.id}`;
      },
    }),
  },
});

/** usecases/: one factory per usecase, each declaring only what it uses, by the adapters' own types. */
type Store = Provided<typeof store.provides.store>;
type Mailer = Provided<typeof mailer.provides.mailer>;
type Plans = Provided<typeof billing.provides.entitlements>;
const preview =
  ({ store, plans }: { store: Store; plans: Plans }) =>
  async (userId: string) => {
    const pending = await store.pendingFor(userId);
    if (!pending) return null;
    const cap = (await plans.planOf(userId)) === 'pro' ? 25 : 3;
    return { ...pending, items: pending.items.slice(0, cap) };
  };
const sendDue =
  ({ mailer }: { mailer: Mailer }) =>
  (userId: string) =>
    mailer.sendPending(userId);
/** The usecases object the chain should build, written out by hand so the test can fail. */
type DigestUsecases = { readonly preview: ReturnType<typeof preview>; readonly sendDue: ReturnType<typeof sendDue> };

/* ---- minimal entrypoint descriptors: the protocol `@arki/dot/orpc`, `@arki/schedule` and `@arki/journal` implement ---- */

const digestContract = { preview: { path: '/digest/preview' } } as const;

const rpc = <C extends object, R>(contract: C, router: R): RpcEntrypoint<C, R> => ({
  kind: 'rpc',
  key: 'rpc',
  actions: [],
  contract,
  router,
  resolve: () => router,
});

const schedules = <C extends AnyFeatureCore>(
  _core: C,
  defs: readonly { readonly name: string; readonly handler: (services: DepsOf<C>) => unknown }[],
): Entrypoint<DepsOf<C>> & { readonly key: 'schedules' } => ({
  kind: 'schedules',
  key: 'schedules',
  actions: defs.map(d => ({ id: `${d.name}.tick`, binding: 'cron', direction: 'in' as const })),
  resolve: services => defs.map(d => ({ name: d.name, run: async () => d.handler(services) })),
});

const effects = <C extends AnyFeatureCore>(
  _core: C,
  defs: readonly {
    readonly name: string;
    readonly events: readonly string[];
    readonly run: (services: DepsOf<C>) => Promise<string>;
  }[],
): Entrypoint<DepsOf<C>> & { readonly key: 'journal' } => ({
  kind: 'journal',
  key: 'journal',
  actions: defs.map(d => ({
    id: `${d.name}.run`,
    binding: 'journal',
    direction: 'in' as const,
    address: d.name,
    metaSchema: '@arki/journal/action-meta@1',
    meta: { events: [...d.events] },
  })),
  resolve: services => defs.map(d => ({ name: d.name, run: () => d.run(services) })),
});

/* ---- feature.ts ---- */

const digestDeps = defineFeature('digest')
  .needs({ db: database.provides.db, plans: billing.provides.entitlements })
  .infra(store, mailer);
const digestLogic = digestDeps.usecases({ preview, sendDue });

/** entrypoints/procedures.ts: a factory over the logic stage (`import type` in a real app), resolving the handles per request. */
const procedures = (c: typeof digestLogic) => ({
  preview: async (services: ServicesBag, userId: string) => resolveNeeds(services, c.handles).usecases.preview(userId),
});

const digest = digestLogic
  .provides({ digests: ({ usecases, store }) => ({ previewFor: usecases.preview, raw: store.pendingFor }) })
  .entrypoints(
    rpc(digestContract, procedures(digestLogic)),
    schedules(digestLogic, [{ name: 'nightly-preview', handler: ({ usecases }) => usecases.preview('u1') }]),
    effects(digestLogic, [
      {
        name: 'send-on-request',
        events: ['DigestRequested'],
        run: async ({ usecases }) => orThrow(await usecases.sendDue('u1')),
      },
    ]),
  );

type Runnable = { readonly name: string; readonly run: () => Promise<unknown> };
function runnables(value: unknown): readonly Runnable[] {
  if (!Array.isArray(value)) throw new Error('expected a list of runnables');
  return value.filter(
    (v): v is Runnable => typeof v === 'object' && v !== null && 'run' in v && typeof v.run === 'function',
  );
}

const boot = (f: typeof digest) => defineApp('digest-app').infra(database, billing).features([f]).start();

describe('the chain: each step typed from the earlier ones', () => {
  it('runs a request through the handles: needs, private infra and usecases resolve from the services bag', async () => {
    const app = orThrow(await boot(digest));
    // 'u1' is pro: 6 items survive the cap — the usecase saw both the store and billing.
    const preview = orThrow(await digest.router.preview(app.services, 'u1'));
    expect(preview?.items).toHaveLength(6);
    orThrow(await app.dispose());
  });

  it('publishes typed public handles another feature can need', async () => {
    const app = orThrow(await boot(digest));
    const result = orThrow(await app.services.digests.previewFor('u2'));
    expect(result?.items).toHaveLength(3);
    expectTypeOf<Provided<typeof digest.provides.digests>['previewFor']>().toEqualTypeOf<
      SupervisedUsecase<ReturnType<typeof preview>>
    >();
    orThrow(await app.dispose());
  });

  it('hands every entrypoint the usecases: schedules and effects run through them', async () => {
    const app = orThrow(await boot(digest));
    const slices = app.services['feature.digest'];
    expect(await runnables(slices.schedules)[0]?.run()).toMatchObject({ id: 'd_2' });
    // The effect goes usecases → mailer → store: the mailer's need on its sibling resolved.
    expect(await runnables(slices.journal)[0]?.run()).toBe('mailed d_2');
    orThrow(await app.dispose());
  });

  it('builds the usecases object once per boot and anew for the next boot', async () => {
    let builds = 0;
    const counted = defineFeature('counted')
      .usecases({ id: () => ++builds })
      .provides({ a: ({ usecases }) => usecases, b: ({ usecases }) => usecases })
      .entrypoints();
    const first = orThrow(await defineApp('a').features([counted]).start());
    expect(first.services.a).toBe(first.services.b);
    expect(first.services['counted.usecases']).toBe(first.services.a);
    const second = orThrow(await defineApp('b').features([counted]).start());
    expect(second.services.a.id).toBe(2);
    expect(await Promise.all([first.dispose(), second.dispose()])).toEqual([undefined, undefined]);
  });

  it('types the usecases deps, the handles and the entrypoint services from the chain', () => {
    expectTypeOf<Provided<typeof digestLogic.handles.usecases>>().toEqualTypeOf<SupervisedUsecases<DigestUsecases>>();
    type HandlerContext = ReturnType<typeof resolveNeeds<typeof digestLogic.handles>>;
    expectTypeOf<HandlerContext>().toHaveProperty('mailer');
    expectTypeOf<HandlerContext>().toHaveProperty('plans');
    expectTypeOf<HandlerContext['store']>().toEqualTypeOf<Store>();
    // `db` is the feature's own need (the store takes it from the feature), so a handler sees it too.
    expectTypeOf<HandlerContext['db']>().toEqualTypeOf<Db>();
    expectTypeOf<DepsOf<typeof digestLogic>['usecases']>().toEqualTypeOf<SupervisedUsecases<DigestUsecases>>();
    // Before `.usecases()`, `DepsOf` is what a usecase may ask for: needs + infra, and no `usecases` yet.
    expectTypeOf<keyof DepsOf<typeof digestDeps>>().toEqualTypeOf<'db' | 'plans' | 'store' | 'stats' | 'mailer'>();
  });

  it('rejects steps out of order at compile time', () => {
    const unused = () => {
      // @ts-expect-error -- `needs` comes before `infra`
      defineFeature('x').infra(store).needs({});
      // @ts-expect-error -- `infra` is one step
      defineFeature('x').infra(store).infra(mailer);
      const provided = defineFeature('x').provides({});
      // @ts-expect-error -- `usecases` comes before `provides`
      provided.usecases({});
    };
    expect(unused).toBeTypeOf('function');
  });

  it('accepts empty steps without widening the later checks', () => {
    const empty = defineFeature('x')
      .needs({ db: database.provides.db })
      .infra(store)
      .usecases({})
      .provides({})
      .entrypoints(rpc({}, {}));
    expect(empty.plugins().map(p => p.name)).toEqual(['x/store', 'x']);
  });

  it('infers inline usecase deps: `({ stats }) => …` gets the feature deps with no annotation', () => {
    const lean = defineFeature('x')
      .needs({ db: database.provides.db, plans: billing.provides.entitlements })
      .infra(store);
    const logic = lean.usecases({
      count:
        ({ stats }) =>
        () =>
          stats.count(),
      planOf:
        ({ plans, store: digests }) =>
        async (userId: string) => ({ plan: await plans.planOf(userId), pending: await digests.pendingFor(userId) }),
    });
    expectTypeOf<Provided<typeof logic.handles.usecases>>().toEqualTypeOf<
      SupervisedUsecases<{
        readonly count: () => Promise<number>;
        readonly planOf: (userId: string) => Promise<{ plan: string; pending: Digest | null }>;
      }>
    >();
    expect(logic.name).toBe('x');
  });

  it('rejects usecases that ask for what neither needs nor infra provide', () => {
    const lean = defineFeature('x')
      .needs({ db: database.provides.db, plans: billing.provides.entitlements })
      .infra(store);
    const unused = () => {
      // @ts-expect-error -- `queue` is neither a need nor an infra service
      lean.usecases({ needsQueue: (deps: { queue: unknown }) => deps });
      // @ts-expect-error -- a factory borrowed from a feature with a mailer: `x` has none
      lean.usecases({ sendDue });
      // @ts-expect-error -- a usecase file that Picks a dep the feature lacks fails in that file
      type BadPick = Pick<DepsOf<typeof lean>, 'mailer'>;
      return null as unknown as BadPick;
    };
    expect(unused).toBeTypeOf('function');
  });

  it('names the usecase and the missing dep in the error', () => {
    const lean = defineFeature('x').needs({ db: database.provides.db }).infra(store);
    // An instantiation expression (`typeof lean.usecases<F>`) checks F against EVERY overload, so the label is
    // read off the guard the fallback overload carries; the call itself is the `@ts-expect-error` above.
    type Guard = UsecaseGuard<DepsOf<typeof lean>, { sendDue: typeof sendDue }>;
    expectTypeOf<Guard['DOT: a usecase asks for a dep the feature does not provide']>().toEqualTypeOf<{
      readonly sendDue: 'mailer';
    }>();
    expect(lean.name).toBe('x');
  });

  it('accepts a usecase whose returned function has a default parameter', () => {
    const lean = defineFeature('x').needs({ db: database.provides.db }).infra(store);
    type Deps = DepsOf<typeof lean>;
    // A usecase file: `(deps) => (fail = false) => …`. The default makes the inner parameter optional; that is
    // the usecase's own shape and says nothing about which deps the factory asks for.
    const pendingOrNull =
      ({ store }: Pick<Deps, 'store'>) =>
      (fail = false) =>
        fail ? null : store.pendingFor('u1');
    const logic = lean.usecases({
      pendingOrNull,
      inline:
        ({ store }: Pick<Deps, 'store'>) =>
        (fail = false) =>
          fail ? null : store.pendingFor('u1'),
    });
    expectTypeOf<Provided<typeof logic.handles.usecases>['pendingOrNull']>().toEqualTypeOf<
      SupervisedUsecase<ReturnType<typeof pendingOrNull>>
    >();
    expectTypeOf<Provided<typeof logic.handles.usecases>['inline']>().toEqualTypeOf<
      SupervisedUsecase<(fail?: boolean) => Promise<Digest | null> | null>
    >();
    expect(logic.name).toBe('x');
    const unused = () => {
      // The default parameter buys nothing: a dep the feature lacks is still a compile error.
      const needsMailer =
        ({ mailer }: { mailer: Mailer }) =>
        (fail = false) =>
          fail ? null : mailer.sendPending('u1');
      // @ts-expect-error -- `mailer` is neither a need nor an infra service of `x`
      lean.usecases({ needsMailer });
      // @ts-expect-error -- the same, written inline: the second inference pass still checks the deps
      lean.usecases({
        needsMailer:
          ({ mailer }: { mailer: Mailer }) =>
          (fail = false) =>
            fail ? null : mailer.sendPending('u1'),
      });
    };
    expect(unused).toBeTypeOf('function');
  });

  it('accepts factories that ask for a subset of the deps, or for nothing', async () => {
    const lean = defineFeature('lean')
      .needs({ db: database.provides.db })
      .infra(store)
      .usecases({ raw: ({ store }: { store: Store }) => store.pendingFor, ping: () => () => 'pong' })
      .provides({ lean: ({ usecases }) => usecases })
      .entrypoints();
    const app = orThrow(await defineApp('lean').infra(database).features([lean]).start());
    expect(app.services.lean.ping()).toBe('pong');
    expect(await app.services.lean.raw('u1')).toMatchObject({ id: 'd_2' });
    orThrow(await app.dispose());
  });

  it('types schedule handlers in another file by the logic stage alone', () => {
    const unused = () =>
      // @ts-expect-error -- `nope` is not among the logic stage's services
      schedules(digestLogic, [{ name: 'n', handler: ({ nope }) => nope }]);
    expect(unused).toBeTypeOf('function');
  });
});

describe('compilation into kernel units', () => {
  it('compiles to the qualified infra plugins, then the feature plugin', () => {
    expect(digest.plugins().map(p => p.name)).toEqual(['digest/store', 'digest/mailer', 'digest']);
    expect(Object.keys(digest.plugins()[0].provides)).toEqual(['digest.store', 'digest.stats']);
    expect(digest.plugins()[2].role).toBe('feature');
  });

  it('keeps private keys private: two features may each have a `store`', async () => {
    const other = defineFeature('other')
      .needs({ db: database.provides.db })
      .infra(store)
      .provides({ n: ({ stats }) => stats })
      .entrypoints();
    const app = orThrow(await defineApp('two').infra(database, billing).features([digest, other]).start());
    expect(app.services['digest.store']).not.toBe(app.services['other.store']);
    orThrow(await app.dispose());
  });

  it('puts every edge in the manifest and in `dot explain`: feature → private infra → app infra', async () => {
    const app = orThrow(await boot(digest));
    const unit = (name: string) => app.manifest.plugins.find(p => p.name === name);
    expect(unit('digest')?.dependencies).toEqual([
      'db',
      'entitlements',
      'digest.store',
      'digest.stats',
      'digest.mailer',
    ]);
    expect(unit('digest/mailer')?.dependencies).toEqual(['digest.store']);
    expect(unit('digest/store')?.dependencies).toEqual(['db']);
    const explained = textUi();
    renderExplainText(app.manifest, explained.ui);
    const text = explained.text();
    expect(text).toContain('digest --[digest.store]--> digest/store');
    expect(text).toContain('digest/mailer --[digest.store]--> digest/store');
    expect(text).toContain('digest/store --[db]--> database');
    expect(text).toContain('digest --[entitlements]--> billing');
    orThrow(await app.dispose());
  });

  it('exposes entrypoint metadata before boot: journal effects carry their event names', () => {
    // A collector (the journal) reads this before any feature boots.
    const featureUnit = digest.plugins()[2];
    expect(featureUnit.actions).toContainEqual(
      expect.objectContaining({ id: 'send-on-request.run', meta: { events: ['DigestRequested'] } }),
    );
    const configured = orThrow(defineApp('static').infra(database, billing).features([digest]).configure());
    expect(configured.manifest.actions).toContainEqual(
      expect.objectContaining({ id: 'send-on-request.run', plugin: 'digest' }),
    );
  });

  it('keeps the kernel order checks: the feature before its own infra (E020), or without it (E012)', async () => {
    const [storeUnit, mailerUnit, featureUnit] = digest.plugins();
    // @ts-expect-error -- the feature before its own infra: the tuple guard on testApp's argument refuses it too
    await expect(testApp([database, billing, featureUnit, storeUnit, mailerUnit]).start()).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: { code: 'ARKI_DOT_E020' },
    });
    // @ts-expect-error -- the feature without its infra
    await expect(testApp([database, billing, featureUnit]).start()).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: { code: 'ARKI_DOT_E012' },
    });
  });
});

describe('override (tests swap infra before compilation)', () => {
  const fakeStore = { pendingFor: async (userId: string) => ({ id: 'fake', userId, items: ['x'] }) };

  it('keeps the feature whole: same type, same entrypoints, one provider per key', async () => {
    const faked = digest.override({ store: fakeStore });
    expectTypeOf(faked).toEqualTypeOf<typeof digest>();
    expect(faked.plugins().map(p => p.name)).toEqual(['digest/store', 'digest/mailer', 'digest']);
    const app = orThrow(await boot(faked));
    const preview = orThrow(await faked.router.preview(app.services, 'u1'));
    expect(preview?.id).toBe('fake');
    expect(await runnables(app.services['feature.digest'].journal)[0]?.run()).toBe('mailed fake');
    orThrow(await app.dispose());
  });

  it('is typed by the port and rejects keys no infra plugin provides', () => {
    // @ts-expect-error -- wrong shape for `store`
    expect(() => digest.override({ store: { nope: 1 } })).not.toThrow();
    // @ts-expect-error -- `queue` is not an infra service of this feature
    expect(() => digest.override({ queue: {} })).toThrow(
      expect.objectContaining({ code: FEATURE_ERROR_CODES.unknownOverride }),
    );
  });
});

describe('reserved names and collisions: compile errors, with a runtime check behind them', () => {
  const collision = expect.objectContaining({ code: FEATURE_ERROR_CODES.keyCollision });

  it('rejects request-context keys and `usecases` as need aliases', () => {
    // @ts-expect-error -- `session` is a request-context key
    expect(() => defineFeature('x').needs({ session: billing.provides.entitlements })).toThrow(collision);
    // @ts-expect-error -- `usecases` is reserved
    expect(() => defineFeature('x').needs({ usecases: billing.provides.entitlements })).toThrow(collision);
  });

  it('rejects an infra key equal to a reserved name or to a need alias', () => {
    const sessionPlugin = plugin({ name: 'p', provides: { session: () => 1 } });
    // @ts-expect-error -- a private `session` would shadow the request's session
    expect(() => defineFeature('x').infra(sessionPlugin)).toThrow(collision);
    const withStoreNeed = defineFeature('x').needs({ store: billing.provides.entitlements });
    // @ts-expect-error -- infra `store` collides with the need alias `store`
    expect(() => withStoreNeed.infra(store)).toThrow(collision);
  });

  it('rejects a provided service named `usecases`', () => {
    // @ts-expect-error -- `usecases` is reserved
    expect(() => defineFeature('x').provides({ usecases: () => 1 })).toThrow(collision);
  });

  it('rejects an entrypoint key equal to a provided key', () => {
    const provider = defineFeature('x').provides({ rpc: () => 1 });
    // @ts-expect-error -- the entrypoint `rpc` collides with the provided service `rpc`
    expect(() => provider.entrypoints(rpc({}, {}))).toThrow(collision);
  });
});

describe('routerFor: mount keys written once, in the app contract', () => {
  const plain = defineFeature('plain')
    .provides({ x: () => 1 })
    .entrypoints();

  it('finds each feature by its contract and skips features without an rpc entrypoint', () => {
    const rpcContract = { digest: digestContract };
    const router = routerFor(rpcContract, [digest, plain]);
    expect(router.digest).toBe(digest.router);
    expectTypeOf(router.digest).toEqualTypeOf<typeof digest.router>();
  });

  it('rejects an app-contract key no feature implements', () => {
    const rpcContract = { digest: digestContract, other: { ping: { path: '/ping' } } };
    // @ts-expect-error -- `other` has no feature
    expect(() => routerFor(rpcContract, [digest])).toThrow(
      expect.objectContaining({ code: FEATURE_ERROR_CODES.contractOwner }),
    );
  });

  it('rejects a feature whose contract the app contract does not mount', () => {
    // @ts-expect-error -- digest's contract is not mounted
    expect(() => routerFor({}, [digest])).toThrow(
      expect.objectContaining({ code: FEATURE_ERROR_CODES.contractNotMounted }),
    );
  });
});

describe('defineApp: .infra() / .features() / .entrypoints()', () => {
  it('mounts .infra() units in argument order, so `log(...)` given first boots first', () => {
    const configured = orThrow(defineApp('order').infra(database, billing, store).configure());
    expect(configured.manifest.plugins.map(p => p.name)).toEqual(['database', 'billing', 'store']);
  });

  it('checks .infra(), .features() and .entrypoints() lists at compile time', () => {
    const unused = () => {
      // @ts-expect-error -- `store` needs `db`, which nothing before it provides
      defineApp('x').infra(store, database);
      // @ts-expect-error -- digest needs `entitlements`
      defineApp('x').infra(database).features([digest]);
      const needsDigests = plugin({ name: 'gateway', needs: { digests: digest.provides.digests } });
      // @ts-expect-error -- `digests` comes from a feature, so the gateway cannot sit in .infra()
      defineApp('x').infra(database, billing, needsDigests);
      return defineApp('x').infra(database, billing).features([digest]).entrypoints(needsDigests);
    };
    expect(unused).toBeTypeOf('function');
  });

  it('mounts object-form and chain features side by side; drivers in .entrypoints() see both', async () => {
    const legacy = feature('legacy', {
      use: [{ key: 'schedules', actions: [], resolve: () => [{ name: 'legacy-tick' }] }],
    });
    const seen: unknown[] = [];
    const scheduler = driver(features =>
      plugin({
        name: 'scheduler',
        boot: ctx => {
          for (const f of features) seen.push([f.name, sliceOf(ctx, f)['schedules']]);
        },
      }),
    );
    const app = orThrow(
      await defineApp('mixed').infra(database, billing).features([legacy, digest]).entrypoints(scheduler).start(),
    );
    expect(seen.map(entry => (Array.isArray(entry) ? entry[0] : undefined))).toEqual(['legacy', 'digest']);
    expect(app.manifest.plugins.find(p => p.name === 'scheduler')?.role).toBe('driving');
    orThrow(await app.dispose());
  });

  it('lets a driven adapter in .infra() read entrypoint declarations before the features boot', async () => {
    let declared: readonly string[] = [];
    const collector = driven(features =>
      plugin({
        name: 'collector',
        boot: () => {
          declared = features.flatMap(f => entrypointsOf(f).map(slice => `${f.name}:${slice.key}`));
        },
      }),
    );
    const app = orThrow(await defineApp('collect').infra(database, billing, collector).features([digest]).start());
    expect(declared).toEqual(['digest:rpc', 'digest:schedules', 'digest:journal']);
    orThrow(await app.dispose());
  });
});

/**
 * Regressions from the Revision 1 prototype, found in Astra's review. Each
 * failed there and passes here; each names what broke.
 */
describe('regressions (Astra review of Revision 1)', () => {
  it('1. override of one service keeps the sibling services of the same plugin', async () => {
    // Revision 1 turned the plugin into a fake of the first matching key and dropped `stats`.
    const app = orThrow(await boot(digest.override({ store: { pendingFor: async () => null } })));
    expect(await app.services['digest.stats'].count()).toBe(5);
    orThrow(await app.dispose());
  });

  it('2. a qualified infra key remaps the needs of its siblings (no E012)', async () => {
    // Revision 1 left mailer needing the wire key `store` after qualifying it to `digest.store`.
    const app = orThrow(await boot(digest));
    expect(await app.services['digest.mailer'].sendPending('u1')).toBe('mailed d_2');
    orThrow(await app.dispose());
  });

  it('3. a reserved alias or a key collision never silently overwrites the request context or a factory', () => {
    // Revision 1 accepted a private `session` and an entrypoint keyed like a provided service.
    const sessionPlugin = plugin({ name: 'p', provides: { session: () => 'forged' } });
    // @ts-expect-error -- compile error; and the runtime check below for erased callers
    expect(() => defineFeature('x').infra(sessionPlugin)).toThrow(
      expect.objectContaining({ code: FEATURE_ERROR_CODES.keyCollision }),
    );
  });

  it('4. plugins() keeps its tuple type, so the app builder guard can check it', () => {
    // Revision 1 returned `readonly AnyPlugin[]`, and `useAll` then demanded an error argument.
    expectTypeOf<ReturnType<typeof digest.plugins>['length']>().toEqualTypeOf<3>();
    expectTypeOf<Provided<ReturnType<typeof digest.plugins>[0]['provides']['digest.store']>>().toEqualTypeOf<
      Provided<typeof store.provides.store>
    >();
    const unused = () => {
      // @ts-expect-error -- the feature unit before its own infra: `digest.store` is not available yet
      defineApp('x').use(database).use(billing).use(digest.plugins()[2]);
      return defineApp('y').use(database).use(billing).useAll(digest.plugins());
    };
    expect(unused).toBeTypeOf('function');
  });
});
