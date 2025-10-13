/**
 * Retry Strategy Utilities for BullMQ Integration
 *
 * This module provides comprehensive retry strategies for job processing, including
 * AWS-recommended approaches for distributed systems.
 *
 * ## Available Strategies
 *
 * ### Basic Strategies
 * - **Fixed**: Constant delay between retries (e.g., 10s, 10s, 10s)
 * - **Exponential**: Delay grows exponentially (e.g., 1s, 2s, 4s, 8s, 16s)
 * - **Linear**: Delay increases linearly (e.g., 5s, 10s, 15s, 20s, 25s)
 * - **Polynomial**: Delay grows polynomially (e.g., 1s, 4s, 9s, 16s, 25s)
 *
 * ### Advanced Jitter Strategies (AWS Recommended)
 * - **Decorrelated Jitter**: AWS's #1 recommended strategy for distributed systems
 *   - Random between base_delay and previous_delay * 3
 *   - Best distribution to prevent thundering herd
 *   - Optimal for high-concurrency scenarios
 *
 * - **Full Jitter**: Maximum randomness (random between 0 and exponential_delay)
 *   - Best for preventing synchronized retry storms
 *   - Good when immediate retry is acceptable
 *
 * - **Equal Jitter**: Balanced approach (half fixed + half random)
 *   - Guarantees minimum wait time
 *   - Good middle ground between distribution and predictability
 *
 * - **Exponential Jitter**: Basic exponential with configurable randomness
 *   - Adds percentage-based jitter to exponential backoff
 *
 * ### Hybrid Strategies
 * - **Fibonacci**: Natural growth using Fibonacci sequence (1, 1, 2, 3, 5, 8, 13...)
 *   - Less aggressive than exponential
 *   - Good balance for distributed systems
 *
 * - **Constant then Exponential**: Fixed delays initially, then exponential
 *   - Perfect for transient vs persistent failures
 *   - Common in file processing systems
 *
 * - **Stepped/Tiered**: Different delays for different attempt ranges
 *   - Fine-grained control for complex requirements
 *   - Used in payment processing and rate-limited APIs
 *
 * - **Custom**: User-defined function for complete control
 *
 * ## Quick Start
 *
 * ```typescript
 * import { COMMON_RETRY_CONFIGS } from '@arki/queue';
 *
 * // AWS recommended for distributed systems
 * retry: COMMON_RETRY_CONFIGS.AWS_DECORRELATED
 *
 * // High concurrency scenarios
 * retry: COMMON_RETRY_CONFIGS.AWS_FULL_JITTER
 *
 * // General purpose
 * retry: COMMON_RETRY_CONFIGS.STANDARD
 *
 * // Payment processing
 * retry: COMMON_RETRY_CONFIGS.PAYMENT_PROCESSING
 * ```
 *
 * ## Custom Configuration
 *
 * ```typescript
 * retry: {
 *   attempts: 5,
 *   backoff: {
 *     type: 'decorrelated-jitter',
 *     delay: 1000,
 *     multiplier: 3
 *   },
 *   maxDelay: 30000  // Cap at 30 seconds
 * }
 * ```
 *
 * ## Recommendations by Use Case
 *
 * - **Distributed Systems/Microservices**: `AWS_DECORRELATED` ⭐⭐⭐
 * - **High Concurrency**: `AWS_FULL_JITTER` ⭐⭐
 * - **General Purpose**: `STANDARD` or `AWS_EQUAL_JITTER`
 * - **Rate-Limited APIs**: `RATE_LIMITED`
 * - **Payment Processing**: `PAYMENT_PROCESSING`
 * - **Database Operations**: `FIBONACCI` or `STANDARD`
 * - **File Processing**: `CONSTANT_THEN_EXPONENTIAL`
 * - **Critical Operations**: `AGGRESSIVE`
 *
 * @see {@link https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/}
 * @module retry-strategies
 */

import type { BackoffOptions } from 'bullmq';

import type { BackoffStrategy, RetryConfig } from './types/job.ts';

