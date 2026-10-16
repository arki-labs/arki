/**
 * One call from env to a ready protocol-2 handler. The plain-route recipe and
 * the DOT `foreman()` slice both build their handler here, so the two
 * attachments cannot drift.
 */
import { getLogger } from '@arki/log';

import type { CoreModulesOptions } from './core';
import type { CreateForemanHandlerOptions } from './dispatcher';
import type { ForemanEnv } from './env';
import type { ForemanEnvironment } from './protocol';
import { withCoreModules } from './core';
import { createForemanHandler } from './dispatcher';
import { foremanConfigFromEnv } from './env';
import { ADMIN_ERROR_CODES } from './errors';

const logger = getLogger('arki:admin');

export type ForemanAppOptions<TCtx> = Pick<
  CreateForemanHandlerOptions<TCtx>,
  'nonces' | 'receipts' | 'context' | 'clock'
> &
  Pick<CoreModulesOptions<TCtx>, 'health' | 'modules' | 'packages' | 'providers'> & {
    /** The app's validated env. The `FOREMAN_*` keys come from `foremanEnvShape`. */
    env: ForemanEnv;
    /** `prod`, `staging` or `dev`: the second half of the audience. Use `foremanEnvironmentFromNodeEnv`. */
    environment: ForemanEnvironment;
    app: { version: string; commit?: string };
  };

/**
 * Build the handler for `/api/foreman/*`, with `core.health` and `core.manifest`
 * added to the app's modules. With no `FOREMAN_*` variables set it returns a
 * handler that answers 404, so a fresh app boots with Foreman v2 off.
 */
export function createForemanHandlerFromEnv<TCtx>(
  options: ForemanAppOptions<TCtx>,
): (request: Request) => Promise<Response> {
  const config = foremanConfigFromEnv(options.env, options.environment);
  if (config === undefined) {
    logger.debug('Foreman v2 is off: no FOREMAN_* variables are set.');
    return () =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: ADMIN_ERROR_CODES.unknownCapability,
              message: 'Foreman v2 is not configured on this app.',
              remediation:
                'Set the FOREMAN_* variables (see @arki/admin/env), or ignore this: the app runs fine without them.',
            },
          },
          { status: 404, headers: { 'cache-control': 'no-store' } },
        ),
      );
  }
  return createForemanHandler<TCtx>({
    identity: config.identity,
    keys: config.keys,
    writes: config.writes,
    nonces: options.nonces,
    receipts: options.receipts,
    context: options.context,
    clock: options.clock,
    app: options.app,
    packages: options.packages,
    providers: options.providers,
    modules: withCoreModules({
      app: { id: config.appId, environment: options.environment, ...options.app },
      packages: options.packages,
      writes: config.writes,
      providers: options.providers,
      health: options.health,
      modules: options.modules,
      receipts: options.receipts,
    }),
  });
}
