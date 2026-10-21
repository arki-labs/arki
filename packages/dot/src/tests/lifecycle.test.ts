/**
 * Lifecycle behaviour tests for the DOT kernel (v2).
 *
 * Tests enter through public boundaries only — `defineApp`, `plugin`, and the
 * `DotApp` lifecycle methods. The internal scheduler is not tested directly.
 *
 * v2 note: declaration order IS boot order. Ordering across units is
 * asserted via `.infra()` order; the old name-based `dependencies` array no
 * longer exists.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { FailureOf, SuccessOf } from '@arki/failure';
import { Deadline } from '@arki/async';
import { defineFailure, isFailure, orThrow, UnexpectedDefect } from '@arki/failure';

import { defineApp } from '../define-app.js';
import { DotLifecycleError, DotLifecycleErrorCode } from '../lifecycle.js';
import { infra, rename, service } from '../unit-contract.js';

type CallLog = {
  hook: 'configure' | 'boot' | 'start' | 'stop' | 'dispose';
  plugin: string;
};

/** Build a unit that logs every hook invocation. */
function loggingUnit(name: string, calls: CallLog[], overrides: { failIn?: 'boot' | 'start' | 'stop' } = {}) {
  return infra({
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
    const a = loggingUnit('a', calls);
    const b = loggingUnit('b', calls);

    const app = orThrow(await defineApp('test').infra(a).infra(b).start());
    orThrow(await app.dispose());

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

  it('returns a supervised defect for an async configure hook', async () => {
    const bad = infra({
      name: 'bad',
      // @ts-expect-error Deliberately bypass authoring to test the runtime protocol check.
      configure: () => Promise.resolve(),
    });

    await expect(defineApp('test').infra(bad).boot()).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.ConfigureAsync,
        phase: 'configure',
        plugin: 'bad',
      },
    });
  });

  it('supervises malformed JavaScript hook returns and still completes teardown', async () => {
    const configured = defineApp('invalid-configure')
      .infra(
        infra({
          name: 'invalid',
          // @ts-expect-error JavaScript authors can return an invalid phase result.
          configure: () => 42,
        }),
      )
      .configure();
    expect(configured).toMatchObject({ code: UnexpectedDefect.code, cause: { phase: 'configure', plugin: 'invalid' } });

    const calls: string[] = [];
    const app = orThrow(
      await defineApp('invalid-dispose')
        .infra(
          infra({
            name: 'first',
            dispose() {
              calls.push('first');
            },
          }),
        )
        .infra(
          infra({
            name: 'invalid',
            // @ts-expect-error An invalid result must never turn disposal into success.
            dispose: () => 42,
          }),
        )
        .boot(),
    );
    const disposed = await app.dispose();
    expect(disposed).toMatchObject({ code: UnexpectedDefect.code, cause: { phase: 'dispose', plugin: 'invalid' } });
    expect(calls).toEqual(['first']);
  });

  it('disposes already-booted units in reverse order when a later boot fails', async () => {
    const calls: CallLog[] = [];
    const a = loggingUnit('a', calls);
    const b = loggingUnit('b', calls, { failIn: 'boot' });

    const outcome = await defineApp('test').infra(a).infra(b).boot();
    expect(UnexpectedDefect.is(outcome)).toBe(true);
    expect(outcome).toMatchObject({ cause: new Error('boom-b') });

    // Unit a booted, then b threw — a's dispose runs, b's dispose does NOT
    // (its boot never completed).
    expect(calls.filter(c => c.hook !== 'configure')).toEqual([
      { hook: 'boot', plugin: 'a' },
      { hook: 'boot', plugin: 'b' },
      { hook: 'dispose', plugin: 'a' },
    ]);
  });

  it('does not call dispose for a unit whose boot threw with partial resources', async () => {
    const calls: CallLog[] = [];
    let partialCleanup = false;
    const a = loggingUnit('a', calls);
    const partial = infra({
      name: 'partial',
      boot: () => {
        calls.push({ hook: 'boot', plugin: 'partial' });
        // simulate partial resource setup, then failure — the unit cleans up itself
        partialCleanup = true;
        throw new Error('partial-failed');
      },
      // dispose would never be called for partial — DOT only disposes booted units
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'partial' });
      },
    });

    const outcome = await defineApp('test').infra(a).infra(partial).boot();
    expect(UnexpectedDefect.is(outcome)).toBe(true);
    expect(outcome).toMatchObject({ cause: new Error('partial-failed') });
    expect(partialCleanup).toBe(true);
    expect(calls.filter(c => c.plugin === 'partial' && c.hook === 'dispose')).toEqual([]);
    expect(calls.filter(c => c.plugin === 'a' && c.hook === 'dispose')).toEqual([{ hook: 'dispose', plugin: 'a' }]);
  });

  it('on start failure stops started units and disposes all booted units (reverse order)', async () => {
    const calls: CallLog[] = [];
    const a = loggingUnit('a', calls);
    const b = loggingUnit('b', calls, { failIn: 'start' });

    await expect(defineApp('test').infra(a).infra(b).start()).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.StartFailed,
      },
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

  it('stop continues through individual unit failures with aggregate error', async () => {
    const calls: CallLog[] = [];
    const a = loggingUnit('a', calls);
    const b = loggingUnit('b', calls, { failIn: 'stop' });
    const c = loggingUnit('c', calls);

    const app = orThrow(await defineApp('test').infra(a).infra(b).infra(c).start());
    await expect(app.stop()).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.StopFailed,
      },
    });

    expect(calls.filter(x => x.hook === 'stop')).toEqual([
      { hook: 'stop', plugin: 'c' },
      { hook: 'stop', plugin: 'b' },
      { hook: 'stop', plugin: 'a' },
    ]);
  });

  it('boot() is idempotent while app is booted', async () => {
    let bootCalls = 0;
    const p = infra({
      name: 'p',
      boot: () => {
        bootCalls += 1;
      },
    });
    const app = orThrow(await defineApp('test').infra(p).boot());
    expect(bootCalls).toBe(1);
    orThrow(await app.start());
    expect(bootCalls).toBe(1);
    // Calling start() again should not re-boot or re-start.
    orThrow(await app.start());
    expect(bootCalls).toBe(1);
    orThrow(await app.dispose());
  });

  it('concurrent boot() calls share the same in-flight promise', async () => {
    let bootCalls = 0;
    let resolveBoot!: () => void;
    const bootGate = new Promise<void>(r => {
      resolveBoot = r;
    });

    const slow = infra({
      name: 'slow',
      boot: async () => {
        bootCalls += 1;
        await bootGate;
      },
    });

    const builder = defineApp('test').infra(slow);
    // Drive boot through two concurrent start() calls on the same DotApp.
    // To do this we configure, then call boot() twice from a wrapped app.
    const configured = orThrow(builder.configure());
    const p1 = configured.boot();
    const p2 = configured.boot();
    resolveBoot();
    const [app1, app2] = await Promise.all([p1.then(value => orThrow(value)), p2.then(value => orThrow(value))]);
    // Strongest contract: the shared in-flight promise means boot() ran once,
    // even with two concurrent callers. Wrappers may differ (each call wraps
    // the underlying impl), but they proxy to the same state.
    expect(bootCalls).toBe(1);
    expect(app1.state).toBe('booted');
    expect(app2.state).toBe('booted');
    expect(app1.name).toBe(app2.name);
    orThrow(await app1.dispose());
    expect(app2.state).toBe('disposed');
  });

  it('start() from defined runs configure + boot first', async () => {
    const calls: CallLog[] = [];
    const p = loggingUnit('p', calls);
    const app = orThrow(await defineApp('test').infra(p).start());
    expect(calls.map(c => c.hook)).toEqual(['configure', 'boot', 'start']);
    expect(app.state).toBe('started');
    orThrow(await app.dispose());
  });

  it('stop() on a booted-but-never-started app is a no-op', async () => {
    let stopCalls = 0;
    const p = infra({
      name: 'p',
      boot: () => {
        /* side effects only */
      },
      stop: () => {
        stopCalls += 1;
      },
    });
    const app = orThrow(await defineApp('test').infra(p).boot());
    expect(await app.stop()).toBeUndefined();
    expect(stopCalls).toBe(0);
    expect(app.state).toBe('stopped');
    orThrow(await app.dispose());
  });

  it('dispose() from started runs stop then dispose', async () => {
    const calls: CallLog[] = [];
    const p = infra({
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
    const app = orThrow(await defineApp('test').infra(p).start());
    orThrow(await app.dispose());
    expect(calls.map(c => c.hook)).toEqual(['start', 'stop', 'dispose']);
    expect(app.state).toBe('disposed');
  });

  it('start() after dispose returns a defect with ReuseAfterDispose diagnostics', async () => {
    const p = infra({
      name: 'p',
      boot: () => {
        /* side effects only */
      },
    });
    const app = orThrow(await defineApp('test').infra(p).boot());
    orThrow(await app.dispose());
    await expect(app.start()).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.ReuseAfterDispose,
      },
    });
  });

  it('unsatisfied need fails boot with UnsatisfiedNeed and rolls back booted units', async () => {
    const calls: CallLog[] = [];
    const a = loggingUnit('a', calls);
    const consumer = infra({
      name: 'consumer',
      needs: { db: service<{ query(): void }>() },
      boot: ({ db }) => {
        void db;
      },
    });

    // The compile-time guard forbids this chain; the erased seam simulates
    // dynamic composition, which the kernel must still validate.
    // @ts-expect-error — `db` has no provider; intentionally invalid wiring
    const builder = defineApp('test').infra(a).infra(consumer);
    await expect(builder.boot()).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.UnsatisfiedNeed,
        phase: 'boot',
        plugin: 'consumer',
      },
    });
    // Unit a booted before the failure — it must be rolled back.
    expect(calls.filter(c => c.hook === 'dispose')).toEqual([{ hook: 'dispose', plugin: 'a' }]);
  });

  it('mutual needs between two units are a ring (E019) at configure, before anything boots', async () => {
    const a = infra({
      name: 'a',
      needs: { beta: service<number>() },
      provides: { alpha: ({ beta }) => beta + 1 },
    });
    const b = infra({
      name: 'b',
      needs: { alpha: service<number>() },
      provides: { beta: ({ alpha }) => alpha + 1 },
    });

    // No ordering of these two units typechecks — the cycle is unrepresentable
    // at the type level. The erased seam simulates dynamic composition, which
    // the kernel must still reject with actionable guidance.
    // @ts-expect-error — a's need has no provider; intentionally cyclic wiring
    const builder = defineApp('test').infra(a).infra(b);
    const outcome = await builder.boot();
    expect(outcome).toMatchObject({
      code: UnexpectedDefect.code,
      cause: { code: DotLifecycleErrorCode.CapabilityRing },
    });
    if (UnexpectedDefect.is(outcome)) {
      expect(outcome.cause).toBeInstanceOf(DotLifecycleError);
      expect(outcome.cause).toMatchObject({ message: expect.stringMatching(/a needs beta ← b needs alpha ← a/) });
    }
  });

  it('service collision fails boot with ServiceCollision and rolls back (incl. the colliding unit)', async () => {
    const calls: CallLog[] = [];
    const first = infra({
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
    const second = infra({
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
    const builder = defineApp('test').infra(first).infra(second);
    await expect(builder.boot()).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.ServiceCollision,
        phase: 'boot',
        plugin: 'second',
      },
    });
    // Both units completed boot before the collision surfaced — both roll back,
    // in reverse order.
    expect(calls.filter(c => c.hook === 'dispose')).toEqual([
      { hook: 'dispose', plugin: 'second' },
      { hook: 'dispose', plugin: 'first' },
    ]);
  });

  it('reports duplicate unit registration as a managed configure defect', () => {
    const a = infra({ name: 'a' });
    const outcome = defineApp('test').infra(a).infra(a).configure();
    expect(outcome).toMatchObject({
      code: UnexpectedDefect.code,
      cause: { code: DotLifecycleErrorCode.DuplicateUnit },
    });
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
    const slow = infra({
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

    const app = orThrow(await defineApp('race-start-dispose').infra(slow).boot());
    const starting = app.start();
    await entered.promise; // start hook is mid-flight at its await point
    const disposing = app.dispose();
    await new Promise(r => setTimeout(r, 0)); // room for a mis-serialized dispose to interleave
    expect(order).toEqual(['boot', 'start:begin']); // dispose queued, not interleaved

    gate.resolve();
    await Promise.all([starting.then(value => orThrow(value)), disposing.then(value => orThrow(value))]);
    // Start completes first, THEN the queued dispose cascades stop+dispose.
    expect(order).toEqual(['boot', 'start:begin', 'start:end', 'stop', 'dispose']);
    expect(app.state).toBe('disposed'); // start must not stamp `started` over `disposed`
  });

  it('concurrent start() calls coalesce onto one in-flight transition', async () => {
    let startRuns = 0;
    const gate = deferred();
    const p = infra({
      name: 'once',
      start: async () => {
        startRuns += 1;
        await gate.promise;
      },
    });

    const app = orThrow(await defineApp('race-double-start').infra(p).boot());
    const first = app.start();
    const second = app.start();
    gate.resolve();
    await Promise.all([first.then(value => orThrow(value)), second.then(value => orThrow(value))]);
    expect(startRuns).toBe(1);
    expect(app.state).toBe('started');
  });

  it('start() issued while dispose() is in flight fails — a disposed app cannot restart', async () => {
    const entered = deferred();
    const gate = deferred();
    const p = infra({
      name: 'p',
      boot: () => {
        /* side effects only */
      },
      dispose: async () => {
        entered.resolve();
        await gate.promise;
      },
    });

    const app = orThrow(await defineApp('race-dispose-start').infra(p).boot());
    const disposing = app.dispose();
    await entered.promise; // dispose hook is mid-flight
    const starting = app.start();
    gate.resolve();
    orThrow(await disposing);
    await expect(starting).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.ReuseAfterDispose,
      },
    });
    expect(app.state).toBe('disposed');
  });
});

