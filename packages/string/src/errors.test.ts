import { describe, expect, expectTypeOf, it } from 'vitest';

import type { StringErrorCode } from './errors.js';
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
    expectTypeOf<StringErrorCode>().extract<'ARKI_STRING_E002' | 'ARKI_STRING_E003'>().toBeNever();
    expect(STRING_ERROR_CODES).toEqual({
      invalidArgument: 'ARKI_STRING_E001',
      invalidTemplate: 'ARKI_STRING_E004',
    });
  });

  it('raises E001 with a remediation for an out-of-range argument', () => {
    const error = caught(() => padStart('a', -1));
    expect(error).toBeInstanceOf(StringError);
    expect(error).toMatchObject({ code: 'ARKI_STRING_E001', name: 'StringError' });
    expect(error instanceof StringError && error.remediation.length > 0).toBe(true);
  });

  it('keeps canonical UTF-8 and base64 failures apart, so callers can report the right one', () => {
    expect(toBase64('\uD83D')).toMatchObject({ code: 'string.invalid_utf8' });
    expect(fromBase64('/w==')).toMatchObject({ code: 'string.invalid_utf8' });
    expect(fromBase64('abc')).toMatchObject({ code: 'string.invalid_base64' });
  });

  it('separates malformed syntax from returned missing-data failures', () => {
    expect(caught(() => interpolate('{{ open', {}))).toMatchObject({ code: 'ARKI_STRING_E004' });
    expect(interpolate('{{ name }}', {})).toMatchObject({ code: 'string.missing_value' });
  });
});
