/**
 * Smoke tests for the public defineApp surface (v2).
 *
 * Includes the compile-time wiring-guard assertions: `@ts-expect-error`
 * cases fail the typecheck if the guard ever stops firing.
 */

import type { ScopePlan } from '@arki/async';
import { child, cleanup } from '@arki/async';
import { defineFailure, orThrow } from '@arki/failure';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DotApp } from '../define-app.js';
import type { EmptyShape, EmptyOwnership, PluginOpenFailure, PluginCloseFailure } from '../plugin-contract.js';
import { defineApp } from '../define-app.js';
import { feature } from '../feature.js';
import { initPlugins } from '../init-plugins.js';
import { plugin, rename, service } from '../plugin-contract.js';
import { testApp } from '../test-harness.js';

type DbService = {
  query(sql: string): Promise<null>;
};
type AuthService = {
  verify(token: string): boolean;
};

const makeDbPlugin = () =>
  plugin({
    name: 'db',
    provides: {
      db: (): DbService => ({ query: async (_sql: string) => null }),
    },
  });

describe('defineApp', () => {
  it('defineApp(name) returns a builder', () => {
    const builder = defineApp('app');
    expect(typeof builder.use).toBe('function');
    expect(typeof builder.boot).toBe('function');
    expect(typeof builder.start).toBe('function');
    expect(typeof builder.configure).toBe('function');
  });

  it('builder.use() with a plugin returns a new builder (immutable)', () => {
    const p = plugin({ name: 'p' });
    const b1 = defineApp('app');
    const b2 = b1.use(p);
    expect(b1).not.toBe(b2);
  });

  it('builder.boot() returns a DotApp with state=booted', async () => {
    const p = plugin({
      name: 'p',
      boot: () => {
        /* side effects only */
      },
    });
    const app = orThrow(await defineApp('app').use(p).boot());
    expect(app.state).toBe('booted');
    expect(app.name).toBe('app');
    orThrow(await app.dispose());
  });

  it('type-level: app.services is correctly typed from accumulated .use() calls', async () => {
    const dbPlugin = makeDbPlugin();
    const authPlugin = plugin({
      name: 'auth',
      provides: {
        auth: () => ({ verify: (_token: string) => true }) satisfies AuthService,
      },
    });

    const app = orThrow(await defineApp('app').use(dbPlugin).use(authPlugin).boot());
    expectTypeOf(app.services).toMatchTypeOf<{ db: DbService; auth: AuthService }>();
    expect(app.services.db).toBeDefined();
    expect(app.services.auth).toBeDefined();
    orThrow(await app.dispose());
  });

  it('boot destructures typed services from the needs shape', async () => {
    const dbPlugin = makeDbPlugin();
    let observed: DbService | undefined;
    const consumer = plugin({
      name: 'consumer',
      needs: { db: service<DbService>() },
      boot: ({ db, $app, $plugin }) => {
        expectTypeOf(db).toEqualTypeOf<DbService>();
        expect($app).toBe('app');
        expect($plugin).toBe('consumer');
        observed = db;
      },
    });

    const app = orThrow(await defineApp('app').use(dbPlugin).use(consumer).boot());
    expect(observed).toBe(app.services.db);
    orThrow(await app.dispose());
  });

  it('compile-time guard: unsatisfied needs fail .use() at the call site', () => {
    const consumer = plugin({
      name: 'consumer',
      needs: { db: service<DbService>() },
      boot: ({ db }) => {
        void db;
      },
    });
    // @ts-expect-error — nothing provides `db` yet
    defineApp('app').use(consumer);
    // Wrong order is a compile error too (declaration order IS boot order):
    // @ts-expect-error — consumer used before its provider
    defineApp('app').use(consumer).use(makeDbPlugin());
    expect(true).toBe(true);
  });

  it('compile-time guard: wire-key collisions fail .use(); rename() resolves them', async () => {
    const dbPlugin = makeDbPlugin();
    // @ts-expect-error — second provider of wire key `db`
    defineApp('app').use(dbPlugin).use(makeDbPlugin());

    const reportsPlugin = rename(makeDbPlugin(), { db: 'reportsDb' }, 'reports-db');
    const app = orThrow(await defineApp('app').use(dbPlugin).use(reportsPlugin).boot());
    expectTypeOf(app.services.reportsDb).toEqualTypeOf<DbService>();
    expect(app.services.db).toBeDefined();
    expect(app.services.reportsDb).toBeDefined();
    expect(app.services.db).not.toBe(app.services.reportsDb);
    orThrow(await app.dispose());
  });

  it('the wiring errors sit on the argument, with the DOT label; testApp types its services from the tuple', async () => {
    const consumer = plugin({
      name: 'consumer',
      needs: { db: service<DbService>() },
      boot: () => {
        /* side effects only */
      },
    });
    const bare = defineApp('app');
    type UseArg = Parameters<typeof bare.use<{ readonly db: DbService }, EmptyShape, EmptyOwnership>>[0];
    expectTypeOf<UseArg>().toHaveProperty(
      'DOT: this unit needs services that nothing before it provides. Mount their providers earlier (.use → .features → .serve)',
    );
    const withDb = bare.use(makeDbPlugin());
    type CollisionArg = Parameters<typeof withDb.use<EmptyShape, { readonly db: DbService }, EmptyOwnership>>[0];
    expectTypeOf<CollisionArg>().toHaveProperty(
      'DOT: this unit provides a key that an earlier unit already provides. Give one of them a new key with rename()',
    );
    type ListArg = Parameters<typeof bare.useAll<readonly [typeof consumer]>>[0];
    expectTypeOf<ListArg>().toHaveProperty('DOT: a unit in this list cannot be mounted at its position');

    const app = orThrow(await testApp([makeDbPlugin(), consumer]).boot());
    expectTypeOf(app.services.db).toEqualTypeOf<DbService>();
    // @ts-expect-error — the tuple would not mount: consumer before its provider
    testApp([consumer, makeDbPlugin()]);
    orThrow(await app.dispose());
  });

  it('test harness produces a runnable builder', async () => {
    const p = plugin({
      name: 'p',
      boot: () => {
        /* side effects only */
      },
    });
    const app = orThrow(await testApp([p]).boot());
    expect(app.state).toBe('booted');
    orThrow(await app.dispose());
  });

  it('synthetic two-plugin app surfaces manifest + diagnostics shape', async () => {
    const db = plugin({
      name: 'db',
      configure: ctx => {
        ctx.registerService('db', 'db');
      },
      provides: { db: () => ({ name: 'primary' }) },
    });
    const api = plugin({
      name: 'api',
      needs: { db: service<{ name: string }>() },
      configure: ctx => {
        ctx.registerAction({ id: 'api.health', binding: 'http', direction: 'in', address: 'GET /health' });
      },
      boot: ({ db }) => {
        expect(db.name).toBe('primary');
      },
    });

    const app: DotApp<{ db: { name: string } }> = orThrow(await defineApp('synthetic').use(db).use(api).boot());
    expect(app.state).toBe('booted');
    expect(app.services.db.name).toBe('primary');

    const m = app.manifest;
    expect(m.app.name).toBe('synthetic');
    expect(m.plugins.map(p => p.name)).toEqual(['db', 'api']);
    expect(m.plugins.find(p => p.name === 'api')?.dependencies).toEqual(['db']);
    expect(m.services).toEqual([{ name: 'db', plugin: 'db', kind: 'db' }]);
    expect(m.actions).toEqual([
      { id: 'api.health', plugin: 'api', binding: 'http', direction: 'in', address: 'GET /health' },
    ]);
    // Edges are observed from actual wiring: api's `db` need was satisfied
    // by the `db` plugin's published service.
    expect(m.dependencies).toEqual([{ from: 'api', to: 'db', kind: 'requires', key: 'db' }]);

    const d = app.diagnostics;
    expect(d.app).toEqual({ name: 'synthetic', state: 'booted' });
    expect(d.plugins).toHaveLength(2);
    expect(d.plugins.every(p => p.status === 'ok')).toBe(true);

    orThrow(await app.dispose());
  });
});

