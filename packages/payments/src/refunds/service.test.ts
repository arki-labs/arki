/**
 * RefundService on the journal
 *
 * Flow: RefundService → writes(run) → command → journal event → `refunds` row,
 *       in one transaction per step.
 *
 * A refund moves money back to a customer. The service decides who may get
 * one (a known payment, inside the window, not more than was paid), asks the
 * provider, and stores each step. These tests pin that every step leaves an
 * event, that a refund the provider refused ends `failed` and not `completed`,
 * and that a request the service turns down writes nothing.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Money } from '@arki/money';
import { money } from '@arki/money';

import type { CoreWrites } from '../core/journal';
import type { AppDb } from '../test-support';
import type { RefundWrites } from './journal';
import { toMinorColumn } from '../core/money';
import { createPaymentId } from '../core/primitives';
import { coreReads, refundReads, refundRow, runnerOn, seedPayment } from '../service-test-support';
import { adminId, countEvents, customerId, eventTypesOf, openDb, rejectionOf, typed, userId } from '../test-support';
import { RefundService } from './service';

type Provider = ConstructorParameters<typeof RefundService>[2];

let db: AppDb;
let client: PGlite;
let coreWrites: CoreWrites;
let writes: RefundWrites;

/** The id the provider gives the refund. The service stores it as `providerRefundId`. */
const refundedAs = createPaymentId();
const refundedOn = new Date('2026-01-10T00:00:00.000Z');

/** Every amount the provider was asked to pay back, in order. */
const askedToRefund: (Money | undefined)[] = [];

/** A provider that pays the refund back. */
const providerThatRefunds: Provider = {
  refundPayment: (providerPaymentId, params) => {
    askedToRefund.push(params.amount);
    const refunded = params.amount ?? money(0, 'USD');

    return Promise.resolve({
      id: refundedAs,
      userId,
      customerId,
      subscriptionId: null,
      providerPaymentId: 're_test',
      amountMinor: toMinorColumn(refunded),
      currency: refunded.currency.code,
      status: 'succeeded',
      paymentMethod: 'card',
      description: `Refund for ${providerPaymentId}`,
      failureReason: null,
      receiptUrl: null,
      refunded: true,
      refundedAmountMinor: toMinorColumn(refunded),
      metadata: null,
      createdAt: refundedOn,
      updatedAt: refundedOn,
    });
  },
};

const providerThatRefuses: Provider = {
  refundPayment: () => Promise.reject(new Error('charge already refunded')),
};

function serviceWith(provider: Provider) {
  return new RefundService(refundReads(db), writes, provider, coreReads(db), { systemUserId: adminId });
}

/** A request above the auto-approve limit, for a reason that needs a person to approve. */
async function pendingRefund(service: RefundService, amount = money(40, 'USD')) {
  const payment = await seedPayment(coreWrites, null, '100');

  return service.requestRefund({ paymentId: payment.id, amount, reason: 'customer_request', requestedBy: userId });
}

beforeAll(async () => {
  ({ db, client } = await openDb());
  coreWrites = typed.core.writes(runnerOn(db));
  writes = typed.refunds.writes(runnerOn(db));
});

afterAll(async () => {
  await client.close();
});

