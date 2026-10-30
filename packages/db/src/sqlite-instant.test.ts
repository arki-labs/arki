import { expect, it } from 'vitest';

import { UnexpectedFailure } from '@arki/failure';

import { StoredValueUnreadable } from './errors.js';
import { instantFromMilliseconds } from './sqlite-instant.js';

it('reads stored milliseconds as an Instant', () => {
  expect(instantFromMilliseconds(1_700_000_000_123).toString()).toBe('2023-11-14T22:13:20.123Z');
});

it('refuses NaN and out-of-range stored milliseconds with StoredValueUnreadable, never a raw RangeError', () => {
  for (const stored of [Number.NaN, 8.64e15 + 1, Number.POSITIVE_INFINITY]) {
    let thrown: unknown;
    try {
      instantFromMilliseconds(stored);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnexpectedFailure);
    expect(thrown).not.toBeInstanceOf(RangeError);
    expect(thrown).toMatchObject({ code: StoredValueUnreadable.code });
  }
});
