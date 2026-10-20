import assert from 'node:assert/strict';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Failure, FailureOf, SuccessOf } from '@arki/failure';
import { MockClock } from '@arki/clock';
import { defineFailure, isFailure, UnexpectedDefect } from '@arki/failure';

import type { Lazy } from '../lazy.js';
import { isLazy, lazy, LazyClosed, lazyOf, LazyTag } from '../lazy.js';

const InitRefused = defineFailure('lazy_test.init_refused');
const CleanupRefused = defineFailure('lazy_test.cleanup_refused');

function deferred<Value>() {
  let accept: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>(resolve => {
    accept = resolve;
  });
  return {
    promise,
    resolve(value: Value) {
      assert.ok(accept);
      accept(value);
    },
  };
}
describe('lazy handle ownership', () => {
  it('ordinary success is lazy, shared, cached, and visible only while open', async () => {
    let attempts = 0;
    const handle = lazy(() => {
      attempts++;
      return { id: 7 };
    });
    assert.equal(attempts, 0);
    assert.equal(handle.initialized, false);
    assert.equal(handle.peek(), undefined);
    const first = handle.get();
    assert.equal(handle.get(), first);
    const value = await first;
    assert.ok(!isFailure(value));
    assert.equal(await handle.get(), value);
    assert.equal(handle.peek(), value);
    assert.equal(handle.initialized, true);
    assert.equal(attempts, 1);
    assert.equal(await handle.dispose(), undefined);
    assert.equal(handle.initialized, false);
    assert.equal(handle.peek(), undefined);
    assert.ok(LazyClosed.is(await handle.get()));
  });
  it('returned init failure is shared, never initialized, and retried later', async () => {
    let attempts = 0;
    let cleanups = 0;
    const refusal = InitRefused();
    const handle = lazy(() => (++attempts === 1 ? refusal : { id: 1 }), {
      dispose: value => {
        assert.equal(value.id, 1);
        cleanups++;
      },
    });
    const first = handle.get();
    assert.equal(handle.get(), first);
    assert.equal(await first, refusal);
    assert.equal(handle.initialized, false);
    assert.equal(handle.peek(), undefined);
    const next = await handle.get();
    assert.ok(!isFailure(next));
    assert.equal(next.id, 1);
    assert.equal(attempts, 2);
    assert.equal(await handle.dispose(), undefined);
    assert.equal(cleanups, 1);
  });
  it('sync init throw becomes private UnexpectedDefect and later call retries', async () => {
    const secret = new Error('init-private-secret');
    let attempts = 0;
    const handle = lazy(() => {
      if (++attempts === 1) throw secret;
      return 42;
    });
    const failed = await handle.get();
    assert.ok(UnexpectedDefect.is(failed));
    assert.equal(failed.cause, secret);
    assert.ok(!JSON.stringify(failed).includes('init-private-secret'));
    assert.equal(handle.peek(), undefined);
    assert.equal(await handle.get(), 42);
    assert.equal(await handle.dispose(), undefined);
  });
  it('async init rejection becomes UnexpectedDefect', async () => {
    const cause = new Error('async init');
    const handle = lazy(() => Promise.reject(cause));
    const failed = await handle.get();
    assert.ok(UnexpectedDefect.is(failed));
    assert.equal(failed.cause, cause);
    assert.equal(handle.initialized, false);
    assert.equal(await handle.dispose(), undefined);
  });
  it('disposal closes admission before pending initialization settles', async () => {
    const gate = deferred<{ id: number }>();
    const events: string[] = [];
    const handle = lazy(() => gate.promise, {
      dispose: value => {
        events.push(`close:${value.id}`);
      },
    });
    const getting = handle.get();
    const disposing = handle.dispose();
    assert.equal(handle.dispose(), disposing);
    assert.ok(LazyClosed.is(await handle.get()));
    assert.equal(handle.peek(), undefined);
    assert.equal(handle.initialized, false);
    gate.resolve({ id: 8 });
    assert.deepEqual(await getting, { id: 8 });
    assert.equal(await disposing, undefined);
    assert.deepEqual(events, ['close:8']);
  });
  it('pending init refusal reaches disposer, skips cleanup, and caches result', async () => {
    const refusal = InitRefused();
    const gate = deferred<typeof refusal>();
    let cleanups = 0;
    const handle = lazy(() => gate.promise, {
      dispose: () => {
        cleanups++;
      },
    });
    const getting = handle.get();
    const disposing = handle.dispose();
    gate.resolve(refusal);
    assert.equal(await getting, refusal);
    assert.equal(await disposing, refusal);
    assert.equal(handle.dispose(), disposing);
    assert.equal(await handle.dispose(), refusal);
    assert.equal(cleanups, 0);
    assert.ok(LazyClosed.is(await handle.get()));
  });
  it('pending init defect also reaches disposer with original private cause', async () => {
    const gate = deferred<void>();
    const cause = new Error('pending init defect');
    const handle = lazy(async () => {
      await gate.promise;
      throw cause;
    });
    const getting = handle.get();
    const disposing = handle.dispose();
    gate.resolve();
    const failed = await disposing;
    assert.ok(UnexpectedDefect.is(failed));
    assert.equal(failed.cause, cause);
    assert.equal(await getting, failed);
  });
  it('returned cleanup refusal is not erased by void and complete result is cached', async () => {
    let cleanups = 0;
    const failure = CleanupRefused();
    const handle = lazy(() => 42, {
      dispose: value => {
        assert.equal(value, 42);
        cleanups++;
        return failure;
      },
    });
    assert.equal(await handle.get(), 42);
    const disposing = handle.dispose();
    assert.equal(await disposing, failure);
    assert.equal(await handle.dispose(), failure);
    assert.equal(handle.dispose(), disposing);
    assert.equal(cleanups, 1);
  });
  it('all disposal callers wait for async cleanup and receive the complete result', async () => {
    const failure = CleanupRefused();
    const gate = deferred<typeof failure>();
    let cleanups = 0;
    const handle = lazy(() => 42, {
      dispose: () => {
        cleanups++;
        return gate.promise;
      },
    });
    assert.equal(await handle.get(), 42);
    let settled = false;
    const first = handle.dispose();
    const second = handle.dispose();
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(first, second);
    assert.ok(LazyClosed.is(await handle.get()));
    gate.resolve(failure);
    assert.equal(await first, failure);
    assert.equal(await second, failure);
    assert.equal(cleanups, 1);
  });
  it('cleanup throw and rejection normalize to cached private defects', async () => {
    const cause = new Error('cleanup-private-secret');
    for (const close of [
      () => {
        throw cause;
      },
      () => Promise.reject(cause),
    ]) {
      const handle = lazy(() => 42, { dispose: close });
      assert.equal(await handle.get(), 42);
      const failed = await handle.dispose();
      assert.ok(UnexpectedDefect.is(failed));
      assert.equal(failed.cause, cause);
      assert.equal(await handle.dispose(), failed);
      assert.ok(!JSON.stringify(failed).includes('cleanup-private-secret'));
    }
  });
  it('never initialized handle closes without opening or cleaning', async () => {
    let attempts = 0;
    let cleanups = 0;
    const handle = lazy(
      () => {
        attempts++;
        return 42;
      },
      {
        dispose: () => {
          cleanups++;
        },
      },
    );
    const disposing = handle.dispose();
    assert.ok(LazyClosed.is(await handle.get()));
    assert.equal(await disposing, undefined);
    assert.equal(await handle.dispose(), undefined);
    assert.equal(attempts, 0);
    assert.equal(cleanups, 0);
  });
  it('undefined is a successful resource and is disposed once', async () => {
    let cleanups = 0;
    let opened = false;
    const handle = lazy(
      () => {
        opened = true;
      },
      {
        dispose: value => {
          assert.equal(value, undefined);
          cleanups++;
        },
      },
    );
    assert.equal(await handle.get(), undefined);
    assert.equal(opened, true);
    assert.equal(handle.initialized, true);
    assert.equal(await handle.dispose(), undefined);
    assert.equal(cleanups, 1);
  });
  it('incidental cleanup success normalizes to void and stays cached', async () => {
    const handle = lazy(() => 42, { dispose: () => 123 });
    assert.equal(await handle.get(), 42);
    assert.equal(await handle.dispose(), undefined);
    assert.equal(await handle.dispose(), undefined);
  });
});