describe('hookTimeoutMs watchdog (E015)', () => {
  it('a boot deadline joins owned work before rolling back earlier units', async () => {
    const calls: CallLog[] = [];
    const cancelled = deferred();
    const gate = deferred();
    const hung = infra({
      name: 'hung',
      boot: async ({ $signal }) => {
        $signal.addEventListener('abort', cancelled.resolve, { once: true });
        await gate.promise;
      },
    });
    const pending = defineApp('watchdog-boot', { hookTimeoutMs: 30 })
      .infra(loggingUnit('good', calls))
      .infra(hung)
      .boot();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await cancelled.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(calls.filter(c => c.hook === 'dispose')).toEqual([]);
    gate.resolve();
    expect(await pending).toMatchObject({ code: 'async.deadline' });
    expect(calls.filter(c => c.hook === 'dispose')).toEqual([{ hook: 'dispose', plugin: 'good' }]);
  });

  it('a start deadline joins the hook before cascading rollback', async () => {
    const calls: CallLog[] = [];
    const cancelled = deferred();
    const gate = deferred();
    const hung = infra({
      name: 'hung-start',
      start: async ({ $signal }) => {
        $signal.addEventListener('abort', cancelled.resolve, { once: true });
        await gate.promise;
      },
    });
    const pending = defineApp('watchdog-start', { hookTimeoutMs: 30 })
      .infra(loggingUnit('good', calls))
      .infra(hung)
      .start();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await cancelled.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(calls.filter(c => c.hook === 'stop' || c.hook === 'dispose')).toEqual([]);
    gate.resolve();
    await expect(pending).resolves.toMatchObject({
      code: Deadline.code,
      cause: { code: DotLifecycleErrorCode.HookTimeout, plugin: 'hung-start' },
    });
    expect(calls.filter(c => c.hook === 'stop')).toEqual([{ hook: 'stop', plugin: 'good' }]);
    expect(calls.filter(c => c.hook === 'dispose')).toEqual([{ hook: 'dispose', plugin: 'good' }]);
  });

  it('a dispose deadline joins cleanup before disposing earlier units', async () => {
    const order: string[] = [];
    const cancelled = deferred();
    const gate = deferred();
    const hung = infra({
      name: 'hung-dispose',
      dispose: async ({ $signal }) => {
        $signal.addEventListener('abort', cancelled.resolve, { once: true });
        await gate.promise;
      },
    });
    const tidy = infra({ name: 'tidy', dispose: () => void order.push('tidy') });
    const app = orThrow(await defineApp('watchdog-dispose', { hookTimeoutMs: 30 }).infra(tidy).infra(hung).boot());
    const pending = app.dispose();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await cancelled.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(order).toEqual([]);
    gate.resolve();
    const outcome = await pending;
    expect(Deadline.is(outcome)).toBe(true);
    expect(outcome).toMatchObject({
      cause: { code: DotLifecycleErrorCode.HookTimeout, plugin: 'hung-dispose', phase: 'dispose' },
    });
    expect(order).toEqual(['tidy']);
  });

  it("aborts an owned boot hook's signal and reports Deadline after it stops", async () => {
    let seen: AbortSignal | undefined;
    let stopped = false;
    const hung = infra({
      name: 'hung-io',
      boot: ({ $signal }) => {
        seen = $signal;
        return new Promise<undefined>(resolve => {
          $signal.addEventListener(
            'abort',
            () => {
              stopped = true;
              // eslint-disable-next-line unicorn/no-useless-undefined -- Explicit undefined prevents void from erasing returned failures.
              resolve(undefined);
            },
            { once: true },
          );
        });
      },
    });
    expect(await defineApp('watchdog-signal', { hookTimeoutMs: 30 }).infra(hung).boot()).toMatchObject({
      code: 'async.deadline',
    });
    expect(stopped).toBe(true);
    expect(seen?.aborted).toBe(true);
  });

  it('gives each hook call its own signal, not aborted when the hook finishes in time', async () => {
    const signals: AbortSignal[] = [];
    const quick = infra({
      name: 'quick-signal',
      boot: ({ $signal }) => void signals.push($signal),
      start: ({ $signal }) => void signals.push($signal),
    });
    const app = orThrow(await defineApp('watchdog-signal-ok', { hookTimeoutMs: 1000 }).infra(quick).start());
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.some(signal => signal.aborted)).toBe(false);
    expect(await app.stop()).toBeUndefined();
    orThrow(await app.dispose());
  });

  it('hooks under budget are untouched by the watchdog', async () => {
    const quick = infra({
      name: 'quick',
      provides: {
        ok: async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return true;
        },
      },
    });
    const app = orThrow(await defineApp('watchdog-ok', { hookTimeoutMs: 1000 }).infra(quick).boot());
    expect(app.services.ok).toBe(true);
    orThrow(await app.dispose());
  });
});