describe('requestRefund', () => {
  it('a request that needs approval is stored as pending, with its event', async () => {
    const refund = await pendingRefund(serviceWith(providerThatRefunds));

    expect(refund).toMatchObject({ status: 'pending', refundAmountMinor: 4000, requestedBy: userId });
    expect(await refundRow(db, refund.id)).toMatchObject({ status: 'pending', refundAmountMinor: 4000 });
    expect(await eventTypesOf(db, 'refund', refund.id)).toEqual(['RefundRequestedV2']);
  });

  it('a small refund is approved by the system and paid back at once: four steps, four events', async () => {
    const payment = await seedPayment(coreWrites, null, '100');

    const refund = await serviceWith(providerThatRefunds).requestRefund({
      paymentId: payment.id,
      amount: money(5, 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    });

    expect(refund).toMatchObject({ status: 'completed', approvedBy: adminId });
    expect(refund.providerRefundId).toBe(refundedAs);
    expect(await eventTypesOf(db, 'refund', refund.id)).toEqual([
      'RefundRequestedV2',
      'RefundApproved',
      'RefundProcessed',
      'RefundCompleted',
    ]);
  });

  it('a refund for a payment we do not know is turned down and writes nothing', async () => {
    const eventsBefore = await countEvents(db);

    const error = await rejectionOf(
      serviceWith(providerThatRefunds).requestRefund({
        paymentId: createPaymentId(),
        amount: money(5, 'USD'),
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );

    expect(error).toMatchObject({ message: 'Payment not found' });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('a refund above what was paid is turned down and writes nothing', async () => {
    const payment = await seedPayment(coreWrites, null, '30');
    const eventsBefore = await countEvents(db);

    const error = await rejectionOf(
      serviceWith(providerThatRefunds).requestRefund({
        paymentId: payment.id,
        amount: money('30.01', 'USD'),
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );

    expect(error).toMatchObject({ message: 'Refund amount exceeds payment amount' });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('refunds add up exactly: 0.10 then 0.20 of a 0.30 payment is all of it, not a cent over by float drift', async () => {
    const service = serviceWith(providerThatRefunds);
    const payment = await seedPayment(coreWrites, null, '0.30');

    await service.requestRefund({
      paymentId: payment.id,
      amount: money('0.10', 'USD'),
      reason: 'billing_error',
      requestedBy: userId,
    });
    const second = await service.requestRefund({
      paymentId: payment.id,
      amount: money('0.20', 'USD'),
      reason: 'billing_error',
      requestedBy: userId,
    });

    expect(second).toMatchObject({ status: 'completed' });
  });

  it("a refund keeps the payment's currency: a EUR payment is refunded in EUR, not stored as USD", async () => {
    const payment = await seedPayment(coreWrites, null, '50', 'EUR');

    const eurRefund = await serviceWith(providerThatRefunds).requestRefund({
      paymentId: payment.id,
      amount: money(40, 'EUR'),
      reason: 'customer_request',
      requestedBy: userId,
    });

    expect(eurRefund).toMatchObject({ currency: 'EUR', refundAmountMinor: 4000, originalAmountMinor: 4000 });
  });

  it('a refund in another currency than the payment is turned down and writes nothing', async () => {
    const payment = await seedPayment(coreWrites, null, '50', 'EUR');
    const eventsBefore = await countEvents(db);

    const error = await rejectionOf(
      serviceWith(providerThatRefunds).requestRefund({
        paymentId: payment.id,
        amount: money(40, 'USD'),
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );

    expect(error).toMatchObject({ message: 'Refund currency USD differs from the payment currency EUR' });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('a JPY refund reaches the provider as 1500 JPY, never divided by 100', async () => {
    const payment = await seedPayment(coreWrites, null, '5000', 'JPY');

    await serviceWith(providerThatRefunds).requestRefund({
      paymentId: payment.id,
      amount: money(1500, 'JPY'),
      reason: 'billing_error',
      requestedBy: userId,
    });

    expect(askedToRefund.at(-1)?.toString()).toBe('1500 JPY');
  });
});

describe('approveRefund', () => {
  it('an approved refund is paid back through the provider and ends completed', async () => {
    const service = serviceWith(providerThatRefunds);
    const pending = await pendingRefund(service);

    const refund = await service.approveRefund({ refundId: pending.id, approvedBy: adminId });

    expect(refund).toMatchObject({ status: 'completed', approvedBy: adminId });
    expect(refund.completedAt).toBeInstanceOf(Date);
    expect(await refundRow(db, pending.id)).toMatchObject({ status: 'completed', approvedBy: adminId });
    expect(await eventTypesOf(db, 'refund', pending.id)).toEqual([
      'RefundRequestedV2',
      'RefundApproved',
      'RefundProcessed',
      'RefundCompleted',
    ]);
  });

  it('when the provider refuses, the refund ends failed with the reason, and the error reaches the caller', async () => {
    const service = serviceWith(providerThatRefuses);
    const pending = await pendingRefund(service);

    const error = await rejectionOf(service.approveRefund({ refundId: pending.id, approvedBy: adminId }));

    expect(error).toMatchObject({ message: 'charge already refunded' });
    expect(await refundRow(db, pending.id)).toMatchObject({
      status: 'failed',
      providerResponse: JSON.stringify({ error: 'charge already refunded' }),
    });
    expect(await eventTypesOf(db, 'refund', pending.id)).toEqual([
      'RefundRequestedV2',
      'RefundApproved',
      'RefundProcessed',
      'RefundFailed',
    ]);
  });

  it('a refund that was already decided cannot be approved again: refused, nothing written', async () => {
    const service = serviceWith(providerThatRefunds);
    const pending = await pendingRefund(service);
    await service.rejectRefund({ refundId: pending.id, rejectedBy: adminId, reason: 'outside policy' });
    const eventsBefore = await countEvents(db);

    const error = await rejectionOf(service.approveRefund({ refundId: pending.id, approvedBy: adminId }));

    expect(error).toMatchObject({ message: `Invalid refund state for ${pending.id}` });
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await refundRow(db, pending.id)).toMatchObject({ status: 'rejected' });
  });
});

describe('rejectRefund', () => {
  it('a rejected refund keeps who rejected it and why, with its event', async () => {
    const service = serviceWith(providerThatRefunds);
    const pending = await pendingRefund(service);

    const refund = await service.rejectRefund({ refundId: pending.id, rejectedBy: adminId, reason: 'outside policy' });

    expect(refund).toMatchObject({ status: 'rejected', rejectedBy: adminId, rejectionReason: 'outside policy' });
    expect(await eventTypesOf(db, 'refund', pending.id)).toEqual(['RefundRequestedV2', 'RefundRejected']);
  });
});
