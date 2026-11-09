/**
 * writtenRow: a command result with no row is a bug in the journal, not a plain Error.
 * lockReferences: a value no row can hold is a missing reference, never a raw Postgres error.
 */
import { describe, expect, it } from 'vitest';

import { FAILURE_ERROR_CODES, FailureError } from '@arki/failure';

import { core, openDb, rejectionOf, userId } from '../../test-support.js';
import { ReferenceNotFound } from '../providers/provider-error.js';
import { lockReferences, writtenRow } from './support.js';

describe('writtenRow', () => {
  it('throws the invariant failure when the journal returned no row', async () => {
    const error = await rejectionOf(writtenRow(Promise.resolve({ row: null }), 'createSubscription'));

    expect(error).toBeInstanceOf(FailureError);
    expect(error).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
  });
});

/** The customer's user reference, as `PaymentRepository.createCustomer` checks it. */
function userReference(value: string) {
  return {
    column: core.customers.userId,
    value,
    missing: () => ReferenceNotFound({ kind: 'user', id: value, missing: 'row' }),
  };
}

describe('lockReferences', () => {
  it('returns missing() for a value holding U+0000, which no row can hold, instead of a raw 22021', async () => {
    const { db, client } = await openDb();

    const [nul, known] = await db.transaction(async tx => [
      await lockReferences(tx, core.customers, [userReference('usr_\u0000buyer')]),
      await lockReferences(tx, core.customers, [userReference(userId)]),
    ]);
    await client.close();

    expect(nul).toMatchObject({ code: 'payments.reference_not_found', data: { kind: 'user' } });
    expect(known).toBeUndefined();
  });
});
