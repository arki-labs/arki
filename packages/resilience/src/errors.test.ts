import { expect, expectTypeOf, it } from 'vitest';
import { isFailure, UnexpectedDefect } from '@arki/failure';
import type { CircuitFailure, TimeoutFailure, BulkheadFailure, ResilienceFailure, ExecutionFailure, CIRCUIT_FAILURES, TIMEOUT_FAILURES, BULKHEAD_FAILURES } from './index.js';
import {
  CircuitOpen, Timeout, Cancelled, BulkheadRejected, InvalidBackoffError, ResilienceError,
  RESILIENCE_ERROR_CODES, EXECUTION_FAILURES, RESILIENCE_FAILURES,
} from './index.js';

it('owned outcomes use canonical definitions and keep private causes off the wire', () => {
  for (const definition of [CircuitOpen, Timeout, Cancelled, BulkheadRejected]) {
    const cause = new Error('private cause');
    const value = definition({ cause });
    expect(definition.is(value)).toBe(true);
    expect(isFailure(value)).toBe(true);
    expect(value.cause).toBe(cause);
    expect(JSON.stringify(value)).not.toContain('private cause');
    expect(definition.is(new Error(value.code))).toBe(false);
  }
  expect(CircuitOpen.is(Timeout())).toBe(false);
  expect(BulkheadRejected.is(CircuitOpen())).toBe(false);
});

it('failure admission retains the original definitions and exact types', () => {
  expectTypeOf<ExecutionFailure>().toEqualTypeOf<ReturnType<(typeof EXECUTION_FAILURES)[number]>>();
  expectTypeOf<CircuitFailure>().toEqualTypeOf<ReturnType<(typeof CIRCUIT_FAILURES)[number]>>();
  expectTypeOf<TimeoutFailure>().toEqualTypeOf<ReturnType<(typeof TIMEOUT_FAILURES)[number]>>();
  expectTypeOf<BulkheadFailure>().toEqualTypeOf<ReturnType<(typeof BULKHEAD_FAILURES)[number]>>();
  expectTypeOf<ResilienceFailure>().toEqualTypeOf<ReturnType<(typeof RESILIENCE_FAILURES)[number]>>();
  expect(EXECUTION_FAILURES).toEqual([Cancelled, UnexpectedDefect]);
  expect(RESILIENCE_FAILURES).toContain(CircuitOpen);
  expect(RESILIENCE_FAILURES).toContain(Timeout);
  expect(RESILIENCE_FAILURES).toContain(BulkheadRejected);
});

it('static backoff misuse retains its diagnostic code and remediation', () => {
  const error = new InvalidBackoffError('invalid attempt');
  expect(error).toBeInstanceOf(ResilienceError);
  expect(error.code).toBe(RESILIENCE_ERROR_CODES.invalidBackoff);
  expect(error.code).toBe('ARKI_RESILIENCE_E006');
  expect(error.remediation).toContain('finite');
});
