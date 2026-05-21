/**
 * Smoke tests for the public defineApp surface.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DotApp } from '../define-app.js';
import { defineApp } from '../define-app.js';
import { defineDotPip } from '../pip-contract.js';
import { testApp } from '../test-harness.js';

describe('defineApp', () => {
  it('defineApp(name) returns a builder', () => {
    const builder = defineApp('app');
    expect(typeof builder.use).toBe('function');
    expect(typeof builder.boot).toBe('function');
    expect(typeof builder.start).toBe('function');
    expect(typeof builder.configure).toBe('function');
  });

  it('builder.use() with a pip returns a new builder (immutable)', () => {
    const p = defineDotPip({ name: 'p' });
    const b1 = defineApp('app');
    const b2 = b1.use(p);
    expect(b1).not.toBe(b2);
  });

  it('builder.boot() returns a DotApp with state=booted', async () => {
    const p = defineDotPip({ name: 'p', boot: () => ({}) });
    const app = await defineApp('app').use(p).boot();
    expect(app.state).toBe('booted');
    expect(app.name).toBe('app');
    await app.dispose();
  });

  it('type-level: app.services is correctly typed from accumulated .use() calls', async () => {
    type DbService = {
      query(sql: string): Promise<unknown>;
    };
    type AuthService = {
      verify(token: string): boolean;
    };

    const dbPip = defineDotPip<{ db: DbService }>({
      name: 'db',
      boot: () => ({
        services: {
          db: { query: async (_sql: string) => null },
        },
      }),
    });
    const authPip = defineDotPip<{ auth: AuthService }>({
      name: 'auth',
      boot: () => ({
        services: {
          auth: { verify: (_token: string) => true },
        },
      }),
    });

    const app = await defineApp('app').use(dbPip).use(authPip).boot();
    expectTypeOf(app.services).toMatchTypeOf<{ db: DbService; auth: AuthService }>();
    expect(app.services.db).toBeDefined();
    expect(app.services.auth).toBeDefined();
    await app.dispose();
  });

  it('defineDotPip returns the pip verbatim (type-narrowing helper)', () => {
    const input = { name: 'p' };
    const out = defineDotPip(input);
    expect(out).toBe(input);
  });

  it('test harness produces a runnable builder', async () => {
    const p = defineDotPip({ name: 'p', boot: () => ({}) });
    const app = await testApp([p]).boot();
    expect(app.state).toBe('booted');
    await app.dispose();
  });

  it('synthetic two-pip app surfaces manifest + diagnostics shape', async () => {
    const db = defineDotPip<{ db: { name: string } }>({
      name: 'db',
      version: '1.0.0',
      configure: ctx => {
        ctx.registerService('db', 'db');
      },
      boot: () => ({ services: { db: { name: 'primary' } } }),
    });
    const api = defineDotPip({
      name: 'api',
      version: '1.0.0',
      dependencies: ['db'],
      configure: ctx => {
        ctx.registerRoute({ id: 'api.health', method: 'GET', path: '/health', transport: 'http' });
      },
    });

    const app: DotApp<{ db: { name: string } }> = await defineApp('synthetic').use(db).use(api).boot();
    expect(app.state).toBe('booted');
    expect(app.services.db.name).toBe('primary');

    const m = app.manifest;
    expect(m.app.name).toBe('synthetic');
    expect(m.pips.map(p => p.name)).toEqual(['db', 'api']);
    expect(m.services).toEqual([{ name: 'db', pip: 'db', kind: 'db' }]);
    expect(m.routes).toEqual([{ id: 'api.health', pip: 'api', method: 'GET', path: '/health', transport: 'http' }]);
    expect(m.dependencies).toEqual([{ from: 'api', to: 'db', kind: 'requires' }]);

    const d = app.diagnostics;
    expect(d.app).toEqual({ name: 'synthetic', state: 'booted' });
    expect(d.pips).toHaveLength(2);
    expect(d.pips.every(p => p.status === 'ok')).toBe(true);

    await app.dispose();
  });
});
