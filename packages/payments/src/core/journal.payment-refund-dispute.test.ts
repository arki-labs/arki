/**
 * A payment's refunds and disputes on the journal
 *
 * The provider reports both after the fact, and resends. The refund command
 * takes the running total, so a resent or late report never doubles or lowers
 * what was refunded. A refund or a dispute on money that was never collected,
 * or in another currency, is rejected and writes nothing.
 */
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { AppDb } from '../test-support.js';
import type { PaymentId } from './types.js';
import { core, countEvents, customerId, eventTypesOf, meta, openDb, plain, userId } from '../test-support.js';
import { createPaymentId } from './primitives.js';

const { payments } = core;
const { journal } = plain;
const { commands } = plain.core;

let db: AppDb;
let client: PGlite;
let next = 0;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

async function seed(options: { collected: boolean; amount?: string; currency?: string }): Promise<PaymentId> {
  next += 1;
  const paymentId = createPaymentId();
  await orThrow(
    journal.run(
      db,
      commands.initiatePayment,
      {
        paymentId,
        userId,
        customerId,
        providerPaymentId: `pi_refund_${next}`,
        amount: { amount: options.amount ?? '50', currency: options.currency ?? 'USD' },
      },
      meta,
    ),
  );
  if (options.collected) await orThrow(journal.run(db, commands.completePayment, { paymentId }, meta));

  return paymentId;
}

async function rowOf(paymentId: PaymentId) {
  const [row] = await db.select().from(payments).where(eq(payments.id, paymentId));

  return row;
}

describe('recordPaymentRefund', () => {
  it('records a partial refund in minor units and marks the payment refunded', async () => {
    const paymentId = await seed({ collected: true });

    const result = await orThrow(
      journal.run(
        db,
        commands.recordPaymentRefund,
        { paymentId, refundedAmount: { amount: '12.50', currency: 'USD' } },
        meta,
      ),
    );

    expect(result.events.map(event => event.type)).toEqual(['PaymentRefundRecorded']);
    expect(await rowOf(paymentId)).toMatchObject({ refunded: true, refundedAmountMinor: 1250, status: 'succeeded' });
  });

  it('takes the total, so the same report again and an older, lower one write nothing', async () => {
    const paymentId = await seed({ collected: true });
    const refund = (amount: string) =>
      orThrow(
        journal.run(db, commands.recordPaymentRefund, { paymentId, refundedAmount: { amount, currency: 'USD' } }, meta),
      );
    await refund('20');
    const eventsBefore = await countEvents(db);

    const repeated = await refund('20');
    const older = await refund('5');

    expect(repeated.events).toEqual([]);
    expect(older.events).toEqual([]);
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await rowOf(paymentId)).toMatchObject({ refundedAmountMinor: 2000 });
  });

  it('raises the total with a later report of a bigger refund', async () => {
    const paymentId = await seed({ collected: true });
    const refund = (amount: string) =>
      orThrow(
        journal.run(db, commands.recordPaymentRefund, { paymentId, refundedAmount: { amount, currency: 'USD' } }, meta),
      );
    await refund('20');
    await refund('50');

    expect(await rowOf(paymentId)).toMatchObject({ refunded: true, refundedAmountMinor: 5000 });
    expect(await eventTypesOf(db, 'payment', paymentId)).toEqual([
      'PaymentInitiatedV2',
      'PaymentCompleted',
      'PaymentRefundRecorded',
      'PaymentRefundRecorded',
    ]);
  });

  it('stores a JPY refund in yen', async () => {
    const paymentId = await seed({ collected: true, amount: '3000', currency: 'JPY' });

    await orThrow(
      journal.run(
        db,
        commands.recordPaymentRefund,
        { paymentId, refundedAmount: { amount: '1500', currency: 'JPY' } },
        meta,
      ),
    );

    expect(await rowOf(paymentId)).toMatchObject({ refundedAmountMinor: 1500, currency: 'JPY' });
  });

  it.each([
    ['money that was never collected', { collected: false }, '10', 'USD', 'journal.conflict'],
    ['more than the payment', { collected: true }, '50.01', 'USD', 'journal.invalid'],
    ['another currency', { collected: true }, '10', 'EUR', 'journal.invalid'],
  ] as const)('rejects a refund of %s and writes nothing', async (_name, options, amount, currency, code) => {
    const paymentId = await seed(options);
    const eventsBefore = await countEvents(db);
    const rowBefore = await rowOf(paymentId);

    const refused = await journal.run(
      db,
      commands.recordPaymentRefund,
      { paymentId, refundedAmount: { amount, currency } },
      meta,
    );

    expect(refused).toMatchObject({ code });
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await rowOf(paymentId)).toEqual(rowBefore);
  });
});

describe('recordPaymentDispute', () => {
  it('records the dispute id and status on the payment', async () => {
    const paymentId = await seed({ collected: true });

    const result = await orThrow(
      journal.run(
        db,
        commands.recordPaymentDispute,
        { paymentId, disputeId: 'dp_1', status: 'needs_response', reason: 'fraudulent' },
        meta,
      ),
    );

    expect(result.events.map(event => event.type)).toEqual(['PaymentDisputeRecorded']);
    expect(await rowOf(paymentId)).toMatchObject({ disputeId: 'dp_1', disputeStatus: 'needs_response' });
  });

  it('writes nothing for the same dispute and status again, and records a status change', async () => {
    const paymentId = await seed({ collected: true });
    const dispute = (status: string) =>
      orThrow(journal.run(db, commands.recordPaymentDispute, { paymentId, disputeId: 'dp_2', status }, meta));
    await dispute('needs_response');

    const again = await dispute('needs_response');
    const changed = await dispute('under_review');

    expect(again.events).toEqual([]);
    expect(changed.events.map(event => event.type)).toEqual(['PaymentDisputeRecorded']);
    expect(await rowOf(paymentId)).toMatchObject({ disputeId: 'dp_2', disputeStatus: 'under_review' });
  });

  it('rejects a dispute on a payment that does not exist', async () => {
    const refused = await journal.run(
      db,
      commands.recordPaymentDispute,
      { paymentId: createPaymentId(), disputeId: 'dp_3', status: 'needs_response' },
      meta,
    );

    expect(refused).toMatchObject({ code: 'journal.not_found' });
  });
});
