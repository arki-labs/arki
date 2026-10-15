/**
 * Lifecycle behaviour tests for the DOT kernel (v2).
 *
 * Tests enter through public boundaries only — `defineApp`, `plugin`, and the
 * `DotApp` lifecycle methods. The internal scheduler is not tested directly.
 *
 * v2 note: declaration order IS boot order. Ordering across plugins is
 * asserted via `.use()` order; the old name-based `dependencies` array no
 * longer exists.
 */

import { describe, expect, it } from 'vitest';

import { defineApp } from '../define-app.js';
import { DotLifecycleError, DotLifecycleErrorCode } from '../lifecycle.js';
import { plugin, rename, service } from '../plugin-contract.js';

type CallLog = {
  hook: 'configure' | 'boot' | 'start' | 'stop' | 'dispose';
  plugin: string;
};

/** Build a plugin that logs every hook invocation. */
function loggingPlugin(name: string, calls: CallLog[], overrides: { failIn?: 'boot' | 'start' | 'stop' } = {}) {
  return plugin({
    name,
    configure: () => {
      calls.push({ hook: 'configure', plugin: name });
    },
    boot: () => {
      calls.push({ hook: 'boot', plugin: name });
      if (overrides.failIn === 'boot') throw new Error(`boom-${name}`);
    },
    start: () => {
      calls.push({ hook: 'start', plugin: name });
      if (overrides.failIn === 'start') throw new Error(`start-failed-${name}`);
    },
    stop: () => {
      calls.push({ hook: 'stop', plugin: name });
      if (overrides.failIn === 'stop') throw new Error(`stop-broken-${name}`);
    },
    dispose: () => {
      calls.push({ hook: 'dispose', plugin: name });
    },
  });
}

