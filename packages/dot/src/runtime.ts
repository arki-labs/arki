/**
 * `@arki/dot/runtime` — `createAppRuntime`: the one started Dot app of a server process, safe under
 * Vite hot updates.
 *
 * TanStack Start boots the app lazily inside Vite's SSR graph. A hot update
 * re-runs the module that owns the app, so the old instance must be gone
 * before the new one starts: two live apps mean two database pools, and two
 * PGlite handles on one data directory corrupt it. Disposing in
 * `import.meta.hot.dispose` is not enough on its own, because Vite does not
 * wait for it — the next request starts the new app at once. This helper
 * leaves the old app's disposal in `hot.data`, and the new instance's first
 * `get()` waits for it before `start()`.
 */
import { getLogger } from '@arki/log';

import type { DotApp, DotAppLifecycle } from './define-app.js';
import type { ServiceRecord } from './plugin-contract.js';
import { hookSignals } from './signals.js';

const log = getLogger('arki:dot:app-runtime');

/** The `hot.data` key where a replaced module instance leaves its app's disposal. */
const DISPOSING_KEY = 'arki.appRuntime.disposing';

/**
 * Wait for the app disposal a replaced module instance left in `hot.data`. A
 * failed disposal is logged, not rethrown: if it left a handle open, the new
 * start fails loudly on its own.
 */
async function settled(previous: unknown): Promise<void> {
  if (!(previous instanceof Promise)) return;
  try {
    await previous;
  } catch (error) {
    log.error('the replaced app failed to dispose', { error: error instanceof Error ? error : String(error) });
  }
}

function replacedError(): Error {
  return new Error('[app-runtime] this module was replaced by a hot update; the new module instance owns the app.');
}

/**
 * Start `app` once per module instance and hand out the started app.
 *
 * - `get()` returns the cached start. A failed start is not cached, so the
 *   next call tries again (a database that comes up late needs no restart).
 * - With `hot` (`import.meta.hot`), a hot update disposes the app, and the
 *   replacing instance starts only after that disposal finished. The replaced
 *   instance's `get()` then rejects: the new instance owns the app.
 * - The started app is hooked to SIGTERM / SIGINT (`hookSignals`): a signal
 *   drains it before the process exits. A hot update unhooks it.
 * - `onStarted` runs once per started app, before `get()` resolves. If it
 *   throws, the app is disposed and `get()` rejects.
 *
 * @example
 * ```ts
 * const runtime = createAppRuntime(app, { hot: import.meta.hot });
 * export const getApp = runtime.get;
 * ```
 */
export function createAppRuntime<S extends ServiceRecord>(
  app: DotAppLifecycle<S>,
  options: {
    readonly hot?:
      | {
          readonly data: Record<string, unknown>;
          dispose(callback: (data: Record<string, unknown>) => void): void;
        }
      | undefined;
    readonly onStarted?: ((app: DotApp<S>) => void) | undefined;
  } = {},
): { get(): Promise<DotApp<S>> } {
  const { hot, onStarted } = options;
  const previousGone = settled(hot?.data[DISPOSING_KEY]);
  let running: Promise<DotApp<S>> | undefined;
  let unhookSignals: (() => void) | undefined;
  let replaced = false;

  /** Throw when a hot update replaced this module instance. A function, so later reads of `replaced` are not narrowed. */
  const assertCurrent = (): void => {
    if (replaced) throw replacedError();
  };

  async function start(): Promise<DotApp<S>> {
    await previousGone;
    // Replaced before it began: never start an app only to dispose it.
    assertCurrent();
    const started = await app.start();
    try {
      onStarted?.(started);
    } catch (error) {
      await started.dispose();
      throw error;
    }
    // Replaced while starting: the hot dispose below disposes this app, so it gets no signal hook.
    if (!replaced) unhookSignals = hookSignals(started);
    return started;
  }

  hot?.dispose(data => {
    replaced = true;
    const current = running;
    running = undefined;
    unhookSignals?.();
    unhookSignals = undefined;
    data[DISPOSING_KEY] = (async () => {
      await previousGone;
      if (current === undefined) return;
      let started: DotApp<S>;
      try {
        started = await current;
      } catch {
        return; // a start that failed left nothing to dispose
      }
      await started.dispose();
    })();
  });

  return {
    get() {
      running ??= start().catch((error: unknown) => {
        running = undefined;
        throw error;
      });
      return running;
    },
  };
}
