/**
 * Rate Limiter for API calls
 * Implements token bucket algorithm with sliding window
 */

import { debugRetry } from '../debug.ts';
import { RateLimited } from '../failures.ts';

export type RateLimiterConfig = {
  maxRequests: number; // Maximum requests allowed
  windowMs: number; // Time window in milliseconds
  maxRetries?: number; // Maximum retry attempts
  retryDelayMs?: number; // Base delay between retries
};

export class RateLimiter {
  private requests = new Map<string, number[]>();
  private readonly config: Required<RateLimiterConfig>;

  constructor(config: RateLimiterConfig) {
    this.config = {
      maxRequests: config.maxRequests,
      windowMs: config.windowMs,
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
    };

    debugRetry.debug(
      '[RateLimiter] Initialized (maxRequests: {maxRequests}, windowMs: {windowMs}ms, maxRetries: {maxRetries}, retryDelayMs: {retryDelayMs}ms)',
      {
        maxRequests: this.config.maxRequests,
        windowMs: this.config.windowMs,
        maxRetries: this.config.maxRetries,
        retryDelayMs: this.config.retryDelayMs,
      },
    );
  }

  /**
   * Execute a function with rate limiting. Returns the function's value, or `RateLimited` when no
   * slot frees up within `maxRetries` waits. A busy limit is an answer the caller branches on, so it
   * is returned, not thrown.
   */
  async execute<T>(key: string, fn: () => Promise<T>): Promise<T | RateLimited> {
    debugRetry.debug('[RateLimiter] Executing function for key: {key}', { key });
    let attempts = 0;

    while (attempts < this.config.maxRetries) {
      const canProceed = this.checkLimit(key);

      if (canProceed) {
        debugRetry.debug('[RateLimiter] Rate limit check passed for key: {key} (attempt {value2}/{maxRetries})', {
          key,
          value2: attempts + 1,
          maxRetries: this.config.maxRetries,
        });
        const data = await fn();
        debugRetry.debug('[RateLimiter] Function executed successfully for key: {key}', { key });
        return data;
      }

      // Rate limited, calculate retry delay
      const retryAfterMs = this.getRetryAfterMs(key);
      debugRetry.debug(
        '[RateLimiter] Rate limit hit for key: {key} (attempt {value2}/{maxRetries}, retry after {retryAfterMs}ms)',
        { key, value2: attempts + 1, maxRetries: this.config.maxRetries, retryAfterMs },
      );

      if (attempts === this.config.maxRetries - 1) {
        // Last attempt failed
        debugRetry.debug('[RateLimiter] Max retries reached for key: {key}', { key });
        return RateLimited({ retryAfterMs });
      }

      // Wait before retrying
      debugRetry.debug('[RateLimiter] Waiting {retryAfterMs}ms before retry for key: {key}', { retryAfterMs, key });
      await this.delay(retryAfterMs);
      attempts++;
    }

    debugRetry.debug('[RateLimiter] All retry attempts exhausted for key: {key}', { key });
    return RateLimited({ retryAfterMs: this.getRetryAfterMs(key) });
  }

  /**
   * Check if a request can proceed
   */
  private checkLimit(key: string): boolean {
    const now = Date.now();
    const requests = this.requests.get(key) || [];

    // Remove old requests outside the window
    const validRequests = requests.filter(timestamp => now - timestamp < this.config.windowMs);

    debugRetry.debug('[RateLimiter] Checking rate limit for key: {key} (valid requests: {requests}/{maxRequests})', {
      key,
      requests: validRequests.length,
      maxRequests: this.config.maxRequests,
    });

    if (validRequests.length >= this.config.maxRequests) {
      // Update the map with cleaned requests
      this.requests.set(key, validRequests);
      debugRetry.debug('[RateLimiter] Rate limit exceeded for key: {key}', { key });
      return false;
    }

    // Add current request
    validRequests.push(now);
    this.requests.set(key, validRequests);
    debugRetry.debug('[RateLimiter] Request allowed for key: {key} (used: {used}/{maxRequests})', {
      key,
      used: validRequests.length,
      maxRequests: this.config.maxRequests,
    });
    return true;
  }

