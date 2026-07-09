/**
 * DOT adapter for `@arki/kv`.
 *
 * Wraps `KV` construction as a DOT plugin. The plugin opens a Redis-backed
 * KV client in `boot`, publishes it as `services.kv`, and closes the client
 * in `dispose` (reverse declaration order).
 *
 * @example
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { kv } from '@arki/kv/dot';
 *
 * const app = await defineApp('my-app')
 *   // Whole-config thunk: env is read at boot, so the declaration stays
 *   // import-pure (loadable from a bare checkout).
 *   .use(kv(() => ({ url: env.KV_URL, namespace: 'my-app' })))
 *   .boot();
 *
 * await app.services.kv.set('hello', 'world', 60);
 * await app.dispose();
 * ```
 *
 * To mount a second KV scope in the same app, rename the published wire
 * key at the mount site:
 *
 * ```ts
 * import { rename } from '@arki/dot';
 *
 * .use(kv({ namespace: 'app' }))
 * .use(rename(kv({ namespace: 'sessions' }), { kv: 'sessionsKv' }, 'sessions-kv'))
 * ```
 *
 * The `@arki/dot` package is an OPTIONAL peer of `@arki/kv`. Importing
 * this adapter without `@arki/dot` installed will fail at module load —
 * that is intentional: the adapter only makes sense in a DOT app.
 */

import type { EmptyShape, Plugin } from '@arki/dot/plugin';
import type { Lazy } from '@arki/ts';
import { DotPluginError, plugin } from '@arki/dot/plugin';
import { resolveLazy } from '@arki/ts';

import { KV } from './index.js';

/**
 * Stable error codes thrown by the kv plugin. Exported so consumers and
 * coding agents can match against them — never parse the message.
 */
export const KV_PLUGIN_ERROR_CODES = {
  /** boot was called without a configured URL. */
  urlNotConfigured: 'KV_PLUGIN_E001',
} as const;

/**
 * Options for the kv DOT adapter.
 */
export type KvDotOptions = {
  /**
   * Redis/Keyv URL. Use `rediss://` for TLS. If omitted, the plugin reads
   * `KV_URL` from `process.env` (matching the `createKV` factory behaviour).
   * To defer an env read to boot, prefer thunking the WHOLE options object
   * — `kv(() => ({ url: env.REDIS_URL }))` — over this per-field thunk
   * (kept for backwards compatibility).
   */
  readonly url?: string | (() => string | undefined);
  /** Optional namespace prefix for all keys (defaults to no prefix). */
  readonly namespace?: string;
  /** Optional prefix for rate-limit keys (default `rl`). */
  readonly rateLimitPrefix?: string;
};

/** Services published by the kv adapter. */
export type KvServices = {
  readonly kv: KV;
};

/**
 * Build a DOT plugin that opens a `KV` client and publishes it as a service.
 *
 * @param options - Connection + naming options, or a thunk producing them.
 *   Thunk the whole object to keep the declaration import-pure — env is
 *   then read at boot, not at module load:
 *   `kv(() => ({ url: env.REDIS_URL, namespace: 'my-app' }))`.
 * @returns A plugin that publishes `services.kv`.
 */
export function kv(options: Lazy<KvDotOptions> = {}): Plugin<EmptyShape, KvServices> {
  return plugin({
    name: 'kv',
    version: '0.1.0',
    configure(ctx) {
      ctx.registerService('kv', 'kv');
    },
    boot() {
      const config = resolveLazy(options);
      const url = (typeof config.url === 'function' ? config.url() : config.url) ?? process.env['KV_URL'];
      if (url === undefined || url === '') {
        throw new DotPluginError({
          code: KV_PLUGIN_ERROR_CODES.urlNotConfigured,
          message: '[kv] KV URL is not configured.',
          remediation: 'Pass options.url to kv(...) or set KV_URL in the environment before booting the app.',
          docsUrl: 'https://arki.dev/dot/errors/kv-plugin-e001',
        });
      }
      const client = new KV(url, config.namespace, config.rateLimitPrefix);
      return { kv: client };
    },
    async dispose({ kv: client }) {
      await client.close();
    },
  });
}
