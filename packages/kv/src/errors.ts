/** `RateLimitExceededError` and the initialization error codes. */
import type { IRateLimiterRes } from 'rate-limiter-flexible';

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
