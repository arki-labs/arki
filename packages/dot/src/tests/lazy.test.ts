/**
 * Tests for lazy service initialization.
 *
 * Two layers:
 *   1. `lazy()` handle semantics — memoization, single-flight, failed-init
 *      retry, dispose idempotency, get-after-dispose.
 *   2. Kernel integration — never-touched handles never initialize or clean
 *      up; initialized handles are auto-disposed in reverse order even when
 *      the publishing pip has no dispose hook; cleanup failures aggregate.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Lazy } from '../pip-contract.js';
import { defineApp } from '../define-app.js';
import { DotLifecycleError, DotLifecycleErrorCode } from '../lifecycle.js';
import { isLazy, lazy, pip, service } from '../pip-contract.js';

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

    const first = await handle.get();
    const second = await handle.get();
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
    const [a, b] = await Promise.all([p1, p2]);
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

    await expect(handle.get()).rejects.toThrow('flaky');
    expect(handle.initialized).toBe(false);
    await expect(handle.get()).resolves.toBe('ok');
    expect(attempts).toBe(2);
  });

  it('dispose runs cleanup once, only if initialized; get() after dispose throws', async () => {
    let cleanups = 0;
    const untouched = lazy(() => 'x', { dispose: () => void (cleanups += 1) });
    await untouched.dispose();
    expect(cleanups).toBe(0); // never initialized → no cleanup

    const touched = lazy(() => 'x', { dispose: () => void (cleanups += 1) });
    await touched.get();
    await touched.dispose();
    await touched.dispose(); // idempotent
    expect(cleanups).toBe(1);
    await expect(touched.get()).rejects.toThrow(/disposed/);
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
    await Promise.all([getting, disposing]);
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

  function makeLazyDbPip(log: string[]) {
    return pip({
      name: 'db',
      boot: () => ({
        db: lazy(
          (): Db => {
            log.push('init');
            return { id: 1, close: () => log.push('close') };
          },
          { dispose: db => db.close() },
        ),
      }),
      // NOTE: no dispose hook — the kernel auto-disposes the lazy handle.
    });
  }

  it('a never-accessed lazy service never initializes and never cleans up', async () => {
    const log: string[] = [];
    const app = await defineApp('lazy-untouched').use(makeLazyDbPip(log)).boot();
    expect(log).toEqual([]);
    expect(app.services.db.initialized).toBe(false);
    await app.dispose();
    expect(log).toEqual([]); // no init → no close
  });

  it('an initialized lazy service is auto-disposed at app.dispose() without a dispose hook', async () => {
    const log: string[] = [];
    const app = await defineApp('lazy-touched').use(makeLazyDbPip(log)).boot();
    const db = await app.services.db.get();
    expect(db.id).toBe(1);
    expect(log).toEqual(['init']);
    await app.dispose();
    expect(log).toEqual(['init', 'close']);
  });

  it('consumers receive the typed handle through needs and get() it on demand', async () => {
    const log: string[] = [];
    let seen: Db | undefined;
    const consumer = pip({
      name: 'consumer',
      needs: { db: service<Lazy<Db>>() },
      boot: ({ db }) => {
        expectTypeOf(db).toEqualTypeOf<Lazy<Db>>();
        expect(db.initialized).toBe(false); // still cold at consumer boot
        return {};
      },
      async start({ db }) {
        seen = await db.get(); // first access initializes
      },
    });

    const app = await defineApp('lazy-consumer').use(makeLazyDbPip(log)).use(consumer).start();
    expect(log).toEqual(['init']);
    expect(seen?.id).toBe(1);
    await app.dispose();
    expect(log).toEqual(['init', 'close']);
  });

  it('boot rollback auto-disposes initialized lazy services of already-booted pips', async () => {
    const log: string[] = [];
    const eager = pip({
      name: 'eager',
      needs: { db: service<Lazy<Db>>() },
      // Forces initialization during boot, then a later pip fails.
      boot: async ({ db }) => {
        await db.get();
        return {};
      },
    });
    const bomb = pip({
      name: 'bomb',
      boot: () => {
        throw new Error('boom');
      },
    });

    await expect(defineApp('lazy-rollback').use(makeLazyDbPip(log)).use(eager).use(bomb).boot()).rejects.toThrow(
      'boom',
    );
    expect(log).toEqual(['init', 'close']); // rollback cleaned the initialized handle
  });

  it('lazy cleanup failures aggregate into the dispose error with the pip name', async () => {
    const broken = pip({
      name: 'broken',
      boot: () => ({
        svc: lazy(() => 'value', {
          dispose: () => {
            throw new Error('cleanup-broken');
          },
        }),
      }),
    });

    const app = await defineApp('lazy-cleanup-fail').use(broken).boot();
    await app.services.svc.get();
    const error = await app.dispose().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DotLifecycleError);
    expect((error as DotLifecycleError).code).toBe(DotLifecycleErrorCode.DisposeFailed);
    expect((error as DotLifecycleError).failures).toEqual([
      expect.objectContaining({ pip: 'broken', phase: 'dispose' }),
    ]);
  });

  it('service.lazy lifts an EAGER provider into a pre-initialized handle', async () => {
    const eagerDb: Db = { id: 7, close: () => undefined };
    const provider = pip({ name: 'db', boot: () => ({ db: eagerDb }) });
    let handleSeen: Lazy<Db> | undefined;
    const consumer = pip({
      name: 'consumer',
      needs: { db: service.lazy<Db>() },
      boot: async ({ db }) => {
        expectTypeOf(db).toEqualTypeOf<Lazy<Db>>();
        expect(db.initialized).toBe(true); // lifted eager value is already live
        expect(db.peek()).toBe(eagerDb);
        expect(await db.get()).toBe(eagerDb);
        handleSeen = db;
        return {};
      },
    });

    const app = await defineApp('lift-eager').use(provider).use(consumer).boot();
    expect(handleSeen).toBeDefined();
    // The lifted wrapper is per-injection and unpublished — app-level access
    // still sees the plain value, and dispose leaves it untouched.
    expectTypeOf(app.services.db).toEqualTypeOf<Db>();
    expect(app.services.db).toBe(eagerDb);
    await app.dispose();
    expect(await handleSeen!.get().catch(() => 'rejected')).not.toBe('rejected');
  });

  it('service.lazy passes a LAZY provider handle through by identity', async () => {
    const log: string[] = [];
    const consumer = pip({
      name: 'consumer',
      needs: { db: service.lazy<Db>() },
      boot: ({ db }) => {
        expectTypeOf(db).toEqualTypeOf<Lazy<Db>>();
        expect(db.initialized).toBe(false); // still cold — no lift wrapping
        return { consumerDb: db };
      },
    });

    const app = await defineApp('lift-lazy').use(makeLazyDbPip(log)).use(consumer).boot();
    expect(app.services.consumerDb).toBe(app.services.db); // same handle object
    expect(log).toEqual([]);
    await app.services.consumerDb.get();
    expect(log).toEqual(['init']);
    await app.dispose();
    expect(log).toEqual(['init', 'close']); // provider-side cleanup still owns it
  });

  it('the guard accepts eager or lazy providers for a service.lazy need — and still rejects wrong types', () => {
    const eagerProvider = pip({ name: 'db', boot: () => ({ db: { id: 1, close: () => undefined } as Db }) });
    const lazyProvider = makeLazyDbPip([]);
    const consumer = pip({
      name: 'consumer',
      needs: { db: service.lazy<Db>() },
      boot: ({ db }) => {
        void db;
        return {};
      },
    });
    const wrongProvider = pip({ name: 'db', boot: () => ({ db: 42 }) });

    // Both provider strategies typecheck against the same consumer:
    defineApp('ok-eager').use(eagerProvider).use(consumer);
    defineApp('ok-lazy').use(lazyProvider).use(consumer);
    // @ts-expect-error — number is neither Db nor Lazy<Db>
    defineApp('bad').use(wrongProvider).use(consumer);
    expect(true).toBe(true);
  });

  it('runs the pip dispose hook BEFORE auto-disposing its lazy publishes', async () => {
    const order: string[] = [];
    const p = pip({
      name: 'ordered',
      boot: () => ({
        svc: lazy(() => 'value', { dispose: () => void order.push('lazy-cleanup') }),
      }),
      async dispose({ svc }) {
        // The handle is still usable inside the pip's own dispose hook.
        expect(await svc.get()).toBe('value');
        order.push('hook');
      },
    });

    const app = await defineApp('lazy-order').use(p).boot();
    await app.services.svc.get();
    await app.dispose();
    expect(order).toEqual(['hook', 'lazy-cleanup']);
  });
});
