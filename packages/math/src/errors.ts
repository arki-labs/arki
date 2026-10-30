/**
 * Parsers return, builders throw. The `parse*` functions and `fromBase` read
 * outside text and return a typed failure ({@link InvalidNumber},
 * {@link NumberOutOfRange}) for text that is not a number or is past a limit.
 * Builders (`decimal('1.5')`, `ratio('1/3')`, `complex('3+4i')`) and arithmetic
 * throw: every thrown error extends `MathError`, so callers can catch the whole
 * family with one `instanceof`. Each concrete class carries a stable `code` and
 * a one-sentence `remediation`: match on the code, never on the message. Wrong
 * runtime types (a string where a number was required, or `decimal('2') + 1`)
 * throw the built-in `TypeError` instead. Nothing in this package returns
 * `NaN` or `null` as a hidden failure channel.
 */
import type { FailureOf } from '@arki/failure';
import { defineFailure } from '@arki/failure';

/**
 * Outside text is not a number in the parser's syntax. The text is not echoed back.
 *
 * @fix Show the user the field again. For `parseNumber` and `parseDecimal` check that the locale or `symbols` match the text; for `fromBase` check the base.
 * @verify cd packages/math && bun run vitest run src/parse.test.ts src/integer.test.ts src/complex.test.ts
 */
export const InvalidNumber = /* @__PURE__ */ defineFailure('math.invalid_number', {
  status: 400,
  message: 'Text is not a number in the accepted syntax.',
  remediation: 'Check the text against the syntax and locale the parser expects, then ask for the number again.',
});

/**
 * Outside text holds a number past a documented limit: more than 10 000 digits,
 * an exponent or scale past ±10 000, or a value outside the float range for a `number` result.
 *
 * @fix Reject the input as too large, or for a `number` result parse with `parseDecimal` to keep every digit.
 * @verify cd packages/math && bun run vitest run src/parse.test.ts src/integer.test.ts src/complex.test.ts
 */
export const NumberOutOfRange = /* @__PURE__ */ defineFailure('math.number_out_of_range', {
  status: 400,
  message: 'Text holds a number outside the supported digits, scale or range.',
  remediation:
    'Keep values within 10 000 digits and an exponent of 10 000, or use parseDecimal for values past the float range.',
});

/** Every failure a `@arki/math` parser returns. The one list; {@link MathParseFailure} is derived from it. */
export const MATH_PARSE_FAILURES = [InvalidNumber, NumberOutOfRange] as const;

/** A failure value returned by a `@arki/math` parser. */
export type MathParseFailure = FailureOf<(typeof MATH_PARSE_FAILURES)[number]>;

