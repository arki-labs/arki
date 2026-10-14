import { describe, expect, it } from 'vitest';

import { decimal } from './decimal.js';
import {
  ConvergenceError,
  DivisionByZeroError,
  EmptyDataError,
  InvalidArgumentError,
  MATH_ERROR_CODES,
  MathError,
  NotPositiveDefiniteError,
  NumberFormatError,
  NumericRangeError,
  ResourceLimitError,
  RoundingNecessaryError,
  SingularMatrixError,
  UnsupportedFeatureError,
} from './errors.js';

const CLASSES = [
  [NumberFormatError, 'ARKI_MATH_E001'],
  [InvalidArgumentError, 'ARKI_MATH_E002'],
  [DivisionByZeroError, 'ARKI_MATH_E003'],
  [RoundingNecessaryError, 'ARKI_MATH_E004'],
  [NumericRangeError, 'ARKI_MATH_E005'],
  [EmptyDataError, 'ARKI_MATH_E006'],
  [ResourceLimitError, 'ARKI_MATH_E007'],
  [UnsupportedFeatureError, 'ARKI_MATH_E008'],
  [SingularMatrixError, 'ARKI_MATH_E009'],
  [ConvergenceError, 'ARKI_MATH_E010'],
  [NotPositiveDefiniteError, 'ARKI_MATH_E011'],
] as const;

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('MathError codes', () => {
  it.each(CLASSES)('%o keeps its code %s, so callers can match on it across releases', (ErrorClass, code) => {
    const error = new ErrorClass('detail');
    expect(error).toBeInstanceOf(MathError);
    expect(error.code).toBe(code);
    expect(error.remediation.length).toBeGreaterThan(0);
    expect(error.message).toBe('detail');
  });

  it('gives every code exactly one class, so no two failures share a code', () => {
    expect(new Set(CLASSES.map(([, code]) => code)).size).toBe(CLASSES.length);
    expect(Object.values(MATH_ERROR_CODES).toSorted()).toEqual(CLASSES.map(([, code]) => code).toSorted());
  });

  it('carries the code on errors thrown by real calls', () => {
    expect(caught(() => decimal(1).dividedBy(0))).toMatchObject({ code: 'ARKI_MATH_E003' });
    expect(caught(() => decimal(1).dividedBy(3))).toMatchObject({ code: 'ARKI_MATH_E004' });
    expect(caught(() => decimal('not a number'))).toMatchObject({ code: 'ARKI_MATH_E001' });
  });
});
