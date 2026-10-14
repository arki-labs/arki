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
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Money } from '@arki/money';
import { instant, isInstant } from '@arki/date';
import { money } from '@arki/money';

import type { CoreWrites } from '../core/journal.js';
import type { PaymentId } from '../core/types.js';
import type { AppDb } from '../test-support.js';
import type { RefundWrites } from './journal.js';
import type { RefundReason } from './primitives.js';
import type { RefundAutoApproveLimits } from './service.js';
import { toMinorColumn } from '../core/money.js';
import { createPaymentId } from '../core/primitives.js';
import { coreReads, refundReads, refundRow, runnerOn, seedPayment } from '../service-test-support.js';
import {
  adminId,
  countEvents,
  customerId,
  eventTypesOf,
  openDb,
  refundsTables,
  rejectionOf,
  typed,
  userId,
} from '../test-support.js';
import { createRefundId } from './primitives.js';
import { RefundService } from './service.js';

type Provider = ConstructorParameters<typeof RefundService>[2];

let db: AppDb;
let client: PGlite;
let coreWrites: CoreWrites;
let writes: RefundWrites;

/** The Stripe refund id the provider gives. The service stores it as `providerRefundId`. */
const refundedAs = 're_test';
const refundedOn = instant('2026-01-10T00:00:00.000Z');

/** Every amount the provider was asked to pay back, in order. */
const askedToRefund: (Money | undefined)[] = [];

/** A provider that pays the refund back. */
const providerThatRefunds: Provider = {
  refundPayment: (paymentId, params) => {
    askedToRefund.push(params.amount);
    const refunded = params.amount ?? money(0, 'USD');

    return Promise.resolve({
      providerRefundId: refundedAs,
      payment: {
        id: paymentId,
        userId,
        customerId,
        subscriptionId: null,
        providerPaymentId: 'pi_test',
        amountMinor: toMinorColumn(refunded),
        currency: refunded.currency.code,
        status: 'succeeded',
        paymentMethod: 'card',
        description: null,
        failureReason: null,
        receiptUrl: null,
        refunded: true,
        refundedAmountMinor: toMinorColumn(refunded),
        disputeId: null,
        disputeStatus: null,
        metadata: null,
        createdAt: refundedOn,
        updatedAt: refundedOn,
      },
    });
  },
};

const providerThatRefuses: Provider = {
  refundPayment: () => Promise.reject(new Error('charge already refunded')),
};

function serviceWith(provider: Provider, autoApproveLimits?: RefundAutoApproveLimits) {
  return new RefundService(refundReads(db), writes, provider, coreReads(db), {
    systemUserId: adminId,
    ...(autoApproveLimits === undefined ? {} : { autoApproveLimits }),
  });
}