/** Stable error codes of `@arki/math`. */
export const MATH_ERROR_CODES = {
  /**
   * A string is not a number in the accepted syntax.
   *
   * @fix Pass a plain ASCII decimal string such as `'12.5'` or `'1e3'`, or parse locale text with `@arki/math/parse`.
   * @verify cd packages/math && bun run vitest run src/errors.test.ts
   */
  numberFormat: 'ARKI_MATH_E001',
  /**
   * An argument is outside what the function accepts.
   *
   * @fix Read the message for the argument and fix its value: bounds in order, a positive step, a probability from 0 to 1.
   * @verify cd packages/math && bun run vitest run src/errors.test.ts
   */
  invalidArgument: 'ARKI_MATH_E002',
  /**
   * Division by zero, or zero raised to a negative power.
   *
   * @fix Check the divisor before the call, or choose a result for the zero case in your own code.
   * @verify cd packages/math && bun run vitest run src/errors.test.ts
   */
  divisionByZero: 'ARKI_MATH_E003',
  /**
   * The exact result needs rounding and no rounding mode was given.
   *
   * @fix Pass a scale and a rounding mode, for example `{ scale: 4, rounding: 'halfEven' }`.
   * @verify cd packages/math && bun run vitest run src/errors.test.ts
   */
  roundingNecessary: 'ARKI_MATH_E004',
  /**
   * A value cannot be represented in the target type.
   *
   * @fix Use a `bigint` or `Decimal` input, or keep the value inside the safe integer and finite float range.
   * @verify cd packages/math && bun run vitest run src/errors.test.ts
   */
  numericRange: 'ARKI_MATH_E005',
  /**
   * A statistic was asked of an empty or too small data set.
   *
   * @fix Check the data length first. Most statistics need one value; variance and regression need more.
   * @verify cd packages/math && bun run vitest run src/errors.test.ts
   */
  emptyData: 'ARKI_MATH_E006',
  /**
   * An input or result exceeds the documented digit limits.
   *
   * @fix Keep values within 10 000 digits and an exponent of 10 000. These limits guard against hostile input.
   * @verify cd packages/math && bun run vitest run src/errors.test.ts
   */
  resourceLimit: 'ARKI_MATH_E007',
  /**
   * The runtime lacks an `Intl` feature this call depends on.
   *
   * @fix Pass `symbols` to parse without `Intl`, or use a runtime with the feature (Hermes on iOS lacks `formatToParts`).
   * @verify cd packages/math && bun run vitest run src/errors.test.ts
   */
  unsupportedFeature: 'ARKI_MATH_E008',
  /**
   * A matrix is singular to working precision.
   *
   * @fix Check the matrix with `conditionNumber` or `rank`, or use `leastSquares` or `pseudoInverse`.
   * @verify cd packages/math && bun run vitest run src/errors.test.ts
   */
  singularMatrix: 'ARKI_MATH_E009',
  /**
   * An iterative method did not reach its tolerance.
   *
   * @fix Read `.best` for the best estimate, widen the tolerance or iteration limit, or give a better starting bracket.
   * @verify cd packages/math && bun run vitest run src/errors.test.ts
   */
  convergence: 'ARKI_MATH_E010',
  /**
   * A matrix that must be symmetric positive definite is not.
   *
   * @fix Pass a symmetric positive definite matrix, or use LU or QR decomposition instead of Cholesky.
   * @verify cd packages/math && bun run vitest run src/errors.test.ts
   */
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
  /** Iterations, sweeps or evaluations spent before the method stopped. */
  readonly iterations: number;

  constructor(message: string, iterations: number) {
    super(message);
    this.iterations = iterations;
  }
}

/**
 * A numeric method got valid input and still did not reach its tolerance in its iteration limit: a function with no
 * limit at the point, an integrand that is not integrable, a matrix whose QR or SVD iteration stalls. `cause` is the
 * `ConvergenceError` with `iterations`; the root, integral and limit errors also carry `best`, the last estimate.
 *
 * @fix Show the user that the method did not settle; loosen the tolerance, raise the iteration limit, or start elsewhere, and use `cause.best` if a rough value is enough.
 * @verify cd packages/math && bun run vitest run src/errors.test.ts src/roots.test.ts src/integrate.test.ts
 */
export const NotConverged = /* @__PURE__ */ defineFailure('math.not_converged', {
  status: 422,
  message: 'The method did not converge within its iteration limit.',
  remediation: 'Loosen the tolerance, raise the iteration limit, or pass a better starting point.',
});

/** A failure value returned by an iterative method that did not converge. */
export type NotConvergedFailure = FailureOf<typeof NotConverged>;

/**
 * Runs an iterative method and returns {@link NotConverged} when it throws a {@link ConvergenceError} (with the error
 * as `cause`). Invalid input and every other error are still thrown.
 */
export function orNotConverged<Value>(run: () => Value): Value | NotConvergedFailure {
  try {
    return run();
  } catch (error) {
    if (error instanceof ConvergenceError) return NotConverged({ cause: error });
    throw error;
  }
}

/** A matrix that must be symmetric positive definite (for a Cholesky factorization) is not. */
export class NotPositiveDefiniteError extends MathError {
  readonly code = MATH_ERROR_CODES.notPositiveDefinite;
  readonly remediation = 'Pass a symmetric positive definite matrix, or use a general factorization such as LU.';
}
