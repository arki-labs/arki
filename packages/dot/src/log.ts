/**
 * `log()`: the plugin that fills Dot's logging slot with an `@arki/log` configuration.
 *
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { log } from '@arki/dot/log';
 * import { asyncContext, fromEnv, stdout } from '@arki/log/node';
 *
 * const app = await defineApp('checkout')
 *   .use(log(() => ({ ...fromEnv(), context: asyncContext(), channels: { stdout: stdout() }, default: { level: 'info', channels: ['stdout'] } })))
 *   .boot();
 * ```
 *
 * - The kernel calls the config thunk before its first boot record and
 *   closes logging after its last disposal record. Configure performs no logging I/O. Importing this module does nothing.
 * - `resource['service.name']` defaults to the app's name.
 * - The `configure()` handle is published as the `logging` service.
 * - It reads no env on its own (spread `fromEnv()`), installs no OTel SDK and
 *   does not patch `console`.
 */

import type { Configured, LogConfig } from '@arki/log';
import { configure } from '@arki/log';

import { DotPluginError, plugin } from './plugin-contract.js';

export const DOT_LOG_ERROR_CODES = {
  /**
   * `boot` ran before the kernel activated the logging slot.
   * @fix Mount `log()` with `.use()` in a Dot app and let the kernel run its hooks; never call them yourself.
   * @verify dot doctor --json | jq -e .ok
   */
  notActivated: 'DOT_LOG_E001',
} as const;

/** What `log()` publishes. */
export type LogServices<C extends string> = { readonly logging: Configured<C> };

/** The Dot plugin that configures `@arki/log` for the app. Pass a thunk: it runs when the app boots, never at import. */
export function log<const C extends string>(config: () => LogConfig<C>) {
  let handle: Configured<C> | undefined;
  return plugin({
    name: 'log',
    logging: ({ appName }) => {
      const resolved = config();
      handle = configure({ ...resolved, resource: { 'service.name': appName, ...resolved.resource } });
      const active = handle;
      return {
        async close() {
          await active.close();
        },
      };
    },
    provides: {
      logging: (): LogServices<C>['logging'] => {
        if (handle === undefined) {
          throw new DotPluginError({
            code: DOT_LOG_ERROR_CODES.notActivated,
            message: '[log] boot ran before the logging slot was activated.',
            remediation: 'Mount log() with defineApp(...).use(log(...)); do not call its hooks by hand.',
            docsUrl: 'https://github.com/arki-labs/arki/blob/HEAD/packages/dot/README.md#logging',
          });
        }
        return handle;
      },
    },
  });
}