describe('reserved $ keys (E014)', () => {
  it('a boot hook publishing a $-prefixed key fails with ReservedServiceKey and rolls back', async () => {
    const calls: CallLog[] = [];
    const good = loggingUnit('good', calls);
    const bad = infra({
      name: 'bad',
      // @ts-expect-error — $-prefixed provide keys are reserved for kernel context
      provides: { $app: () => 42 },
    });

    await expect(defineApp('reserved-publish').infra(good).infra(bad).boot()).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.ReservedServiceKey,
      },
    });
    // The earlier unit had booted — it must roll back.
    expect(calls.filter(c => c.hook === 'dispose')).toEqual([{ hook: 'dispose', plugin: 'good' }]);
  });

  it('a $-prefixed needs alias returns a defect with ReservedServiceKey diagnostics', () => {
    const bad = infra({
      name: 'bad-needs',
      // @ts-expect-error — $-prefixed needs aliases are reserved for kernel context
      needs: { $db: service<number>() },
    });

    const outcome = defineApp('reserved-needs').infra(bad).configure();
    expect(outcome).toMatchObject({
      code: UnexpectedDefect.code,
      cause: { code: DotLifecycleErrorCode.ReservedServiceKey },
    });
  });

  it('rename() to a $-prefixed wire key returns a defect with ReservedServiceKey diagnostics', () => {
    const provider = infra({ name: 'db', provides: { db: () => 1 } });
    const renamed = rename(provider, { db: '$db' });

    const outcome = defineApp('reserved-rename').infra(renamed).configure();
    expect(outcome).toMatchObject({
      code: UnexpectedDefect.code,
      cause: { code: DotLifecycleErrorCode.ReservedServiceKey },
    });
  });
});

