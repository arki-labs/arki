/**
 * Tests for lazy service initialization.
 *
 * Two layers:
 *   1. `lazy()` handle semantics — memoization, single-flight, failed-init
 *      retry, dispose idempotency, get-after-dispose.
 *   2. Kernel integration — never-touched handles never initialize or clean
 *      up; initialized handles are auto-disposed in reverse order even when
 *      the publishing unit has no dispose hook; cleanup failures aggregate.
 */

import { orThrow, UnexpectedDefect } from '@arki/failure';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Lazy } from '../unit-contract.js';
import { defineApp } from '../define-app.js';
import { isLazy, lazy, LazyClosed, infra, service } from '../unit-contract.js';

describe('lazy() handle semantics', () => {
  it('does not initialize until first get(); memoizes the value', async () => {
    let inits = 0;
    const handle = lazy(() => {
      inits += 1;
      return { id: inits };
    });

    expect(inits).toBe(0);
    expect(handle.initialized).toBe(false);
    expect(handle.peek()).toBeUndefined();

    const first = orThrow(await handle.get());
    const second = orThrow(await handle.get());
    expect(inits).toBe(1);
    expect(first).toBe(second);
    expect(handle.initialized).toBe(true);
    expect(handle.peek()).toBe(first);
  });

  it('single-flight: concurrent get() calls share one initialization', async () => {
    let inits = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const handle = lazy(async () => {
      inits += 1;
      await gate;
      return { ok: true };
    });

    const p1 = handle.get();
    const p2 = handle.get();
    release();
    const [a, b] = await Promise.all([p1.then(value => orThrow(value)), p2.then(value => orThrow(value))]);
    expect(inits).toBe(1);
    expect(a).toBe(b);
  });

  it('a failed initialization is not cached — the next get() retries', async () => {
    let attempts = 0;
    const handle = lazy(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('flaky');
      return 'ok';
    });

    const failure = await handle.get();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    expect(failure).toMatchObject({ code: UnexpectedDefect.code, cause: new Error('flaky') });
    expect(handle.initialized).toBe(false);
    await expect(handle.get()).resolves.toBe('ok');
    expect(attempts).toBe(2);
  });

  it('dispose runs cleanup once, only if initialized; get() after dispose returns LazyClosed', async () => {
    let cleanups = 0;
    const untouched = lazy(() => 'x', { dispose: () => void (cleanups += 1) });
    orThrow(await untouched.dispose());
    expect(cleanups).toBe(0); // never initialized → no cleanup

    const touched = lazy(() => 'x', { dispose: () => void (cleanups += 1) });
    orThrow(await touched.get());
    orThrow(await touched.dispose());
    orThrow(await touched.dispose()); // idempotent
    expect(cleanups).toBe(1);
    expect(await touched.get()).toEqual(LazyClosed());
  });

  it('dispose awaits an in-flight initialization before cleaning up', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const handle = lazy(
      async () => {
        await gate;
        events.push('initialized');
        return 'value';
      },
      { dispose: () => void events.push('cleaned') },
    );

    const getting = handle.get();
    const disposing = handle.dispose();
    release();
    await Promise.all([getting.then(value => orThrow(value)), disposing.then(value => orThrow(value))]);
    expect(events).toEqual(['initialized', 'cleaned']);
  });

  it('isLazy distinguishes handles from plain services', () => {
    expect(isLazy(lazy(() => 1))).toBe(true);
    expect(isLazy({ get: () => 1 })).toBe(false);
    expect(isLazy(null)).toBe(false);
  });
});

