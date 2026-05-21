/**
 * Lifecycle behaviour tests for the DOT kernel.
 *
 * Tests enter through public boundaries only — `defineApp`, `defineDotPlugin`,
 * and the `DotApp` lifecycle methods. The internal scheduler is not tested
 * directly.
 */

import { describe, expect, it } from 'vitest';

import { defineApp } from '../define-app.js';
import { DotLifecycleError, DotLifecycleErrorCode } from '../lifecycle.js';
import { defineDotPlugin } from '../plugin-contract.js';

type CallLog = {
  hook: 'configure' | 'boot' | 'start' | 'stop' | 'dispose';
  plugin: string;
};

describe('DOT lifecycle', () => {
  it('runs all 5 hooks in topological order; stop/dispose run in reverse', async () => {
    const calls: CallLog[] = [];

    const a = defineDotPlugin({
      name: 'a',
      configure: () => {
        calls.push({ hook: 'configure', plugin: 'a' });
      },
      boot: () => {
        calls.push({ hook: 'boot', plugin: 'a' });
        return {};
      },
      start: () => {
        calls.push({ hook: 'start', plugin: 'a' });
      },
      stop: () => {
        calls.push({ hook: 'stop', plugin: 'a' });
      },
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'a' });
      },
    });

    const b = defineDotPlugin({
      name: 'b',
      dependencies: ['a'],
      configure: () => {
        calls.push({ hook: 'configure', plugin: 'b' });
      },
      boot: () => {
        calls.push({ hook: 'boot', plugin: 'b' });
        return {};
      },
      start: () => {
        calls.push({ hook: 'start', plugin: 'b' });
      },
      stop: () => {
        calls.push({ hook: 'stop', plugin: 'b' });
      },
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'b' });
      },
    });

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
    const bad = defineDotPlugin({
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
    const a = defineDotPlugin({
      name: 'a',
      boot: () => {
        calls.push({ hook: 'boot', plugin: 'a' });
        return {};
      },
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'a' });
      },
    });
    const b = defineDotPlugin({
      name: 'b',
      dependencies: ['a'],
      boot: () => {
        calls.push({ hook: 'boot', plugin: 'b' });
        throw new Error('boom-b');
      },
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'b' });
      },
    });

    await expect(defineApp('test').use(a).use(b).boot()).rejects.toBeInstanceOf(DotLifecycleError);

    // Plugin a booted, then b threw — a's dispose runs, b's dispose does NOT
    // (its boot never completed).
    expect(calls).toEqual([
      { hook: 'boot', plugin: 'a' },
      { hook: 'boot', plugin: 'b' },
      { hook: 'dispose', plugin: 'a' },
    ]);
  });

  it('does not call dispose for a plugin whose boot threw with partial resources', async () => {
    const calls: CallLog[] = [];
    let partialCleanup = false;
    const a = defineDotPlugin({
      name: 'a',
      boot: () => {
        calls.push({ hook: 'boot', plugin: 'a' });
        return {};
      },
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'a' });
      },
    });
    const partial = defineDotPlugin({
      name: 'partial',
      dependencies: ['a'],
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
    const a = defineDotPlugin({
      name: 'a',
      boot: () => {
        calls.push({ hook: 'boot', plugin: 'a' });
        return {};
      },
      start: () => {
        calls.push({ hook: 'start', plugin: 'a' });
      },
      stop: () => {
        calls.push({ hook: 'stop', plugin: 'a' });
      },
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'a' });
      },
    });
    const b = defineDotPlugin({
      name: 'b',
      dependencies: ['a'],
      boot: () => {
        calls.push({ hook: 'boot', plugin: 'b' });
        return {};
      },
      start: () => {
        calls.push({ hook: 'start', plugin: 'b' });
        throw new Error('start-failed');
      },
      stop: () => {
        calls.push({ hook: 'stop', plugin: 'b' });
      },
      dispose: () => {
        calls.push({ hook: 'dispose', plugin: 'b' });
      },
    });

    await expect(defineApp('test').use(a).use(b).start()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.StartFailed,
    });

    // a started, then b failed. a is stopped (reverse), then both are disposed (reverse).
    // b never started so b.stop is NOT called.
    expect(calls).toEqual([
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
    const a = defineDotPlugin({
      name: 'a',
      start: () => {
        calls.push({ hook: 'start', plugin: 'a' });
      },
      stop: () => {
        calls.push({ hook: 'stop', plugin: 'a' });
      },
    });
    const b = defineDotPlugin({
      name: 'b',
      dependencies: ['a'],
      start: () => {
        calls.push({ hook: 'start', plugin: 'b' });
      },
      stop: () => {
        calls.push({ hook: 'stop', plugin: 'b' });
        throw new Error('stop-b-broken');
      },
    });
    const c = defineDotPlugin({
      name: 'c',
      dependencies: ['b'],
      start: () => {
        calls.push({ hook: 'start', plugin: 'c' });
      },
      stop: () => {
        calls.push({ hook: 'stop', plugin: 'c' });
      },
    });

    const app = await defineApp('test').use(a).use(b).use(c).start();
    await expect(app.stop()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.StopFailed,
    });

    expect(calls.filter(c => c.hook === 'stop')).toEqual([
      { hook: 'stop', plugin: 'c' },
      { hook: 'stop', plugin: 'b' },
      { hook: 'stop', plugin: 'a' },
    ]);
  });

  it('boot() is idempotent while app is booted', async () => {
    let bootCalls = 0;
    const p = defineDotPlugin({
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

    const slow = defineDotPlugin({
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
    const p = defineDotPlugin({
      name: 'p',
      configure: () => {
        calls.push({ hook: 'configure', plugin: 'p' });
      },
      boot: () => {
        calls.push({ hook: 'boot', plugin: 'p' });
        return {};
      },
      start: () => {
        calls.push({ hook: 'start', plugin: 'p' });
      },
    });
    const app = await defineApp('test').use(p).start();
    expect(calls.map(c => c.hook)).toEqual(['configure', 'boot', 'start']);
    expect(app.state).toBe('started');
    await app.dispose();
  });

  it('stop() on a booted-but-never-started app is a no-op', async () => {
    let stopCalls = 0;
    const p = defineDotPlugin({
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
    const p = defineDotPlugin({
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
    const p = defineDotPlugin({ name: 'p', boot: () => ({}) });
    const app = await defineApp('test').use(p).boot();
    await app.dispose();
    await expect(app.start()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.ReuseAfterDispose,
    });
  });

  it('detects dependency cycles at configure time', () => {
    const a = defineDotPlugin({ name: 'a', dependencies: ['b'] });
    const b = defineDotPlugin({ name: 'b', dependencies: ['a'] });
    expect(() => defineApp('test').use(a).use(b).configure()).toThrow(DotLifecycleError);
    try {
      defineApp('test').use(a).use(b).configure();
    } catch (error) {
      expect((error as DotLifecycleError).code).toBe(DotLifecycleErrorCode.DependencyCycle);
    }
  });

  it('detects missing dependency at configure time', () => {
    const a = defineDotPlugin({ name: 'a', dependencies: ['missing'] });
    expect(() => defineApp('test').use(a).configure()).toThrow(DotLifecycleError);
    try {
      defineApp('test').use(a).configure();
    } catch (error) {
      expect((error as DotLifecycleError).code).toBe(DotLifecycleErrorCode.MissingDependency);
    }
  });

  it('detects duplicate plugin registration', () => {
    const a = defineDotPlugin({ name: 'a' });
    expect(() => defineApp('test').use(a).use(a).configure()).toThrow(DotLifecycleError);
    try {
      defineApp('test').use(a).use(a).configure();
    } catch (error) {
      expect((error as DotLifecycleError).code).toBe(DotLifecycleErrorCode.DuplicatePlugin);
    }
  });
});
