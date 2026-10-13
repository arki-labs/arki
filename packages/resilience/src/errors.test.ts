import { describe, expect, it } from 'vitest';

import {
  BulkheadRejectedError,
  CancelledError,
  CircuitOpenError,
  createBulkheadPolicy,
  createCircuitBreakerPolicy,
  createTimeoutPolicy,
  isBrokenCircuitError,
  isBulkheadRejectedError,
  isResilienceError,
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
