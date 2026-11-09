import { invariant } from '@arki/failure';

/** The most decimal places `Number.prototype.toFixed` takes. */
const MAX_PRECISION = 100;

/**
 * The formatters' precondition on `precision`: a finite number from 0 to 100, the range `toFixed`
 * takes. Anything else is a caller bug and throws the invariant failure `ARKI_FAILURE_E008` (outside
 * the range `toFixed` threw a raw `RangeError`; `NaN` silently meant 0 places). Internal: not exported
 * from the package.
 */
export function assertPrecision(operation: string, precision: number): void {
  invariant(
    Number.isFinite(precision) && precision >= 0 && precision <= MAX_PRECISION,
    () => `${operation}: precision must be a finite number from 0 to ${MAX_PRECISION}, got ${precision}.`,
  );
}
