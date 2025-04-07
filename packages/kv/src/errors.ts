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
