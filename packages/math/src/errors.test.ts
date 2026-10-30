import { describe, expect, it } from 'vitest';

import { decimal } from './decimal.js';
import {
  ConvergenceError,
  DivisionByZeroError,
  EmptyDataError,
  InvalidArgumentError,
  MATH_ERROR_CODES,
  MathError,
  NotConverged,
  NotPositiveDefiniteError,
  NumberFormatError,
  NumericRangeError,
  orNotConverged,
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

describe('ConvergenceError', () => {
  it('keeps its code ARKI_MATH_E010 and says how many iterations it spent, so NotConverged can report them', () => {
    const error = new ConvergenceError('detail', 7);
    expect(error).toBeInstanceOf(MathError);
    expect(error.code).toBe('ARKI_MATH_E010');
    expect(error.iterations).toBe(7);
    expect(error.remediation.length).toBeGreaterThan(0);
  });
});

describe('MathError codes', () => {
  it.each(CLASSES)('%o keeps its code %s, so callers can match on it across releases', (ErrorClass, code) => {
    const error = new ErrorClass('detail');
    expect(error).toBeInstanceOf(MathError);
    expect(error.code).toBe(code);
    expect(error.remediation.length).toBeGreaterThan(0);
    expect(error.message).toBe('detail');
  });

  it('gives every code exactly one class, so no two failures share a code', () => {
    const codes = [...CLASSES.map(([, code]) => code), MATH_ERROR_CODES.convergence];
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.values(MATH_ERROR_CODES).toSorted()).toEqual(codes.toSorted());
  });

  it('carries the code on errors thrown by real calls', () => {
    expect(caught(() => decimal(1).dividedBy(0))).toMatchObject({ code: 'ARKI_MATH_E003' });
    expect(caught(() => decimal(1).dividedBy(3))).toMatchObject({ code: 'ARKI_MATH_E004' });
    expect(caught(() => decimal('not a number'))).toMatchObject({ code: 'ARKI_MATH_E001' });
  });
});

describe('orNotConverged', () => {
  it('turns a ConvergenceError into NotConverged with the error as cause, so iterations and best reach the caller', () => {
    const error = new ConvergenceError('stalled', 12);
    const result = orNotConverged(() => {
      throw error;
    });
    expect(NotConverged.is(result)).toBe(true);
    expect(NotConverged.is(result) && result.cause).toBe(error);
  });

  it('returns the value of a call that converged', () => {
    expect(orNotConverged(() => 42)).toBe(42);
  });

  it('still throws every other error: a bad argument is a bug, not a failure to converge', () => {
    expect(() =>
      orNotConverged(() => {
        throw new InvalidArgumentError('bad');
      }),
    ).toThrow(InvalidArgumentError);
  });
});
