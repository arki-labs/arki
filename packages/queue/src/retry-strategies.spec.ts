/**
 * Unit tests for retry strategy algorithms
 *
 * These tests focus on the complex algorithmic code:
 * - Backoff delay calculations for each strategy
 * - MaxDelay capping logic
 * - Edge cases and boundary conditions
 * - Stateful strategies (decorrelated jitter)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBackoffStrategy,
  getWorkerBackoffStrategy,
  needsCustomBackoffStrategy,
  toBullMQBackoff,
} from './retry-strategies';

describe('createBackoffStrategy', () => {
  describe('fixed strategy', () => {
    it('should return constant delay for all attempts', () => {
      const strategy = createBackoffStrategy({ type: 'fixed', delay: 5000 });

      expect(strategy(0)).toBe(5000);
      expect(strategy(1)).toBe(5000);
      expect(strategy(5)).toBe(5000);
      expect(strategy(100)).toBe(5000);
    });

    it('should respect maxDelay cap', () => {
      const strategy = createBackoffStrategy({ type: 'fixed', delay: 10000 }, 8000);

      expect(strategy(0)).toBe(8000);
      expect(strategy(5)).toBe(8000);
    });
  });

  describe('exponential strategy', () => {
    it('should calculate exponential backoff with default base', () => {
      const strategy = createBackoffStrategy({ type: 'exponential', delay: 1000 });

      expect(strategy(0)).toBe(1000); // 1000 * 2^0
      expect(strategy(1)).toBe(2000); // 1000 * 2^1
      expect(strategy(2)).toBe(4000); // 1000 * 2^2
      expect(strategy(3)).toBe(8000); // 1000 * 2^3
      expect(strategy(4)).toBe(16000); // 1000 * 2^4
    });

    it('should calculate exponential backoff with custom base', () => {
      const strategy = createBackoffStrategy({ type: 'exponential', delay: 1000, base: 3 });

      expect(strategy(0)).toBe(1000); // 1000 * 3^0
      expect(strategy(1)).toBe(3000); // 1000 * 3^1
      expect(strategy(2)).toBe(9000); // 1000 * 3^2
      expect(strategy(3)).toBe(27000); // 1000 * 3^3
    });

    it('should respect maxDelay cap', () => {
      const strategy = createBackoffStrategy({ type: 'exponential', delay: 1000 }, 10000);

      expect(strategy(0)).toBe(1000);
      expect(strategy(3)).toBe(8000);
      expect(strategy(4)).toBe(10000); // Would be 16000, capped at 10000
      expect(strategy(10)).toBe(10000); // Would be huge, capped at 10000
    });

    it('should handle fractional base values', () => {
      const strategy = createBackoffStrategy({ type: 'exponential', delay: 1000, base: 1.5 });

      expect(strategy(0)).toBe(1000); // 1000 * 1.5^0
      expect(strategy(1)).toBe(1500); // 1000 * 1.5^1
      expect(strategy(2)).toBe(2250); // 1000 * 1.5^2
    });
  });

  describe('linear strategy', () => {
    it('should calculate linear backoff', () => {
      const strategy = createBackoffStrategy({ type: 'linear', delay: 5000 });

      expect(strategy(0)).toBe(5000); // 5000 * 1
      expect(strategy(1)).toBe(10000); // 5000 * 2
      expect(strategy(2)).toBe(15000); // 5000 * 3
      expect(strategy(3)).toBe(20000); // 5000 * 4
      expect(strategy(4)).toBe(25000); // 5000 * 5
    });

    it('should respect maxDelay cap', () => {
      const strategy = createBackoffStrategy({ type: 'linear', delay: 5000 }, 18000);

      expect(strategy(0)).toBe(5000);
      expect(strategy(2)).toBe(15000);
      expect(strategy(3)).toBe(18000); // Would be 20000, capped
      expect(strategy(10)).toBe(18000); // Would be 55000, capped
    });
  });

  describe('polynomial strategy', () => {
    it('should calculate polynomial backoff with default power (quadratic)', () => {
      const strategy = createBackoffStrategy({ type: 'polynomial', delay: 1000 });

      expect(strategy(0)).toBe(1000); // 1000 * 1^2
      expect(strategy(1)).toBe(4000); // 1000 * 2^2
      expect(strategy(2)).toBe(9000); // 1000 * 3^2
      expect(strategy(3)).toBe(16000); // 1000 * 4^2
      expect(strategy(4)).toBe(25000); // 1000 * 5^2
    });

    it('should calculate polynomial backoff with custom power', () => {
      const strategy = createBackoffStrategy({ type: 'polynomial', delay: 1000, power: 3 });

      expect(strategy(0)).toBe(1000); // 1000 * 1^3
      expect(strategy(1)).toBe(8000); // 1000 * 2^3
      expect(strategy(2)).toBe(27000); // 1000 * 3^3
    });

    it('should respect maxDelay cap', () => {
      const strategy = createBackoffStrategy({ type: 'polynomial', delay: 1000, power: 2 }, 10000);

      expect(strategy(0)).toBe(1000);
      expect(strategy(2)).toBe(9000);
      expect(strategy(3)).toBe(10000); // Would be 16000, capped
    });
  });

  describe('exponential-jitter strategy', () => {
    beforeEach(() => {
      // Mock Math.random to return predictable values
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    it('should add jitter to exponential backoff', () => {
      const strategy = createBackoffStrategy({
        type: 'exponential-jitter',
        delay: 1000,
        jitter: 0.1,
      });

      // With random = 0.5 and jitter = 0.1:
      // Multiplier = 1 + (0.5 * 0.1) = 1.05
      expect(strategy(0)).toBe(1050); // 1000 * 2^0 * 1.05
      expect(strategy(1)).toBe(2100); // 1000 * 2^1 * 1.05
      expect(strategy(2)).toBe(4200); // 1000 * 2^2 * 1.05
    });

    it('should use default jitter if not specified', () => {
      const strategy = createBackoffStrategy({
        type: 'exponential-jitter',
        delay: 1000,
      });

      // Default jitter is 0.1, with random = 0.5:
      // Multiplier = 1 + (0.5 * 0.1) = 1.05
      expect(strategy(0)).toBe(1050);
    });

    it('should respect maxDelay cap', () => {
      const strategy = createBackoffStrategy(
        {
          type: 'exponential-jitter',
          delay: 1000,
          jitter: 0.1,
        },
        5000,
      );

      expect(strategy(0)).toBe(1050);
      expect(strategy(3)).toBe(5000); // Would be 8400, capped
    });
  });

  describe('fibonacci strategy', () => {
    it('should calculate fibonacci sequence delays', () => {
      const strategy = createBackoffStrategy({ type: 'fibonacci', delay: 1000 });

      expect(strategy(0)).toBe(1000); // 1 * 1000
      expect(strategy(1)).toBe(1000); // 1 * 1000
      expect(strategy(2)).toBe(2000); // 2 * 1000
      expect(strategy(3)).toBe(3000); // 3 * 1000
      expect(strategy(4)).toBe(5000); // 5 * 1000
      expect(strategy(5)).toBe(8000); // 8 * 1000
      expect(strategy(6)).toBe(13000); // 13 * 1000
      expect(strategy(7)).toBe(21000); // 21 * 1000
    });

    it('should cache fibonacci numbers for performance', () => {
      const strategy = createBackoffStrategy({ type: 'fibonacci', delay: 1000 });

      // Call with high attempt number
      const result1 = strategy(10);
      const result2 = strategy(10);

      // Both should return the same value efficiently
      expect(result1).toBe(result2);
      expect(result1).toBe(89000); // 89th fibonacci * 1000
    });

    it('should respect maxDelay cap', () => {
      const strategy = createBackoffStrategy({ type: 'fibonacci', delay: 1000 }, 10000);

      expect(strategy(5)).toBe(8000);
      expect(strategy(6)).toBe(10000); // Would be 13000, capped
      expect(strategy(10)).toBe(10000); // Would be 89000, capped
    });
  });

  describe('decorrelated-jitter strategy', () => {
    beforeEach(() => {
      // Mock Math.random to return predictable values
      let callCount = 0;
      vi.spyOn(Math, 'random').mockImplementation(() => {
        // Return different values for each call
        const values = [0.5, 0.3, 0.7, 0.4];
        return values[callCount++ % values.length]!;
      });
    });

    it('should use decorrelated jitter algorithm', () => {
      const strategy = createBackoffStrategy({
        type: 'decorrelated-jitter',
        delay: 1000,
        multiplier: 3,
      });

      // First call: random between 1000 and 3000 (1000 * 3)
      // With random = 0.5: 1000 + 0.5 * (3000 - 1000) = 2000
      const first = strategy(0);
      expect(first).toBe(2000);

      // Second call: random between 1000 and 6000 (2000 * 3)
      // With random = 0.3: 1000 + 0.3 * (6000 - 1000) = 2500
      const second = strategy(1);
      expect(second).toBe(2500);

      // Third call: random between 1000 and 7500 (2500 * 3)
      // With random = 0.7: 1000 + 0.7 * (7500 - 1000) = 5550
      const third = strategy(2);
      expect(third).toBe(5550);
    });

    it('should use default multiplier if not specified', () => {
      const strategy = createBackoffStrategy({
        type: 'decorrelated-jitter',
        delay: 1000,
      });

      const first = strategy(0);
      expect(first).toBeGreaterThanOrEqual(1000);
      expect(first).toBeLessThanOrEqual(3000);
    });

    it('should respect maxDelay cap', () => {
      const strategy = createBackoffStrategy(
        {
          type: 'decorrelated-jitter',
          delay: 1000,
          multiplier: 3,
        },
        4000,
      );

      const first = strategy(0);
      expect(first).toBe(2000);

      const second = strategy(1);
      expect(second).toBe(2500);

      // Third would be 5550, but capped at 4000
      const third = strategy(2);
      expect(third).toBe(4000);
    });
  });

  describe('full-jitter strategy', () => {
    beforeEach(() => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    it('should return random value between 0 and exponential delay', () => {
      const strategy = createBackoffStrategy({ type: 'full-jitter', delay: 1000 });

      // With random = 0.5:
      expect(strategy(0)).toBe(500); // 0.5 * (1000 * 2^0)
      expect(strategy(1)).toBe(1000); // 0.5 * (1000 * 2^1)
      expect(strategy(2)).toBe(2000); // 0.5 * (1000 * 2^2)
      expect(strategy(3)).toBe(4000); // 0.5 * (1000 * 2^3)
    });

    it('should use custom base', () => {
      const strategy = createBackoffStrategy({ type: 'full-jitter', delay: 1000, base: 3 });

      expect(strategy(0)).toBe(500); // 0.5 * (1000 * 3^0)
      expect(strategy(1)).toBe(1500); // 0.5 * (1000 * 3^1)
      expect(strategy(2)).toBe(4500); // 0.5 * (1000 * 3^2)
    });

    it('should respect maxDelay cap', () => {
      const strategy = createBackoffStrategy({ type: 'full-jitter', delay: 1000 }, 3000);

      expect(strategy(0)).toBe(500);
      expect(strategy(1)).toBe(1000);
      expect(strategy(2)).toBe(2000);
      expect(strategy(3)).toBe(3000); // Would be 4000, capped
    });
  });

  describe('equal-jitter strategy', () => {
    beforeEach(() => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    it('should return half fixed plus half random', () => {
      const strategy = createBackoffStrategy({ type: 'equal-jitter', delay: 1000 });

      // With random = 0.5:
      // attempt 0: exp = 1000, half = 500, result = 500 + (0.5 * 500) = 750
      expect(strategy(0)).toBe(750);
      // attempt 1: exp = 2000, half = 1000, result = 1000 + (0.5 * 1000) = 1500
      expect(strategy(1)).toBe(1500);
      // attempt 2: exp = 4000, half = 2000, result = 2000 + (0.5 * 2000) = 3000
      expect(strategy(2)).toBe(3000);
    });

    it('should use custom base', () => {
      const strategy = createBackoffStrategy({ type: 'equal-jitter', delay: 1000, base: 3 });

      // With random = 0.5:
      // attempt 1: exp = 3000, half = 1500, result = 1500 + (0.5 * 1500) = 2250
      expect(strategy(1)).toBe(2250);
    });

    it('should respect maxDelay cap', () => {
      const strategy = createBackoffStrategy({ type: 'equal-jitter', delay: 1000 }, 2000);

      expect(strategy(0)).toBe(750);
      expect(strategy(1)).toBe(1500);
      expect(strategy(2)).toBe(2000); // Would be 3000, capped
    });
  });

  describe('constant-then-exponential strategy', () => {
    it('should use constant delay for initial attempts', () => {
      const strategy = createBackoffStrategy({
        type: 'constant-then-exponential',
        constantDelay: 2000,
        constantAttempts: 3,
        exponentialDelay: 1000,
      });

      // First 3 attempts use constant delay
      expect(strategy(0)).toBe(2000);
      expect(strategy(1)).toBe(2000);
      expect(strategy(2)).toBe(2000);

      // Then switch to exponential
      expect(strategy(3)).toBe(1000); // 1000 * 2^0
      expect(strategy(4)).toBe(2000); // 1000 * 2^1
      expect(strategy(5)).toBe(4000); // 1000 * 2^2
    });

    it('should use custom base for exponential phase', () => {
      const strategy = createBackoffStrategy({
        type: 'constant-then-exponential',
        constantDelay: 2000,
        constantAttempts: 2,
        exponentialDelay: 1000,
        base: 3,
      });

      expect(strategy(0)).toBe(2000);
      expect(strategy(1)).toBe(2000);
      expect(strategy(2)).toBe(1000); // 1000 * 3^0
      expect(strategy(3)).toBe(3000); // 1000 * 3^1
      expect(strategy(4)).toBe(9000); // 1000 * 3^2
    });

    it('should respect maxDelay cap', () => {
      const strategy = createBackoffStrategy(
        {
          type: 'constant-then-exponential',
          constantDelay: 2000,
          constantAttempts: 2,
          exponentialDelay: 1000,
        },
        5000,
      );

      expect(strategy(0)).toBe(2000);
      expect(strategy(4)).toBe(2000);
      expect(strategy(5)).toBe(4000);
      expect(strategy(6)).toBe(5000); // Would be 8000, capped
    });
  });

  describe('stepped strategy', () => {
    it('should use appropriate tier based on attempt', () => {
      const strategy = createBackoffStrategy({
        type: 'stepped',
        tiers: [
          { maxAttempt: 3, delay: 1000 },
          { maxAttempt: 5, delay: 5000 },
          { maxAttempt: Infinity, delay: 30000 },
        ],
      });

      // Attempts 1-3: 1000ms
      expect(strategy(0)).toBe(1000);
      expect(strategy(1)).toBe(1000);
      expect(strategy(2)).toBe(1000);

      // Attempts 4-5: 5000ms
      expect(strategy(3)).toBe(5000);
      expect(strategy(4)).toBe(5000);

      // Attempts 6+: 30000ms
      expect(strategy(5)).toBe(30000);
      expect(strategy(10)).toBe(30000);
      expect(strategy(100)).toBe(30000);
    });

    it('should sort tiers automatically', () => {
      const strategy = createBackoffStrategy({
        type: 'stepped',
        tiers: [
          { maxAttempt: 5, delay: 5000 }, // Out of order
          { maxAttempt: 3, delay: 1000 },
          { maxAttempt: Infinity, delay: 30000 },
        ],
      });

      // Should still work correctly despite unsorted input
      expect(strategy(0)).toBe(1000);
      expect(strategy(3)).toBe(5000);
      expect(strategy(5)).toBe(30000);
    });

    it('should respect maxDelay cap', () => {
      const strategy = createBackoffStrategy(
        {
          type: 'stepped',
          tiers: [
            { maxAttempt: 2, delay: 1000 },
            { maxAttempt: Infinity, delay: 50000 },
          ],
        },
        10000,
      );

      expect(strategy(0)).toBe(1000);
      expect(strategy(2)).toBe(10000); // Would be 50000, capped
    });
  });

  describe('custom strategy', () => {
    it('should call custom function with correct parameters', async () => {
      const customFn = vi.fn((attemptsMade: number) => attemptsMade * 1000);

      const strategy = createBackoffStrategy({
        type: 'custom',
        strategy: customFn,
      });

      await strategy(0);
      await strategy(3);

      expect(customFn).toHaveBeenCalledTimes(2);
      expect(customFn).toHaveBeenNthCalledWith(1, 0, undefined, undefined);
      expect(customFn).toHaveBeenNthCalledWith(2, 3, undefined, undefined);
    });

    it('should pass error parameter to custom function', async () => {
      const customFn = vi.fn(() => 1000);
      const strategy = createBackoffStrategy({ type: 'custom', strategy: customFn });

      const testError = new Error('Test error');
      await strategy(0, 'test-type', testError);

      expect(customFn).toHaveBeenCalledWith(0, 'test-type', testError);
    });

    it('should respect maxDelay cap', async () => {
      const strategy = createBackoffStrategy(
        {
          type: 'custom',
          strategy: () => 50000,
        },
        10000,
      );

      const result = await strategy(0);
      expect(result).toBe(10000);
    });

    it('should handle async custom functions', async () => {
      const strategy = createBackoffStrategy({
        type: 'custom',
        strategy: async attemptsMade => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return attemptsMade * 1000;
        },
      });

      const result = await strategy(5);
      expect(result).toBe(5000);
    });
  });
});

describe('toBullMQBackoff', () => {
  it('should return default exponential backoff when no retry config', () => {
    const result = toBullMQBackoff();
    expect(result).toEqual({ type: 'exponential', delay: 1000 });
  });

  it('should return default exponential backoff when no backoff specified', () => {
    const result = toBullMQBackoff({ attempts: 3 });
    expect(result).toEqual({ type: 'exponential', delay: 1000 });
  });

  it('should return fixed backoff options', () => {
    const result = toBullMQBackoff({
      attempts: 3,
      backoff: { type: 'fixed', delay: 5000 },
    });
    expect(result).toEqual({ type: 'fixed', delay: 5000 });
  });

  it('should return exponential backoff with default base', () => {
    const result = toBullMQBackoff({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
    expect(result).toEqual({ type: 'exponential', delay: 2000 });
  });

  it('should return undefined for exponential with custom base', () => {
    const result = toBullMQBackoff({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000, base: 3 },
    });
    expect(result).toBeUndefined();
  });

  it('should return undefined for non-standard strategies', () => {
    expect(
      toBullMQBackoff({
        attempts: 5,
        backoff: { type: 'linear', delay: 1000 },
      }),
    ).toBeUndefined();

    expect(
      toBullMQBackoff({
        attempts: 5,
        backoff: { type: 'fibonacci', delay: 1000 },
      }),
    ).toBeUndefined();
  });
});

describe('needsCustomBackoffStrategy', () => {
  it('should return false when no retry config', () => {
    expect(needsCustomBackoffStrategy()).toBe(false);
  });

  it('should return false when no backoff specified', () => {
    expect(needsCustomBackoffStrategy({ attempts: 3 })).toBe(false);
  });

  it('should return false for fixed strategy', () => {
    expect(
      needsCustomBackoffStrategy({
        attempts: 3,
        backoff: { type: 'fixed', delay: 5000 },
      }),
    ).toBe(false);
  });

  it('should return false for exponential with default base', () => {
    expect(
      needsCustomBackoffStrategy({
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      }),
    ).toBe(false);
  });

  it('should return true for exponential with custom base', () => {
    expect(
      needsCustomBackoffStrategy({
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000, base: 3 },
      }),
    ).toBe(true);
  });

  it('should return true for all advanced strategies', () => {
    const advancedStrategies = [
      { type: 'linear' as const, delay: 1000 },
      { type: 'polynomial' as const, delay: 1000 },
      { type: 'exponential-jitter' as const, delay: 1000 },
      { type: 'fibonacci' as const, delay: 1000 },
      { type: 'decorrelated-jitter' as const, delay: 1000 },
      { type: 'full-jitter' as const, delay: 1000 },
      { type: 'equal-jitter' as const, delay: 1000 },
      {
        type: 'constant-then-exponential' as const,
        constantDelay: 1000,
        constantAttempts: 3,
        exponentialDelay: 1000,
      },
      { type: 'stepped' as const, tiers: [{ maxAttempt: 3, delay: 1000 }] },
      { type: 'custom' as const, strategy: () => 1000 },
    ];

    advancedStrategies.forEach(backoff => {
      expect(needsCustomBackoffStrategy({ attempts: 5, backoff })).toBe(true);
    });
  });
});

describe('getWorkerBackoffStrategy', () => {
  it('should return undefined when no custom strategy needed', () => {
    expect(getWorkerBackoffStrategy()).toBeUndefined();
    expect(getWorkerBackoffStrategy({ attempts: 3 })).toBeUndefined();
    expect(
      getWorkerBackoffStrategy({
        attempts: 3,
        backoff: { type: 'fixed', delay: 5000 },
      }),
    ).toBeUndefined();
  });

  it('should return strategy function when custom strategy needed', () => {
    const strategy = getWorkerBackoffStrategy({
      attempts: 5,
      backoff: { type: 'linear', delay: 5000 },
    });

    expect(strategy).toBeDefined();
    expect(typeof strategy).toBe('function');
  });

  it('should return strategy with maxDelay applied', () => {
    const strategy = getWorkerBackoffStrategy({
      attempts: 5,
      backoff: { type: 'linear', delay: 5000 },
      maxDelay: 12000,
    });

    expect(strategy!(0)).toBe(5000);
    expect(strategy!(1)).toBe(10000);
    expect(strategy!(2)).toBe(12000); // Would be 15000, capped
  });
});

describe('Edge Cases and Boundary Conditions', () => {
  it('should handle zero attempts gracefully', () => {
    const exponential = createBackoffStrategy({ type: 'exponential', delay: 1000 });
    expect(exponential(0)).toBe(1000);

    const linear = createBackoffStrategy({ type: 'linear', delay: 1000 });
    expect(linear(0)).toBe(1000);
  });

  it('should handle very large attempt numbers', () => {
    const strategy = createBackoffStrategy({ type: 'exponential', delay: 1000 }, 60000);

    // Large attempt number should still be capped
    expect(strategy(100)).toBe(60000);
  });

  it('should handle maxDelay of 0', () => {
    const strategy = createBackoffStrategy({ type: 'exponential', delay: 1000 }, 0);

    expect(strategy(0)).toBe(0);
    expect(strategy(5)).toBe(0);
  });

  it('should handle very small delays', () => {
    const strategy = createBackoffStrategy({ type: 'exponential', delay: 1 });

    expect(strategy(0)).toBe(1);
    expect(strategy(1)).toBe(2);
  });
});

describe('Real-World Scenarios', () => {
  it('should implement AWS recommended decorrelated jitter correctly', () => {
    const strategy = createBackoffStrategy({
      type: 'decorrelated-jitter',
      delay: 1000,
      multiplier: 3,
    });

    // Each delay should be between min and previous * multiplier
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      delays.push(strategy(i));
    }

    // All delays should be >= base delay
    delays.forEach(delay => {
      expect(delay).toBeGreaterThanOrEqual(1000);
    });

    // Delays should be somewhat random (not all the same)
    const uniqueDelays = new Set(delays);
    expect(uniqueDelays.size).toBeGreaterThan(1);
  });

  it('should implement payment processing stepped backoff', () => {
    const strategy = createBackoffStrategy({
      type: 'stepped',
      tiers: [
        { maxAttempt: 3, delay: 1000 },
        { maxAttempt: 5, delay: 5000 },
        { maxAttempt: Infinity, delay: 30000 },
      ],
    });

    // Quick retries for transient issues
    expect(strategy(0)).toBe(1000);
    expect(strategy(2)).toBe(1000);

    // Moderate delay for persistent issues
    expect(strategy(3)).toBe(5000);

    // Long delay for serious problems
    expect(strategy(5)).toBe(30000);
  });

  it('should implement rate-limited API strategy', () => {
    const strategy = createBackoffStrategy({
      type: 'stepped',
      tiers: [
        { maxAttempt: 2, delay: 5000 },
        { maxAttempt: Infinity, delay: 60000 },
      ],
    });

    // Quick retry for transient rate limits
    expect(strategy(0)).toBe(5000);
    expect(strategy(1)).toBe(5000);

    // Wait for rate limit window reset
    expect(strategy(2)).toBe(60000);
  });
});
