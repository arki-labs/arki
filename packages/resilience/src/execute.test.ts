import { describe, expect, it } from 'vitest';

import type { Policy } from './index.js';
import {
  backoff,
  createCircuitBreakerPolicy,
  createRetryPolicy,
  CircuitOpen,
  noop,
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
      { backoff: backoff.exponential({ base: 1, max: 2 }).upTo(2) },
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
    ).resolves.toMatchObject({ code: 'resilience.timeout' });
  });

  it('withResilience runs the call through the given policy', async () => {
    const policy = createRetryPolicy({ backoff: backoff.exponential({ base: 1, max: 2 }).upTo(1) });

    await expect(withResilience(() => 42, policy)).resolves.toBe(42);
  });

  // withResilience returns the policy's promise directly (no async wrapper), so a policy that throws
  // synchronously must still reach the caller as a rejection, never as a synchronous throw.
  it('withResilience turns a synchronous throw from the policy into a defect', async () => {
    const thrown = new Error('policy broke');
    const broken: Policy = {
      onSuccess: noop.onSuccess,
      onFailure: noop.onFailure,
      execute() {
        throw thrown;
      },
    };

    let call: Promise<unknown> | undefined;
    expect(() => {
      call = withResilience(() => 1, broken);
    }).not.toThrow();
    await expect(call).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: thrown });
  });

  it('a reused circuit breaker opens and stops calling the failing function', async () => {
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 2 });
    let calls = 0;
    const failing = (): never => {
      calls += 1;
      throw new Error('downstream down');
    };

    await expect(withResilience(failing, breaker)).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: new Error('downstream down') });
    await expect(withResilience(failing, breaker)).resolves.toMatchObject({ code: 'failure.unexpected_defect', cause: new Error('downstream down') });
    const third = await withResilience(failing, breaker).catch((error: unknown) => error);

    expect(CircuitOpen.is(third)).toBe(true);
    expect(calls).toBe(2);
  });
});
