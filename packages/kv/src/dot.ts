/**
 * DOT adapter for `@arki/kv`.
 *
 * Wraps `KV` construction as a DOT plugin. The plugin's `kv` factory opens a
 * Redis-backed KV client at boot, publishes it as `services.kv`, and closes
 * the client in `dispose` (reverse declaration order). `cache.provides.kv`
 * is the typed handle consumers name in their `needs`.
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
 * Redis optional (dev, tests)? `kv.optional(...)` publishes `kv` as
 * `KV | null` — `null` when no URL is set — instead of failing boot.
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
  urlNotConfigured: 'ARKI_KV_PLUGIN_E001',
  /** `probe: true` and the set/get/delete round trip at boot failed. */
  probeFailed: 'ARKI_KV_PLUGIN_E002',
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
  /**
   * Prove the connection at boot with a set/get/delete round trip (default
   * `false`). A bad or unreachable URL then fails boot instead of the first
   * request. The client is closed before the error is thrown.
   */
  readonly probe?: boolean;
  /**
   * How long the probe may take, in milliseconds (default `5000`). An
   * unreachable Redis never answers — the client keeps reconnecting — so
   * without this limit a bad URL would hang boot instead of failing it.
   */
  readonly probeTimeoutMs?: number;
};

/** Services published by the kv adapter. */
export type KvServices = {
  readonly kv: KV;
};

/** The configured URL: `options.url`, else `KV_URL`. An empty string counts as unset. */
function resolveUrl(config: KvDotOptions): string | undefined {
  const url = (typeof config.url === 'function' ? config.url() : config.url) ?? process.env['KV_URL'];
  return url === '' ? undefined : url;
}

/** Set, read back and delete one key; resolves only if the value survived the round trip. */
async function roundTrip(client: KV): Promise<void> {
  const key = 'arki-kv-dot-probe';
  await client.set(key, 'ok', 5);
  const value = await client.get<string>(key);
  await client.delete(key);
  if (value !== 'ok') throw new Error(`read back ${JSON.stringify(value)} instead of "ok"`);
}

/** Fail boot with `probeFailed` (round trip failed or timed out), closing the client first. */
async function probe(client: KV, timeoutMs: number): Promise<KV> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([roundTrip(client), timeout]);
    return client;
  } catch (error) {
    await client.close();
    throw new DotPluginError({
      code: KV_PLUGIN_ERROR_CODES.probeFailed,
      message: `[kv] KV connection probe failed: ${error instanceof Error ? error.message : String(error)}`,
      remediation: 'Check that the KV URL is correct and that Redis is reachable from this process.',
      docsUrl: 'https://arki.dev/dot/errors/arki-kv-plugin-e002',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Open the client for `url`; with `probe: true`, only once a round trip worked. */
function open(url: string, config: KvDotOptions): KV | Promise<KV> {
  const client = new KV(url, config.namespace, config.rateLimitPrefix);
  return config.probe === true ? probe(client, config.probeTimeoutMs ?? 5000) : client;
}

/**
 * Build a DOT plugin that opens a `KV` client and publishes it as a service.
 *
 * Without a URL, boot fails with `ARKI_KV_PLUGIN_E001`. For an app that runs
 * without Redis (dev, tests), use {@link kv.optional} instead.
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
    provides: {
      kv: () => {
        const config = resolveLazy(options);
        const url = resolveUrl(config);
        if (url === undefined) {
          throw new DotPluginError({
            code: KV_PLUGIN_ERROR_CODES.urlNotConfigured,
            message: '[kv] KV URL is not configured.',
            remediation: 'Pass options.url to kv(...) or set KV_URL in the environment before booting the app.',
            docsUrl: 'https://arki.dev/dot/errors/arki-kv-plugin-e001',
          });
        }
        return open(url, config);
      },
    },
    async dispose({ kv: client }) {
      await client.close();
    },
  });
}

/**
 * The same plugin as {@link kv}, for an app where Redis is optional: with no
 * URL it publishes `kv` as `null` and opens nothing; with a URL it opens the
 * same client `kv()` does. Consumers handle `null` (a rate limiter allows
 * every request, a cache misses). `dispose` closes a non-null client.
 *
 * @example
 * ```ts
 * export const cache = kv.optional(() => ({ url: env.KV_URL, namespace: 'my-app' }));
 * export type Kv = Provided<typeof cache.provides.kv>; // KV | null
 * ```
 */
kv.optional = function optional(options: Lazy<KvDotOptions> = {}) {
  return plugin({
    name: 'kv',
    version: '0.1.0',
    configure(ctx) {
      ctx.registerService('kv', 'kv');
    },
    provides: {
      kv: (): KV | null | Promise<KV> => {
        const config = resolveLazy(options);
        const url = resolveUrl(config);
        return url === undefined ? null : open(url, config);
      },
    },
    async dispose({ kv: client }) {
      await client?.close();
    },
  });
};