describe('typed lifecycle outcomes', () => {
  const ConfigureFailed = defineFailure('test.dot.configure_failed');
  const BootFailed = defineFailure('test.dot.boot_failed');
  const StartFailed = defineFailure('test.dot.start_failed');
  const StopFailed = defineFailure('test.dot.stop_failed');
  const DisposeFailed = defineFailure('test.dot.dispose_failed');

  it('does not reach later configure or boot callbacks after a known configure failure', async () => {
    const failure = ConfigureFailed();
    const calls: string[] = [];
    const result = await defineApp('configure-known')
      .infra(infra({ name: 'failed', configure: () => failure, boot: () => void calls.push('failed-boot') }))
      .infra(
        infra({
          name: 'consumer',
          configure: () => void calls.push('consumer-configure'),
          boot: () => void calls.push('consumer-boot'),
        }),
      )
      .boot();
    expect(result).toBe(failure);
    expect(calls).toEqual([]);
  });

  it('keeps the start primary identity after successful rollback', async () => {
    const failure = StartFailed();
    const calls: string[] = [];
    const result = await defineApp('start-known')
      .infra(
        infra({
          name: 'ready',
          start: () => void calls.push('start'),
          stop: () => void calls.push('stop'),
          dispose: () => void calls.push('ready-dispose'),
        }),
      )
      .infra(infra({ name: 'failed', start: () => failure, dispose: () => void calls.push('failed-dispose') }))
      .start();
    expect(result).toBe(failure);
    expect(calls).toEqual(['start', 'stop', 'failed-dispose', 'ready-dispose']);
  });

  it('keeps the boot primary and ordered cleanup failures as original aggregate members', async () => {
    const primary = BootFailed();
    const later = DisposeFailed();
    const earlier = DisposeFailed();
    const result = await defineApp('boot-cleanup-known')
      .infra(infra({ name: 'earlier', dispose: () => earlier }))
      .infra(infra({ name: 'later', dispose: () => later }))
      .infra(infra({ name: 'failed', boot: () => primary }))
      .boot();
    expect(result).toMatchObject({
      code: 'async.scope_failed',
      cause: { primary: [primary], cleanup: [later, earlier] },
    });
    if (isFailure(result) && result.code === 'async.scope_failed') {
      expect(result.cause.primary[0]).toBe(primary);
      expect(result.cause.cleanup[0]).toBe(later);
      expect(result.cause.cleanup[1]).toBe(earlier);
    }
  });

  it('keeps start primary and ordered stop then dispose failures', async () => {
    const primary = StartFailed();
    const stop = StopFailed();
    const later = DisposeFailed();
    const earlier = DisposeFailed();
    const result = await defineApp('start-cleanup-known')
      .infra(
        infra({
          name: 'earlier',
          start: () => {
            /* Registers active work for stop participation. */
          },
          stop: () => stop,
          dispose: () => earlier,
        }),
      )
      .infra(infra({ name: 'failed', start: () => primary, dispose: () => later }))
      .start();
    expect(result).toMatchObject({
      code: 'async.scope_failed',
      cause: { primary: [primary], cleanup: [stop, later, earlier] },
    });
    if (isFailure(result) && result.code === 'async.scope_failed') {
      expect(result.cause.primary[0]).toBe(primary);
      expect(result.cause.cleanup).toEqual([stop, later, earlier]);
    }
  });

  it('continues all stop and dispose hooks after returned stop failures', async () => {
    const earlier = StopFailed();
    const later = StopFailed();
    const calls: string[] = [];
    const app = orThrow(
      await defineApp('stop-known')
        .infra(
          infra({
            name: 'earlier',
            start: () => {
              /* Registers active work for stop participation. */
            },
            stop: () => {
              calls.push('earlier-stop');
              return earlier;
            },
            dispose: () => void calls.push('earlier-dispose'),
          }),
        )
        .infra(
          infra({
            name: 'later',
            start: () => {
              /* Registers active work for stop participation. */
            },
            stop: () => {
              calls.push('later-stop');
              return later;
            },
            dispose: () => void calls.push('later-dispose'),
          }),
        )
        .start(),
    );
    const result = await app.stop();
    expect(result).toMatchObject({ code: 'async.scope_failed', cause: { primary: [], cleanup: [later, earlier] } });
    expect(await app.stop()).toBeUndefined();
    orThrow(await app.dispose());
    expect(calls).toEqual(['later-stop', 'earlier-stop', 'later-dispose', 'earlier-dispose']);
  });

  it('aggregates cascading stop and dispose failures while coalescing disposal', async () => {
    const stop = StopFailed();
    const later = DisposeFailed();
    const earlier = DisposeFailed();
    const calls: string[] = [];
    const app = orThrow(
      await defineApp('dispose-known')
        .infra(
          infra({
            name: 'earlier',
            start: () => {
              /* Registers active work for stop participation. */
            },
            stop: () => stop,
            dispose: () => {
              calls.push('earlier');
              return earlier;
            },
          }),
        )
        .infra(
          infra({
            name: 'later',
            dispose: () => {
              calls.push('later');
              return Promise.resolve(later);
            },
          }),
        )
        .start(),
    );
    const [first, second] = await Promise.all([app.dispose(), app.dispose()]);
    expect(first).toBe(second);
    expect(first).toMatchObject({
      code: 'async.scope_failed',
      cause: { primary: [], cleanup: [stop, later, earlier] },
    });
    expect(calls).toEqual(['later', 'earlier']);
    expect(await app.dispose()).toBe(first);
    expect(app.state).toBe('disposed');
  });
});

