// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * PaymentRepository list filters, on the real relational queries
 *
 * A list that ignores a filter shows a customer rows they did not ask for, and
 * a list that ignores `userId` shows them someone else's. These tests run
 * `findPlans`, `findSubscriptions` and `findPayments` on PGlite with the
 * relations an app registers.
 */
import type { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { add, instant, now } from '@arki/date';
import { orThrow } from '@arki/failure';

import type { PaymentQuery, PlanQuery, SubscriptionQuery } from './contracts.js';
import { runnerOn, seedPayment, seedSubscription } from '../service-test-support.js';
import { adminId, core, openDb, planId, typed } from '../test-support.js';
import { createCustomerId, createPlanId } from './primitives.js';
import { PaymentRepository } from './repository.js';

const relations = defineRelations(
  { plans: core.plans, customers: core.customers, subscriptions: core.subscriptions, payments: core.payments },
  r => ({
    subscriptions: {
      plan: r.one.plans({ from: r.subscriptions.planId, to: r.plans.id }),
      customer: r.one.customers({ from: r.subscriptions.customerId, to: r.customers.id }),
    },
    payments: {
      subscription: r.one.subscriptions({ from: r.payments.subscriptionId, to: r.subscriptions.id }),
      customer: r.one.customers({ from: r.payments.customerId, to: r.customers.id }),
    },
  }),
);

let client: PGlite;
let repo: PaymentRepository;
let writes: ReturnType<typeof typed.core.writes>;
const proPlanId = orThrow(createPlanId());
const otherCustomerId = orThrow(createCustomerId());

const page = { limit: 50, offset: 0 };

beforeAll(async () => {
  const opened = await openDb();
  client = opened.client;
  const db = opened.db;
  repo = new PaymentRepository(drizzle({ client, relations }), core);
  writes = typed.core.writes(runnerOn(db));

  await db.insert(core.plans).values([
    { id: proPlanId, name: 'Pro monthly', tier: 'pro', priceMinor: 2000, interval: 'monthly' },
    { id: orThrow(createPlanId()), name: 'Pro yearly', tier: 'pro', priceMinor: 20_000, interval: 'yearly' },
    { id: orThrow(createPlanId()), name: 'Retired', tier: 'premium', priceMinor: 900, isActive: false },
  ]);
  await db
    .insert(core.customers)
    .values({ id: otherCustomerId, userId: adminId, providerCustomerId: 'cus_admin', email: 'admin@example.com' });

  // The buyer: one active and one canceled subscription; the admin: one active on the Pro plan
  await seedSubscription(writes, 'active');
  await seedSubscription(writes, 'canceled');
  await orThrow(
    writes.createSubscription({
      userId: adminId,
      planId: proPlanId,
      customerId: otherCustomerId,
      providerSubscriptionId: 'psub_admin',
      status: 'active',
      currentPeriodStart: instant('2026-01-01T00:00:00Z'),
      currentPeriodEnd: instant('2026-02-01T00:00:00Z'),
      canceledAt: null,
    }),
  );

  const done = await seedPayment(writes, null);
  await orThrow(writes.completePayment({ paymentId: done.id }));
  const failed = await seedPayment(writes, null);
  await orThrow(writes.failPayment({ paymentId: failed.id, failureReason: 'declined' }));
  await seedPayment(writes, null);
});

afterAll(async () => {
  await client.close();
});

const plans = (query: Partial<PlanQuery>) => repo.findPlans({ ...page, ...query });
const subscriptions = (query: Partial<SubscriptionQuery>) => repo.findSubscriptions({ ...page, ...query });
const payments = (query: Partial<PaymentQuery>) => repo.findPayments({ ...page, ...query });

describe('findPlans', () => {
  it('returns only the tier asked for', async () => {
    const result = await plans({ tier: 'pro' });

    expect(result.map(plan => plan.name)).toEqual(['Pro monthly', 'Pro yearly']);
  });

  it('filters by interval and by active state', async () => {
    const rows1 = await plans({ interval: 'yearly' });
    expect(rows1.map(plan => plan.name)).toEqual(['Pro yearly']);
    const rows2 = await plans({ isActive: false });
    expect(rows2.map(plan => plan.name)).toEqual(['Retired']);
  });

  it('returns every plan without a filter, and pages them', async () => {
    expect(await plans({})).toHaveLength(4);
    expect(await plans({ limit: 2, offset: 3 })).toHaveLength(1);
  });

  it('finds the fixture plan under its default tier', async () => {
    const rows3 = await plans({ tier: 'basic' });
    expect(rows3.map(plan => plan.id)).toEqual([planId]);
  });
});

describe('findSubscriptions', () => {
  it('returns only the status asked for', async () => {
    const result = await subscriptions({ status: 'canceled' });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: 'canceled', plan: { id: planId } });
  });

  it('returns only one user’s subscriptions', async () => {
    const result = await subscriptions({ userId: adminId });

    expect(result.map(subscription => subscription.userId)).toEqual([adminId]);
  });

  it('filters by plan, and combines filters', async () => {
    expect(await subscriptions({ planId: proPlanId })).toHaveLength(1);
    expect(await subscriptions({ planId, status: 'active' })).toHaveLength(1);
    expect(await subscriptions({ planId: proPlanId, status: 'canceled' })).toEqual([]);
  });

  it('pages the newest first', async () => {
    const all = await subscriptions({});
    const second = await subscriptions({ limit: 1, offset: 1 });

    expect(all).toHaveLength(3);
    expect(second.map(row => row.id)).toEqual([all[1]?.id]);
  });
});

describe('findPayments', () => {
  it('returns only the status asked for', async () => {
    const rows4 = await payments({ status: 'succeeded' });
    expect(rows4.map(payment => payment.status)).toEqual(['succeeded']);
    const rows5 = await payments({ status: 'failed' });
    expect(rows5.map(payment => payment.status)).toEqual(['failed']);
    expect(await payments({ status: 'pending' })).toHaveLength(1);
  });

  it('returns only one user’s payments', async () => {
    expect(await payments({ userId: adminId })).toEqual([]);
    expect(await payments({})).toHaveLength(3);
  });

  it('bounds the list by creation date', async () => {
    expect(await payments({ startDate: add(now(), { hours: 1 }) })).toEqual([]);
    expect(await payments({ endDate: instant('2020-01-01T00:00:00Z') })).toEqual([]);
    expect(
      await payments({ startDate: instant('2020-01-01T00:00:00Z'), endDate: add(now(), { hours: 1 }) }),
    ).toHaveLength(3);
  });

  it('filters by subscription', async () => {
    const subscription = await seedSubscription(writes, 'active');
    const payment = await seedPayment(writes, subscription.id);

    const rows6 = await payments({ subscriptionId: subscription.id });
    expect(rows6.map(row => row.id)).toEqual([payment.id]);
  });
});