/** A customer asks for `amount` back from a payment of 5000 in the same currency. */
async function askFor(
  amount: Money,
  autoApproveLimits?: RefundAutoApproveLimits,
  reason: RefundReason = 'customer_request',
) {
  const payment = await seedPayment(coreWrites, null, '5000', amount.currency.code);

  return serviceWith(providerThatRefunds, autoApproveLimits).requestRefund({
    paymentId: payment.id,
    amount,
    reason,
    requestedBy: userId,
  });
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

    expect(error).toMatchObject({ code: 'AMOUNT_EXCEEDED', message: 'Refund amount exceeds payment amount' });
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

/**
 * Small refunds skip the person, but "small" depends on the currency: 10 USD is
 * small, 10 KWD is about 32 USD, and 10 JPY is a few cents. So each currency has
 * its own configured limit, and a currency without one always waits for a person.
 */
describe('auto-approval limits per currency', () => {
  it.each([
    ['10.00', 'USD', 'completed'],
    ['10.01', 'USD', 'pending'],
    ['1500', 'JPY', 'completed'],
    ['1501', 'JPY', 'pending'],
  ])(
    'under the default limits, %s %s ends %s: at the limit is small, a unit above is not',
    async (amount, currency, status) => {
      const refund = await askFor(money(amount, currency));

      expect(refund.status).toBe(status);
    },
  );

  it('10 JPY waits for a person when JPY has no limit: "10" no longer means 10 of any currency', async () => {
    const refund = await askFor(money(10, 'JPY'), { USD: '10.00' });

    expect(refund.status).toBe('pending');
    expect(refund.approvedBy).toBeNull();
  });

  it('a currency without a limit is never approved by the system, however small: 0.01 GBP', async () => {
    const refund = await askFor(money('0.01', 'GBP'));

    expect(refund.status).toBe('pending');
    expect(await eventTypesOf(db, 'refund', refund.id)).toEqual(['RefundRequestedV2']);
  });

  it.each(['billing_error', 'technical_issue'] as const)(
    'a %s above the limit still waits for a person: our own mistakes do not skip review at any size',
    async reason => {
      const above = await askFor(money('10.01', 'USD'), undefined, reason);
      const atLimit = await askFor(money('10.00', 'USD'), undefined, reason);

      expect(above.status).toBe('pending');
      expect(atLimit.status).toBe('completed');
    },
  );

  it('turns down a limit that is not an amount of its currency when the service is built, not on a refund', () => {
    expect(() => serviceWith(providerThatRefunds, { USD: '10.001' })).toThrow();
    expect(() => serviceWith(providerThatRefunds, { NOPE: '10' })).toThrow();
  });
});

describe('approveRefund', () => {
  it('an approved refund is paid back through the provider and ends completed', async () => {
    const service = serviceWith(providerThatRefunds);
    const pending = await pendingRefund(service);

    const refund = await service.approveRefund({ refundId: pending.id, approvedBy: adminId });

    expect(refund).toMatchObject({ status: 'completed', approvedBy: adminId });
    expect(isInstant(refund.completedAt)).toBe(true);
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

describe('approval notes, missing refunds, empty reasons and double requests', () => {
  it("the approver's notes are kept on the refund and in its event", async () => {
    const service = serviceWith(providerThatRefunds);
    const pending = await pendingRefund(service);

    const refund = await service.approveRefund({
      refundId: pending.id,
      approvedBy: adminId,
      notes: 'checked with the customer',
    });

    expect(refund).toMatchObject({ status: 'completed', approvalNotes: 'checked with the customer' });
    expect(await refundRow(db, pending.id)).toMatchObject({ approvalNotes: 'checked with the customer' });
  });

  it('an approval without notes leaves them empty', async () => {
    const service = serviceWith(providerThatRefunds);
    const pending = await pendingRefund(service);

    const refund = await service.approveRefund({ refundId: pending.id, approvedBy: adminId });

    expect(refund.approvalNotes).toBeNull();
  });

  it('approving a refund that does not exist is a REFUND_NOT_FOUND error, not a plain failure', async () => {
    const eventsBefore = await countEvents(db);

    const error = await rejectionOf(
      serviceWith(providerThatRefunds).approveRefund({ refundId: createRefundId(), approvedBy: adminId }),
    );

    expect(error).toMatchObject({ name: 'RefundError', code: 'REFUND_NOT_FOUND' });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('rejecting a refund that does not exist is a REFUND_NOT_FOUND error', async () => {
    const error = await rejectionOf(
      serviceWith(providerThatRefunds).rejectRefund({ refundId: createRefundId(), rejectedBy: adminId, reason: 'no' }),
    );

    expect(error).toMatchObject({ name: 'RefundError', code: 'REFUND_NOT_FOUND' });
  });

  it.each(['', '   '])('a rejection with the reason %j is refused and the refund stays pending', async reason => {
    const service = serviceWith(providerThatRefunds);
    const pending = await pendingRefund(service);
    const eventsBefore = await countEvents(db);

    const error = await rejectionOf(service.rejectRefund({ refundId: pending.id, rejectedBy: adminId, reason }));

    expect(error).toMatchObject({ name: 'RefundError', code: 'REASON_REQUIRED' });
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await refundRow(db, pending.id)).toMatchObject({ status: 'pending', rejectionReason: null });
  });

  it('a second request for a payment that already has a pending refund is refused', async () => {
    const service = serviceWith(providerThatRefunds);
    const payment = await seedPayment(coreWrites, null, '100');
    await service.requestRefund({
      paymentId: payment.id,
      amount: money(40, 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    });
    const eventsBefore = await countEvents(db);

    const error = await rejectionOf(
      service.requestRefund({
        paymentId: payment.id,
        amount: money(20, 'USD'),
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );

    expect(error).toMatchObject({ name: 'RefundError', code: 'DUPLICATE_PENDING_REFUND' });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('once the first refund is decided, the payment can be refunded again', async () => {
    const service = serviceWith(providerThatRefunds);
    const payment = await seedPayment(coreWrites, null, '100');
    const first = await service.requestRefund({
      paymentId: payment.id,
      amount: money(40, 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    });
    await service.rejectRefund({ refundId: first.id, rejectedBy: adminId, reason: 'outside policy' });

    const second = await service.requestRefund({
      paymentId: payment.id,
      amount: money(20, 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    });

    expect(second).toMatchObject({ status: 'pending' });
  });
});

describe('what a payment can still refund', () => {
  it.each(['approved', 'processing'] as const)(
    'a %s refund already counts: a request over the rest is refused with AMOUNT_EXCEEDED',
    async stage => {
      const payment = await seedPayment(coreWrites, null, '100');
      const earlier = await writes.requestRefund({
        paymentId: payment.id,
        originalAmount: { amount: '100', currency: 'USD' },
        refundAmount: { amount: '80', currency: 'USD' },
        reason: 'customer_request',
        requestedBy: userId,
      });
      await writes.approveRefund({ refundId: earlier.id, approvedBy: adminId });
      if (stage === 'processing') {
        await writes.processRefund({ refundId: earlier.id });
      }
      const eventsBefore = await countEvents(db);

      const error = await rejectionOf(
        serviceWith(providerThatRefunds).requestRefund({
          paymentId: payment.id,
          amount: money(30, 'USD'),
          reason: 'customer_request',
          requestedBy: userId,
        }),
      );

      expect(error).toMatchObject({ name: 'RefundError', code: 'AMOUNT_EXCEEDED' });
      expect(await countEvents(db)).toBe(eventsBefore);
    },
  );

  it('a rejected or failed refund frees its amount again', async () => {
    const service = serviceWith(providerThatRefunds);
    const payment = await seedPayment(coreWrites, null, '100');
    const first = await service.requestRefund({
      paymentId: payment.id,
      amount: money(80, 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    });
    await service.rejectRefund({ refundId: first.id, rejectedBy: adminId, reason: 'outside policy' });

    const second = await service.requestRefund({
      paymentId: payment.id,
      amount: money(90, 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    });

    expect(second).toMatchObject({ status: 'pending' });
  });
});

describe('two requests at once for one payment', () => {
  const request = (paymentId: PaymentId, amount: Money) => ({
    paymentId,
    amount,
    reason: 'customer_request' as const,
    requestedBy: userId,
  });

  /** Only a database-level rule can stop this: the service's own reads see no refund yet. */
  it('the database refuses the second pending refund even when the service check sees nothing', async () => {
    const blind = new RefundService(
      { ...refundReads(db), findByPaymentId: () => Promise.resolve([]) },
      writes,
      providerThatRefunds,
      coreReads(db),
      { systemUserId: adminId },
    );
    const payment = await seedPayment(coreWrites, null, '100');
    await blind.requestRefund(request(payment.id, money(40, 'USD')));

    const error = await rejectionOf(blind.requestRefund(request(payment.id, money(20, 'USD'))));

    expect(error).toMatchObject({ name: 'RefundError', code: 'DUPLICATE_PENDING_REFUND' });
    const rows = await db.select().from(refundsTables.refunds).where(eq(refundsTables.refunds.paymentId, payment.id));
    expect(rows).toHaveLength(1);
  });

  /**
   * PGlite has one connection, so its transactions run one after the other: this proves that exactly one
   * of two simultaneous requests wins and the other gets the typed error, not that two connections wait
   * on the payment's row lock. The lock itself needs a real Postgres.
   */
  it('of two simultaneous requests exactly one is stored', async () => {
    const service = serviceWith(providerThatRefunds);
    const payment = await seedPayment(coreWrites, null, '100');

    const results = await Promise.allSettled([
      service.requestRefund(request(payment.id, money(40, 'USD'))),
      service.requestRefund(request(payment.id, money(40, 'USD'))),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected');
    expect(failed?.reason).toMatchObject({ code: 'DUPLICATE_PENDING_REFUND' });
    const rows = await db.select().from(refundsTables.refunds).where(eq(refundsTables.refunds.paymentId, payment.id));
    expect(rows).toHaveLength(1);
  });
});
