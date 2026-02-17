/**
 * Rate Limiter for API calls
 * Implements token bucket algorithm with sliding window
 */

import { debugRetry } from '../debug.ts';

export type RateLimiterConfig = {
  maxRequests: number;      // Maximum requests allowed
  windowMs: number;          // Time window in milliseconds
  maxRetries?: number;       // Maximum retry attempts
  retryDelayMs?: number;     // Base delay between retries
}

export type RateLimitResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error; retryAfterMs: number };

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

    debugRetry(
      '[RateLimiter] Initialized (maxRequests: %d, windowMs: %dms, maxRetries: %d, retryDelayMs: %dms)',
      this.config.maxRequests,
      this.config.windowMs,
      this.config.maxRetries,
      this.config.retryDelayMs,
    );
  }

  /**
   * Execute a function with rate limiting
   */
  async execute<T>(
    key: string,
    fn: () => Promise<T>
  ): Promise<RateLimitResult<T>> {
    debugRetry('[RateLimiter] Executing function for key: %s', key);
    let attempts = 0;

    while (attempts < this.config.maxRetries) {
      const canProceed = this.checkLimit(key);

      if (canProceed) {
        debugRetry('[RateLimiter] Rate limit check passed for key: %s (attempt %d/%d)', key, attempts + 1, this.config.maxRetries);
        const data = await fn();
        debugRetry('[RateLimiter] Function executed successfully for key: %s', key);
        return { success: true, data };
      }

      // Rate limited, calculate retry delay
      const retryAfterMs = this.getRetryAfterMs(key);
      debugRetry('[RateLimiter] Rate limit hit for key: %s (attempt %d/%d, retry after %dms)', key, attempts + 1, this.config.maxRetries, retryAfterMs);

      if (attempts === this.config.maxRetries - 1) {
        // Last attempt failed
        debugRetry('[RateLimiter] Max retries reached for key: %s', key);
        return {
          success: false,
          error: new Error(`Rate limit exceeded for ${key}`),
          retryAfterMs,
        };
      }

      // Wait before retrying
      debugRetry('[RateLimiter] Waiting %dms before retry for key: %s', retryAfterMs, key);
      await this.delay(retryAfterMs);
      attempts++;
    }

    debugRetry('[RateLimiter] All retry attempts exhausted for key: %s', key);
    return {
      success: false,
      error: new Error(`Max retry attempts reached for ${key}`),
      retryAfterMs: this.getRetryAfterMs(key),
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

    debugRetry(
      '[RateLimiter] Checking rate limit for key: %s (valid requests: %d/%d)',
      key,
      validRequests.length,
      this.config.maxRequests,
    );

    if (validRequests.length >= this.config.maxRequests) {
      // Update the map with cleaned requests
      this.requests.set(key, validRequests);
      debugRetry('[RateLimiter] Rate limit exceeded for key: %s', key);
      return false;
    }

    // Add current request
    validRequests.push(now);
    this.requests.set(key, validRequests);
    debugRetry('[RateLimiter] Request allowed for key: %s (used: %d/%d)', key, validRequests.length, this.config.maxRequests);
    return true;
  }

  /**
   * Calculate how long to wait before retrying
   */
  private getRetryAfterMs(key: string): number {
    const requests = this.requests.get(key) || [];

    if (requests.length === 0) {
      debugRetry('[RateLimiter] No requests tracked for key: %s, retry delay: 0ms', key);
      return 0;
    }

    // Find the oldest request that would need to expire
    const oldestRequest = Math.min(...requests);
    const now = Date.now();
    const timeUntilExpiry = (oldestRequest + this.config.windowMs) - now;
    const retryDelay = Math.max(0, timeUntilExpiry);

    debugRetry('[RateLimiter] Calculated retry delay for key: %s - %dms', key, retryDelay);

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
    debugRetry('[RateLimiter] Resetting rate limit for key: %s', key);
    this.requests.delete(key);
  }

  /**
   * Reset all rate limits
   */
  resetAll(): void {
    const keyCount = this.requests.size;
    debugRetry('[RateLimiter] Resetting all rate limits (%d keys)', keyCount);
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

    debugRetry(
      '[RateLimiter] Usage for key: %s (used: %d/%d, remaining: %d, reset in: %dms)',
      key,
      used,
      this.config.maxRequests,
      remaining,
      resetInMs,
    );

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
  const functionKey = fn.name || 'anonymous';

  debugRetry('[RateLimiter] Created rate-limited wrapper for function: %s', functionKey);

  return async (...args: TArgs): Promise<TResult> => {
    // Use a stable key for this function
    const key = functionKey;

    const result = await limiter.execute(key, () => fn(...args));

    if (!result.success) {
      throw result.error;
    }

    return result.data;
  };
}

/**
 * Global rate limiter instances for different services
 */
debugRetry('[RateLimiter] Initializing global rate limiter instances');

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

debugRetry('[RateLimiter] Global rate limiter instances initialized (openai, anthropic, groq, google, mistral, openrouter, embedding, vectorSearch)');
