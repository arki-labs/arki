/**
 * `createAppRuntime` keeps one started app per server process across Vite
 * hot updates. Vite does not wait for `hot.dispose`, so without the runtime
 * the next request starts a new app while the old one still holds its pool
 * or its PGlite directory. These tests replay hot updates the way Vite runs
 * them: `dispose(data)` on the old module, then a new module with the same
 * `hot.data`. The PGlite case (20 fast edits, one handle) lives in
 * `@arki/db` (`src/dot.hmr.test.ts`): the kernel cannot depend on it.
 */
import { describe, expect, it } from 'vitest';

import { createAppRuntime } from '../runtime.js';
import { defineApp } from '../define-app.js';
import { plugin } from '../plugin-contract.js';

/** A fake `import.meta.hot` per module instance; `replace()` is the hot update. */
function hotModule(data: Record<string, unknown>) {
  let onDispose: ((data: Record<string, unknown>) => void) | undefined;
  return {
    hot: {
      data,
      dispose(callback: (data: Record<string, unknown>) => void) {
        onDispose = callback;
      },
    },
    replace() {
      onDispose?.(data);
    },
  };
}

/** An app whose one plugin counts live instances and disposes slowly, like a pool draining. */
function countedApp() {
  const counts = { live: 0, maxLive: 0, starts: 0 };
  const app = defineApp('counted').use(
    plugin({
      name: 'probe',
      version: '0.0.0',
      provides: {
        probe: () => {
          counts.live += 1;
          counts.starts += 1;
          counts.maxLive = Math.max(counts.maxLive, counts.live);
          return 'probe';
        },
      },
      async dispose() {
        await new Promise(resolve => setTimeout(resolve, 30));
        counts.live -= 1;
      },
    }),
  );
  return { app, counts };
}

describe('createAppRuntime', () => {
  it('starts once for concurrent callers and retries a failed start', async () => {
    let failNext = true;
    const app = defineApp('flaky').use(
      plugin({
        name: 'flaky',
        version: '0.0.0',
        provides: {
          flaky: () => {
            if (failNext) {
              failNext = false;
              throw new Error('database not up yet');
            }
            return 'up';
          },
        },
      }),
    );
    const runtime = createAppRuntime(app);

    await expect(runtime.get()).rejects.toThrow();
    const [a, b] = await Promise.all([runtime.get(), runtime.get()]);
    expect(a).toBe(b);
    expect(a.services.flaky).toBe('up');
    await a.dispose();
  });

  it('starts the replacing module only after the replaced app finished disposing', async () => {
    const { app, counts } = countedApp();
    const data: Record<string, unknown> = {};

    const first = hotModule(data);
    await createAppRuntime(app, { hot: first.hot }).get();
    first.replace();

    const second = hotModule(data);
    const started = await createAppRuntime(app, { hot: second.hot }).get();

    expect(counts.maxLive).toBe(1);
    expect(counts.live).toBe(1);
    await started.dispose();
  });

  it('refuses get() on the replaced module: the new module owns the app', async () => {
    const { app } = countedApp();
    const data: Record<string, unknown> = {};
    const old = hotModule(data);
    const oldRuntime = createAppRuntime(app, { hot: old.hot });
    await oldRuntime.get();
    old.replace();

    await expect(oldRuntime.get()).rejects.toThrow(/replaced by a hot update/);
    const current = await createAppRuntime(app, { hot: hotModule(data).hot }).get();
    await current.dispose();
  });

  it('hooks signals for the started app and unhooks them on a hot update', async () => {
    const { app } = countedApp();
    const data: Record<string, unknown> = {};
    const before = process.listenerCount('SIGTERM');

    const first = hotModule(data);
    await createAppRuntime(app, { hot: first.hot }).get();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    first.replace();
    expect(process.listenerCount('SIGTERM')).toBe(before);

    const current = await createAppRuntime(app, { hot: hotModule(data).hot }).get();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    await current.dispose();
  });
});
