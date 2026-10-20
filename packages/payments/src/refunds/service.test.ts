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
import {
  TransactionCancelled,
  TransactionCommitUncertain,
  TransactionConflict,
  TransactionDefect,
  TransactionRejected,
  TransactionUnavailable,
} from '@arki/db/errors';
import { isFailure, orThrow } from '@arki/failure';
import { money } from '@arki/money';

import type { CoreWrites } from '../core/journal.js';
import type { PaymentId } from '../core/types.js';
import type { AppDb } from '../test-support.js';
import type { RefundWrites } from './journal.js';
import type { RefundReason } from './primitives.js';
import type { RefundAutoApproveLimits } from './service.js';
import { toMinorColumn } from '../core/money.js';
import { createPaymentId } from '../core/primitives.js';
import { ReferenceNotFound } from '../core/providers/provider-error.js';
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
import {
  DuplicatePendingRefund,
  RefundAmountExceeded,
  RefundInvalidState,
  RefundNotFound,
  RefundWindowExceeded,
  TransactionNotFound,
} from './failures.js';
import { createRefundId } from './primitives.js';
import { RefundService } from './service.js';
import { pendingRefundIndexName } from './tables.js';

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

  return orThrow(
    serviceWith(providerThatRefunds, autoApproveLimits).requestRefund({
      paymentId: payment.id,
      amount,
      reason,
      requestedBy: userId,
    }),
  );
}

