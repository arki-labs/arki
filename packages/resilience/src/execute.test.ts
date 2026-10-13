import { describe, expect, it } from 'vitest';

import {
  createCircuitBreakerPolicy,
  createRetryPolicy,
  isBrokenCircuitError,
  withCircuitBreaker,
  withResilience,
  withRetry,
  withTimeout,
} from './index.js';

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

describe('execution helpers', () => {
  it('withRetry retries a failed call and returns the later success', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls += 1;
        if (calls === 1) throw new Error('first call fails');
        return 'ok';
      },
      { maxAttempts: 2, initialDelay: 1, maxDelay: 2 },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('withTimeout rejects when the call outlives the deadline', async () => {
    await expect(
      withTimeout(
        async () => {
          await wait(200);
          return 'late';
        },
        { timeoutMs: 10 },
      ),
    ).rejects.toThrow();
  });

  it('withResilience runs the call through the given policy', async () => {
    const policy = createRetryPolicy({ maxAttempts: 1, initialDelay: 1, maxDelay: 2 });

    await expect(withResilience(() => 42, policy)).resolves.toBe(42);
  });

  it('a reused circuit breaker opens and stops calling the failing function', async () => {
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 2 });
    let calls = 0;
    const failing = (): never => {
      calls += 1;
      throw new Error('downstream down');
    };

    await expect(withResilience(failing, breaker)).rejects.toThrow('downstream down');
    await expect(withResilience(failing, breaker)).rejects.toThrow('downstream down');
    const third = await withResilience(failing, breaker).catch((error: unknown) => error);

    expect(isBrokenCircuitError(third)).toBe(true);
    expect(calls).toBe(2);
  });

  it('withCircuitBreaker never opens because each call builds a fresh breaker', async () => {
    let calls = 0;
    const failing = (): never => {
      calls += 1;
      throw new Error('downstream down');
    };

    await expect(withCircuitBreaker(failing, { consecutiveFailures: 2 })).rejects.toThrow('downstream down');
    await expect(withCircuitBreaker(failing, { consecutiveFailures: 2 })).rejects.toThrow('downstream down');
    await expect(withCircuitBreaker(failing, { consecutiveFailures: 2 })).rejects.toThrow('downstream down');

    expect(calls).toBe(3);
  });
});
