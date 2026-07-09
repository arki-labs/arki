/**
 * DOT adapter for `@arki/env`.
 *
 * Wraps `defineEnv()` as a DOT plugin so a DOT app can validate its
 * environment alongside any other services. The plugin is sync (env
 * validation is sync), so the `boot` hook returns the validated env
 * object synchronously through the standard provides channel.
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

import { plugin, type EmptyShape, type Plugin } from '@arki/dot/plugin';
import type { ZodType } from 'zod';

import { defineEnv } from './core/define-env.js';

/**
 * Options for the env DOT adapter.
 *
 * @typeParam TSchema - The shape of the `server` schema record. The
 *   resulting `app.services.env` is typed from this.
 */
export type EnvDotOptions<TSchema extends Record<string, ZodType>> = {
  /** Zod schemas for each env var the plugin validates. */
  readonly schema: TSchema;
  /**
   * Forwarded to `defineEnv`. If `true`, the validator is skipped
   * entirely. By default, validation is skipped when `CI` is set or
   * `NODE_ENV !== 'development'`.
   */
  readonly skipValidation?: boolean;
};

/** The shape of services published by the env adapter. */
export type EnvServices<TSchema extends Record<string, ZodType>> = {
  readonly env: { readonly [K in keyof TSchema]: TSchema[K] extends ZodType<infer U> ? U : never };
};

/**
 * Build a DOT plugin that validates and publishes a typed `env` service.
 *
 * @param options - Schema + optional config.
 * @returns A plugin that publishes `services.env`.
 */
export function env<TSchema extends Record<string, ZodType>>(
  options: EnvDotOptions<TSchema>,
): Plugin<EmptyShape, EnvServices<TSchema>> {
  return plugin({
    name: 'env',
    version: '0.1.0',
    configure(ctx) {
      ctx.registerService('env', 'env');
    },
    boot() {
      const validated = defineEnv({
        server: options.schema,
        options:
          options.skipValidation !== undefined
            ? { skipValidation: options.skipValidation }
            : undefined,
      });
      // `defineEnv` returns a Proxy from `@t3-oss/env-core`; we narrow it
      // to the schema-derived shape so downstream typing flows through.
      // The runtime guarantee comes from Zod-side validation inside
      // `defineEnv`. No `any` involved — the cast is type-only.
      const envObject = validated as unknown as EnvServices<TSchema>['env'];
      return { env: envObject };
    },
  });
}
