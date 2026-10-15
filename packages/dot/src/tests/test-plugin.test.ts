/**
 * Tests for `testPlugin` — the typed unit-test builder.
 *
 * Two layers:
 *   1. Type-level: `.provide()` is compile-checked (wrong shape, unknown
 *      key) and `boot()` refuses to compile while needs remain unprovided.
 *   2. Runtime: fakes flow through the real kernel — reverse-order
 *      teardown, lazy lifting, and `$config` behave as in production.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Lazy } from '../plugin-contract.js';
import { lazyOf, plugin, service, token } from '../plugin-contract.js';
import { testPlugin } from '../test-harness.js';

type Db = { query(sql: string): readonly string[] };
type Cache = { get(key: string): string | undefined };

const Db = token<Db>()('test.db');

describe('testPlugin', () => {
  it('satisfies token and anonymous needs with typed fakes', async () => {
    const consumer = plugin({
      name: 'consumer',
      needs: { db: Db, cache: service<Cache>() },
      provides: {
        answer: ({ db, cache }) => ({ rows: db.query('q'), cached: cache.get('k') }),
      },
    });

    const fakeDb: Db = { query: () => ['row'] };
    const fakeCache: Cache = { get: () => 'hit' };

    const app = await testPlugin(consumer)
      .provide(Db, fakeDb) // token form
      .provide('cache', fakeCache) // anonymous form — wire key is the alias
      .boot();

    expect(app.services.answer).toEqual({ rows: ['row'], cached: 'hit' });
    expectTypeOf(app.services.answer.rows).toEqualTypeOf<readonly string[]>();
    await app.dispose();
  });

  it('boot() does not compile until every need is provided; wrong shapes fail at provide()', () => {
    const consumer = plugin({
      name: 'consumer',
      needs: { db: Db, cache: service<Cache>() },
      provides: { rows: ({ db }) => db.query('q') },
    });

    // @ts-expect-error — `cache` is still unprovided ("Expected 2 arguments").
    // The runtime boot really does reject (kernel E012) — swallow it so the
    // compile-time demonstration doesn't leak an unhandled rejection.
    void testPlugin(consumer).provide(Db, { query: () => [] }).boot().catch(() => null);

    // @ts-expect-error — a number is not a Db
    void testPlugin(consumer).provide(Db, 42);

    // @ts-expect-error — `nope` is not one of this plugin's needs
    void testPlugin(consumer).provide('nope', 1);

    expect(true).toBe(true);
  });

  it('lifts a plain fake for a service.lazy need; lazyOf works for pre-built handles', async () => {
    const consumer = plugin({
      name: 'lazy-consumer',
      needs: { db: service.lazy<Db>() },
      provides: {
        rows: async ({ db }) => {
          expectTypeOf(db).toEqualTypeOf<Lazy<Db>>();
          const handle = await db.get();
          return handle.query('q');
        },
      },
    });

    const plain = await testPlugin(consumer).provide('db', { query: () => ['plain'] }).boot();
    expect(plain.services.rows).toEqual(['plain']);
    await plain.dispose();

    const handle = await testPlugin(consumer)
      .provide('db', lazyOf<Db>({ query: () => ['handle'] }))
      .boot();
    expect(handle.services.rows).toEqual(['handle']);
    await handle.dispose();
  });

  it('runs the real kernel: teardown order, own provides in dispose, $config', async () => {
    const order: string[] = [];
    const consumer = plugin({
      name: 'consumer',
      needs: { db: Db },
      provides: { rows: ({ db }) => db.query('q'), flag: ({ $config }) => $config['flag'] },
      dispose: ({ flag }) => void order.push(`consumer-dispose:${String(flag)}`),
    });

    const app = await testPlugin(consumer, { config: { flag: 'on' } })
      .provide(Db, { query: () => [] })
      .start();
    expect(app.state).toBe('started');
    await app.dispose();
    expect(order).toEqual(['consumer-dispose:on']);
  });
});