describe('void-boot provides inference (constraint-fallback regression)', () => {
  it('a void-returning boot provides nothing — later plugins still pass the guard', async () => {
    const provider = plugin({ name: 'p', provides: { thing: () => 42 } });
    const sideEffect = plugin({
      name: 'side',
      needs: { thing: service<number>() },
      boot({ thing }) {
        // Returns void. Without InferredProvides, TS substituted the
        // CONSTRAINT for TProvides (keyof = string), which collided with
        // every accumulated wire key and broke all later .use() calls.
        void thing;
      },
    });
    const consumer = plugin({
      name: 'c',
      needs: { thing: service<number>() },
      provides: { doubled: ({ thing }) => thing * 2 },
    });

    const app = orThrow(await defineApp('void-boot').use(provider).use(sideEffect).use(consumer).boot());
    expect(app.services.doubled).toBe(84);
    expectTypeOf(app.services.doubled).toEqualTypeOf<number>();
    orThrow(await app.dispose());
  });
});

describe('initPlugins.context', () => {
  type AppServices = {
    readonly db: DbService;
    readonly auth: AuthService;
    readonly ordersService: { readonly list: () => readonly string[] };
  };

  const p = initPlugins.context<AppServices>().create();

  it('authors plugins with key-array needs and preserves concrete hook types', async () => {
    const dbPlugin = makeDbPlugin();
    const ordersPlugin = p.plugin({
      name: 'orders',
      needs: ['db'] as const,
      provides: {
        ordersService: ({ db }) => {
          expectTypeOf(db).toEqualTypeOf<DbService>();
          return {
            list: () => ['o1'],
          };
        },
      },
    });
    const authPlugin = p.plugin({
      name: 'auth',
      provides: {
        auth: () => ({ verify: (_token: string): boolean => true }) satisfies AuthService,
      },
    });

    const app = orThrow(await defineApp('feature-plugins')
      .useAll([dbPlugin, authPlugin, ordersPlugin] as const)
      .boot());

    expect(app.services.ordersService.list()).toEqual(['o1']);
    expectTypeOf(app.services.db).toEqualTypeOf<DbService>();
    expectTypeOf(app.services.auth).toMatchTypeOf<AuthService>();
    expectTypeOf(app.services.ordersService).toMatchTypeOf<AppServices['ordersService']>();
    orThrow(await app.dispose());
  });

  it('bridges app service keys to witness records for adapter plugins', async () => {
    const dbPlugin = makeDbPlugin();
    const consumer = plugin({
      name: 'consumer',
      needs: p.needs('db'),
      provides: {
        rows: ({ db }) => {
          expectTypeOf(db).toEqualTypeOf<DbService>();
          return db.query('select 1');
        },
      },
    });

    const app = orThrow(await defineApp('bridge').use(dbPlugin).use(consumer).boot());
    // An async factory is awaited: the kernel publishes the resolved value.
    expect(app.services.rows).toBeNull();
    orThrow(await app.dispose());
  });

  it('keeps the same ordering and collision guard through useAll', () => {
    const dbPlugin = makeDbPlugin();
    const consumer = p.plugin({
      name: 'consumer',
      needs: ['db'] as const,
      boot: () => {
        /* side effects only */
      },
    });

    // @ts-expect-error — useAll preserves the same unsatisfied-needs guard as chained .use()
    defineApp('wrong-order').useAll([consumer, dbPlugin] as const);
    const dynamicPlugins = [consumer, dbPlugin];
    // @ts-expect-error — useAll requires a tuple so plain arrays cannot bypass declaration-order checks
    defineApp('dynamic-wrong-order').useAll(dynamicPlugins);
    // @ts-expect-error — "missing" is not an AppServices key
    p.plugin({ name: 'bad-key', needs: ['missing'] as const });
    // @ts-expect-error — overlapping provides must satisfy the AppServices entry type
    p.plugin({ name: 'bad-provide', provides: { db: () => ({ nope: true }) } });

    expect(true).toBe(true);
  });
});