  /**
   * Calculate how long to wait before retrying
   */
  private getRetryAfterMs(key: string): number {
    const requests = this.requests.get(key) || [];

    if (requests.length === 0) {
      debugRetry.debug('[RateLimiter] No requests tracked for key: {key}, retry delay: 0ms', { key });
      return 0;
    }

    // Find the oldest request that would need to expire
    const oldestRequest = Math.min(...requests);
    const now = Date.now();
    const timeUntilExpiry = oldestRequest + this.config.windowMs - now;
    const retryDelay = Math.max(0, timeUntilExpiry);

    debugRetry.debug('[RateLimiter] Calculated retry delay for key: {key} - {retryDelay}ms', { key, retryDelay });

    return retryDelay;
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
    debugRetry.debug('[RateLimiter] Resetting rate limit for key: {key}', { key });
    this.requests.delete(key);
  }

  /**
   * Reset all rate limits
   */
  resetAll(): void {
    const keyCount = this.requests.size;
    debugRetry.debug('[RateLimiter] Resetting all rate limits ({keyCount} keys)', { keyCount });
    this.requests.clear();
  }

  /**
   * Get current usage for a key
   */
  getUsage(key: string): { used: number; remaining: number; resetInMs: number } {
    const now = Date.now();
    const requests = this.requests.get(key) || [];

    const validRequests = requests.filter(timestamp => now - timestamp < this.config.windowMs);

    const used = validRequests.length;
    const remaining = Math.max(0, this.config.maxRequests - used);

    const oldestRequest = validRequests.length > 0 ? Math.min(...validRequests) : now;

    const resetInMs = Math.max(0, oldestRequest + this.config.windowMs - now);

    debugRetry.debug(
      '[RateLimiter] Usage for key: {key} (used: {used}/{maxRequests}, remaining: {remaining}, reset in: {in}ms)',
      { key, used, maxRequests: this.config.maxRequests, remaining, in: resetInMs },
    );

    return { used, remaining, resetInMs };
  }
}

/**
 * Create a rate-limited wrapper for any async function. The wrapper returns the function's value,
 * or `RateLimited` when the limit stays busy.
 */
export function createRateLimitedFunction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  config: RateLimiterConfig,
): (...args: TArgs) => Promise<TResult | RateLimited> {
  const limiter = new RateLimiter(config);
  const functionKey = fn.name || 'anonymous';

  debugRetry.debug('[RateLimiter] Created rate-limited wrapper for function: {function}', { function: functionKey });

  // Use a stable key for this function
  return (...args: TArgs): Promise<TResult | RateLimited> => limiter.execute(functionKey, () => fn(...args));
}

/**
 * Global rate limiter instances for different services
 */
debugRetry.debug('[RateLimiter] Initializing global rate limiter instances');

export const rateLimiters = {
  // OpenAI: 60 RPM on most tiers
  openai: new RateLimiter({
    maxRequests: 60,
    windowMs: 60 * 1000,
    maxRetries: 3,
    retryDelayMs: 2000,
  }),

  // Anthropic: 50 RPM
  anthropic: new RateLimiter({
    maxRequests: 50,
    windowMs: 60 * 1000,
    maxRetries: 3,
    retryDelayMs: 2000,
  }),

  // Groq: 240 requests/minute on free tier (14,400/day)
  groq: new RateLimiter({
    maxRequests: 240,
    windowMs: 60 * 1000,
    maxRetries: 3,
    retryDelayMs: 1000,
  }),

  // Google AI (Gemini): 60 RPM on free tier
  google: new RateLimiter({
    maxRequests: 60,
    windowMs: 60 * 1000,
    maxRetries: 3,
    retryDelayMs: 2000,
  }),

  // Mistral: 60 RPM (varies by tier)
  mistral: new RateLimiter({
    maxRequests: 60,
    windowMs: 60 * 1000,
    maxRetries: 3,
    retryDelayMs: 2000,
  }),

  // OpenRouter: varies by model, conservative default
  openrouter: new RateLimiter({
    maxRequests: 60,
    windowMs: 60 * 1000,
    maxRetries: 3,
    retryDelayMs: 2000,
  }),

  // Embeddings
  embedding: new RateLimiter({
    maxRequests: 100,
    windowMs: 60 * 1000,
    maxRetries: 3,
    retryDelayMs: 1000,
  }),

  // Vector search
  vectorSearch: new RateLimiter({
    maxRequests: 200,
    windowMs: 60 * 1000,
    maxRetries: 2,
    retryDelayMs: 500,
  }),
};

debugRetry.debug(
  '[RateLimiter] Global rate limiter instances initialized (openai, anthropic, groq, google, mistral, openrouter, embedding, vectorSearch)',
);