it('runs a stop-only unit after its app starts, including startup rollback', async () => {
  const StopFailed = defineFailure('test.dot.stop_only');
  const failure = StopFailed();
  const calls: string[] = [];
  const app = orThrow(
    await defineApp('stop-only')
      .infra(
        infra({
          name: 'stop-only',
          stop: () => {
            calls.push('stop');
            return failure;
          },
        }),
      )
      .start(),
  );
  expect(await app.stop()).toBe(failure);
  orThrow(await app.dispose());
  expect(calls).toEqual(['stop']);

  const StartFailed = defineFailure('test.dot.rollback_start');
  const primary = StartFailed();
  const outcome = await defineApp('stop-only-rollback')
    .infra(infra({ name: 'stop-only', stop: () => failure }))
    .infra(infra({ name: 'failed', start: () => primary }))
    .start();
  expect(outcome).toMatchObject({ code: 'async.scope_failed', cause: { primary: [primary], cleanup: [failure] } });
});

it('keeps failures limited to the phases reached from each public entry point', () => {
  const ConfigureFailed = defineFailure('test.phase.configure');
  const BootFailed = defineFailure('test.phase.boot');
  const StartFailed = defineFailure('test.phase.start');
  const StopFailed = defineFailure('test.phase.stop');
  const DisposeFailed = defineFailure('test.phase.dispose');
  const _phaseBuilder = defineApp('phase-types').infra(
    infra({
      name: 'phases',
      configure: () => ConfigureFailed(),
      boot: () => BootFailed(),
      start: () => StartFailed(),
      stop: () => StopFailed(),
      dispose: () => DisposeFailed(),
    }),
  );
  type Configured = SuccessOf<typeof _phaseBuilder.configure>;
  type BootFailure = FailureOf<Configured['boot']>;
  type BootRollback = Extract<BootFailure, { readonly code: 'async.scope_failed' }>;
  type BootCleanup = BootRollback['cause']['cleanup'][number];
  expectTypeOf<
    Extract<
      BootFailure,
      ReturnType<typeof ConfigureFailed> | ReturnType<typeof StartFailed> | ReturnType<typeof StopFailed>
    >
  >().toEqualTypeOf<never>();
  expectTypeOf<Extract<BootCleanup, ReturnType<typeof StopFailed>>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<BootCleanup, ReturnType<typeof DisposeFailed>>>().toEqualTypeOf<
    ReturnType<typeof DisposeFailed>
  >();
  type Booted = SuccessOf<Configured['boot']>;
  type StartedFailure = FailureOf<Booted['start']>;
  expectTypeOf<
    Extract<StartedFailure, ReturnType<typeof ConfigureFailed> | ReturnType<typeof BootFailed>>
  >().toEqualTypeOf<never>();
  expectTypeOf<Extract<StartedFailure, ReturnType<typeof StartFailed>>>().toEqualTypeOf<
    ReturnType<typeof StartFailed>
  >();
  expectTypeOf<Extract<FailureOf<Booted['stop']>, ReturnType<typeof StopFailed>>>().toEqualTypeOf<
    ReturnType<typeof StopFailed>
  >();
});