/**
 * Create a BullMQ-compatible backoff strategy function from our BackoffStrategy configuration
 *
 * This function converts our declarative retry strategy configuration into a function
 * that BullMQ can use to calculate delays between retry attempts. It supports all
 * 12 built-in strategies plus custom functions.
 *
 * The returned function signature matches BullMQ's BackoffStrategy:
 * `(attemptsMade: number, type?: string, err?: Error) => number | Promise<number>`
 *
 * ## Strategy Implementation Notes
 *
 * - **Fixed**: Returns constant delay regardless of attempt number
 * - **Exponential**: Uses Math.pow for exponential growth
 * - **Linear**: Multiplies delay by (attemptsMade + 1)
 * - **Polynomial**: Uses Math.pow with custom power
 * - **Exponential Jitter**: Adds percentage-based randomness to exponential
 * - **Fibonacci**: Uses cached sequence for O(1) lookups after initial calculation
 * - **Decorrelated Jitter**: Maintains state via closure to track previous delay
 * - **Full Jitter**: Random between 0 and exponential delay
 * - **Equal Jitter**: Half fixed + half random
 * - **Constant then Exponential**: Switches strategy at configured attempt count
 * - **Stepped**: Uses tier lookup with sorted array
 * - **Custom**: Wraps user function to apply maxDelay cap
 *
 * @param backoff - Backoff strategy configuration defining the retry behavior
 * @param maxDelay - Optional maximum delay cap in milliseconds. When set, all calculated
 *                   delays will be capped at this value to prevent excessive wait times.
 * @returns A function that calculates retry delay based on attempt number, compatible
 *          with BullMQ's BackoffStrategy type. May return Promise<number> for async strategies.
 *
 * @example
 * ```typescript
 * // Simple exponential backoff
 * const strategy = createBackoffStrategy(
 *   { type: 'exponential', delay: 1000, base: 2 },
 *   30000 // Cap at 30 seconds
 * );
 *
 * strategy(0); // Returns 1000ms
 * strategy(1); // Returns 2000ms
 * strategy(4); // Returns 16000ms
 * strategy(10); // Returns 30000ms (capped)
 * ```
 *
 * @example
 * ```typescript
 * // AWS decorrelated jitter (recommended for distributed systems)
 * const strategy = createBackoffStrategy({
 *   type: 'decorrelated-jitter',
 *   delay: 1000,
 *   multiplier: 3
 * });
 *
 * // Each call returns random value with optimal distribution
 * strategy(0); // e.g., 2100ms
 * strategy(1); // e.g., 4500ms (based on previous)
 * ```
 *
 * @example
 * ```typescript
 * // Custom error-aware strategy
 * const strategy = createBackoffStrategy({
 *   type: 'custom',
 *   strategy: async (attemptsMade, type, error) => {
 *     if (error?.message.includes('rate limit')) {
 *       return 60000; // 1 minute for rate limits
 *     }
 *     return Math.min(1000 * Math.pow(2, attemptsMade), 30000);
 *   }
 * });
 * ```
 *
 * @throws {Error} If an unknown backoff type is provided (compile-time safety via never type)
 */
