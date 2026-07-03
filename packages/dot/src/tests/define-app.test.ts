/**
 * Smoke tests for the public defineApp surface (v2).
 *
 * Includes the compile-time wiring-guard assertions: `@ts-expect-error`
 * cases fail the typecheck if the guard ever stops firing.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DotApp } from '../define-app.js';
import { defineApp } from '../define-app.js';
import { pip, rename, service } from '../pip-contract.js';
import { testApp } from '../test-harness.js';

type DbService = {
  query(sql: string): Promise<unknown>;
};
type AuthService = {
  verify(token: string): boolean;
};

const makeDbPip = () =>
  pip({
    name: 'db',
    boot: () => ({
      db: { query: async (_sql: string) => null } as DbService,
    }),
  });

describe('defineApp', () => {
  it('defineApp(name) returns a builder', () => {
    const builder = defineApp('app');
    expect(typeof builder.use).toBe('function');
    expect(typeof builder.boot).toBe('function');
    expect(typeof builder.start).toBe('function');
    expect(typeof builder.configure).toBe('function');
  });

  it('builder.use() with a pip returns a new builder (immutable)', () => {
    const p = pip({ name: 'p' });
    const b1 = defineApp('app');
    const b2 = b1.use(p);
    expect(b1).not.toBe(b2);
  });

  it('builder.boot() returns a DotApp with state=booted', async () => {
    const p = pip({ name: 'p', boot: () => ({}) });
    const app = await defineApp('app').use(p).boot();
    expect(app.state).toBe('booted');
    expect(app.name).toBe('app');
    await app.dispose();
  });

  it('type-level: app.services is correctly typed from accumulated .use() calls', async () => {
    const dbPip = makeDbPip();
    const authPip = pip({
      name: 'auth',
      boot: () => ({
        auth: { verify: (_token: string) => true } as AuthService,
      }),
    });

    const app = await defineApp('app').use(dbPip).use(authPip).boot();
    expectTypeOf(app.services).toMatchTypeOf<{ db: DbService; auth: AuthService }>();
    expect(app.services.db).toBeDefined();
    expect(app.services.auth).toBeDefined();
    await app.dispose();
  });

  it('boot destructures typed services from the needs shape', async () => {
    const dbPip = makeDbPip();
    let observed: DbService | undefined;
    const consumer = pip({
      name: 'consumer',
      needs: { db: service<DbService>() },
      boot: ({ db, $app, $pip }) => {
        expectTypeOf(db).toEqualTypeOf<DbService>();
        expect($app).toBe('app');
        expect($pip).toBe('consumer');
        observed = db;
        return {};
      },
    });

    const app = await defineApp('app').use(dbPip).use(consumer).boot();
    expect(observed).toBe(app.services.db);
    await app.dispose();
  });

  it('compile-time guard: unsatisfied needs fail .use() at the call site', () => {
    const consumer = pip({
      name: 'consumer',
      needs: { db: service<DbService>() },
      boot: ({ db }) => {
        void db;
        return {};
      },
    });
    // @ts-expect-error — nothing provides `db` yet
    defineApp('app').use(consumer);
    // Wrong order is a compile error too (declaration order IS boot order):
    // @ts-expect-error — consumer used before its provider
    defineApp('app').use(consumer).use(makeDbPip());
    expect(true).toBe(true);
  });

  it('compile-time guard: wire-key collisions fail .use(); rename() resolves them', async () => {
    const dbPip = makeDbPip();
    // @ts-expect-error — second provider of wire key `db`
    defineApp('app').use(dbPip).use(makeDbPip());

    const reportsPip = rename(makeDbPip(), { db: 'reportsDb' }, 'reports-db');
    const app = await defineApp('app').use(dbPip).use(reportsPip).boot();
    expectTypeOf(app.services.reportsDb).toEqualTypeOf<DbService>();
    expect(app.services.db).toBeDefined();
    expect(app.services.reportsDb).toBeDefined();
    expect(app.services.db).not.toBe(app.services.reportsDb);
    await app.dispose();
  });

  it('test harness produces a runnable builder', async () => {
    const p = pip({ name: 'p', boot: () => ({}) });
    const app = await testApp([p]).boot();
    expect(app.state).toBe('booted');
    await app.dispose();
  });

  it('synthetic two-pip app surfaces manifest + diagnostics shape', async () => {
    const db = pip({
      name: 'db',
      version: '1.0.0',
      configure: ctx => {
        ctx.registerService('db', 'db');
      },
      boot: () => ({ db: { name: 'primary' } }),
    });
    const api = pip({
      name: 'api',
      needs: { db: service<{ name: string }>() },
      version: '1.0.0',
      configure: ctx => {
        ctx.registerRoute({ id: 'api.health', method: 'GET', path: '/health', transport: 'http' });
      },
      boot: ({ db }) => {
        expect(db.name).toBe('primary');
        return {};
      },
    });

    const app: DotApp<{ db: { name: string } }> = await defineApp('synthetic').use(db).use(api).boot();
    expect(app.state).toBe('booted');
    expect(app.services.db.name).toBe('primary');

    const m = app.manifest;
    expect(m.app.name).toBe('synthetic');
    expect(m.pips.map(p => p.name)).toEqual(['db', 'api']);
    expect(m.pips.find(p => p.name === 'api')?.dependencies).toEqual(['db']);
    expect(m.services).toEqual([{ name: 'db', pip: 'db', kind: 'db' }]);
    expect(m.routes).toEqual([{ id: 'api.health', pip: 'api', method: 'GET', path: '/health', transport: 'http' }]);
    // Edges are observed from actual wiring: api's `db` need was satisfied
    // by the `db` pip's published service.
    expect(m.dependencies).toEqual([{ from: 'api', to: 'db', kind: 'requires' }]);

    const d = app.diagnostics;
    expect(d.app).toEqual({ name: 'synthetic', state: 'booted' });
    expect(d.pips).toHaveLength(2);
    expect(d.pips.every(p => p.status === 'ok')).toBe(true);

    await app.dispose();
  });
});
