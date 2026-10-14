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

import type { RefundWrites } from './journal.js';
import { runnerOn, seedPayment } from '../service-test-support.js';
import { adminId, openDb, refundsTables, typed, userId } from '../test-support.js';
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
    const refund = await writes.requestRefund({
      paymentId: payment.id,
      originalAmount: { amount: '25', currency: 'USD' },
      refundAmount: { amount: '10', currency: 'USD' },
      reason: 'customer_request',
      requestedBy: userId,
    });
    await writes.approveRefund({ refundId: refund.id, approvedBy: adminId });
    await writes.processRefund({ refundId: refund.id });
    await writes.completeRefund({ refundId: refund.id, providerRefundId: 're_lookup' });

    expect(await repo.findByProviderRefundId('re_lookup')).toMatchObject({ id: refund.id });
    expect(await repo.findByProviderRefundId('re_unknown')).toBeNull();
  });
});