it('coalesces failed boot and start calls through each narrowed phase entry point', async () => {
  const BootFailed = defineFailure('test.dot.coalesced_boot');
  const StartFailed = defineFailure('test.dot.coalesced_start');
  const bootFailure = BootFailed();
  const startFailure = StartFailed();
  let boots = 0;
  let starts = 0;
  const configuredBoot = orThrow(
    defineApp('coalesced-boot')
      .infra(
        infra({
          name: 'failed',
          boot: () => {
            boots += 1;
            return bootFailure;
          },
        }),
      )
      .configure(),
  );
  const [firstBoot, secondBoot] = await Promise.all([configuredBoot.boot(), configuredBoot.boot()]);
  expect(firstBoot).toBe(bootFailure);
  expect(secondBoot).toBe(bootFailure);
  expect(boots).toBe(1);
  const failed = infra({
    name: 'failed',
    start: () => {
      starts += 1;
      return startFailure;
    },
  });
  const configuredStart = orThrow(defineApp('coalesced-configured-start').infra(failed).configure());
  const [firstStart, secondStart] = await Promise.all([configuredStart.start(), configuredStart.start()]);
  expect(firstStart).toBe(startFailure);
  expect(secondStart).toBe(startFailure);
  expect(starts).toBe(1);
  const booted = orThrow(await defineApp('coalesced-booted-start').infra(failed).boot());
  const [firstRestart, secondRestart] = await Promise.all([booted.start(), booted.start()]);
  expect(firstRestart).toBe(startFailure);
  expect(secondRestart).toBe(startFailure);
  expect(starts).toBe(2);
});