describe('lazy clocks and borrowed services', () => {
  it('waits for initialization and cleanup timers while admission stays closed', async () => {
    const clock = new MockClock();
    const refused = CleanupRefused();
    let initialized = false;
    let cleaned = false;
    const handle = lazy(
      async () => {
        await clock.sleep(20);
        initialized = true;
        return { id: 9 };
      },
      {
        dispose: async value => {
          expect(value.id).toBe(9);
          await clock.sleep(30);
          cleaned = true;
          return refused;
        },
      },
    );
    const getting = handle.get();
    const disposing = handle.dispose();
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    expect(LazyClosed.is(await handle.get())).toBe(true);
    await clock.advanceAsync(19);
    expect(initialized).toBe(false);
    expect(disposed).toBe(false);
    await clock.advanceAsync(1);
    expect(initialized).toBe(true);
    expect(isFailure(await getting)).toBe(false);
    expect(handle.peek()).toBeUndefined();
    await clock.advanceAsync(29);
    expect(cleaned).toBe(false);
    expect(disposed).toBe(false);
    await clock.advanceAsync(1);
    expect(await disposing).toBe(refused);
    expect(cleaned).toBe(true);
    expect(await handle.dispose()).toBe(refused);
  });

  it('borrows an eager value without calling or owning its cleanup', async () => {
    let cleanups = 0;
    const value = {
      id: 4,
      close() {
        cleanups++;
      },
    };
    const handle = lazyOf(value);
    expect(isLazy(handle)).toBe(true);
    expect(handle.initialized).toBe(true);
    expect(handle.peek()).toBe(value);
    expect(await handle.get()).toBe(value);
    expect(await handle.dispose()).toBeUndefined();
    expect(cleanups).toBe(0);
    expect(handle.initialized).toBe(false);
    expect(handle.peek()).toBeUndefined();
    expect(LazyClosed.is(await handle.get())).toBe(true);
  });

  it('never exposes a borrowed failure as an initialized service', async () => {
    const refused = InitRefused();
    const handle = lazyOf(refused);
    expect(handle.initialized).toBe(false);
    expect(handle.peek()).toBeUndefined();
    expect(await handle.get()).toBe(refused);
    expect(handle.initialized).toBe(false);
    expect(handle.peek()).toBeUndefined();
    expect(await handle.dispose()).toBeUndefined();
  });

  it('preserves borrowed failure inference and an honest erased cleanup outcome', () => {
    const borrowed = lazyOf(InitRefused());
    const _getDefinitions = [InitRefused, LazyClosed] as const;
    expectTypeOf<FailureOf<typeof borrowed.get>>().toEqualTypeOf<ReturnType<(typeof _getDefinitions)[number]>>();
    expectTypeOf(borrowed.peek()).toEqualTypeOf<undefined>();
    const value: unknown = lazy(() => 42, { dispose: () => CleanupRefused() });
    if (isLazy(value)) {
      expectTypeOf<Awaited<ReturnType<typeof value.dispose>>>().toMatchTypeOf<Failure | undefined>();
      expectTypeOf<Failure | undefined>().toMatchTypeOf<Awaited<ReturnType<typeof value.dispose>>>();
    }
    expect(isLazy(null)).toBe(false);
    expect(isLazy({ get: () => 1 })).toBe(false);
    expect(isLazy({ [LazyTag]: false })).toBe(false);
  });
});

