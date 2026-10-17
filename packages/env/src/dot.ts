/**
 * DOT adapter for `@arki/env`.
 *
 * Wraps `defineEnv()` as a DOT plugin so a DOT app validates its
 * environment at boot. The `env` factory builds the env and forces
 * validation right there, so a bad config stops `boot()` with
 * `ARKI_ENV_PLUGIN_E001` instead of failing on the first request.
 * `configure` only registers metadata, so `dot explain` needs no secrets.
 *
 * @example
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { env } from '@arki/env/dot';
 * import { z } from 'zod';
 *
 * const app = await defineApp('my-app')
 *   .use(env({ schema: { PORT: z.coerce.number().default(3000) } }))
 *   .boot();
 *
 * console.log(app.services.env.PORT); // number, typed.
 * ```
 *
 * To mount a second env scope in the same app, rename the published wire
 * key at the mount site:
 *
 * ```ts
 * import { rename } from '@arki/dot';
 *
 * .use(env({ schema: appSchema }))
 * .use(rename(env({ schema: publicSchema }), { env: 'publicEnv' }, 'public-env'))
 * ```
 *
 * The `@arki/dot` package is an OPTIONAL peer of `@arki/env`. Importing
 * this adapter without `@arki/dot` installed will fail at module load —
 * that is intentional: the adapter only makes sense in a DOT app.
 */

import type { StandardSchemaV1 } from '@arki/schema';

import type { EmptyShape, Plugin } from '@arki/dot/plugin';
import { DotPluginError, plugin } from '@arki/dot/plugin';

import { defineEnv, formatIssues } from './core/define-env.js';

export const ENV_PLUGIN_ERROR_CODES = {
  /**
   * The env failed its schema at boot. The message lists every bad key.
   *
   * @fix Set the listed variables, or fix their values, before booting the app.
   * @verify dot doctor --json | jq '.data'
   */
  invalidEnv: 'ARKI_ENV_PLUGIN_E001',
} as const;

/**
 * Options for the env DOT adapter.
 *
 * @typeParam TSchema - The shape of the `server` schema record. The
 *   resulting `app.services.env` is typed from this.
 */
export type EnvDotOptions<TSchema extends Record<string, StandardSchemaV1>> = {
  /** One Standard Schema (Zod, Valibot, ArkType, ...) per env var the plugin validates. */
  readonly schema: TSchema;
  /**
   * Forwarded to `defineEnv`. If `true`, the validator is skipped
   * entirely. By default the env is validated at boot, in every
   * environment, unless the process sets `SKIP_ENV_VALIDATION=1`.
   */
  readonly skipValidation?: boolean;
};

/** The shape of services published by the env adapter. */
export type EnvServices<TSchema extends Record<string, StandardSchemaV1>> = {
  readonly env: ReturnType<typeof defineEnv<TSchema>>;
};

/**
 * Build a DOT plugin that validates and publishes a typed `env` service.
 *
 * @param options - Schema + optional config.
 * @returns A plugin that publishes `services.env`.
 */
export function env<TSchema extends Record<string, StandardSchemaV1>>(
  options: EnvDotOptions<TSchema>,
): Plugin<EmptyShape, EnvServices<TSchema>, EmptyShape, 'env'> {
  return plugin({
    name: 'env',
    configure(ctx) {
      ctx.registerService('env', 'env');
    },
    provides: {
      env: () => {
        const validated = defineEnv({
          server: options.schema,
          options: {
            ...(options.skipValidation === undefined ? {} : { skipValidation: options.skipValidation }),
            onValidationError: (issues): never => {
              throw new DotPluginError({
                code: ENV_PLUGIN_ERROR_CODES.invalidEnv,
                message: formatIssues(undefined, issues),
                remediation: 'Set the variables listed above (or fix their values) before booting the app.',
                docsUrl: 'https://arki.dev/dot/errors/arki-env-plugin-e001',
              });
            },
          },
        });
        // Boot is where config must be proven. The first operation on a `defineEnv` env builds and
        // validates it, so this call moves the failure from the first request to boot. `configure`
        // never runs this factory, which keeps `dot explain` free of secrets.
        Reflect.ownKeys(validated);
        return validated;
      },
    },
  });
}
