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
import type { Failure, FailureIn } from '@arki/failure';
import { scopeAggregate, ScopeFailed } from '@arki/async';
import { defineFailure, isFailure, UnexpectedDefect } from '@arki/failure';

import type { DotApp, DotAppLifecycle } from './define-app.js';
import type { EmptyPhases, PluginPhases, ServiceRecord } from './plugin-contract.js';
import { hookSignals } from './signals.js';

/**
 * A replaced module no longer owns the application's runtime.
 * @fix Obtain the runtime exported by the current module.
 * @verify bun run test -- src/tests/app-runtime.test.ts
 */
export const RuntimeReplaced = defineFailure('dot.runtime_replaced', {
  status: 503,
  message: 'This module was replaced; the current module owns the application.',
  remediation: 'Obtain the runtime exported by the current module.',
});

/**
 * Previous ownership could not be released, so starting another app is unsafe.
 * @fix Resolve the disposal failure before starting another owner of the resources.
 * @verify bun run test -- src/tests/app-runtime.test.ts
 */
export const RuntimeReleaseFailed = defineFailure('dot.runtime_release_failed', {
  status: 500,
  message: 'The previous application could not release its resources.',
  remediation: 'Resolve the disposal failure before starting another owner of the resources.',
});

const DISPOSING_KEY = 'arki.appRuntime.disposing';

function failed<Value>(value: Value): value is FailureIn<Value> {
  return isFailure<unknown>(value);
}

function startedApp<S extends ServiceRecord, Open extends Failure, Close extends Failure, Phases extends PluginPhases>(
  value: DotApp<S, Close, Open, Phases> | Failure,
): value is DotApp<S, Close, Open, Phases> {
  return !isFailure<unknown>(value);
}

function cleanupFailed(outcome: unknown): boolean {
  return ScopeFailed.is(outcome) && outcome.data.cleanupCount > 0;
}

/** HMR data is an untyped edge; preserve its failure privately under one canonical definition. */
async function previousDisposal(previous: unknown) {
  if (previous === undefined) return;
  try {
    const outcome: unknown = await Promise.resolve(previous);
    if (outcome !== undefined) return RuntimeReleaseFailed({ cause: outcome });
  } catch (error) {
    return RuntimeReleaseFailed({ cause: error });
  }
  return;
}

async function disposeOwned<Outcome>(dispose: () => Promise<Outcome>) {
  try {
    return await dispose();
  } catch (error) {
    return UnexpectedDefect({ cause: error });
  }
}

/**
 * Start one Dot app per module instance and wait for prior HMR disposal.
 * Resolved start failures are never cached as ready. A failed release prevents
 * another owner from starting. Replaced modules return RuntimeReplaced.
 *
 * @example
 * const runtime = createAppRuntime(app, { hot: import.meta.hot });
 * export const getApp = runtime.get;
 */
export function createAppRuntime<
  S extends ServiceRecord,
  Open extends Failure = never,
  Close extends Failure = never,
  Phases extends PluginPhases = EmptyPhases,
>(
  app: DotAppLifecycle<S, Open, Close, Phases>,
  options: {
    readonly hot?:
      | {
          readonly data: Record<string, unknown>;
          dispose(callback: (data: Record<string, unknown>) => void): void;
        }
      | undefined;
    readonly onStarted?: ((app: DotApp<S, Close, Open, Phases>) => void) | undefined;
  } = {},
) {
  const { hot, onStarted } = options;
  const previousGone = previousDisposal(hot?.data[DISPOSING_KEY]);
  let running: ReturnType<typeof start> | undefined;
  let unhookSignals: (() => void) | undefined;
  let replaced = false;
  let releaseFailure: ReturnType<typeof RuntimeReleaseFailed> | undefined;

  async function start() {
    const previous = await previousGone;
    if (previous !== undefined) return previous;
    if (releaseFailure !== undefined) return releaseFailure;
    if (replaced) return RuntimeReplaced();
    let started;
    try {
      started = await app.start();
    } catch (error) {
      // An unmanaged thrown start has no typed proof that rollback completed.
      releaseFailure = RuntimeReleaseFailed({ cause: error });
      return UnexpectedDefect({ cause: error });
    }
    if (!startedApp(started)) {
      if (cleanupFailed(started)) {
        releaseFailure = RuntimeReleaseFailed({ cause: started });
      }
      return started;
    }
    try {
      onStarted?.(started);
      if (!replaced) unhookSignals = hookSignals(started);
    } catch (error) {
      const failure = UnexpectedDefect({ cause: error });
      const disposed = await disposeOwned(() => started.dispose());
      if (failed(disposed)) {
        releaseFailure = RuntimeReleaseFailed({ cause: disposed });
        return scopeAggregate([failure], [disposed]);
      }
      return failure;
    }
    return started;
  }

  hot?.dispose(data => {
    replaced = true;
    const current = running;
    running = undefined;
    unhookSignals?.();
    unhookSignals = undefined;
    // This promise always resolves, so HMR without a replacement module cannot
    // leave an unobserved rejection. The next module validates its outcome.
    data[DISPOSING_KEY] = (async () => {
      const previous = await previousGone;
      if (previous !== undefined) return previous;
      if (releaseFailure !== undefined) return releaseFailure;
      if (current === undefined) return;
      const started = await current;
      if (!startedApp(started)) return releaseFailure;
      return disposeOwned(() => started.dispose());
    })();
  });

  return {
    get() {
      if (replaced) return Promise.resolve(RuntimeReplaced());
      running ??= start().then(outcome => {
        if (failed(outcome)) running = undefined;
        return outcome;
      });
      return running;
    },
  };
}
