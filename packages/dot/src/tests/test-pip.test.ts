/**
 * Tests for `testPip` — the typed unit-test builder.
 *
 * Two layers:
 *   1. Type-level: `.provide()` is compile-checked (wrong shape, unknown
 *      key) and `boot()` refuses to compile while needs remain unprovided.
 *   2. Runtime: fakes flow through the real kernel — reverse-order
 *      teardown, lazy lifting, and `$config` behave as in production.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Lazy } from '../pip-contract.js';
import { lazyOf, pip, service, token } from '../pip-contract.js';
import { testPip } from '../test-harness.js';

type Db = { query(sql: string): readonly string[] };
type Cache = { get(key: string): string | undefined };

const Db = token<Db>()('test.db');

describe('testPip', () => {
  it('satisfies token and anonymous needs with typed fakes', async () => {
    const consumer = pip({
      name: 'consumer',
      needs: { db: Db, cache: service<Cache>() },
      boot: ({ db, cache }) => ({
        answer: { rows: db.query('q'), cached: cache.get('k') },
      }),
    });

    const fakeDb: Db = { query: () => ['row'] };
    const fakeCache: Cache = { get: () => 'hit' };

    const app = await testPip(consumer)
      .provide(Db, fakeDb) // token form
      .provide('cache', fakeCache) // anonymous form — wire key is the alias
      .boot();

    expect(app.services.answer).toEqual({ rows: ['row'], cached: 'hit' });
    expectTypeOf(app.services.answer.rows).toEqualTypeOf<readonly string[]>();
    await app.dispose();
  });

  it('boot() does not compile until every need is provided; wrong shapes fail at provide()', () => {
    const consumer = pip({
      name: 'consumer',
      needs: { db: Db, cache: service<Cache>() },
      boot: ({ db }) => ({ rows: db.query('q') }),
    });

    // @ts-expect-error — `cache` is still unprovided ("Expected 2 arguments").
    // The runtime boot really does reject (kernel E012) — swallow it so the
    // compile-time demonstration doesn't leak an unhandled rejection.
    void testPip(consumer).provide(Db, { query: () => [] }).boot().catch(() => null);

    // @ts-expect-error — a number is not a Db
    void testPip(consumer).provide(Db, 42);

    // @ts-expect-error — `nope` is not one of this pip's needs
    void testPip(consumer).provide('nope', 1);

    expect(true).toBe(true);
  });

  it('lifts a plain fake for a service.lazy need; lazyOf works for pre-built handles', async () => {
    const consumer = pip({
      name: 'lazy-consumer',
      needs: { db: service.lazy<Db>() },
      async boot({ db }) {
        expectTypeOf(db).toEqualTypeOf<Lazy<Db>>();
        const handle = await db.get();
        return { rows: handle.query('q') };
      },
    });

    const plain = await testPip(consumer).provide('db', { query: () => ['plain'] }).boot();
    expect(plain.services.rows).toEqual(['plain']);
    await plain.dispose();

    const handle = await testPip(consumer)
      .provide('db', lazyOf<Db>({ query: () => ['handle'] }))
      .boot();
    expect(handle.services.rows).toEqual(['handle']);
    await handle.dispose();
  });

  it('runs the real kernel: teardown order, own provides in dispose, $config', async () => {
    const order: string[] = [];
    const consumer = pip({
      name: 'consumer',
      needs: { db: Db },
      boot: ({ db, $config }) => ({ rows: db.query('q'), flag: $config['flag'] }),
      dispose: ({ flag }) => void order.push(`consumer-dispose:${String(flag)}`),
    });

    const app = await testPip(consumer, { config: { flag: 'on' } })
      .provide(Db, { query: () => [] })
      .start();
    expect(app.state).toBe('started');
    await app.dispose();
    expect(order).toEqual(['consumer-dispose:on']);
  });
});
