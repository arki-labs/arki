/**
 * DOT adapter for `@arki/kv`.
 *
 * Wraps `KV` construction as a `DotPip`. The pip opens a Redis-backed
 * KV client in `boot`, publishes it as `services.kv`, and closes the client
 * in `dispose` (reverse-topological order).
 *
 * @example
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { kv } from '@arki/kv/dot';
 *
 * const app = await defineApp('my-app')
 *   .use(kv({ url: process.env.KV_URL!, namespace: 'my-app' }))
 *   .boot();
 *
 * await app.services.kv.set('hello', 'world', 60);
 * await app.dispose();
 * ```
 *
 * The `@arki/dot` package is an OPTIONAL peer of `@arki/kv`. Importing
 * this adapter without `@arki/dot` installed will fail at module load —
 * that is intentional: the adapter only makes sense in a DOT app.
 */

import { defineDotPip, DotPipError, type DotPip } from '@arki/dot/pip';

import { KV } from './index.js';

/**
 * Stable error codes thrown by the kv pip. Exported so consumers and
 * coding agents can match against them — never parse the message.
 */
export const KV_PIP_ERROR_CODES = {
  /** boot was called without a configured URL. */
  urlNotConfigured: 'KV_PIP_E001',
} as const;

/**
 * Options for the kv DOT adapter.
 */
export type KvDotOptions = {
  /**
   * Redis/Keyv URL. Use `rediss://` for TLS. If omitted, the pip reads
   * `KV_URL` from `process.env` (matching the `createKV` factory behaviour).
   */
  readonly url?: string;
  /** Optional namespace prefix for all keys (defaults to no prefix). */
  readonly namespace?: string;
  /** Optional prefix for rate-limit keys (default `rl`). */
  readonly rateLimitPrefix?: string;
  /**
   * Pip name override. Defaults to `'kv'`. Use this only when composing
   * multiple KV scopes inside the same app (rare).
   */
  readonly name?: string;
};

/** Services published by the kv adapter. */
export type KvServices = {
  readonly kv: KV;
};

/**
 * Build a DOT pip that opens a `KV` client and publishes it as a service.
 *
 * @param options - Connection + naming options.
 * @returns A `DotPip` that registers a `kv`-kind service.
 */
export function kv(options: KvDotOptions = {}): DotPip<KvServices> {
  const name = options.name ?? 'kv';
  return defineDotPip<KvServices>({
    name,
    version: '0.1.0',
    provides: ['kv'],
    configure(ctx) {
      ctx.registerService('kv', 'kv');
    },
    boot() {
      const url = options.url ?? process.env['KV_URL'];
      if (url === undefined || url === '') {
        throw new DotPipError({
          code: KV_PIP_ERROR_CODES.urlNotConfigured,
          message: `[${name}] KV URL is not configured.`,
          remediation:
            'Pass options.url to kv(...) or set KV_URL in the environment before booting the app.',
          docsUrl: 'https://arki.dev/dot/errors/kv-pip-e001',
        });
      }
      const client = new KV(url, options.namespace, options.rateLimitPrefix);
      return { services: { kv: client } };
    },
    async dispose({ services }) {
      await services.kv.close();
    },
  });
}