export function createBackoffStrategy(
  backoff: BackoffStrategy,
  maxDelay?: number,
): (attemptsMade: number, type?: string, err?: Error) => number | Promise<number> {
  switch (backoff.type) {
    case 'fixed': {
      const delay = backoff.delay;
      return () => (maxDelay ? Math.min(delay, maxDelay) : delay);
    }

    case 'exponential': {
      const { delay, base = 2 } = backoff;
      return attemptsMade => {
        const calculatedDelay = delay * Math.pow(base, attemptsMade);
        return maxDelay ? Math.min(calculatedDelay, maxDelay) : calculatedDelay;
      };
    }

    case 'linear': {
      const delay = backoff.delay;
      return attemptsMade => {
        // Linear: delay * (attempt + 1)
        // +1 because attemptsMade is 0-indexed
        const calculatedDelay = delay * (attemptsMade + 1);
        return maxDelay ? Math.min(calculatedDelay, maxDelay) : calculatedDelay;
      };
    }

    case 'polynomial': {
      const { delay, power = 2 } = backoff;
      return attemptsMade => {
        // Polynomial: delay * (attempt + 1) ^ power
        const calculatedDelay = delay * Math.pow(attemptsMade + 1, power);
        return maxDelay ? Math.min(calculatedDelay, maxDelay) : calculatedDelay;
      };
    }

    case 'exponential-jitter': {
      const { delay, base = 2, jitter = 0.1 } = backoff;
      return attemptsMade => {
        // Exponential with jitter: delay * (base ^ attempt) * (1 + random * jitter)
        const baseDelay = delay * Math.pow(base, attemptsMade);
        const jitterMultiplier = 1 + Math.random() * jitter;
        const calculatedDelay = baseDelay * jitterMultiplier;
        return maxDelay ? Math.min(calculatedDelay, maxDelay) : calculatedDelay;
      };
    }

    case 'fibonacci': {
      const delay = backoff.delay;
      // Cache fibonacci numbers for performance
      const fibCache: number[] = [1, 1];
      const getFib = (n: number): number => {
        if (n < fibCache.length) return fibCache[n]!;
        for (let i = fibCache.length; i <= n; i++) {
          fibCache[i] = fibCache[i - 1]! + fibCache[i - 2]!;
        }
        return fibCache[n]!;
      };

      return attemptsMade => {
        const fib = getFib(attemptsMade);
        const calculatedDelay = delay * fib;
        return maxDelay ? Math.min(calculatedDelay, maxDelay) : calculatedDelay;
      };
    }

    case 'decorrelated-jitter': {
      const { delay, multiplier = 3 } = backoff;
      // Need to track previous delay for decorrelated jitter
      let previousDelay = delay;

      return () => {
        // Random between base_delay and previous_delay * multiplier
        const min = delay;
        const max = previousDelay * multiplier;
        const calculatedDelay = min + Math.random() * (max - min);
        previousDelay = calculatedDelay;
        return maxDelay ? Math.min(calculatedDelay, maxDelay) : calculatedDelay;
      };
    }

    case 'full-jitter': {
      const { delay, base = 2 } = backoff;
      return attemptsMade => {
        // Random between 0 and exponential_delay
        const exponentialDelay = delay * Math.pow(base, attemptsMade);
        const calculatedDelay = Math.random() * exponentialDelay;
        return maxDelay ? Math.min(calculatedDelay, maxDelay) : calculatedDelay;
      };
    }

    case 'equal-jitter': {
      const { delay, base = 2 } = backoff;
      return attemptsMade => {
        // (exponential_delay / 2) + random(0, exponential_delay / 2)
        const exponentialDelay = delay * Math.pow(base, attemptsMade);
        const halfDelay = exponentialDelay / 2;
        const calculatedDelay = halfDelay + Math.random() * halfDelay;
        return maxDelay ? Math.min(calculatedDelay, maxDelay) : calculatedDelay;
      };
    }

    case 'constant-then-exponential': {
      const { constantDelay, constantAttempts, exponentialDelay, base = 2 } = backoff;
      return attemptsMade => {
        let calculatedDelay: number;

        if (attemptsMade < constantAttempts) {
          // Constant phase
          calculatedDelay = constantDelay;
        } else {
          // Exponential phase (starting from 0 for the exponential part)
          const exponentialAttempt = attemptsMade - constantAttempts;
          calculatedDelay = exponentialDelay * Math.pow(base, exponentialAttempt);
        }

        return maxDelay ? Math.min(calculatedDelay, maxDelay) : calculatedDelay;
      };
    }

    case 'stepped': {
      const { tiers } = backoff;
      // Sort tiers by maxAttempt to ensure proper order
      const sortedTiers = [...tiers].sort((a, b) => a.maxAttempt - b.maxAttempt);

      return attemptsMade => {
        // Find the appropriate tier for this attempt
        // +1 because attemptsMade is 0-indexed but tier maxAttempt is 1-indexed
        const attemptNumber = attemptsMade + 1;
        const tier = sortedTiers.find(t => attemptNumber <= t.maxAttempt);

        const calculatedDelay = tier?.delay ?? sortedTiers[sortedTiers.length - 1]!.delay;
        return maxDelay ? Math.min(calculatedDelay, maxDelay) : calculatedDelay;
      };
    }

    case 'custom': {
      return async (attemptsMade, type, err) => {
        const calculatedDelay = await backoff.strategy(attemptsMade, type, err);
        return maxDelay ? Math.min(calculatedDelay, maxDelay) : calculatedDelay;
      };
    }

    default: {
      // Exhaustive type check
      const _: never = backoff;
      throw new Error(`Unknown backoff type: ${(_ as BackoffStrategy).type}`);
    }
  }
}

/**
 * Convert RetryConfig to BullMQ backoff options
 *
 * For simple strategies (fixed, exponential), we use BullMQ's built-in support.
 * For complex strategies, we return undefined here and use Worker's backoffStrategy option instead.
 *
 * @param retry - Retry configuration
 * @returns BullMQ backoff options or undefined for custom strategies
 */
export function toBullMQBackoff(retry?: RetryConfig): BackoffOptions | undefined {
  if (!retry?.backoff) {
    return { type: 'exponential', delay: 1000 };
  }

  const { backoff } = retry;

  // BullMQ has built-in support for fixed and exponential
  if (backoff.type === 'fixed') {
    return {
      type: 'fixed',
      delay: backoff.delay,
    };
  }

  if (backoff.type === 'exponential' && !backoff.base) {
    // BullMQ's exponential uses base 2 by default, matching our default
    return {
      type: 'exponential',
      delay: backoff.delay,
    };
  }

  // For all other strategies (including exponential with custom base),
  // we need to use Worker's backoffStrategy option
  return undefined;
}

