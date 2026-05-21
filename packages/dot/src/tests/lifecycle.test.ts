/**
 * Lifecycle behaviour tests for the DOT kernel.
 *
 * Tests enter through public boundaries only — `defineApp`, `defineDotPip`,
 * and the `DotApp` lifecycle methods. The internal scheduler is not tested
 * directly.
 */

import { describe, expect, it } from 'vitest';

import { defineApp } from '../define-app.js';
import { DotLifecycleError, DotLifecycleErrorCode } from '../lifecycle.js';
import { defineDotPip } from '../pip-contract.js';

type CallLog = {
  hook: 'configure' | 'boot' | 'start' | 'stop' | 'dispose';
  pip: string;
};

describe('DOT lifecycle', () => {
  it('runs all 5 hooks in topological order; stop/dispose run in reverse', async () => {
    const calls: CallLog[] = [];

    const a = defineDotPip({
      name: 'a',
      configure: () => {
        calls.push({ hook: 'configure', pip: 'a' });
      },
      boot: () => {
        calls.push({ hook: 'boot', pip: 'a' });
        return {};
      },
      start: () => {
        calls.push({ hook: 'start', pip: 'a' });
      },
      stop: () => {
        calls.push({ hook: 'stop', pip: 'a' });
      },
      dispose: () => {
        calls.push({ hook: 'dispose', pip: 'a' });
      },
    });

    const b = defineDotPip({
      name: 'b',
      dependencies: ['a'],
      configure: () => {
        calls.push({ hook: 'configure', pip: 'b' });
      },
      boot: () => {
        calls.push({ hook: 'boot', pip: 'b' });
        return {};
      },
      start: () => {
        calls.push({ hook: 'start', pip: 'b' });
      },
      stop: () => {
        calls.push({ hook: 'stop', pip: 'b' });
      },
      dispose: () => {
        calls.push({ hook: 'dispose', pip: 'b' });
      },
    });

    const app = await defineApp('test').use(a).use(b).start();
    await app.dispose();

    expect(calls).toEqual([
      { hook: 'configure', pip: 'a' },
      { hook: 'configure', pip: 'b' },
      { hook: 'boot', pip: 'a' },
      { hook: 'boot', pip: 'b' },
      { hook: 'start', pip: 'a' },
      { hook: 'start', pip: 'b' },
      { hook: 'stop', pip: 'b' },
      { hook: 'stop', pip: 'a' },
      { hook: 'dispose', pip: 'b' },
      { hook: 'dispose', pip: 'a' },
    ]);
  });

  it('rejects an async configure hook', async () => {
    const bad = defineDotPip({
      name: 'bad',
      // Intentional: a configure hook returning a Promise must be detected.
      configure: () => Promise.resolve() as unknown as void,
    });

    await expect(defineApp('test').use(bad).boot()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.ConfigureAsync,
      phase: 'configure',
      pip: 'bad',
    });
  });

  it('disposes already-booted pips in reverse order when a later boot fails', async () => {
    const calls: CallLog[] = [];
    const a = defineDotPip({
      name: 'a',
      boot: () => {
        calls.push({ hook: 'boot', pip: 'a' });
        return {};
      },
      dispose: () => {
        calls.push({ hook: 'dispose', pip: 'a' });
      },
    });
    const b = defineDotPip({
      name: 'b',
      dependencies: ['a'],
      boot: () => {
        calls.push({ hook: 'boot', pip: 'b' });
        throw new Error('boom-b');
      },
      dispose: () => {
        calls.push({ hook: 'dispose', pip: 'b' });
      },
    });

    await expect(defineApp('test').use(a).use(b).boot()).rejects.toBeInstanceOf(DotLifecycleError);

    // Pip a booted, then b threw — a's dispose runs, b's dispose does NOT
    // (its boot never completed).
    expect(calls).toEqual([
      { hook: 'boot', pip: 'a' },
      { hook: 'boot', pip: 'b' },
      { hook: 'dispose', pip: 'a' },
    ]);
  });

  it('does not call dispose for a pip whose boot threw with partial resources', async () => {
    const calls: CallLog[] = [];
    let partialCleanup = false;
    const a = defineDotPip({
      name: 'a',
      boot: () => {
        calls.push({ hook: 'boot', pip: 'a' });
        return {};
      },
      dispose: () => {
        calls.push({ hook: 'dispose', pip: 'a' });
      },
    });
    const partial = defineDotPip({
      name: 'partial',
      dependencies: ['a'],
      boot: () => {
        calls.push({ hook: 'boot', pip: 'partial' });
        // simulate partial resource setup, then failure — the pip cleans up itself
        partialCleanup = true;
        throw new Error('partial-failed');
      },
      // dispose would never be called for partial — DOT only disposes booted pips
      dispose: () => {
        calls.push({ hook: 'dispose', pip: 'partial' });
      },
    });

    await expect(defineApp('test').use(a).use(partial).boot()).rejects.toBeInstanceOf(DotLifecycleError);
    expect(partialCleanup).toBe(true);
    expect(calls.filter(c => c.pip === 'partial' && c.hook === 'dispose')).toEqual([]);
    expect(calls.filter(c => c.pip === 'a' && c.hook === 'dispose')).toEqual([{ hook: 'dispose', pip: 'a' }]);
  });

  it('on start failure stops started pips and disposes all booted pips (reverse order)', async () => {
    const calls: CallLog[] = [];
    const a = defineDotPip({
      name: 'a',
      boot: () => {
        calls.push({ hook: 'boot', pip: 'a' });
        return {};
      },
      start: () => {
        calls.push({ hook: 'start', pip: 'a' });
      },
      stop: () => {
        calls.push({ hook: 'stop', pip: 'a' });
      },
      dispose: () => {
        calls.push({ hook: 'dispose', pip: 'a' });
      },
    });
    const b = defineDotPip({
      name: 'b',
      dependencies: ['a'],
      boot: () => {
        calls.push({ hook: 'boot', pip: 'b' });
        return {};
      },
      start: () => {
        calls.push({ hook: 'start', pip: 'b' });
        throw new Error('start-failed');
      },
      stop: () => {
        calls.push({ hook: 'stop', pip: 'b' });
      },
      dispose: () => {
        calls.push({ hook: 'dispose', pip: 'b' });
      },
    });

    await expect(defineApp('test').use(a).use(b).start()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.StartFailed,
    });

    // a started, then b failed. a is stopped (reverse), then both are disposed (reverse).
    // b never started so b.stop is NOT called.
    expect(calls).toEqual([
      { hook: 'boot', pip: 'a' },
      { hook: 'boot', pip: 'b' },
      { hook: 'start', pip: 'a' },
      { hook: 'start', pip: 'b' },
      { hook: 'stop', pip: 'a' },
      { hook: 'dispose', pip: 'b' },
      { hook: 'dispose', pip: 'a' },
    ]);
  });

  it('stop continues through individual pip failures with aggregate error', async () => {
    const calls: CallLog[] = [];
    const a = defineDotPip({
      name: 'a',
      start: () => {
        calls.push({ hook: 'start', pip: 'a' });
      },
      stop: () => {
        calls.push({ hook: 'stop', pip: 'a' });
      },
    });
    const b = defineDotPip({
      name: 'b',
      dependencies: ['a'],
      start: () => {
        calls.push({ hook: 'start', pip: 'b' });
      },
      stop: () => {
        calls.push({ hook: 'stop', pip: 'b' });
        throw new Error('stop-b-broken');
      },
    });
    const c = defineDotPip({
      name: 'c',
      dependencies: ['b'],
      start: () => {
        calls.push({ hook: 'start', pip: 'c' });
      },
      stop: () => {
        calls.push({ hook: 'stop', pip: 'c' });
      },
    });

    const app = await defineApp('test').use(a).use(b).use(c).start();
    await expect(app.stop()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.StopFailed,
    });

    expect(calls.filter(c => c.hook === 'stop')).toEqual([
      { hook: 'stop', pip: 'c' },
      { hook: 'stop', pip: 'b' },
      { hook: 'stop', pip: 'a' },
    ]);
  });

  it('boot() is idempotent while app is booted', async () => {
    let bootCalls = 0;
    const p = defineDotPip({
      name: 'p',
      boot: () => {
        bootCalls += 1;
        return {};
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

    const slow = defineDotPip({
      name: 'slow',
      boot: async () => {
        bootCalls += 1;
        await bootGate;
        return {};
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
    const p = defineDotPip({
      name: 'p',
      configure: () => {
        calls.push({ hook: 'configure', pip: 'p' });
      },
      boot: () => {
        calls.push({ hook: 'boot', pip: 'p' });
        return {};
      },
      start: () => {
        calls.push({ hook: 'start', pip: 'p' });
      },
    });
    const app = await defineApp('test').use(p).start();
    expect(calls.map(c => c.hook)).toEqual(['configure', 'boot', 'start']);
    expect(app.state).toBe('started');
    await app.dispose();
  });

  it('stop() on a booted-but-never-started app is a no-op', async () => {
    let stopCalls = 0;
    const p = defineDotPip({
      name: 'p',
      boot: () => ({}),
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
    const p = defineDotPip({
      name: 'p',
      start: () => {
        calls.push({ hook: 'start', pip: 'p' });
      },
      stop: () => {
        calls.push({ hook: 'stop', pip: 'p' });
      },
      dispose: () => {
        calls.push({ hook: 'dispose', pip: 'p' });
      },
    });
    const app = await defineApp('test').use(p).start();
    await app.dispose();
    expect(calls.map(c => c.hook)).toEqual(['start', 'stop', 'dispose']);
    expect(app.state).toBe('disposed');
  });

  it('boot() after dispose throws DotLifecycleError with ReuseAfterDispose code', async () => {
    const p = defineDotPip({ name: 'p', boot: () => ({}) });
    const app = await defineApp('test').use(p).boot();
    await app.dispose();
    await expect(app.start()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.ReuseAfterDispose,
    });
  });

  it('detects dependency cycles at configure time', () => {
    const a = defineDotPip({ name: 'a', dependencies: ['b'] });
    const b = defineDotPip({ name: 'b', dependencies: ['a'] });
    expect(() => defineApp('test').use(a).use(b).configure()).toThrow(DotLifecycleError);
    try {
      defineApp('test').use(a).use(b).configure();
    } catch (error) {
      expect((error as DotLifecycleError).code).toBe(DotLifecycleErrorCode.DependencyCycle);
    }
  });

  it('detects missing dependency at configure time', () => {
    const a = defineDotPip({ name: 'a', dependencies: ['missing'] });
    expect(() => defineApp('test').use(a).configure()).toThrow(DotLifecycleError);
    try {
      defineApp('test').use(a).configure();
    } catch (error) {
      expect((error as DotLifecycleError).code).toBe(DotLifecycleErrorCode.MissingDependency);
    }
  });

  it('detects duplicate pip registration', () => {
    const a = defineDotPip({ name: 'a' });
    expect(() => defineApp('test').use(a).use(a).configure()).toThrow(DotLifecycleError);
    try {
      defineApp('test').use(a).use(a).configure();
    } catch (error) {
      expect((error as DotLifecycleError).code).toBe(DotLifecycleErrorCode.DuplicatePip);
    }
  });
});
