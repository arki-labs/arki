/**
 * Static misuse outside UTF-8/base64 raises a {@link StringError} with a
 * stable `code`. Match on the code, never on the message. Wrong runtime types
 * (a number where a string was required) are not checked and have no code.
 */

/** Stable error codes of `@arki/string`. */
export const STRING_ERROR_CODES = {
  /**
   * An argument is outside what the function accepts (empty needle, negative length, bad glyph).
   *
   * @fix Check the argument against the range in the function reference: a non-empty needle, a whole number of at least 0 for lengths.
   * @verify bun run test
   */
  invalidArgument: 'ARKI_STRING_E001',
  /**
   * Text or bytes are not valid UTF-8: an unpaired surrogate, an overlong form, a bad lead byte.
   *
   * @fix Pass well-formed text with no lone surrogates, or valid UTF-8 bytes. Encoding APIs return canonical failures; narrow with `isFailure`.
   * @verify bun run test
   */
  invalidUtf8: 'ARKI_STRING_E002',
  /**
   * An input is not valid strict base64: whitespace, a mixed alphabet, bad padding or an impossible length.
   *
   * @fix Pass strict base64 of the chosen alphabet with correct padding. Encoding APIs return canonical failures; narrow with `isFailure`.
   * @verify bun run test
   */
  invalidBase64: 'ARKI_STRING_E003',
  /**
   * An `interpolate` template has a malformed placeholder.
   *
   * @fix Write placeholders as `{{ name }}` with an identifier inside, and close every `{{` with `}}`.
   * @verify bun run test
   */
  invalidTemplate: 'ARKI_STRING_E004',
  /**
   * An `interpolate` placeholder has no value and `missing` is `'throw'`.
   *
   * @fix Pass a value for the placeholder, or set `missing` to `'keep'` or `'empty'`.
   * @verify bun run test
   */
  missingValue: 'ARKI_STRING_E005',
} as const;

/** The code of a {@link StringError}. */
export type StringErrorCode = (typeof STRING_ERROR_CODES)[keyof typeof STRING_ERROR_CODES];

const REMEDIATIONS: Record<StringErrorCode, string> = {
  ARKI_STRING_E001: 'Check the argument against the range in the function reference.',
  ARKI_STRING_E002:
    'Pass well-formed text (no lone surrogates) or valid UTF-8 bytes. Encoding APIs return canonical failures.',
  ARKI_STRING_E003:
    'Pass strict base64 of the chosen alphabet with correct padding. Encoding APIs return canonical failures.',
  ARKI_STRING_E004: 'Write placeholders as {{ name }} with an identifier inside, and close every {{ with }}.',
  ARKI_STRING_E005: "Pass a value for the placeholder, or set missing to 'keep' or 'empty'.",
};

/** Legacy diagnostic for static misuse; encoding APIs return canonical failures. */
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