// Compile-only fixtures keep callback outputs as the sole failure type source.
function exactCallbackContracts() {
  const fails = false as boolean;
  const init = () => Promise.resolve(fails ? InitRefused() : { query: () => 42 });
  const close = (db: SuccessOf<typeof init>) => Promise.resolve(fails ? CleanupRefused() : void db.query());
  const handle = lazy(init, { dispose: close });
  const _inline = lazy(init, {
    dispose: db => {
      expectTypeOf(db).toEqualTypeOf<SuccessOf<typeof init>>();
      // @ts-expect-error Cleanup receives only a successfully initialized resource.
      void db.code;
      return CleanupRefused();
    },
  });
  const _noCleanup = lazy(init);
  const _synchronous = lazy(() => (fails ? InitRefused() : 42), { dispose: () => CleanupRefused() });
  const _asyncCleanup = lazy(() => 42, { dispose: () => Promise.resolve(CleanupRefused()) });
  const defaulted = lazy(() => 42);
  const incidental = lazy(() => 42, { dispose: () => 123 });
  const plainAlias: Lazy<number> = defaulted;
  const incidentalAlias: Lazy<number> = incidental;
  void plainAlias;
  void incidentalAlias;
  // @ts-expect-error An init-refusing provider cannot hide refusal behind Lazy<Db>.
  const erasedInit: Lazy<SuccessOf<typeof init>> = handle;
  // @ts-expect-error A cleanup refusal cannot hide in a default dispose contract.
  const erasedCleanup: Lazy<Awaited<ReturnType<typeof init>>> = handle;
  void erasedInit;
  void erasedCleanup;
  // @ts-expect-error Unknown initialization requires validation before ownership.
  lazy((): unknown => InitRefused());
  // @ts-expect-error Async unknown initialization also requires validation.
  lazy((): Promise<unknown> => Promise.resolve(InitRefused()));
  // @ts-expect-error Unknown cleanup can hide a returned refusal.
  lazy(() => 42, { dispose: (): unknown => CleanupRefused() });
  // @ts-expect-error Async unknown cleanup can also hide a returned refusal.
  lazy(() => 42, { dispose: (): Promise<unknown> => Promise.resolve(CleanupRefused()) });
  const untyped: unknown = {};
  // Borrowing an erased registry value does not claim to validate its shape.
  const _borrowedUnknown = lazyOf(untyped);
  expectTypeOf<Awaited<ReturnType<typeof _borrowedUnknown.get>>>().toEqualTypeOf<unknown>();
  expectTypeOf<Awaited<ReturnType<typeof _borrowedUnknown.dispose>>>().toEqualTypeOf<undefined>();
  const _getDefinitions = [InitRefused, UnexpectedDefect, LazyClosed] as const;
  const _disposeDefinitions = [InitRefused, CleanupRefused, UnexpectedDefect] as const;
  const _noCleanupDefinitions = [InitRefused, UnexpectedDefect] as const;
  const _cleanupDefinitions = [CleanupRefused, UnexpectedDefect] as const;
  expectTypeOf<FailureOf<typeof handle.get>>().toEqualTypeOf<ReturnType<(typeof _getDefinitions)[number]>>();
  expectTypeOf<SuccessOf<typeof handle.get>>().toEqualTypeOf<SuccessOf<typeof init>>();
  expectTypeOf<FailureOf<typeof handle.dispose>>().toEqualTypeOf<ReturnType<(typeof _disposeDefinitions)[number]>>();
  expectTypeOf<SuccessOf<typeof handle.dispose>>().toEqualTypeOf<undefined>();
  expectTypeOf(handle.peek()).toEqualTypeOf<SuccessOf<typeof init> | undefined>();
  expectTypeOf<FailureOf<typeof _inline.dispose>>().toEqualTypeOf<ReturnType<(typeof _disposeDefinitions)[number]>>();
  expectTypeOf<FailureOf<typeof _noCleanup.dispose>>().toEqualTypeOf<
    ReturnType<(typeof _noCleanupDefinitions)[number]>
  >();
  expectTypeOf<FailureOf<typeof _synchronous.get>>().toEqualTypeOf<ReturnType<(typeof _getDefinitions)[number]>>();
  expectTypeOf<FailureOf<typeof _asyncCleanup.dispose>>().toEqualTypeOf<
    ReturnType<(typeof _cleanupDefinitions)[number]>
  >();
  expectTypeOf<SuccessOf<typeof incidental.dispose>>().toEqualTypeOf<undefined>();
  expectTypeOf<string extends FailureOf<typeof handle.get>['code'] ? true : false>().toEqualTypeOf<false>();
}
void exactCallbackContracts;
