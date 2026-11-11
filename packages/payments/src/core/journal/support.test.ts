/**
 * writtenRow: a command result with no row is a bug in the journal, not a plain Error.
 * lockReferences: a value no row can hold is a missing reference, never a raw Postgres error.
 */
import { describe, expect, it } from 'vitest';

import { FAILURE_ERROR_CODES, FailureError } from '@arki/failure';

import { core, openDb, rejectionOf, userId, users } from '../../test-support.js';
import { MAX_BATCH_ITEMS } from '../pg-values.js';
import { ReferenceNotFound } from '../providers/provider-error.js';
import { lockReferences, sameJson, toInstant, toNullableInstant, writtenRow } from './support.js';

describe('sameJson', () => {
  it('compares arrays item by item and objects by key, in any key order', () => {
    expect(sameJson([1, { a: 'x', b: [2] }], [1, { b: [2], a: 'x' }])).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson([1], { 0: 1 })).toBe(false);
    expect(sameJson({ a: undefined }, {})).toBe(true);
  });
});

describe('writtenRow', () => {
  it('throws the invariant failure when the journal returned no row', async () => {
    const error = await rejectionOf(writtenRow(Promise.resolve({ row: null }), 'createSubscription'));

    expect(error).toBeInstanceOf(FailureError);
    expect(error).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
  });
});

describe('toInstant and toNullableInstant', () => {
  it('read back a timestamp the event schema accepted, and keep null', () => {
    expect(toInstant('2026-01-15T10:00:00Z').toString()).toBe('2026-01-15T10:00:00Z');
    expect(toNullableInstant('2026-01-15T12:00:00+02:00')?.toString()).toBe('2026-01-15T10:00:00Z');
    expect(toNullableInstant(null)).toBeNull();
  });

  it.each(['not a time', '', '2026-01-15', '2026-01-15T10:00:00', '2026-02-30T10:00:00Z'])(
    'a non-timestamp %j breaks the stated precondition: the invariant failure, never a raw RangeError',
    text => {
      expect(() => toNullableInstant(text)).toThrow(expect.objectContaining({ code: FAILURE_ERROR_CODES.invariant }));
      expect(() => toInstant(text)).toThrow(FailureError);
    },
  );
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

  it('returns missing() for a value with a lone surrogate, even when a row holds the U+FFFD the driver would send for it', async () => {
    const { db, client } = await openDb();
    // The host app's user row, written as the fixture writes its users: the text the driver sends for 'usr_\ud800buyer'
    await db.insert(users).values({ id: 'usr_\uFFFDbuyer' });

    const lone = await db.transaction(async tx =>
      lockReferences(tx, core.customers, [userReference('usr_\uD800buyer')]),
    );
    await client.close();

    expect(lone).toMatchObject({ code: 'payments.reference_not_found', data: { kind: 'user' } });
  });

  it('breaks its stated invariant for more than MAX_BATCH_ITEMS references, before any query', async () => {
    const { db, client } = await openDb();
    const references = Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => userReference(userId));

    const error = await db
      .transaction(async tx => lockReferences(tx, core.customers, references))
      .catch((error_: unknown) => error_);
    await client.close();

    expect(error).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
  });
});