describe('lazy services in the kernel', () => {
  type Db = { readonly id: number; close(): void };

  function makeLazyDbUnit(log: string[]) {
    return infra({
      name: 'db',
      provides: {
        db: () =>
          lazy(
            (): Db => {
              log.push('init');
              return { id: 1, close: () => log.push('close') };
            },
            { dispose: db => db.close() },
          ),
      },
      // NOTE: no dispose hook — the kernel auto-disposes the lazy handle.
    });
  }

  it('a never-accessed lazy service never initializes and never cleans up', async () => {
    const log: string[] = [];
    const app = orThrow(await defineApp('lazy-untouched').infra(makeLazyDbUnit(log)).boot());
    expect(log).toEqual([]);
    expect(app.services.db.initialized).toBe(false);
    orThrow(await app.dispose());
    expect(log).toEqual([]); // no init → no close
  });

  it('an initialized lazy service is auto-disposed at app.dispose() without a dispose hook', async () => {
    const log: string[] = [];
    const app = orThrow(await defineApp('lazy-touched').infra(makeLazyDbUnit(log)).boot());
    const db = orThrow(await app.services.db.get());
    expect(db.id).toBe(1);
    expect(log).toEqual(['init']);
    orThrow(await app.dispose());
    expect(log).toEqual(['init', 'close']);
  });

  it('consumers receive the typed handle through needs and get() it on demand', async () => {
    const log: string[] = [];
    let seen: Db | undefined;
    const consumer = infra({
      name: 'consumer',
      needs: { db: service<Lazy<Db>>() },
      boot: ({ db }) => {
        expectTypeOf(db).toEqualTypeOf<Lazy<Db>>();
        expect(db.initialized).toBe(false); // still cold at consumer boot
      },
      async start({ db }) {
        seen = orThrow(await db.get()); // first access initializes
      },
    });

    const app = orThrow(await defineApp('lazy-consumer').infra(makeLazyDbUnit(log)).infra(consumer).start());
    expect(log).toEqual(['init']);
    expect(seen?.id).toBe(1);
    orThrow(await app.dispose());
    expect(log).toEqual(['init', 'close']);
  });

  it('boot rollback auto-disposes initialized lazy services of already-booted units', async () => {
    const log: string[] = [];
    const eager = infra({
      name: 'eager',
      needs: { db: service<Lazy<Db>>() },
      // Forces initialization during boot, then a later unit fails.
      boot: async ({ db }) => {
        orThrow(await db.get());
      },
    });
    const bomb = infra({
      name: 'bomb',
      boot: () => {
        throw new Error('boom');
      },
    });

    const outcome = await defineApp('lazy-rollback').infra(makeLazyDbUnit(log)).infra(eager).infra(bomb).boot();
    expect(UnexpectedDefect.is(outcome)).toBe(true);
    expect(outcome).toMatchObject({ cause: new Error('boom') });
    expect(log).toEqual(['init', 'close']); // rollback cleaned the initialized handle
  });

  it('lazy cleanup failures retain their cause and name the owning unit', async () => {
    const broken = infra({
      name: 'broken',
      provides: {
        svc: () =>
          lazy(() => 'value', {
            dispose: () => {
              throw new Error('cleanup-broken');
            },
          }),
      },
    });

    const app = orThrow(await defineApp('lazy-cleanup-fail').infra(broken).boot());
    orThrow(await app.services.svc.get());
    const outcome = await app.dispose();
    expect(UnexpectedDefect.is(outcome)).toBe(true);
    expect(outcome).toMatchObject({ cause: new Error('cleanup-broken') });
    expect(app.diagnostics.plugins).toContainEqual(expect.objectContaining({ plugin: 'broken', status: 'failed' }));
  });

  it('service.lazy lifts an EAGER provider into a pre-initialized handle', async () => {
    const eagerDb: Db = {
      id: 7,
      close: () => {
        /* noop */
      },
    };
    const provider = infra({ name: 'db', provides: { db: () => eagerDb } });
    let handleSeen: Lazy<Db> | undefined;
    const consumer = infra({
      name: 'consumer',
      needs: { db: service.lazy<Db>() },
      boot: async ({ db }) => {
        expectTypeOf(db).toEqualTypeOf<Lazy<Db>>();
        expect(db.initialized).toBe(true); // lifted eager value is already live
        expect(db.peek()).toBe(eagerDb);
        expect(orThrow(await db.get())).toBe(eagerDb);
        handleSeen = db;
      },
    });

    const app = orThrow(await defineApp('lift-eager').infra(provider).infra(consumer).boot());
    expect(handleSeen).toBeDefined();
    // The lifted wrapper is per-injection and unpublished — app-level access
    // still sees the plain value, and dispose leaves it untouched.
    expectTypeOf(app.services.db).toEqualTypeOf<Db>();
    expect(app.services.db).toBe(eagerDb);
    orThrow(await app.dispose());
    expect(orThrow(await handleSeen!.get())).toBe(eagerDb);
  });

  it('service.lazy passes a LAZY provider handle through by identity', async () => {
    const log: string[] = [];
    const consumer = infra({
      name: 'consumer',
      needs: { db: service.lazy<Db>() },
      provides: {
        consumerDb: ({ db }) => {
          expectTypeOf(db).toEqualTypeOf<Lazy<Db>>();
          expect(db.initialized).toBe(false); // still cold — no lift wrapping
          return db;
        },
      },
    });

    const app = orThrow(await defineApp('lift-lazy').infra(makeLazyDbUnit(log)).infra(consumer).boot());
    expect(app.services.consumerDb).toBe(app.services.db); // same handle object
    expect(log).toEqual([]);
    orThrow(await app.services.consumerDb.get());
    expect(log).toEqual(['init']);
    orThrow(await app.dispose());
    expect(log).toEqual(['init', 'close']); // provider-side cleanup still owns it
  });

  it('a republished handle is auto-disposed by its FIRST publisher — after that unit’s dispose hook', async () => {
    const order: string[] = [];
    const provider = infra({
      name: 'db',
      provides: {
        db: () =>
          lazy((): Db => ({ id: 3, close: () => void order.push('lazy-cleanup') }), {
            dispose: db => db.close(),
          }),
      },
      async dispose({ db }) {
        // The provider's own teardown still needs the handle alive, even
        // though a later unit republished it under another key. Reverse
        // dispose order must not let the republisher close it first.
        expect(orThrow(await db.get())).toMatchObject({ id: 3 });
        order.push('provider-hook');
      },
    });
    const alias = infra({
      name: 'alias',
      needs: { db: service.lazy<Db>() },
      provides: { aliasDb: ({ db }) => db },
      dispose: () => void order.push('alias-hook'),
    });

    const app = orThrow(await defineApp('lazy-ownership').infra(provider).infra(alias).boot());
    orThrow(await app.services.aliasDb.get());
    orThrow(await app.dispose());
    expect(order).toEqual(['alias-hook', 'provider-hook', 'lazy-cleanup']);
  });

  it('the guard accepts eager or lazy providers for a service.lazy need — and still rejects wrong types', () => {
    const eagerProvider = infra({ name: 'db', provides: { db: (): Db => ({ id: 1, close: () => void 1 }) } });
    const lazyProvider = makeLazyDbUnit([]);
    const consumer = infra({
      name: 'consumer',
      needs: { db: service.lazy<Db>() },
      boot: ({ db }) => {
        void db;
      },
    });
    const wrongProvider = infra({ name: 'db', provides: { db: () => 42 } });

    // Both provider strategies typecheck against the same consumer:
    defineApp('ok-eager').infra(eagerProvider).infra(consumer);
    defineApp('ok-lazy').infra(lazyProvider).infra(consumer);
    // @ts-expect-error — number is neither Db nor Lazy<Db>
    defineApp('bad').infra(wrongProvider).infra(consumer);
    expect(true).toBe(true);
  });

  it('runs the unit dispose hook BEFORE auto-disposing its lazy publishes', async () => {
    const order: string[] = [];
    const p = infra({
      name: 'ordered',
      provides: {
        svc: () => lazy(() => 'value', { dispose: () => void order.push('lazy-cleanup') }),
      },
      async dispose({ svc }) {
        // The handle is still usable inside the unit's own dispose hook.
        expect(orThrow(await svc.get())).toBe('value');
        order.push('hook');
      },
    });

    const app = orThrow(await defineApp('lazy-order').infra(p).boot());
    orThrow(await app.services.svc.get());
    orThrow(await app.dispose());
    expect(order).toEqual(['hook', 'lazy-cleanup']);
  });
});
