/**
 * Shared pieces of the service tests
 *
 * A service reads through a repository and writes through the journal. The
 * real repositories read with node-postgres and the app's relations. The
 * package tests run on PGlite, so `coreReads` and `refundReads` read the same
 * tables with plain selects. Nothing here writes a table directly: seeds go
 * through the same commands the services use.
 */
import { and, eq, gte, lte } from 'drizzle-orm';

import type { UserId } from './core/user-id.js';
import type { Instant } from '@arki/date';
import { instant } from '@arki/date';

import type { CoreWrites } from './core/journal.js';
import type { Payment, PaymentId, PlanId, Subscription, SubscriptionId, SubscriptionStatus } from './core/types.js';
import type { RefundId } from './refunds/primitives.js';
import type { AppDb } from './test-support.js';
import { core, customerId, meta, planId, refundsTables, typed, userId } from './test-support.js';

const { customers, payments, plans, subscriptions } = core;
const { refunds } = refundsTables;

/** The app's command runner, as a service gets it: here it runs on the test database. */
export function runnerOn(db: AppDb): Parameters<typeof typed.core.writes>[0] {
  return (command, input) => typed.journal.run(db, command, input, meta);
}

/** The reads of the payments repository that the services use. */
export function coreReads(db: AppDb) {
  async function withPlan<Row extends { planId: PlanId }>(row: Row | undefined) {
    if (!row) {
      return null;
    }

    const [plan] = await db.select().from(plans).where(eq(plans.id, row.planId));

    if (!plan) {
      throw new Error(`plan ${row.planId} is missing`);
    }

    return { ...row, plan };
  }

  return {
    async findPlanById(id: PlanId) {
      const [plan] = await db.select().from(plans).where(eq(plans.id, id));

      return plan ?? null;
    },
    async findCustomerByUserId(ownerId: UserId) {
      const [customer] = await db.select().from(customers).where(eq(customers.userId, ownerId));

      return customer ?? null;
    },
    async findSubscriptionById(id: SubscriptionId) {
      const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));

      return withPlan(row);
    },
    async findActiveSubscriptionByUserId(ownerId: UserId) {
      const [row] = await db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, ownerId), eq(subscriptions.status, 'active')));

      return withPlan(row);
    },
    async findSubscriptionsByUserId(ownerId: UserId) {
      return db.select().from(subscriptions).where(eq(subscriptions.userId, ownerId));
    },
    async findSubscriptionsByStatus(status: SubscriptionStatus) {
      return db.select().from(subscriptions).where(eq(subscriptions.status, status));
    },
    async findSubscriptionsEndingInRange(startDate: Instant, endDate: Instant) {
      return db
        .select()
        .from(subscriptions)
        .where(and(gte(subscriptions.currentPeriodEnd, startDate), lte(subscriptions.currentPeriodEnd, endDate)));
    },
    async getSubscriptionStats() {
      return db.select().from(subscriptions);
    },
    async getPaymentStats() {
      return db.select().from(payments);
    },
    async findPaymentById(id: PaymentId) {
      const [row] = await db.select().from(payments).where(eq(payments.id, id));

      return row ?? null;
    },
  };
}

function notCovered(name: string) {
  return () => Promise.reject(new Error(`${name} is not covered by the service tests`));
}

/** The refund reads `RefundService` uses to decide. Its report queries are not part of these tests. */
export function refundReads(db: AppDb) {
  return {
    async findById(refundId: RefundId) {
      const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId));

      return row ?? null;
    },
    async findByProviderRefundId(providerRefundId: string) {
      const [row] = await db.select().from(refunds).where(eq(refunds.providerRefundId, providerRefundId));

      return row ?? null;
    },
    async findByPaymentId(paymentId: PaymentId) {
      return db.select().from(refunds).where(eq(refunds.paymentId, paymentId));
    },
    getRefundMetrics: notCovered('getRefundMetrics'),
    getAverageProcessingTime: notCovered('getAverageProcessingTime'),
    searchRefunds: notCovered('searchRefunds'),
  };
}

/** A provider method the test does not expect the service to call. */
export function unexpectedCall(name: string) {
  return () => Promise.reject(new Error(`unexpected provider call: ${name}`));
}

let next = 0;

/** A stored subscription in the given status, written by the `createSubscription` command. */
export function seedSubscription(writes: CoreWrites, status: SubscriptionStatus): Promise<Subscription> {
  next += 1;

  return writes.createSubscription({
    userId,
    planId,
    customerId,
    providerSubscriptionId: `psub_service_${next}`,
    status,
    currentPeriodStart: instant('2026-01-01T00:00:00.000Z'),
    currentPeriodEnd: instant('2026-02-01T00:00:00.000Z'),
    canceledAt: status === 'canceled' ? instant('2026-01-15T00:00:00.000Z') : null,
  });
}

/** A stored `pending` payment, written by the `initiatePayment` command. */
export function seedPayment(
  writes: CoreWrites,
  subscriptionId: SubscriptionId | null,
  amount = '25',
  currency = 'USD',
): Promise<Payment> {
  next += 1;

  return writes.initiatePayment({
    subscriptionId,
    userId,
    customerId,
    providerPaymentId: `pi_service_${next}`,
    amount: { amount, currency },
  });
}

export async function subscriptionRow(db: AppDb, subscriptionId: SubscriptionId) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));

  return row;
}

export async function refundRow(db: AppDb, refundId: RefundId) {
  const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId));

  return row;
}
