/**
 * Smoke tests for the public defineApp surface (v2).
 *
 * Includes the compile-time wiring-guard assertions: `@ts-expect-error`
 * cases fail the typecheck if the guard ever stops firing.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ScopePlan } from '@arki/async';
import { child, cleanup } from '@arki/async';
import { defineFailure, orThrow } from '@arki/failure';

import type { DotApp } from '../define-app.js';
import type { EmptyShape, UnitCloseFailure, UnitOpenFailure } from '../unit-contract.js';
import { defineApp } from '../define-app.js';
import { initUnits } from '../init-units.js';
import { testApp } from '../test-harness.js';
import { infra, rename, service } from '../unit-contract.js';

type DbService = {
  query(sql: string): Promise<null>;
};
type AuthService = {
  verify(token: string): boolean;
};

const makeDbUnit = () =>
  infra({
    name: 'db',
    provides: {
      db: (): DbService => ({ query: async (_sql: string) => null }),
    },
  });

describe('defineApp', () => {
  it('defineApp(name) returns a builder', () => {
    const builder = defineApp('app');
    expect(typeof builder.infra).toBe('function');
    expect(typeof builder.boot).toBe('function');
    expect(typeof builder.start).toBe('function');
    expect(typeof builder.configure).toBe('function');
  });

  it('builder.infra() with a unit returns a new builder (immutable)', () => {
    const p = infra({ name: 'p' });
    const b1 = defineApp('app');
    const b2 = b1.infra(p);
    expect(b1).not.toBe(b2);
  });

  it('builder.boot() returns a DotApp with state=booted', async () => {
    const p = infra({
      name: 'p',
      boot: () => {
        /* side effects only */
      },
    });
    const app = orThrow(await defineApp('app').infra(p).boot());
    expect(app.state).toBe('booted');
    expect(app.name).toBe('app');
    orThrow(await app.dispose());
  });

  it('type-level: app.services is correctly typed from accumulated .infra() calls', async () => {
    const dbUnit = makeDbUnit();
    const authUnit = infra({
      name: 'auth',
      provides: {
        auth: () => ({ verify: (_token: string) => true }) satisfies AuthService,
      },
    });

    const app = orThrow(await defineApp('app').infra(dbUnit).infra(authUnit).boot());
    expectTypeOf(app.services).toMatchTypeOf<{ db: DbService; auth: AuthService }>();
    expect(app.services.db).toBeDefined();
    expect(app.services.auth).toBeDefined();
    orThrow(await app.dispose());
  });

  it('boot destructures typed services from the needs shape', async () => {
    const dbUnit = makeDbUnit();
    let observed: DbService | undefined;
    const consumer = infra({
      name: 'consumer',
      needs: { db: service<DbService>() },
      boot: ({ db, $app, $unit }) => {
        expectTypeOf(db).toEqualTypeOf<DbService>();
        expect($app).toBe('app');
        expect($unit).toBe('consumer');
        observed = db;
      },
    });

    const app = orThrow(await defineApp('app').infra(dbUnit).infra(consumer).boot());
    expect(observed).toBe(app.services.db);
    orThrow(await app.dispose());
  });

  it('compile-time guard: unsatisfied needs fail .infra() at the call site', () => {
    const consumer = infra({
      name: 'consumer',
      needs: { db: service<DbService>() },
      boot: ({ db }) => {
        void db;
      },
    });
    // @ts-expect-error — nothing provides `db` yet
    defineApp('app').infra(consumer);
    // Wrong order is a compile error too (declaration order IS boot order):
    // @ts-expect-error — consumer used before its provider
    defineApp('app').infra(consumer).infra(makeDbUnit());
    expect(true).toBe(true);
  });

  it('compile-time guard: wire-key collisions fail .infra(); rename() resolves them', async () => {
    const dbUnit = makeDbUnit();
    // @ts-expect-error — second provider of wire key `db`
    defineApp('app').infra(dbUnit).infra(makeDbUnit());

    const reportsUnit = rename(makeDbUnit(), { db: 'reportsDb' }, 'reports-db');
    const app = orThrow(await defineApp('app').infra(dbUnit).infra(reportsUnit).boot());
    expectTypeOf(app.services.reportsDb).toEqualTypeOf<DbService>();
    expect(app.services.db).toBeDefined();
    expect(app.services.reportsDb).toBeDefined();
    expect(app.services.db).not.toBe(app.services.reportsDb);
    orThrow(await app.dispose());
  });

  it('the wiring errors sit on the argument, with the DOT label; testApp types its services from the tuple', async () => {
    const consumer = infra({
      name: 'consumer',
      needs: { db: service<DbService>() },
      boot: () => {
        /* side effects only */
      },
    });
    const bare = defineApp('app');
    type AtPosition = 'DOT: a unit in this list cannot be mounted at its position';
    type NeedsArg = Parameters<typeof bare.infra<readonly [typeof consumer]>>[0][AtPosition];
    expectTypeOf<NeedsArg>().toHaveProperty(
      'DOT: this unit needs services that nothing before it provides. Mount their providers earlier (.infra → .features → .entrypoints)',
    );
    const _withDb = bare.infra(makeDbUnit());
    const _duplicate = makeDbUnit();
    type CollisionArg = Parameters<typeof _withDb.infra<readonly [typeof _duplicate]>>[0][AtPosition];
    expectTypeOf<CollisionArg>().toHaveProperty(
      'DOT: this unit provides a key that an earlier unit already provides. Give one of them a new key with rename()',
    );
    type ListArg = Parameters<typeof bare.infra<readonly [typeof consumer]>>[0];
    expectTypeOf<ListArg>().toHaveProperty('DOT: a unit in this list cannot be mounted at its position');

    const app = orThrow(await testApp([makeDbUnit(), consumer]).boot());
    expectTypeOf(app.services.db).toEqualTypeOf<DbService>();
    // @ts-expect-error — the tuple would not mount: consumer before its provider
    testApp([consumer, makeDbUnit()]);
    orThrow(await app.dispose());
  });

  it('test harness produces a runnable builder', async () => {
    const p = infra({
      name: 'p',
      boot: () => {
        /* side effects only */
      },
    });
    const app = orThrow(await testApp([p]).boot());
    expect(app.state).toBe('booted');
    orThrow(await app.dispose());
  });

  it('synthetic two-unit app surfaces manifest + diagnostics shape', async () => {
    const db = infra({
      name: 'db',
      configure: ctx => {
        ctx.registerService('db', 'db');
      },
      provides: { db: () => ({ name: 'primary' }) },
    });
    const api = infra({
      name: 'api',
      needs: { db: service<{ name: string }>() },
      configure: ctx => {
        ctx.registerAction({ id: 'api.health', binding: 'http', direction: 'in', address: 'GET /health' });
      },
      boot: ({ db }) => {
        expect(db.name).toBe('primary');
      },
    });

    const app: DotApp<{ db: { name: string } }> = orThrow(await defineApp('synthetic').infra(db).infra(api).boot());
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
    // by the `db` unit's published service.
    expect(m.dependencies).toEqual([{ from: 'api', to: 'db', kind: 'requires', key: 'db' }]);

    const d = app.diagnostics;
    expect(d.app).toEqual({ name: 'synthetic', state: 'booted' });
    expect(d.plugins).toHaveLength(2);
    expect(d.plugins.every(p => p.status === 'ok')).toBe(true);

    orThrow(await app.dispose());
  });
});