/**
 * Check if we need to use Worker's backoffStrategy option
 *
 * @param retry - Retry configuration
 * @returns True if custom backoff strategy is needed
 */
export function needsCustomBackoffStrategy(retry?: RetryConfig): boolean {
  if (!retry?.backoff) {
    return false;
  }

  const { backoff } = retry;

  // BullMQ has built-in support for 'fixed' and 'exponential' (with base 2)
  // All other strategies need custom implementation
  return (
    backoff.type === 'linear' ||
    backoff.type === 'polynomial' ||
    backoff.type === 'exponential-jitter' ||
    backoff.type === 'fibonacci' ||
    backoff.type === 'decorrelated-jitter' ||
    backoff.type === 'full-jitter' ||
    backoff.type === 'equal-jitter' ||
    backoff.type === 'constant-then-exponential' ||
    backoff.type === 'stepped' ||
    backoff.type === 'custom' ||
    (backoff.type === 'exponential' && backoff.base !== undefined && backoff.base !== 2)
  );
}

/**
 * Get the backoff strategy function for Worker options
 *
 * @param retry - Retry configuration
 * @returns Backoff strategy function for Worker
 */
export function getWorkerBackoffStrategy(
  retry?: RetryConfig,
): ((attemptsMade: number, type?: string, err?: Error) => number | Promise<number>) | undefined {
  if (!retry?.backoff || !needsCustomBackoffStrategy(retry)) {
    return undefined;
  }

  return createBackoffStrategy(retry.backoff, retry.maxDelay);
}

/**
 * Pre-configured retry strategies for common use cases
 *
 * These presets provide battle-tested retry configurations for various scenarios.
 * All strategies are production-ready and optimized for their specific use cases.
 *
 * ## Basic Presets
 *
 * - **FAST**: Quick operations with exponential backoff (3 attempts: 1s, 2s, 4s)
 * - **STANDARD**: General-purpose exponential backoff (5 attempts: 2s, 4s, 8s, 16s, 32s)
 * - **AGGRESSIVE**: Many retries with delay cap (10 attempts, max 30s)
 * - **LINEAR**: Predictable linear growth (5 attempts: 5s, 10s, 15s, 20s, 25s)
 * - **FIXED**: Constant delays (3 attempts: 10s each)
 *
 * ## Jitter Strategies (Prevent Thundering Herd)
 *
 * - **EXPONENTIAL_JITTER**: Basic exponential with 10% randomness
 * - **FIBONACCI**: Natural Fibonacci sequence (7 attempts: 1s, 1s, 2s, 3s, 5s, 8s, 13s)
 *
 * ## AWS Strategies (Recommended for Production)
 *
 * - **AWS_DECORRELATED** ⭐⭐⭐: AWS's #1 recommended strategy
 *   - Best for distributed systems and microservices
 *   - Optimal distribution to prevent synchronized retries
 *   - Use this for production distributed systems
 *
 * - **AWS_FULL_JITTER** ⭐⭐: Maximum randomness
 *   - Best for high-concurrency scenarios
 *   - Prevents retry storms
 *
 * - **AWS_EQUAL_JITTER** ⭐: Balanced approach
 *   - Good general-purpose choice
 *   - Guarantees minimum wait time
 *
 * ## Specialized Presets
 *
 * - **CONSTANT_THEN_EXPONENTIAL**: Hybrid strategy for transient failures
 *   - Quick initial retries (3x at 2s)
 *   - Then exponential growth (1s, 2s, 4s, 8s...)
 *
 * - **PAYMENT_PROCESSING**: Tiered delays for payment systems
 *   - First 3 attempts: 1s (quick retries for transient issues)
 *   - Next 2 attempts: 5s (moderate delay)
 *   - Remaining: 30s (long delay for persistent issues)
 *
 * - **RATE_LIMITED**: Respects API rate limits
 *   - First 2 attempts: 5s (quick retry)
 *   - Remaining: 60s (wait for rate limit reset)
 *
 * - **NONE**: No retry, fail immediately
 *
 * @example
 * ```typescript
 * import { COMMON_RETRY_CONFIGS, defineJob } from '@arki/queue';
 *
 * // AWS recommended for distributed systems
 * const microserviceJob = defineJob({
 *   name: 'call-microservice',
 *   // ...
 *   options: {
 *     retry: COMMON_RETRY_CONFIGS.AWS_DECORRELATED
 *   }
 * });
 *
 * // Payment processing
 * const processPayment = defineJob({
 *   name: 'process-payment',
 *   // ...
 *   options: {
 *     retry: COMMON_RETRY_CONFIGS.PAYMENT_PROCESSING
 *   }
 * });
 * ```
 */
