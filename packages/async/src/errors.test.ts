import { describe, expect, expectTypeOf, it } from 'vitest';

import { defineFailure, isFailure, reviveJson, serialize } from '@arki/failure';

import {
  ASYNC_ERROR_CODES,
  AsyncError,
  Cancelled,
  Deadline,
  scopeAggregate,
  ScopeFailed,
  SUPERVISOR_FAILURES,
} from './errors.js';

describe('AsyncError', () => {
  it('carries a stable code, a remediation and an optional cause', () => {
    const cause = new Error('root');
    const error = new AsyncError(ASYNC_ERROR_CODES.aborted, 'm', 'do this', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AsyncError');
    expect(error.code).toBe('ARKI_ASYNC_E002');
    expect(error.remediation).toBe('do this');
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('ARKI_ASYNC_E002');
  });

  it('keeps every published code stable: codes are a public contract, never renumbered', () => {
    expect(ASYNC_ERROR_CODES).toEqual({
      invalidWait: 'ARKI_ASYNC_E001',
      aborted: 'ARKI_ASYNC_E002',
      cleanupFailed: 'ARKI_ASYNC_E003',
      timedOut: 'ARKI_ASYNC_E004',
      invalidConcurrency: 'ARKI_ASYNC_E005',
    });
  });

  it('carries no finalizer errors unless given, and freezes the list it gets', () => {
    expect(new AsyncError(ASYNC_ERROR_CODES.aborted, 'm', 'r').errors).toEqual([]);
    const errors = [new Error('a')];
    const error = new AsyncError(ASYNC_ERROR_CODES.cleanupFailed, 'm', 'r', { errors });
    errors.push(new Error('late'));
    expect(error.errors).toHaveLength(1);
    expect(Object.isFrozen(error.errors)).toBe(true);
  });
});

describe('scope failures', () => {
  it('keeps supervisor definitions stable and reuses the canonical defect', () => {
    expect(SUPERVISOR_FAILURES.map(definition => definition.code)).toEqual([
      'async.cancelled',
      'async.deadline',
      'failure.unexpected_defect',
    ]);
    expect(ScopeFailed.code).toBe('async.scope_failed');
    expect(Cancelled().status).toBe(499);
    expect(Deadline().status).toBe(504);
  });
  it('retains exact original members privately and serializes safe counts', () => {
    const Refused = defineFailure('scope_error_test.refused');
    const primary = Refused({ cause: new Error('private driver secret') });
    const cleanup = Refused();
    const failed = scopeAggregate([primary], [cleanup]);
    expect(isFailure(failed)).toBe(true);
    expect(failed.cause.primary[0]).toBe(primary);
    expect(failed.cause.cleanup[0]).toBe(cleanup);
    expect(Object.isFrozen(failed.cause.primary)).toBe(true);
    expect(Object.isFrozen(failed.cause.cleanup)).toBe(true);
    expect(failed.data).toEqual({ primaryCount: 1, cleanupCount: 1 });
    expectTypeOf(failed.data).toEqualTypeOf<{ primaryCount: number; cleanupCount: number }>();
    const envelope = serialize(failed, [ScopeFailed]);
    if (isFailure(envelope)) throw new Error(envelope.code);
    const wire = JSON.stringify(envelope);
    expect(wire).not.toContain('private driver secret');
    expect(wire).not.toContain(Refused.code);
    const revived = reviveJson(wire, [ScopeFailed]);
    if (!ScopeFailed.is(revived)) throw new Error('Expected canonical scope summary');
    expect(revived.data).toEqual(failed.data);
    expect(revived.cause).toBeUndefined();
  });
  it('rejects malformed aggregate counts at the protocol boundary', () => {
    const revived = reviveJson(
      JSON.stringify({ version: 1, code: ScopeFailed.code, data: { primaryCount: -1, cleanupCount: 0 } }),
      [ScopeFailed],
    );
    expect(revived).toMatchObject({ code: 'failure.invalid_envelope', data: { reason: 'invalid_data' } });
  });
});
