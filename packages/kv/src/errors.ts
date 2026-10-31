/** The KV failures and the initialization error codes. */
import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

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

/**
 * A KV command did not complete: Redis refused the connection, dropped it, or did not answer within
 * `commandTimeoutMs`. For a write, the effect is unknown: the key may or may not have changed.
 * `command` names the method (`get`, `set`, ...); `reason` is the driver's message.
 *
 * @fix Retry the command later (the status is 503). After a write, read the key before you assume it changed.
 * @verify bun run test -- src/kv.redis.test.ts
 */
export const KvUnavailable = /* @__PURE__ */ defineFailure('kv.unavailable', {
  status: 503,
  data: z.object({ command: z.string(), reason: z.string() }),
  message: ({ command, reason }) => `KV ${command} did not complete: ${reason}`,
  remediation: 'Retry later. After a write, read the key before you assume it changed.',
});

/** A {@link KvUnavailable} failure value. */
export type KvUnavailable = ReturnType<typeof KvUnavailable>;

/**
 * The caller's `AbortSignal` ended a KV command. Nothing is wrong with Redis. For a write, the effect is unknown.
 *
 * @fix Stop waiting. Start a new command with a fresh signal if the work is still needed.
 * @verify bun run test -- src/kv.redis.test.ts
 */
export const KvCancelled = /* @__PURE__ */ defineFailure('kv.cancelled', {
  status: 499,
  data: z.object({ command: z.string() }),
  message: ({ command }) => `KV ${command} was cancelled`,
  remediation: 'Stop waiting, or start a new command with a fresh signal.',
});

/** A {@link KvCancelled} failure value. */
export type KvCancelled = ReturnType<typeof KvCancelled>;

/**
 * Redis answered, but the stored value does not match the schema given to `get` or `mget`.
 * `key` is the key, `issues` says what is wrong in one line. The value stays in Redis untouched.
 *
 * @fix Fix the schema, or delete or rewrite the key. A value written by an older version of the app may have another shape.
 * @verify bun run test -- src/kv.redis.test.ts
 */
export const KvValueInvalid = /* @__PURE__ */ defineFailure('kv.value_invalid', {
  status: 500,
  data: z.object({ key: z.string(), issues: z.string() }),
  message: ({ key, issues }) => `the value stored at KV key "${key}" has the wrong shape: ${issues}`,
  remediation: 'Fix the schema, or delete or rewrite the key. An older app version may have written another shape.',
});

/** A {@link KvValueInvalid} failure value. */
export type KvValueInvalid = ReturnType<typeof KvValueInvalid>;

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
