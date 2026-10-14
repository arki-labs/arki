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

  it('keeps the two published codes', () => {
    expect(ASYNC_ERROR_CODES).toEqual({ invalidWait: 'ARKI_ASYNC_E001', aborted: 'ARKI_ASYNC_E002' });
  });
});
