/**
 * `dot _serve`: the runner `dot dev` uses when the project has no Vite config
 * and no `--run`. It starts the app in this process and keeps it running
 * until the CLI's signal aborts (SIGINT/SIGTERM, owned by `@arki/cli`), then
 * disposes it within 10 s.
 */
import type { Failure } from '@arki/failure';
import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import { sleep } from './dev-net.js';
import { discoverApp, guards } from './discover.js';
import { DevAppStarted, lifecycleFailed } from './failures.js';

const debugServe = getLogger('arki:dot:cli:dev');

export type RunServeOptions = {
  readonly app?: string | undefined;
  readonly cwd?: string | undefined;
  readonly signal: AbortSignal;
  /** How long `dispose` may take before `_serve` gives up on it. Default 10 s. */
  readonly disposeTimeoutMs?: number | undefined;
};

/** Start the app, wait for the abort, dispose it. */
export async function runServe(options: RunServeOptions): Promise<{ readonly app: string } | Failure> {
  const discovered = await discoverApp({ appPath: options.app, cwd: options.cwd, prefer: 'dev' });
  if (isFailure(discovered)) return discovered;
  const builder = discovered.app;
  if (!guards.isDotAppBuilder(builder)) {
    return DevAppStarted({ filePath: discovered.filePath, exportName: discovered.exportName });
  }
  let app;
  try {
    app = await builder.start();
  } catch (error) {
    return lifecycleFailed(error, 'boot');
  }
  // An app with no server holds no handle; this timer keeps the process alive until the stop.
  const keepAlive = setInterval(() => {
    // Nothing to do: the timer only keeps the event loop alive.
  }, 2 ** 30);
  try {
    await new Promise<void>(resolve => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    clearInterval(keepAlive);
    const timeoutMs = options.disposeTimeoutMs ?? 10_000;
    const gaveUp = new AbortController();
    const disposed = app.dispose().then(
      () => true,
      (error: unknown) => {
        debugServe.debug('dispose threw', { error: error instanceof Error ? error : String(error) });
        return true;
      },
    );
    const finished = await Promise.race([disposed, sleep(timeoutMs, gaveUp.signal).then(() => false)]);
    gaveUp.abort();
    if (!finished) debugServe.debug('dispose did not finish within {timeoutMs} ms', { timeoutMs });
  }
  return { app: app.name };
}
