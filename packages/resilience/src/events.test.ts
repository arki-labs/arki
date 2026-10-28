import { afterEach, describe, expect, it, vi } from 'vitest';

import { orThrow, UnexpectedDefect } from '@arki/failure';

import type { PolicyLogger } from './index.js';
import {
  attachPolicyLogger,
  backoff,
  createCircuitBreakerPolicy,
  createResiliencePolicy,
  createRetryPolicy,
  createTimeoutPolicy,
} from './index.js';

type Entry = { level: 'info' | 'warn' | 'error'; message: string; context: Record<string, unknown> | undefined };

function recorder() {
  const entries: Entry[] = [];
  const logger: PolicyLogger = {
    info: (message, context) => entries.push({ level: 'info', message, context }),
    warn: (message, context) => entries.push({ level: 'warn', message, context }),
    error: (message, context) => entries.push({ level: 'error', message, context }),
  };
  return { entries, logger };
}

const ignore = (): void => {
  // intentionally pending forever
};
const never = () => new Promise<never>(ignore);

describe('attachPolicyLogger', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs each retry, the give-up and the final failure of a retry policy', async () => {
    vi.useFakeTimers();
    const policy = createRetryPolicy({ backoff: backoff.exponential({ base: 1, max: 2 }).upTo(2) });
    const { entries, logger } = recorder();
    attachPolicyLogger(policy, logger, 'api');

    const call = policy.execute(() => {
      throw new Error('boom');
    });
    const result = call.catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    await result;

    expect(entries.map(e => [e.level, e.message])).toEqual([
      ['error', '[api] Operation failed'],
      ['warn', '[api] Retry attempt'],
      ['error', '[api] Operation failed'],
      ['warn', '[api] Retry attempt'],
      ['error', '[api] Operation failed'],
      ['error', '[api] All retries exhausted'],
    ]);
    expect(entries[1]?.context).toMatchObject({ attempt: 1 });
    expect(typeof entries[1]?.context?.delay).toBe('number');
    expect(entries[0]?.context).toMatchObject({ error: UnexpectedDefect.code });
    expect(typeof entries[0]?.context?.durationMs).toBe('number');
    expect(entries[5]?.context).toEqual({ error: UnexpectedDefect.code });
  });

  it('logs a success with its duration', async () => {
    const policy = createRetryPolicy();
    const { entries, logger } = recorder();
    attachPolicyLogger(policy, logger);

    orThrow(await policy.execute(() => 'ok'));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe('[resilience] Operation succeeded');
    expect(typeof entries[0]?.context?.durationMs).toBe('number');
  });

  it('logs the breaker opening, going half-open and closing', async () => {
    vi.useFakeTimers();
    const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1, halfOpenAfter: 100 });
    const { entries, logger } = recorder();
    attachPolicyLogger(breaker, logger, 'db');

    expect(
      UnexpectedDefect.is(
        await breaker.execute(() => {
          throw new Error('down');
        }),
      ),
    ).toBe(true);
    vi.advanceTimersByTime(100);
    orThrow(await breaker.execute(() => 'up'));

    expect(entries.map(e => [e.level, e.message])).toEqual([
      ['error', '[db] Operation failed'],
      ['error', '[db] Circuit breaker opened'],
      ['info', '[db] Circuit breaker half-open'],
      ['info', '[db] Operation succeeded'],
      ['info', '[db] Circuit breaker closed'],
    ]);
    expect(entries[1]?.context).toEqual({ error: UnexpectedDefect.code });
  });

  it('logs a timeout', async () => {
    vi.useFakeTimers();
    const policy = createTimeoutPolicy({ timeoutMs: 10 });
    const { entries, logger } = recorder();
    attachPolicyLogger(policy, logger);

    const call = policy.execute(() => never());
    const result = call.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    await result;

    expect(entries.map(e => e.message)).toEqual(['[resilience] Operation timed out', '[resilience] Operation failed']);
  });

  it('logs only success and failure for a composed policy', async () => {
    vi.useFakeTimers();
    const policy = createResiliencePolicy({ retry: backoff.exponential({ base: 1, max: 2 }).upTo(1) });
    const { entries, logger } = recorder();
    attachPolicyLogger(policy, logger);

    orThrow(await policy.execute(() => 'ok'));
    const call = policy.execute(() => {
      throw new Error('bad');
    });
    const result = call.catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    await result;

    expect(entries.map(e => e.message)).toEqual([
      '[resilience] Operation succeeded',
      '[resilience] Operation failed',
      '[resilience] Operation failed',
    ]);
  });

  it('stops logging once the returned cleanup runs', async () => {
    const policy = createRetryPolicy();
    const { entries, logger } = recorder();
    const detach = attachPolicyLogger(policy, logger);

    orThrow(await policy.execute(() => 'one'));
    detach();
    orThrow(await policy.execute(() => 'two'));

    expect(entries).toHaveLength(1);
  });
});