export const COMMON_RETRY_CONFIGS = {
  /**
   * Fast retry with exponential backoff
   * Attempts: 3, Delays: 1s, 2s, 4s
   */
  FAST: {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 1000 },
  },

  /**
   * Standard retry with exponential backoff
   * Attempts: 5, Delays: 2s, 4s, 8s, 16s, 32s
   */
  STANDARD: {
    attempts: 5,
    backoff: { type: 'exponential' as const, delay: 2000 },
  },

  /**
   * Aggressive retry with exponential backoff and max delay
   * Attempts: 10, Delays: 1s, 2s, 4s, 8s, 16s, 30s (capped)...
   */
  AGGRESSIVE: {
    attempts: 10,
    backoff: { type: 'exponential' as const, delay: 1000 },
    maxDelay: 30000, // Cap at 30 seconds
  },

  /**
   * Linear retry for predictable delays
   * Attempts: 5, Delays: 5s, 10s, 15s, 20s, 25s
   */
  LINEAR: {
    attempts: 5,
    backoff: { type: 'linear' as const, delay: 5000 },
  },

  /**
   * Fixed delay retry
   * Attempts: 3, Delays: 10s, 10s, 10s
   */
  FIXED: {
    attempts: 3,
    backoff: { type: 'fixed' as const, delay: 10000 },
  },

  /**
   * Exponential with jitter to prevent thundering herd
   * Attempts: 5, Delays: ~2s, ~4s, ~8s, ~16s, ~32s (with 10% randomness)
   */
  EXPONENTIAL_JITTER: {
    attempts: 5,
    backoff: { type: 'exponential-jitter' as const, delay: 2000, jitter: 0.1 },
  },

  /**
   * Fibonacci backoff for balanced growth
   * Attempts: 7, Delays: 1s, 1s, 2s, 3s, 5s, 8s, 13s
   */
  FIBONACCI: {
    attempts: 7,
    backoff: { type: 'fibonacci' as const, delay: 1000 },
  },

  /**
   * Decorrelated jitter (AWS recommended for distributed systems)
   * Attempts: 5, Random delays with optimal distribution
   */
  AWS_DECORRELATED: {
    attempts: 5,
    backoff: { type: 'decorrelated-jitter' as const, delay: 1000, multiplier: 3 },
  },

  /**
   * Full jitter (AWS strategy for maximum randomness)
   * Attempts: 5, Random between 0 and exponential delay
   */
  AWS_FULL_JITTER: {
    attempts: 5,
    backoff: { type: 'full-jitter' as const, delay: 1000, base: 2 },
  },

  /**
   * Equal jitter (AWS strategy balancing predictability)
   * Attempts: 5, Half fixed + half random
   */
  AWS_EQUAL_JITTER: {
    attempts: 5,
    backoff: { type: 'equal-jitter' as const, delay: 1000, base: 2 },
  },

  /**
   * Constant then exponential for initial quick retries
   * Attempts: 7, First 3 at 2s, then exponential starting at 1s
   */
  CONSTANT_THEN_EXPONENTIAL: {
    attempts: 7,
    backoff: {
      type: 'constant-then-exponential' as const,
      constantDelay: 2000,
      constantAttempts: 3,
      exponentialDelay: 1000,
      base: 2,
    },
  },

  /**
   * Stepped backoff for payment processing
   * Attempts: 8, Quick retries then longer delays
   */
  PAYMENT_PROCESSING: {
    attempts: 8,
    backoff: {
      type: 'stepped' as const,
      tiers: [
        { maxAttempt: 3, delay: 1000 }, // First 3: 1s
        { maxAttempt: 5, delay: 5000 }, // Next 2: 5s
        { maxAttempt: Infinity, delay: 30000 }, // Rest: 30s
      ],
    },
  },

  /**
   * API rate limiting strategy
   * Attempts: 5, Tiered delays respecting rate limits
   */
  RATE_LIMITED: {
    attempts: 5,
    backoff: {
      type: 'stepped' as const,
      tiers: [
        { maxAttempt: 2, delay: 5000 }, // First 2: 5s
        { maxAttempt: Infinity, delay: 60000 }, // Rest: 1 minute
      ],
    },
  },

  /**
   * No retry - fail immediately
   */
  NONE: {
    attempts: 1,
    backoff: { type: 'fixed' as const, delay: 0 },
  },
} satisfies Record<string, RetryConfig>;