describe('DOT lifecycle', () => {
  it('runs all 5 hooks in declaration order; stop/dispose run in reverse', async () => {
    const calls: CallLog[] = [];
    const a = loggingPlugin('a', calls);
    const b = loggingPlugin('b', calls);

    const app = await defineApp('test').use(a).use(b).start();
    await app.dispose();

    expect(calls).toEqual([
      { hook: 'configure', plugin: 'a' },
      { hook: 'configure', plugin: 'b' },
      { hook: 'boot', plugin: 'a' },
      { hook: 'boot', plugin: 'b' },
      { hook: 'start', plugin: 'a' },
      { hook: 'start', plugin: 'b' },
      { hook: 'stop', plugin: 'b' },
      { hook: 'stop', plugin: 'a' },
      { hook: 'dispose', plugin: 'b' },
      { hook: 'dispose', plugin: 'a' },
    ]);
  });

  it('rejects an async configure hook', async () => {
    const bad = plugin({
      name: 'bad',
      // Intentional: a configure hook returning a Promise must be detected.
      configure: () => Promise.resolve() as unknown as void,
    });

    await expect(defineApp('test').use(bad).boot()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.ConfigureAsync,
      phase: 'configure',
      plugin: 'bad',
    });
  });

  it('disposes already-booted plugins in reverse order when a later boot fails', async () => {
    const calls: CallLog[] = [];
    const a = loggingPlugin('a', calls);
    const b = loggingPlugin('b', calls, { failIn: 'boot' });

    await expect(defineApp('test').use(a).use(b).boot()).rejects.toBeInstanceOf(DotLifecycleError);

    // Plugin a booted, then b threw — a's dispose runs, b's dispose does NOT
    // (its boot never completed).
    expect(calls.filter(c => c.hook !== 'configure')).toEqual([
      { hook: 'boot', plugin: 'a' },
      { hook: 'boot', plugin: 'b' },
      { hook: 'dispose', plugin: 'a' },
    ]);
  });

  it('does not call dispose for a plugin whose boot threw with partial resources', async () => {
    const calls: CallLog[] = [];
    let partialCleanup = false;
    const a = loggingPlugin('a', calls);
    const partial = plugin({
      name: 'partial',
      boot: () => {
        calls.push({ hook: 'boot', plugin: 'partial' });
        // simulate partial resource setup, then failure — the plugin cleans up itself
        partialCleanup = true;
        throw new Error('partial-failed');
      },
      // dispose would never be called for partial — DOT only disposes booted plugins
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'partial' });
      },
    });

    await expect(defineApp('test').use(a).use(partial).boot()).rejects.toBeInstanceOf(DotLifecycleError);
    expect(partialCleanup).toBe(true);
    expect(calls.filter(c => c.plugin === 'partial' && c.hook === 'dispose')).toEqual([]);
    expect(calls.filter(c => c.plugin === 'a' && c.hook === 'dispose')).toEqual([{ hook: 'dispose', plugin: 'a' }]);
  });

  it('on start failure stops started plugins and disposes all booted plugins (reverse order)', async () => {
    const calls: CallLog[] = [];
    const a = loggingPlugin('a', calls);
    const b = loggingPlugin('b', calls, { failIn: 'start' });

    await expect(defineApp('test').use(a).use(b).start()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.StartFailed,
    });

    // a started, then b failed. a is stopped (reverse), then both are disposed (reverse).
    // b never started so b.stop is NOT called.
    expect(calls.filter(c => c.hook !== 'configure')).toEqual([
      { hook: 'boot', plugin: 'a' },
      { hook: 'boot', plugin: 'b' },
      { hook: 'start', plugin: 'a' },
      { hook: 'start', plugin: 'b' },
      { hook: 'stop', plugin: 'a' },
      { hook: 'dispose', plugin: 'b' },
      { hook: 'dispose', plugin: 'a' },
    ]);
  });

  it('stop continues through individual plugin failures with aggregate error', async () => {
    const calls: CallLog[] = [];
    const a = loggingPlugin('a', calls);
    const b = loggingPlugin('b', calls, { failIn: 'stop' });
    const c = loggingPlugin('c', calls);

    const app = await defineApp('test').use(a).use(b).use(c).start();
    await expect(app.stop()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.StopFailed,
    });

    expect(calls.filter(x => x.hook === 'stop')).toEqual([
      { hook: 'stop', plugin: 'c' },
      { hook: 'stop', plugin: 'b' },
      { hook: 'stop', plugin: 'a' },
    ]);
  });

  it('boot() is idempotent while app is booted', async () => {
    let bootCalls = 0;
    const p = plugin({
      name: 'p',
      boot: () => {
        bootCalls += 1;
      },
    });
    const app = await defineApp('test').use(p).boot();
    expect(bootCalls).toBe(1);
    await app.start();
    expect(bootCalls).toBe(1);
    // Calling start() again should not re-boot or re-start.
    await app.start();
    expect(bootCalls).toBe(1);
    await app.dispose();
  });

  it('concurrent boot() calls share the same in-flight promise', async () => {
    let bootCalls = 0;
    let resolveBoot!: () => void;
    const bootGate = new Promise<void>(r => {
      resolveBoot = r;
    });

    const slow = plugin({
      name: 'slow',
      boot: async () => {
        bootCalls += 1;
        await bootGate;
      },
    });

    const builder = defineApp('test').use(slow);
    // Drive boot through two concurrent start() calls on the same DotApp.
    // To do this we configure, then call boot() twice from a wrapped app.
    const configured = builder.configure();
    const p1 = configured.boot();
    const p2 = configured.boot();
    resolveBoot();
    const [app1, app2] = await Promise.all([p1, p2]);
    // Strongest contract: the shared in-flight promise means boot() ran once,
    // even with two concurrent callers. Wrappers may differ (each call wraps
    // the underlying impl), but they proxy to the same state.
    expect(bootCalls).toBe(1);
    expect(app1.state).toBe('booted');
    expect(app2.state).toBe('booted');
    expect(app1.name).toBe(app2.name);
    await app1.dispose();
    expect(app2.state).toBe('disposed');
  });

  it('start() from defined runs configure + boot first', async () => {
    const calls: CallLog[] = [];
    const p = loggingPlugin('p', calls);
    const app = await defineApp('test').use(p).start();
    expect(calls.map(c => c.hook)).toEqual(['configure', 'boot', 'start']);
    expect(app.state).toBe('started');
    await app.dispose();
  });

  it('stop() on a booted-but-never-started app is a no-op', async () => {
    let stopCalls = 0;
    const p = plugin({
      name: 'p',
      boot: () => { /* side effects only */ },
      stop: () => {
        stopCalls += 1;
      },
    });
    const app = await defineApp('test').use(p).boot();
    await app.stop();
    expect(stopCalls).toBe(0);
    expect(app.state).toBe('stopped');
    await app.dispose();
  });

  it('dispose() from started runs stop then dispose', async () => {
    const calls: CallLog[] = [];
    const p = plugin({
      name: 'p',
      start: () => {
        calls.push({ hook: 'start', plugin: 'p' });
      },
      stop: () => {
        calls.push({ hook: 'stop', plugin: 'p' });
      },
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'p' });
      },
    });
    const app = await defineApp('test').use(p).start();
    await app.dispose();
    expect(calls.map(c => c.hook)).toEqual(['start', 'stop', 'dispose']);
    expect(app.state).toBe('disposed');
  });

  it('boot() after dispose throws DotLifecycleError with ReuseAfterDispose code', async () => {
    const p = plugin({ name: 'p', boot: () => { /* side effects only */ } });
    const app = await defineApp('test').use(p).boot();
    await app.dispose();
    await expect(app.start()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.ReuseAfterDispose,
    });
  });

  it('unsatisfied need fails boot with UnsatisfiedNeed and rolls back booted plugins', async () => {
    const calls: CallLog[] = [];
    const a = loggingPlugin('a', calls);
    const consumer = plugin({
      name: 'consumer',
      needs: { db: service<{ query(): void }>() },
      boot: ({ db }) => {
        void db;
      },
    });

    // The compile-time guard forbids this chain; the erased seam simulates
    // dynamic composition, which the kernel must still validate.
    // @ts-expect-error — `db` has no provider; intentionally invalid wiring
    const builder = defineApp('test').use(a).use(consumer);
    await expect(builder.boot()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.UnsatisfiedNeed,
      phase: 'boot',
      plugin: 'consumer',
    });
    // Plugin a booted before the failure — it must be rolled back.
    expect(calls.filter(c => c.hook === 'dispose')).toEqual([{ hook: 'dispose', plugin: 'a' }]);
  });

  it('mutual needs between two plugins are a ring (E019) at configure, before anything boots', async () => {
    const a = plugin({
      name: 'a',
      needs: { beta: service<number>() },
      provides: { alpha: ({ beta }) => beta + 1 },
    });
    const b = plugin({
      name: 'b',
      needs: { alpha: service<number>() },
      provides: { beta: ({ alpha }) => alpha + 1 },
    });

    // No ordering of these two plugins typechecks — the cycle is unrepresentable
    // at the type level. The erased seam simulates dynamic composition, which
    // the kernel must still reject with actionable guidance.
    // @ts-expect-error — a's need has no provider; intentionally cyclic wiring
    const builder = defineApp('test').use(a).use(b);
    const error = await builder.boot().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DotLifecycleError);
    // Adapters declare their provides statically, so the kernel sees the ring
    // without booting either plugin.
    expect((error as DotLifecycleError).code).toBe(DotLifecycleErrorCode.CapabilityRing);
    expect((error as DotLifecycleError).message).toMatch(/a needs beta ← b needs alpha ← a/);
  });

  it('service collision fails boot with ServiceCollision and rolls back (incl. the colliding plugin)', async () => {
    const calls: CallLog[] = [];
    const first = plugin({
      name: 'first',
      provides: {
        db: () => {
          calls.push({ hook: 'boot', plugin: 'first' });
          return { from: 'first' };
        },
      },
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'first' });
      },
    });
    const second = plugin({
      name: 'second',
      provides: {
        db: () => {
          calls.push({ hook: 'boot', plugin: 'second' });
          return { from: 'second' };
        },
      },
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'second' });
      },
    });

    // @ts-expect-error — both provide wire key `db`; intentionally invalid wiring
    const builder = defineApp('test').use(first).use(second);
    await expect(builder.boot()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.ServiceCollision,
      phase: 'boot',
      plugin: 'second',
    });
    // Both plugins completed boot before the collision surfaced — both roll back,
    // in reverse order.
    expect(calls.filter(c => c.hook === 'dispose')).toEqual([
      { hook: 'dispose', plugin: 'second' },
      { hook: 'dispose', plugin: 'first' },
    ]);
  });

  it('detects duplicate plugin registration', () => {
    const a = plugin({ name: 'a' });
    expect(() => defineApp('test').use(a).use(a).configure()).toThrow(DotLifecycleError);
    try {
      defineApp('test').use(a).use(a).configure();
    } catch (error) {
      expect((error as DotLifecycleError).code).toBe(DotLifecycleErrorCode.DuplicatePlugin);
    }
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('lifecycle transition serialization', () => {
  it('dispose() issued during a slow start() queues behind it — no resurrection', async () => {
    const order: string[] = [];
    const entered = deferred();
    const gate = deferred();
    const slow = plugin({
      name: 'slow',
      boot: () => {
        order.push('boot');
      },
      start: async () => {
        order.push('start:begin');
        entered.resolve();
        await gate.promise;
        order.push('start:end');
      },
      stop: () => void order.push('stop'),
      dispose: () => void order.push('dispose'),
    });

    const app = await defineApp('race-start-dispose').use(slow).boot();
    const starting = app.start();
    await entered.promise; // start hook is mid-flight at its await point
    const disposing = app.dispose();
    await new Promise(r => setTimeout(r, 0)); // room for a mis-serialized dispose to interleave
    expect(order).toEqual(['boot', 'start:begin']); // dispose queued, not interleaved

    gate.resolve();
    await Promise.all([starting, disposing]);
    // Start completes first, THEN the queued dispose cascades stop+dispose.
    expect(order).toEqual(['boot', 'start:begin', 'start:end', 'stop', 'dispose']);
    expect(app.state).toBe('disposed'); // start must not stamp `started` over `disposed`
  });

  it('concurrent start() calls coalesce onto one in-flight transition', async () => {
    let startRuns = 0;
    const gate = deferred();
    const p = plugin({
      name: 'once',
      start: async () => {
        startRuns += 1;
        await gate.promise;
      },
    });

    const app = await defineApp('race-double-start').use(p).boot();
    const first = app.start();
    const second = app.start();
    gate.resolve();
    await Promise.all([first, second]);
    expect(startRuns).toBe(1);
    expect(app.state).toBe('started');
  });

  it('start() issued while dispose() is in flight rejects — a disposed app cannot restart', async () => {
    const entered = deferred();
    const gate = deferred();
    const p = plugin({
      name: 'p',
      boot: () => { /* side effects only */ },
      dispose: async () => {
        entered.resolve();
        await gate.promise;
      },
    });

    const app = await defineApp('race-dispose-start').use(p).boot();
    const disposing = app.dispose();
    await entered.promise; // dispose hook is mid-flight
    const starting = app.start();
    gate.resolve();
    await disposing;
    await expect(starting).rejects.toMatchObject({
      code: DotLifecycleErrorCode.ReuseAfterDispose,
    });
    expect(app.state).toBe('disposed');
  });
});

describe('hookTimeoutMs watchdog (E015)', () => {
  const never = () =>
    new Promise<void>(() => {
      /* never settles — the watchdog must catch it */
    });

  it('a hanging boot hook fails with HookTimeout and rolls back earlier plugins', async () => {
    const calls: CallLog[] = [];
    const good = loggingPlugin('good', calls);
    const hung = plugin({
      name: 'hung',
      boot: async () => {
        await never();
      },
    });

    await expect(
      defineApp('watchdog-boot', { hookTimeoutMs: 30 }).use(good).use(hung).boot(),
    ).rejects.toMatchObject({
      code: DotLifecycleErrorCode.HookTimeout,
      plugin: 'hung',
    });
    expect(calls.filter(c => c.hook === 'dispose')).toEqual([{ hook: 'dispose', plugin: 'good' }]);
  });

  it('a hanging start hook fails with HookTimeout and cascades the rollback', async () => {
    const calls: CallLog[] = [];
    const good = loggingPlugin('good', calls);
    const hung = plugin({
      name: 'hung-start',
      start: () => never(),
    });

    await expect(
      defineApp('watchdog-start', { hookTimeoutMs: 30 }).use(good).use(hung).start(),
    ).rejects.toMatchObject({
      code: DotLifecycleErrorCode.HookTimeout,
      plugin: 'hung-start',
    });
    // Already-started plugins stopped, booted plugins disposed.
    expect(calls.filter(c => c.hook === 'stop')).toEqual([{ hook: 'stop', plugin: 'good' }]);
    expect(calls.filter(c => c.hook === 'dispose')).toEqual([{ hook: 'dispose', plugin: 'good' }]);
  });

  it('a hanging dispose hook is bounded — teardown aggregates the timeout and continues', async () => {
    const order: string[] = [];
    const hung = plugin({
      name: 'hung-dispose',
      boot: () => { /* side effects only */ },
      dispose: () => never(),
    });
    const tidy = plugin({
      name: 'tidy',
      boot: () => { /* side effects only */ },
      dispose: () => void order.push('tidy'),
    });

    const app = await defineApp('watchdog-dispose', { hookTimeoutMs: 30 }).use(tidy).use(hung).boot();
    const error = await app.dispose().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DotLifecycleError);
    expect((error as DotLifecycleError).failures).toEqual([
      expect.objectContaining({ plugin: 'hung-dispose', phase: 'dispose' }),
    ]);
    expect(order).toEqual(['tidy']); // reverse order continued past the hang
  });

  it('hooks under budget are untouched by the watchdog', async () => {
    const quick = plugin({
      name: 'quick',
      provides: {
        ok: async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return true;
        },
      },
    });
    const app = await defineApp('watchdog-ok', { hookTimeoutMs: 1000 }).use(quick).boot();
    expect(app.services.ok).toBe(true);
    await app.dispose();
  });
});