/** A request above the auto-approve limit, for a reason that needs a person to approve. */
async function pendingRefund(service: RefundService, amount = money(40, 'USD')) {
  const payment = await seedPayment(coreWrites, null, '100');

  return orThrow(
    service.requestRefund({ paymentId: payment.id, amount, reason: 'customer_request', requestedBy: userId }),
  );
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

    const refund = await orThrow(
      serviceWith(providerThatRefunds).requestRefund({
        paymentId: payment.id,
        amount: money(5, 'USD'),
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );

    expect(refund).toMatchObject({ status: 'completed', approvedBy: adminId });
    expect(refund.providerRefundId).toBe(refundedAs);
    expect(await eventTypesOf(db, 'refund', refund.id)).toEqual([
      'RefundRequestedV2',
      'RefundApproved',
      'RefundProcessed',
      'RefundCompleted',
    ]);
  });

  it('a refund for a payment we do not know is an answer the caller branches on, and writes nothing', async () => {
    const eventsBefore = await countEvents(db);
    const paymentId = createPaymentId();

    const refused = await serviceWith(providerThatRefunds).requestRefund({
      paymentId,
      amount: money(5, 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    });

    expect(TransactionNotFound.is(refused)).toBe(true);
    expect(refused).toMatchObject({ status: 404, data: { paymentId } });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('a refund for a payment past the refund window is returned as RefundWindowExceeded and pays nothing back', async () => {
    const payment = await seedPayment(coreWrites, null, '100');
    const eventsBefore = await countEvents(db);
    const asked = askedToRefund.length;
    const noWindow = new RefundService(refundReads(db), writes, providerThatRefunds, coreReads(db), {
      systemUserId: adminId,
      refundWindowMs: -1,
    });

    const refused = await noWindow.requestRefund({
      paymentId: payment.id,
      amount: money(5, 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    });

    expect(RefundWindowExceeded.is(refused)).toBe(true);
    expect(refused).toMatchObject({ status: 422, data: { paymentId: payment.id } });
    expect(askedToRefund).toHaveLength(asked);
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('a refund above what was paid is turned down and writes nothing', async () => {
    const payment = await seedPayment(coreWrites, null, '30');
    const eventsBefore = await countEvents(db);

    const refused = await serviceWith(providerThatRefunds).requestRefund({
      paymentId: payment.id,
      amount: money('30.01', 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    });

    expect(RefundAmountExceeded.is(refused)).toBe(true);
    expect(refused).toMatchObject({
      status: 422,
      data: { paymentId: payment.id, requested: '30.01', refundable: '30.00', currency: 'USD' },
    });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('refunds add up exactly: 0.10 then 0.20 of a 0.30 payment is all of it, not a cent over by float drift', async () => {
    const service = serviceWith(providerThatRefunds);
    const payment = await seedPayment(coreWrites, null, '0.30');

    await orThrow(
      service.requestRefund({
        paymentId: payment.id,
        amount: money('0.10', 'USD'),
        reason: 'billing_error',
        requestedBy: userId,
      }),
    );
    const second = await service.requestRefund({
      paymentId: payment.id,
      amount: money('0.20', 'USD'),
      reason: 'billing_error',
      requestedBy: userId,
    });

    expect(second).toMatchObject({ status: 'completed', refundAmountMinor: 20 });
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

    await orThrow(
      serviceWith(providerThatRefunds).requestRefund({
        paymentId: payment.id,
        amount: money(1500, 'JPY'),
        reason: 'billing_error',
        requestedBy: userId,
      }),
    );

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

    const refund = await orThrow(service.approveRefund({ refundId: pending.id, approvedBy: adminId }));

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

  /** A returned "no" from the provider must leave the refund exactly where a thrown one did: failed, not processing. */
  it('when the provider returns a failure, the refund ends failed with its message, and the failure reaches the caller', async () => {
    const providerWithoutThePayment: Provider = {
      refundPayment: paymentId =>
        Promise.resolve(ReferenceNotFound({ kind: 'payment', id: paymentId, missing: 'row' })),
    };
    const service = serviceWith(providerWithoutThePayment);
    const pending = await pendingRefund(service);

    const result = await service.approveRefund({ refundId: pending.id, approvedBy: adminId });

    expect(ReferenceNotFound.is(result)).toBe(true);
    expect(await refundRow(db, pending.id)).toMatchObject({
      status: 'failed',
      providerResponse: JSON.stringify({ error: `payment ${pending.paymentId} not found` }),
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
    await orThrow(service.rejectRefund({ refundId: pending.id, rejectedBy: adminId, reason: 'outside policy' }));
    const eventsBefore = await countEvents(db);

    const refused = await service.approveRefund({ refundId: pending.id, approvedBy: adminId });

    expect(RefundInvalidState.is(refused)).toBe(true);
    expect(refused).toMatchObject({ status: 409, data: { refundId: pending.id, status: 'rejected' } });
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await refundRow(db, pending.id)).toMatchObject({ status: 'rejected' });
  });
});

describe('rejectRefund', () => {
  it('a rejected refund keeps who rejected it and why, with its event', async () => {
    const service = serviceWith(providerThatRefunds);
    const pending = await pendingRefund(service);

    const refund = await orThrow(
      service.rejectRefund({ refundId: pending.id, rejectedBy: adminId, reason: 'outside policy' }),
    );

    expect(refund).toMatchObject({ status: 'rejected', rejectedBy: adminId, rejectionReason: 'outside policy' });
    expect(await eventTypesOf(db, 'refund', pending.id)).toEqual(['RefundRequestedV2', 'RefundRejected']);
  });
});

describe('approval notes, missing refunds, empty reasons and double requests', () => {
  it("the approver's notes are kept on the refund and in its event", async () => {
    const service = serviceWith(providerThatRefunds);
    const pending = await pendingRefund(service);

    const refund = await orThrow(
      service.approveRefund({
        refundId: pending.id,
        approvedBy: adminId,
        notes: 'checked with the customer',
      }),
    );

    expect(refund).toMatchObject({ status: 'completed', approvalNotes: 'checked with the customer' });
    expect(await refundRow(db, pending.id)).toMatchObject({ approvalNotes: 'checked with the customer' });
  });

  it('an approval without notes leaves them empty', async () => {
    const service = serviceWith(providerThatRefunds);
    const pending = await pendingRefund(service);

    const refund = await orThrow(service.approveRefund({ refundId: pending.id, approvedBy: adminId }));

    expect(refund.approvalNotes).toBeNull();
  });

  it('approving a refund that does not exist returns RefundNotFound, which the caller can tell from an outage', async () => {
    const eventsBefore = await countEvents(db);
    const refundId = createRefundId();

    const refused = await serviceWith(providerThatRefunds).approveRefund({ refundId, approvedBy: adminId });

    expect(RefundNotFound.is(refused)).toBe(true);
    expect(refused).toMatchObject({ status: 404, data: { refundId } });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('rejecting a refund that does not exist returns RefundNotFound', async () => {
    const refused = await serviceWith(providerThatRefunds).rejectRefund({
      refundId: createRefundId(),
      rejectedBy: adminId,
      reason: 'no',
    });

    expect(RefundNotFound.is(refused)).toBe(true);
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
    await orThrow(
      service.requestRefund({
        paymentId: payment.id,
        amount: money(40, 'USD'),
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );
    const eventsBefore = await countEvents(db);

    const refused = await service.requestRefund({
      paymentId: payment.id,
      amount: money(20, 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    });

    expect(DuplicatePendingRefund.is(refused)).toBe(true);
    expect(refused).toMatchObject({ status: 409, data: { paymentId: payment.id } });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('once the first refund is decided, the payment can be refunded again', async () => {
    const service = serviceWith(providerThatRefunds);
    const payment = await seedPayment(coreWrites, null, '100');
    const first = await orThrow(
      service.requestRefund({
        paymentId: payment.id,
        amount: money(40, 'USD'),
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );
    await orThrow(service.rejectRefund({ refundId: first.id, rejectedBy: adminId, reason: 'outside policy' }));

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
    'a %s refund already counts: a request over the rest is refused with RefundAmountExceeded',
    async stage => {
      const payment = await seedPayment(coreWrites, null, '100');
      const earlier = await orThrow(
        writes.requestRefund({
          paymentId: payment.id,
          originalAmount: { amount: '100', currency: 'USD' },
          refundAmount: { amount: '80', currency: 'USD' },
          reason: 'customer_request',
          requestedBy: userId,
        }),
      );
      await orThrow(writes.approveRefund({ refundId: earlier.id, approvedBy: adminId }));
      if (stage === 'processing') {
        await orThrow(writes.processRefund({ refundId: earlier.id }));
      }
      const eventsBefore = await countEvents(db);

      const refused = await serviceWith(providerThatRefunds).requestRefund({
        paymentId: payment.id,
        amount: money(30, 'USD'),
        reason: 'customer_request',
        requestedBy: userId,
      });

      expect(refused).toMatchObject({ code: 'payments.refund_amount_exceeded', data: { refundable: '20.00' } });
      expect(await countEvents(db)).toBe(eventsBefore);
    },
  );

  it('a rejected or failed refund frees its amount again', async () => {
    const service = serviceWith(providerThatRefunds);
    const payment = await seedPayment(coreWrites, null, '100');
    const first = await orThrow(
      service.requestRefund({
        paymentId: payment.id,
        amount: money(80, 'USD'),
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );
    await orThrow(service.rejectRefund({ refundId: first.id, rejectedBy: adminId, reason: 'outside policy' }));

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
    await orThrow(blind.requestRefund(request(payment.id, money(40, 'USD'))));

    const refused = await blind.requestRefund(request(payment.id, money(20, 'USD')));

    expect(DuplicatePendingRefund.is(refused)).toBe(true);
    if (!DuplicatePendingRefund.is(refused)) throw new Error('expected the pending-refund refusal');
    expect(TransactionRejected.is(refused.cause)).toBe(true);
    expect(JSON.stringify(refused)).not.toContain('constraint');
    const rows = await db.select().from(refundsTables.refunds).where(eq(refundsTables.refunds.paymentId, payment.id));
    expect(rows).toHaveLength(1);
  });

  /**
   * PGlite has one connection, so its transactions run one after the other: this proves that exactly one
   * of two simultaneous requests wins and the other gets DuplicatePendingRefund, not that two connections wait
   * on the payment's row lock. The lock itself needs a real Postgres.
   */
  it('of two simultaneous requests exactly one is stored', async () => {
    const service = serviceWith(providerThatRefunds);
    const payment = await seedPayment(coreWrites, null, '100');

    const results = await Promise.all([
      service.requestRefund(request(payment.id, money(40, 'USD'))),
      service.requestRefund(request(payment.id, money(40, 'USD'))),
    ]);

    expect(results.filter(result => DuplicatePendingRefund.is(result))).toHaveLength(1);
    expect(results.filter(result => !isFailure(result))).toHaveLength(1);
    const rows = await db.select().from(refundsTables.refunds).where(eq(refundsTables.refunds.paymentId, payment.id));
    expect(rows).toHaveLength(1);
  });
});

describe('transaction failures before a refund is requested', () => {
  const pendingConflict = new Error('query failed', {
    cause: Object.assign(new Error('duplicate pending refund'), { constraint: pendingRefundIndexName }),
  });

  it.each([
    TransactionConflict({ attempts: 1, sqlState: '40001' }, { cause: pendingConflict }),
    TransactionUnavailable({ cause: pendingConflict }),
    TransactionCommitUncertain({ cause: pendingConflict }),
    TransactionCancelled({ cause: pendingConflict }),
    TransactionDefect({ cause: pendingConflict }),
    TransactionRejected({ sqlState: '23503' }, { cause: pendingConflict }),
    TransactionRejected(
      { sqlState: '23505' },
      {
        cause: Object.assign(new Error('another unique constraint'), { constraint: 'refunds_pkey' }),
      },
    ),
    TransactionRejected({ sqlState: '23505' }),
  ])('preserves $code and its cause without retrying or calling the provider', async failure => {
    let attempts = 0;
    const service = new RefundService(
      refundReads(db),
      {
        ...writes,
        requestRefund: () => {
          attempts += 1;
          return Promise.resolve(failure);
        },
      },
      providerThatRefunds,
      coreReads(db),
      { systemUserId: adminId },
    );
    const payment = await seedPayment(coreWrites, null, '100');
    const eventsBefore = await countEvents(db);
    const providerCallsBefore = askedToRefund.length;

    const result = await service.requestRefund({
      paymentId: payment.id,
      amount: money(1, 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    });

    expect(result).toBe(failure);
    expect(attempts).toBe(1);
    expect(askedToRefund).toHaveLength(providerCallsBefore);
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(
      await db.select().from(refundsTables.refunds).where(eq(refundsTables.refunds.paymentId, payment.id)),
    ).toHaveLength(0);
  });
});
