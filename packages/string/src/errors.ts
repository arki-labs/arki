/**
 * Every failure this package raises on purpose is a {@link StringError} with a
 * stable `code`. Match on the code, never on the message. Wrong runtime types
 * (a number where a string was required) are not checked and have no code.
 */

/** Stable error codes of `@arki/string`. */
export const STRING_ERROR_CODES = {
  /** An argument is outside what the function accepts (empty needle, negative length, bad glyph). */
  invalidArgument: 'ARKI_STRING_E001',
  /** Text or bytes are not valid UTF-8: an unpaired surrogate, an overlong form, a bad lead byte. */
  invalidUtf8: 'ARKI_STRING_E002',
  /** An input is not valid strict base64. */
  invalidBase64: 'ARKI_STRING_E003',
  /** A `interpolate` template has a malformed placeholder. */
  invalidTemplate: 'ARKI_STRING_E004',
  /** A `interpolate` placeholder has no value and `missing` is `'throw'`. */
  missingValue: 'ARKI_STRING_E005',
} as const;

/** The code of a {@link StringError}. */
export type StringErrorCode = (typeof STRING_ERROR_CODES)[keyof typeof STRING_ERROR_CODES];

const REMEDIATIONS: Record<StringErrorCode, string> = {
  ARKI_STRING_E001: 'Check the argument against the range in the function reference.',
  ARKI_STRING_E002:
    'Pass well-formed text (no lone surrogates) or valid UTF-8 bytes. Use tryFromBase64 to get null instead.',
  ARKI_STRING_E003:
    'Pass strict base64 of the chosen alphabet with correct padding. Use tryFromBase64 to get null instead.',
  ARKI_STRING_E004: 'Write placeholders as {{ name }} with an identifier inside, and close every {{ with }}.',
  ARKI_STRING_E005: "Pass a value for the placeholder, or set missing to 'keep' or 'empty'.",
};

/** A coded failure of an `@arki/string` function. */
export class StringError extends Error {
  readonly code: StringErrorCode;
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(code: StringErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'StringError';
    this.code = code;
    this.remediation = REMEDIATIONS[code];
  }
}
