/**
 * Playwright's `globalSetup` for a stack: starts the real services once, builds the app if its
 * sources changed, and hands the run values to the workers through `process.env.ARKI_STACK`.
 * Returns the teardown Playwright calls when the run ends.
 */
import { randomBytes } from 'node:crypto';

import { getLogger } from '@arki/log';

import type { ServiceMap, Stack } from '../stack/index.js';
import type { ServerOptions } from './server.js';
import { STACK_ENV_KEY } from '../stack/index.js';
import { ensureBuilt } from './server.js';

const log = getLogger('arki:testing:e2e');

export function stackSetup<M extends ServiceMap>(stack: Stack<M>, options: Pick<ServerOptions, 'build'>) {
  return async function globalSetup(): Promise<() => Promise<void>> {
    const runId = `e${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    const begin = performance.now();
    const [running, built] = await Promise.all([stack.start({ runId }), ensureBuilt(options.build)]);
    process.env[STACK_ENV_KEY] = JSON.stringify(running.manifest);
    log.debug('Stack {runId} ready in {ms} ms (built: {built})', {
      runId,
      ms: Math.round(performance.now() - begin),
      built,
    });
    return async () => {
      await running.stop();
    };
  };
}
