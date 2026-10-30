/** `RateLimitExceededError` and the initialization error codes. */
import type { IRateLimiterRes } from 'rate-limiter-flexible';
import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

export class RateLimitExceededError extends Error {
  readonly limiterResult: IRateLimiterRes;

  constructor(message: string, limiterResult: IRateLimiterRes, cause?: Error) {
    super(message);
    this.name = 'RateLimitExceededError';
    this.limiterResult = limiterResult;
    this.cause = cause;
  }

  getHttpHeaders(points: number) {
    return {
      'Retry-After': (this.limiterResult.msBeforeNext ?? 2500) / 1000,
      'X-RateLimit-Limit': points,
      'X-RateLimit-Remaining': this.limiterResult.remainingPoints,
      'X-RateLimit-Reset': Math.ceil((Date.now() + (this.limiterResult.msBeforeNext ?? 2500)) / 1000),
    };
  }
}

/**
 * `KV.close()` could not disconnect one of its two Redis connections. The connection may still be open.
 * `target` says which one: `store` (the Keyv connection) or `limiter` (the rate limiter connection).
 *
 * @fix Check the Redis server and the network. The process can still end; the server drops idle clients after its timeout.
 * @verify bun run test -- src/kv.redis.test.ts
 */
export const KvCloseFailed = /* @__PURE__ */ defineFailure('kv.close_failed', {
  status: 503,
  data: z.object({ target: z.enum(['store', 'limiter']), reason: z.string() }),
  message: ({ target, reason }) => `the KV ${target} connection did not close: ${reason}`,
  remediation: 'Check the Redis server and the network. The server drops idle clients after its timeout.',
});

/** A {@link KvCloseFailed} failure value. */
export type KvCloseFailed = ReturnType<typeof KvCloseFailed>;

export const KV_INITIALIZATION_ERROR_CODES = {
  /**
   * Production started without `KV_URL`, so no store can be opened.
   *
   * @fix Set `KV_URL` in the production environment.
   * @verify bun run test -- src/instance.test.ts
   */
  urlRequiredInProduction: 'KV_INIT_E001',
  /**
   * The store did not accept the connection in production.
   *
   * @fix Check the URL, the network and the credentials, then restart.
   * @verify bun run test -- src/instance.test.ts
   */
  connectionFailed: 'KV_INIT_E002',
  /**
   * Creating the KV client threw in production.
   *
   * @fix Read the error `cause`. It names the invalid option or the failing call.
   * @verify bun run test -- src/instance.test.ts
   */
  creationFailed: 'KV_INIT_E003',
  /**
   * A factory (`createKV`, `createRateLimitKV`) ran without a Redis URL.
   *
   * @fix Set `KV_URL` (or `RATE_LIMIT_REDIS_URL` for `createRateLimitKV`).
   * @verify bun run test -- src/factory.test.ts
   */
  urlNotConfigured: 'KV_INIT_E004',
} as const;

/** The KV store could not be set up in production. The caller decides whether to end the program. */
export class KVInitializationError extends Error {
  readonly code: (typeof KV_INITIALIZATION_ERROR_CODES)[keyof typeof KV_INITIALIZATION_ERROR_CODES];
  readonly remediation: string;

  constructor(args: {
    readonly code: (typeof KV_INITIALIZATION_ERROR_CODES)[keyof typeof KV_INITIALIZATION_ERROR_CODES];
    readonly message: string;
    readonly remediation: string;
    readonly cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = 'KVInitializationError';
    this.code = args.code;
    this.remediation = args.remediation;
  }
}
