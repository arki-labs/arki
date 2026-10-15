import { describe, expect, it } from 'vitest';

import { ASYNC_ERROR_CODES, AsyncError } from './index.js';

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