describe('ordinary service methods', () => {
  it('keeps open and close methods as service values without inferring resource ownership', async () => {
    const OpenRefused = defineFailure('test.ordinary_open_refused', { status: 503 });
    const CloseRefused = defineFailure('test.ordinary_close_refused', { status: 503 });
    const openFailure = OpenRefused();
    const closeFailure = CloseRefused();
    const calls: string[] = [];
    const connection = plugin({
      name: 'connection',
      provides: {
        connection: () => ({
          open: () => {
            calls.push('open');
            return openFailure;
          },
          close: () => {
            calls.push('close');
            return closeFailure;
          },
        }),
      },
    });
    expectTypeOf<PluginOpenFailure<typeof connection>>().toEqualTypeOf<never>();
    expectTypeOf<PluginCloseFailure<typeof connection>>().toEqualTypeOf<never>();

    const app = orThrow(await defineApp('ordinary-methods').use(connection).boot());
    expectTypeOf(app.services.connection.open).returns.toEqualTypeOf<ReturnType<typeof OpenRefused>>();
    expectTypeOf(app.services.connection.close).returns.toEqualTypeOf<ReturnType<typeof CloseRefused>>();
    expect(calls).toEqual([]);
    expect(app.services.connection.open()).toBe(openFailure);
    expect(app.services.connection.close()).toBe(closeFailure);
    orThrow(await app.dispose());
    expect(calls).toEqual(['open', 'close']);
  });
});