describe('reserved $ keys (E014)', () => {
  it('a boot hook publishing a $-prefixed key fails with ReservedServiceKey and rolls back', async () => {
    const calls: CallLog[] = [];
    const good = loggingPlugin('good', calls);
    const bad = plugin({
      name: 'bad',
      // @ts-expect-error — $-prefixed provide keys are reserved for kernel context
      provides: { $app: () => 42 },
    });

    await expect(defineApp('reserved-publish').use(good).use(bad).boot()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.ReservedServiceKey,
    });
    // The earlier plugin had booted — it must roll back.
    expect(calls.filter(c => c.hook === 'dispose')).toEqual([{ hook: 'dispose', plugin: 'good' }]);
  });

  it('a $-prefixed needs alias throws ReservedServiceKey at construction', () => {
    const bad = plugin({
      name: 'bad-needs',
      // @ts-expect-error — $-prefixed needs aliases are reserved for kernel context
      needs: { $db: service<number>() },
    });

    let thrown: unknown;
    try {
      defineApp('reserved-needs').use(bad).configure();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: DotLifecycleErrorCode.ReservedServiceKey });
  });

  it('rename() to a $-prefixed wire key throws ReservedServiceKey at construction', () => {
    const provider = plugin({ name: 'db', provides: { db: () => 1 } });
    const renamed = rename(provider, { db: '$db' });

    let thrown: unknown;
    try {
      defineApp('reserved-rename').use(renamed).configure();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: DotLifecycleErrorCode.ReservedServiceKey });
  });
});
