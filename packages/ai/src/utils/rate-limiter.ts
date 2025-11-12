/**
 * Rate Limiter for API calls
 * Implements token bucket algorithm with sliding window
 */

export interface RateLimiterConfig {
  maxRequests: number;      // Maximum requests allowed
  windowMs: number;          // Time window in milliseconds
  maxRetries?: number;       // Maximum retry attempts
  retryDelayMs?: number;     // Base delay between retries
}

export interface RateLimitResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  retryAfterMs?: number;
}

export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly config: Required<RateLimiterConfig>;

  constructor(config: RateLimiterConfig) {
    this.config = {
      maxRequests: config.maxRequests,
      windowMs: config.windowMs,
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
    };
  }

  /**
   * Execute a function with rate limiting
   */
  async execute<T>(
    key: string,
    fn: () => Promise<T>
  ): Promise<RateLimitResult<T>> {
    let attempts = 0;

    while (attempts < this.config.maxRetries) {
      const canProceed = this.checkLimit(key);

      if (canProceed) {
        try {
          const data = await fn();
          return { success: true, data };
        } catch (error) {
          return {
            success: false,
            error: error as Error
          };
        }
      }

      // Rate limited, calculate retry delay
      const retryAfterMs = this.getRetryAfterMs(key);

      if (attempts === this.config.maxRetries - 1) {
        // Last attempt failed
        return {
          success: false,
          error: new Error(`Rate limit exceeded for ${key}`),
          retryAfterMs,
        };
      }

      // Wait before retrying
      await this.delay(retryAfterMs);
      attempts++;
    }

    return {
      success: false,
      error: new Error(`Max retry attempts reached for ${key}`),
    };
  }

  /**
   * Check if a request can proceed
   */
  private checkLimit(key: string): boolean {
    const now = Date.now();
    const requests = this.requests.get(key) || [];

    // Remove old requests outside the window
    const validRequests = requests.filter(
      timestamp => now - timestamp < this.config.windowMs
    );

    if (validRequests.length >= this.config.maxRequests) {
      // Update the map with cleaned requests
      this.requests.set(key, validRequests);
      return false;
    }

    // Add current request
    validRequests.push(now);
    this.requests.set(key, validRequests);
    return true;
  }

  /**
   * Calculate how long to wait before retrying
   */
  private getRetryAfterMs(key: string): number {
    const requests = this.requests.get(key) || [];

    if (requests.length === 0) {
      return 0;
    }

    // Find the oldest request that would need to expire
    const oldestRequest = Math.min(...requests);
    const now = Date.now();
    const timeUntilExpiry = (oldestRequest + this.config.windowMs) - now;

    return Math.max(0, timeUntilExpiry);
  }

  /**
   * Delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Reset rate limit for a specific key
   */
  reset(key: string): void {
    this.requests.delete(key);
  }

  /**
   * Reset all rate limits
   */
  resetAll(): void {
    this.requests.clear();
  }

  /**
   * Get current usage for a key
   */
  getUsage(key: string): { used: number; remaining: number; resetInMs: number } {
    const now = Date.now();
    const requests = this.requests.get(key) || [];

    const validRequests = requests.filter(
      timestamp => now - timestamp < this.config.windowMs
    );

    const used = validRequests.length;
    const remaining = Math.max(0, this.config.maxRequests - used);

    const oldestRequest = validRequests.length > 0
      ? Math.min(...validRequests)
      : now;

    const resetInMs = Math.max(0, (oldestRequest + this.config.windowMs) - now);

    return { used, remaining, resetInMs };
  }
}

/**
 * Create a rate-limited wrapper for any async function
 */
export function createRateLimitedFunction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  config: RateLimiterConfig
): (...args: TArgs) => Promise<TResult> {
  const limiter = new RateLimiter(config);

  return async (...args: TArgs): Promise<TResult> => {
    // Use a stable key for this function
    const key = fn.name || 'anonymous';

    const result = await limiter.execute(key, () => fn(...args));

    if (!result.success) {
      throw result.error;
    }

    return result.data!;
  };
}

/**
 * Global rate limiter instances for different services
 */
export const rateLimiters = {
  openai: new RateLimiter({
    maxRequests: 60,          // 60 requests
    windowMs: 60 * 1000,      // per minute
    maxRetries: 3,
    retryDelayMs: 2000,
  }),
  anthropic: new RateLimiter({
    maxRequests: 50,
    windowMs: 60 * 1000,
    maxRetries: 3,
    retryDelayMs: 2000,
  }),
  embedding: new RateLimiter({
    maxRequests: 100,         // 100 requests
    windowMs: 60 * 1000,      // per minute
    maxRetries: 3,
    retryDelayMs: 1000,
  }),
  vectorSearch: new RateLimiter({
    maxRequests: 200,         // 200 requests
    windowMs: 60 * 1000,      // per minute
    maxRetries: 2,
    retryDelayMs: 500,
  }),
};