describe('boot callback boundaries', () => {
  it('rejects unknown callback outcomes and erased plans across authoring forms', () => {
    const untyped = (): unknown => undefined;
    const erased: ScopePlan = { worker: child(() => void 0) };
    const factories = initPlugins.context<EmptyShape>().create();

    // @ts-expect-error -- an unknown boot outcome could conceal a returned failure.
    plugin({ name: 'unknown-boot', boot: untyped });
    // @ts-expect-error -- an unknown cleanup outcome could conceal a disposal failure.
    plugin({ name: 'unknown-cleanup', boot: () => ({ flush: cleanup(untyped) }) });
    // @ts-expect-error -- an unknown child outcome could conceal a worker failure.
    plugin({ name: 'unknown-child', boot: () => ({ worker: child(untyped) }) });
    // @ts-expect-error -- erasing callback outputs to ScopePlan loses the failure contract.
    plugin({ name: 'erased-plan', boot: () => erased });

    // @ts-expect-error -- factory plugins enforce the same typed boot boundary.
    factories.plugin({ name: 'unknown-boot', boot: untyped });
    // @ts-expect-error -- factory cleanup callbacks must retain their outcomes.
    factories.plugin({ name: 'unknown-cleanup', boot: () => ({ flush: cleanup(untyped) }) });
    // @ts-expect-error -- factory child callbacks must retain their outcomes.
    factories.plugin({ name: 'unknown-child', boot: () => ({ worker: child(untyped) }) });
    // @ts-expect-error -- a factory cannot recover callback outcomes from an erased plan.
    factories.plugin({ name: 'erased-plan', boot: () => erased });

    // @ts-expect-error -- object features enforce the same typed boot boundary.
    feature('unknown-boot', { boot: untyped });
    // @ts-expect-error -- feature cleanup callbacks must retain their outcomes.
    feature('unknown-cleanup', { boot: () => ({ flush: cleanup(untyped) }) });
    // @ts-expect-error -- feature child callbacks must retain their outcomes.
    feature('unknown-child', { boot: () => ({ worker: child(untyped) }) });
    // @ts-expect-error -- an object feature cannot recover an erased plan's failure contract.
    feature('erased-plan', { boot: () => erased });

    expect(Object.keys(erased)).toEqual(['worker']);
  });
});