describe('void-boot provides inference (constraint-fallback regression)', () => {
  it('a void-returning boot provides nothing — later units still pass the guard', async () => {
    const provider = infra({ name: 'p', provides: { thing: () => 42 } });
    const sideEffect = infra({
      name: 'side',
      needs: { thing: service<number>() },
      boot({ thing }) {
        // Returns void. Without InferredProvides, TS substituted the
        // CONSTRAINT for TProvides (keyof = string), which collided with
        // every accumulated wire key and broke all later .infra() calls.
        void thing;
      },
    });
    const consumer = infra({
      name: 'c',
      needs: { thing: service<number>() },
      provides: { doubled: ({ thing }) => thing * 2 },
    });

    const app = orThrow(await defineApp('void-boot').infra(provider).infra(sideEffect).infra(consumer).boot());
    expect(app.services.doubled).toBe(84);
    expectTypeOf(app.services.doubled).toEqualTypeOf<number>();
    orThrow(await app.dispose());
  });
});

describe('initUnits.context', () => {
  type AppServices = {
    readonly db: DbService;
    readonly auth: AuthService;
    readonly ordersService: { readonly list: () => readonly string[] };
  };

  const p = initUnits.context<AppServices>().create();

  it('authors units with key-array needs and preserves concrete hook types', async () => {
    const dbUnit = makeDbUnit();
    const ordersUnit = p.infra({
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
    const authUnit = p.infra({
      name: 'auth',
      provides: {
        auth: () => ({ verify: (_token: string): boolean => true }) satisfies AuthService,
      },
    });

    const app = orThrow(
      await defineApp('feature-units')
        .infra(...([dbUnit, authUnit, ordersUnit] as const))
        .boot(),
    );

    expect(app.services.ordersService.list()).toEqual(['o1']);
    expectTypeOf(app.services.db).toEqualTypeOf<DbService>();
    expectTypeOf(app.services.auth).toMatchTypeOf<AuthService>();
    expectTypeOf(app.services.ordersService).toMatchTypeOf<AppServices['ordersService']>();
    orThrow(await app.dispose());
  });

  it('bridges app service keys to witness records for adapter units', async () => {
    const dbUnit = makeDbUnit();
    const consumer = infra({
      name: 'consumer',
      needs: p.needs('db'),
      provides: {
        rows: ({ db }) => {
          expectTypeOf(db).toEqualTypeOf<DbService>();
          return db.query('select 1');
        },
      },
    });

    const app = orThrow(await defineApp('bridge').infra(dbUnit).infra(consumer).boot());
    // An async factory is awaited: the kernel publishes the resolved value.
    expect(app.services.rows).toBeNull();
    orThrow(await app.dispose());
  });

  it('keeps the same ordering and collision guard through useAll', () => {
    const dbUnit = makeDbUnit();
    const consumer = p.infra({
      name: 'consumer',
      needs: ['db'] as const,
      boot: () => {
        /* side effects only */
      },
    });

    // @ts-expect-error — a spread tuple keeps the same unsatisfied-needs guard as separate .infra() calls
    defineApp('wrong-order').infra(...([consumer, dbUnit] as const));
    const dynamicUnits = [consumer, dbUnit];
    // @ts-expect-error — .infra() requires a tuple, so a plain array cannot bypass declaration-order checks
    defineApp('dynamic-wrong-order').infra(...dynamicUnits);
    // @ts-expect-error — "missing" is not an AppServices key
    p.infra({ name: 'bad-key', needs: ['missing'] as const });
    // @ts-expect-error — overlapping provides must satisfy the AppServices entry type
    p.infra({ name: 'bad-provide', provides: { db: () => ({ nope: true }) } });

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
    const connection = infra({
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
    expectTypeOf<UnitOpenFailure<typeof connection>>().toEqualTypeOf<never>();
    expectTypeOf<UnitCloseFailure<typeof connection>>().toEqualTypeOf<never>();

    const app = orThrow(await defineApp('ordinary-methods').infra(connection).boot());
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
    const factories = initUnits.context<EmptyShape>().create();

    // @ts-expect-error -- an unknown boot outcome could conceal a returned failure.
    infra({ name: 'unknown-boot', boot: untyped });
    // @ts-expect-error -- an unknown cleanup outcome could conceal a disposal failure.
    infra({ name: 'unknown-cleanup', boot: () => ({ flush: cleanup(untyped) }) });
    // @ts-expect-error -- an unknown child outcome could conceal a worker failure.
    infra({ name: 'unknown-child', boot: () => ({ worker: child(untyped) }) });
    // @ts-expect-error -- erasing callback outputs to ScopePlan loses the failure contract.
    infra({ name: 'erased-plan', boot: () => erased });

    // @ts-expect-error -- factory units enforce the same typed boot boundary.
    factories.infra({ name: 'unknown-boot', boot: untyped });
    // @ts-expect-error -- factory cleanup callbacks must retain their outcomes.
    factories.infra({ name: 'unknown-cleanup', boot: () => ({ flush: cleanup(untyped) }) });
    // @ts-expect-error -- factory child callbacks must retain their outcomes.
    factories.infra({ name: 'unknown-child', boot: () => ({ worker: child(untyped) }) });
    // @ts-expect-error -- a factory cannot recover callback outcomes from an erased plan.
    factories.infra({ name: 'erased-plan', boot: () => erased });

    expect(Object.keys(erased)).toEqual(['worker']);
  });
});
