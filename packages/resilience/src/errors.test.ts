import { describe, expect, it } from 'vitest';

import {
  BulkheadRejectedError,
  CancelledError,
  CircuitOpenError,
  createBulkheadPolicy,
  createCircuitBreakerPolicy,
  createTimeoutPolicy,
  InvalidBackoffError,
  isBrokenCircuitError,
  isBulkheadRejectedError,
  isResilienceError,
  RESILIENCE_ERROR_CODES,
  ResilienceError,
  RetriesExhaustedError,
  TimeoutError,
} from './index.js';

async function circuitOpenError(): Promise<unknown> {
  const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1 });
  await breaker
    .execute(() => {
      throw new Error('down');
    })
    .catch(ignore);
  return breaker.execute(() => 'x').catch((error: unknown) => error);
}

async function timeoutError(): Promise<unknown> {
  return createTimeoutPolicy({ timeoutMs: 1 })
    .execute(() => never())
    .catch((error: unknown) => error);
}

async function bulkheadError(): Promise<unknown> {
  const bulkhead = createBulkheadPolicy({ maxConcurrent: 1, maxQueue: 0 });
  const hold = bulkhead.execute(() => never());
  const error = await bulkhead.execute(() => 'x').catch((error_: unknown) => error_);
  void hold;
  return error;
}

const ignore = (): void => {
  // intentionally pending forever
};
const never = () => new Promise<never>(ignore);

describe('error predicates', () => {
  it('isResilienceError recognises every error the policies raise themselves', async () => {
    expect(isResilienceError(await circuitOpenError())).toBe(true);
    expect(isResilienceError(await timeoutError())).toBe(true);
    expect(isResilienceError(await bulkheadError())).toBe(true);
    expect(isResilienceError(new RetriesExhaustedError(3, new Error('last')))).toBe(true);
    expect(isResilienceError(new CircuitOpenError())).toBe(true);
    expect(isResilienceError(new TimeoutError())).toBe(true);
    expect(isResilienceError(new CancelledError())).toBe(true);
    expect(isResilienceError(new BulkheadRejectedError())).toBe(true);
  });

  it('keeps the engine error as cause and names each error after its class', async () => {
    const circuit = await circuitOpenError();
    const timeout = await timeoutError();
    const bulkhead = await bulkheadError();

    for (const [error, name] of [
      [circuit, 'CircuitOpenError'],
      [timeout, 'TimeoutError'],
      [bulkhead, 'BulkheadRejectedError'],
    ] as const) {
      expect(error).toBeInstanceOf(ResilienceError);
      expect(error).toMatchObject({ name, cause: expect.any(Error) });
    }
    expect(timeout).toMatchObject({ message: 'Operation timed out after 1ms' });
  });

  it('isResilienceError rejects plain errors and non-errors', () => {
    const plain: unknown[] = [new Error('mine'), 'text', undefined, null];
    expect(plain.map(value => isResilienceError(value))).toEqual([false, false, false, false]);
  });

  it('isBrokenCircuitError and isBulkheadRejectedError each match only their own error', async () => {
    const circuit = await circuitOpenError();
    const bulkhead = await bulkheadError();
    const timeout = await timeoutError();

    expect(isBrokenCircuitError(circuit)).toBe(true);
    expect(isBrokenCircuitError(bulkhead)).toBe(false);
    expect(isBrokenCircuitError(timeout)).toBe(false);
    expect(isBulkheadRejectedError(bulkhead)).toBe(true);
    expect(isBulkheadRejectedError(circuit)).toBe(false);
    expect(isBulkheadRejectedError(timeout)).toBe(false);
    expect(timeout).toBeInstanceOf(TimeoutError);
    expect(circuit).toBeInstanceOf(CircuitOpenError);
  });

  it('RetriesExhaustedError carries the attempt count and the last error', () => {
    const last = new Error('last');
    const error = new RetriesExhaustedError(3, last);

    expect(error.name).toBe('RetriesExhaustedError');
    expect(error.attempts).toBe(3);
    expect(error.lastError).toBe(last);
    expect(error.message).toBe('All 3 retry attempts exhausted: last');
  });
});

describe('error codes', () => {
  it('gives each failure its own stable code, so callers can branch on it instead of the message', async () => {
    expect(await circuitOpenError()).toMatchObject({ code: 'ARKI_RESILIENCE_E001' });
    expect(await timeoutError()).toMatchObject({ code: 'ARKI_RESILIENCE_E002' });
    expect(new CancelledError()).toMatchObject({ code: 'ARKI_RESILIENCE_E003' });
    expect(new BulkheadRejectedError()).toMatchObject({ code: 'ARKI_RESILIENCE_E004' });
    expect(new RetriesExhaustedError(3)).toMatchObject({ code: 'ARKI_RESILIENCE_E005' });
    expect(new InvalidBackoffError('bad')).toMatchObject({ code: 'ARKI_RESILIENCE_E006' });
  });

  it('lists every code once and attaches a remediation to each error', () => {
    expect(Object.values(RESILIENCE_ERROR_CODES)).toHaveLength(6);
    for (const error of [
      new CircuitOpenError(),
      new TimeoutError(),
      new CancelledError(),
      new BulkheadRejectedError(),
      new RetriesExhaustedError(1),
      new InvalidBackoffError('bad'),
    ]) {
      expect(error.remediation.length).toBeGreaterThan(0);
    }
  });
});
