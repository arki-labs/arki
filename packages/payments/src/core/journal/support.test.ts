/**
 * writtenRow: a command result with no row is a bug in the journal, not a plain Error
 */
import { describe, expect, it } from 'vitest';

import { FAILURE_ERROR_CODES, FailureError } from '@arki/failure';

import { rejectionOf } from '../../test-support.js';
import { writtenRow } from './support.js';

describe('writtenRow', () => {
  it('throws the invariant failure when the journal returned no row', async () => {
    const error = await rejectionOf(writtenRow(Promise.resolve({ row: null }), 'createSubscription'));

    expect(error).toBeInstanceOf(FailureError);
    expect(error).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
  });
});
