import { describe, expect, it } from 'vitest';

import { fromBase64, interpolate, padStart, STRING_ERROR_CODES, StringError, toBase64 } from './index.js';

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('StringError codes', () => {
  it('lets callers branch on the code, so each failure kind has its own stable code', () => {
    expect(STRING_ERROR_CODES).toEqual({
      invalidArgument: 'ARKI_STRING_E001',
      invalidUtf8: 'ARKI_STRING_E002',
      invalidBase64: 'ARKI_STRING_E003',
      invalidTemplate: 'ARKI_STRING_E004',
      missingValue: 'ARKI_STRING_E005',
    });
  });

  it('raises E001 with a remediation for an out-of-range argument', () => {
    const error = caught(() => padStart('a', -1));
    expect(error).toBeInstanceOf(StringError);
    expect(error).toMatchObject({ code: 'ARKI_STRING_E001', name: 'StringError' });
    expect(error instanceof StringError && error.remediation.length > 0).toBe(true);
  });

  it('keeps UTF-8 failures (E002) apart from base64 failures (E003), so callers can report the right one', () => {
    expect(toBase64('\uD83D')).toMatchObject({ code: 'string.invalid_utf8' });
    expect(fromBase64('/w==')).toMatchObject({ code: 'string.invalid_utf8' });
    expect(fromBase64('abc')).toMatchObject({ code: 'string.invalid_base64' });
  });

  it('separates a bad template (E004) from a missing value (E005), so callers can fix the data or the template', () => {
    expect(caught(() => interpolate('{{ open', {}))).toMatchObject({ code: 'ARKI_STRING_E004' });
    expect(caught(() => interpolate('{{ name }}', {}))).toMatchObject({ code: 'ARKI_STRING_E005' });
  });
});
