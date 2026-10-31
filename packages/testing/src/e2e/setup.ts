/**
 * Playwright's `globalSetup` for a stack: starts the real services once, builds the app if its
 * sources changed, and hands the run values to the workers through `process.env.ARKI_STACK`.
 * Returns the teardown Playwright calls when the run ends.
 */
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getLogger } from '@arki/log';

import type { ServiceMap, Stack } from '../stack/index.js';
import type { ServerOptions } from './server.js';
import { STACK_ENV_KEY } from '../stack/index.js';
import { ensureBuilt } from './server.js';

const log = getLogger('arki:testing:e2e');

/** The env name of the folder this run's servers start in. Read it where `serve.cwd` is written. */
export const SERVER_ROOT_ENV_KEY = 'ARKI_SERVER_ROOT';

export function stackSetup<M extends ServiceMap>(stack: Stack<M>, options: Pick<ServerOptions, 'build'>) {
  return async function globalSetup(): Promise<() => Promise<void>> {
    const runId = `e${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    const begin = performance.now();
    // Both run together to save time, and both are settled before anything is decided: a build that
    // fails while the stack is still starting must not leave the stack's containers behind.
    const [started, built] = await Promise.allSettled([stack.start({ runId }), ensureBuilt(options.build)]);
    if (started.status === 'rejected') throw started.reason;
    const running = started.value;
    const root = await mkdtemp(path.join(tmpdir(), `arki-e2e-${runId}-`)).catch(async error => {
      await Promise.allSettled([running.stop()]);
      throw error;
    });
    try {
      if (built.status === 'rejected') throw built.reason;
      // The run serves its own copy of the build: another build in the same working tree (a teammate's
      // `vite build`, the next run's rebuild) replaces `.output` while this run's servers read from it.
      const outputName = path.relative(options.build.cwd, path.dirname(path.dirname(options.build.output)));
      await cp(path.dirname(path.dirname(options.build.output)), path.join(root, outputName), { recursive: true });
    } catch (error) {
      await Promise.allSettled([running.stop(), rm(root, { recursive: true, force: true })]);
      throw error;
    }
    process.env[STACK_ENV_KEY] = JSON.stringify(running.manifest);
    process.env[SERVER_ROOT_ENV_KEY] = root;
    log.debug('Stack {runId} ready in {ms} ms (built: {built})', {
      runId,
      ms: Math.round(performance.now() - begin),
      built: built.value,
    });
    return async () => {
      // The folder is removed even when a service refuses to stop.
      const [stopped, removed] = await Promise.allSettled([running.stop(), rm(root, { recursive: true, force: true })]);
      if (stopped.status === 'rejected') throw stopped.reason;
      if (removed.status === 'rejected') throw removed.reason;
    };
  };
}
