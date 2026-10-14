/**
 * Every failure this package raises on purpose extends `MathError`, so callers
 * can catch the whole family with one `instanceof`. Each concrete class carries
 * a stable `code` and a one-sentence `remediation`: match on the code, never on
 * the message. Wrong runtime types (a string where a number was required, or
 * `decimal('2') + 1`) throw the built-in `TypeError` instead. Nothing in this
 * package returns `NaN` or `null` as a hidden failure channel.
 */

/** Stable error codes of `@arki/math`. */
export const MATH_ERROR_CODES = {
  /** A string is not a number in the accepted syntax. */
  numberFormat: 'ARKI_MATH_E001',
  /** An argument is outside what the function accepts. */
  invalidArgument: 'ARKI_MATH_E002',
  /** Division by zero, or zero raised to a negative power. */
  divisionByZero: 'ARKI_MATH_E003',
  /** The exact result needs rounding and no rounding mode was given. */
  roundingNecessary: 'ARKI_MATH_E004',
  /** A value cannot be represented in the target type. */
  numericRange: 'ARKI_MATH_E005',
  /** A statistic was asked of an empty or too small data set. */
  emptyData: 'ARKI_MATH_E006',
  /** An input or result exceeds the documented digit limits. */
  resourceLimit: 'ARKI_MATH_E007',
  /** The runtime lacks an `Intl` feature this call depends on. */
  unsupportedFeature: 'ARKI_MATH_E008',
  /** A matrix is singular to working precision. */
  singularMatrix: 'ARKI_MATH_E009',
  /** An iterative method did not reach its tolerance. */
  convergence: 'ARKI_MATH_E010',
  /** A matrix that must be symmetric positive definite is not. */
  notPositiveDefinite: 'ARKI_MATH_E011',
} as const;

/** The code of a `MathError` raised by `@arki/math` itself. */
export type MathErrorCode = (typeof MATH_ERROR_CODES)[keyof typeof MATH_ERROR_CODES];

export abstract class MathError extends Error {
  /** Stable machine-readable code, `ARKI_<PACKAGE>_E<nnn>`. */
  abstract readonly code: string;
  /** What to do about it, in one sentence. */
  abstract readonly remediation: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The input string is not a number in the accepted syntax. */
export class NumberFormatError extends MathError {
  readonly code = MATH_ERROR_CODES.numberFormat;
  readonly remediation = 'Pass a string in the documented number syntax, or validate user input before parsing.';
}

/** An argument is outside what the function accepts (reversed bounds, negative step, ...). */
export class InvalidArgumentError extends MathError {
  readonly code = MATH_ERROR_CODES.invalidArgument;
  readonly remediation = 'Check the argument against the documented range in the function reference.';
}

/** Division by zero, or zero raised to a negative power. */
export class DivisionByZeroError extends MathError {
  readonly code = MATH_ERROR_CODES.divisionByZero;
  readonly remediation = 'Check the divisor for zero before dividing.';
}

/** The exact result cannot be represented without rounding and no rounding mode was given. */
export class RoundingNecessaryError extends MathError {
  readonly code = MATH_ERROR_CODES.roundingNecessary;
  readonly remediation = 'Pass a scale and a rounding mode so the result can be rounded.';
}

/** A value cannot be represented in the target type (non-finite, unsafe integer, overflow, underflow). */
export class NumericRangeError extends MathError {
  readonly code = MATH_ERROR_CODES.numericRange;
  readonly remediation = 'Use decimal or bigint arithmetic, or keep the value inside the safe range.';
}

/** A statistic was asked of an empty (or too small) data set. */
export class EmptyDataError extends MathError {
  readonly code = MATH_ERROR_CODES.emptyData;
  readonly remediation = 'Pass at least as many values as the statistic needs.';
}

/** An input or result exceeds the documented digit limits. */
export class ResourceLimitError extends MathError {
  readonly code = MATH_ERROR_CODES.resourceLimit;
  readonly remediation = 'Reduce the number of digits or the size of the exponent.';
}

/** The runtime lacks an `Intl` feature this call depends on. */
export class UnsupportedFeatureError extends MathError {
  readonly code = MATH_ERROR_CODES.unsupportedFeature;
  readonly remediation = 'Run on a runtime whose Intl supports the feature, or avoid the locale-dependent option.';
}

/** A matrix is singular to working precision, so it has no inverse and `A·x = b` has no unique solution. */
export class SingularMatrixError extends MathError {
  readonly code = MATH_ERROR_CODES.singularMatrix;
  readonly remediation = 'Check that the matrix has full rank, or use a least-squares method.';
}

/** An iterative method did not reach its tolerance within its iteration limit. */
export class ConvergenceError extends MathError {
  readonly code = MATH_ERROR_CODES.convergence;
  readonly remediation = 'Loosen the tolerance, raise the iteration limit, or pass a better starting point.';
}

/** A matrix that must be symmetric positive definite (for a Cholesky factorization) is not. */
export class NotPositiveDefiniteError extends MathError {
  readonly code = MATH_ERROR_CODES.notPositiveDefinite;
  readonly remediation = 'Pass a symmetric positive definite matrix, or use a general factorization such as LU.';
}
