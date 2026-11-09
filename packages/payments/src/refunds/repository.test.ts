/**
 * RefundRepository lookups the webhook relies on
 *
 * A `charge.refunded` webhook names the refund by Stripe's id. The lookup must
 * find the row `RefundService` stored it on, and nothing for an id we never saw.
 */
import type { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant } from '@arki/date';
import { FAILURE_ERROR_CODES, orThrow } from '@arki/failure';

import type { RefundWrites } from './journal.js';
import { runnerOn, seedPayment } from '../service-test-support.js';
import { adminId, openDb, refundsTables, rejectionOf, typed, userId } from '../test-support.js';
import { RefundRepository } from './repository.js';

let client: PGlite;
let repo: RefundRepository;
let writes: RefundWrites;
let coreWrites: ReturnType<typeof typed.core.writes>;

const relations = defineRelations({ refunds: refundsTables.refunds }, () => ({}));

beforeAll(async () => {
  const opened = await openDb();
  client = opened.client;
  writes = typed.refunds.writes(runnerOn(opened.db));
  coreWrites = typed.core.writes(runnerOn(opened.db));
  repo = new RefundRepository(drizzle({ client, relations }), refundsTables);
});

afterAll(async () => {
  await client.close();
});

describe('RefundRepository.findByProviderRefundId', () => {
  it('finds the refund that was completed with that Stripe id, and no other', async () => {
    const payment = await seedPayment(coreWrites, null, '25');
    const refund = await orThrow(
      writes.requestRefund({
        paymentId: payment.id,
        originalAmount: { amount: '25', currency: 'USD' },
        refundAmount: { amount: '10', currency: 'USD' },
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );
    await orThrow(writes.approveRefund({ refundId: refund.id, approvedBy: adminId }));
    await orThrow(writes.processRefund({ refundId: refund.id }));
    await orThrow(writes.completeRefund({ refundId: refund.id, providerRefundId: 're_lookup' }));

    expect(await repo.findByProviderRefundId('re_lookup')).toMatchObject({ id: refund.id });
    expect(await repo.findByProviderRefundId('re_unknown')).toBeNull();
  });
});

describe('RefundRepository.findByProviderRefundId with U+0000', () => {
  // No row holds U+0000; Postgres used to refuse the parameter with a raw 22021
  it('finds nothing', async () => {
    expect(await repo.findByProviderRefundId('re_\u0000')).toBeNull();
  });

  // Typed ids (`rfnd${string}`, `pay_${string}`, `usr_${string}`) can hold U+0000 too; each of these sent it and
  // rejected with a raw 22021. The empty answer comes back instead, and no query is sent
  it('finds nothing by a typed id holding U+0000, and totals zero', async () => {
    expect(await repo.findById('rfnd\u0000')).toBeNull();
    expect(await repo.findByPaymentId('pay_\u0000')).toEqual([]);
    expect(await repo.findByUser('usr_\u0000')).toEqual([]);
    expect(await repo.searchRefunds({ userId: 'usr_\u0000' })).toEqual([]);
    const total = await repo.getTotalRefundedAmount('pay_\u0000', 'USD');
    expect(total.toString()).toBe('0.00 USD');
  });
});

describe('RefundRepository.getRefundMetrics', () => {
  // The total was built by spreading every refund as call arguments, which overflows Node's stack past ~100k refunds;
  // it is now folded one refund at a time. This checks the fold keeps one exact total per currency.
  it('adds every refund up per currency, and counts them by status and reason', async () => {
    const before = await repo.getRefundMetrics();
    const usd = await seedPayment(coreWrites, null, '30');
    const eur = await seedPayment(coreWrites, null, '30', 'EUR');
    for (const [payment, amount, currency] of [
      [usd, '10.10', 'USD'],
      [eur, '2.20', 'EUR'],
    ] as const) {
      await orThrow(
        writes.requestRefund({
          paymentId: payment.id,
          originalAmount: { amount: '30', currency },
          refundAmount: { amount, currency },
          reason: 'duplicate_charge',
          requestedBy: userId,
        }),
      );
    }

    const after = await repo.getRefundMetrics();

    expect(after.totalCount).toBe(before.totalCount + 2);
    expect(after.totalAmount.get('USD').minus(before.totalAmount.get('USD')).toMoney().toString()).toBe('10.10 USD');
    expect(after.totalAmount.get('EUR').minus(before.totalAmount.get('EUR')).toMoney().toString()).toBe('2.20 EUR');
    expect(after.byReason.duplicate_charge).toBe((before.byReason.duplicate_charge ?? 0) + 2);
  });

  // Postgres refuses a time past the year 9999 as a parameter (raw 22009); a typed Instant there is the caller's bug
  it('fails as an invariant for a bound past the year 9999, before the query', async () => {
    const error = await rejectionOf(repo.getRefundMetrics(undefined, instant('+010000-01-01T00:00:00Z')));
    expect(error).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
    const searched = await rejectionOf(repo.searchRefunds({ startDate: instant('+010000-01-01T00:00:00Z') }));
    expect(searched).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
  });
});
