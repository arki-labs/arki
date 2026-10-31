/**
 * PaymentRepository on a plain database
 *
 * The repository reads with `select` and joins, so it must work on `drizzle({ client })` with
 * no relations registered. With the relational query builder, `db.query.plans` was undefined
 * there and every read threw a TypeError. The joined reads must still hand back the plan and
 * the customer inside each subscription, and the subscription (with its plan) inside each payment.
 */
import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant } from '@arki/date';
import { FAILURE_ERROR_CODES, FailureError, orThrow } from '@arki/failure';

import { runnerOn, seedPayment, seedSubscription } from '../service-test-support.js';
import { core, customerId, openDb, planId, rejectionOf, typed, userId } from '../test-support.js';
import { createCustomerId, createPlanId, createSubscriptionId } from './primitives.js';
import { PaymentRepository } from './repository.js';


/** The ids of the rows a read resolves to. */
async function idsOf<Row extends { id: string }>(rows: Promise<Row[]>): Promise<string[]> {
  const resolved = await rows;
  return resolved.map(row => row.id);
}
/** One field of the row a read resolves to, `undefined` when there is no row. */
async function valueOf<Row, Key extends keyof Row>(row: Promise<Row | null | undefined>, key: Key) {
  const resolved = await row;
  return resolved?.[key];
}

let client: PGlite;
let db: Awaited<ReturnType<typeof openDb>>['db'];
let repo: PaymentRepository;
let writes: ReturnType<typeof typed.core.writes>;

beforeAll(async () => {
  const opened = await openDb();
  client = opened.client;
  db = opened.db;
  repo = new PaymentRepository(db, core);
  writes = typed.core.writes(runnerOn(db));
});

afterAll(async () => {
  await client.close();
});

describe('reads on a database without relations', () => {
  it('reads plans and customers', async () => {
    expect((await valueOf(repo.findPlanById(planId), 'name'))).toBe('Pro');
    expect((await idsOf(repo.findActivePlans()))).toContain(planId);
    expect((await idsOf(repo.findPlans({ isActive: true, limit: 10, offset: 0 })))).toContain(planId);
    expect((await idsOf(repo.findPlansByTier('basic')))).toContain(planId);
    expect((await valueOf(repo.findCustomerById(customerId), 'email'))).toBe('buyer@example.com');
    expect((await valueOf(repo.findCustomerByUserId(userId), 'id'))).toBe(customerId);
    expect((await valueOf(repo.findCustomerByProviderCustomerId('cus_test', 'stripe'), 'id'))).toBe(customerId);
    expect(await repo.findCustomerById(orThrow(createCustomerId()))).toBeNull();
  });

  it('loads the plan and the customer of each subscription', async () => {
    const seeded = await seedSubscription(writes, 'active');

    const byId = await repo.findSubscriptionById(seeded.id);
    expect(byId?.plan.id).toBe(planId);
    expect(byId?.plan.name).toBe('Pro');
    expect(byId?.customer?.id).toBe(customerId);

    const active = await repo.findActiveSubscriptionByUserId(userId);
    expect(active?.plan.id).toBe(planId);

    const byProvider = await repo.findSubscriptionByProviderSubscriptionId(seeded.providerSubscriptionId);
    expect(byProvider?.id).toBe(seeded.id);
    expect(byProvider).toMatchObject({ plan: { id: planId }, customer: { id: customerId } });

    const listed = await repo.findSubscriptions({ userId, limit: 50, offset: 0 });
    expect(listed.map(row => row.id)).toContain(seeded.id);
    expect(listed[0]).toMatchObject({ plan: { id: planId }, customer: { id: customerId } });

    expect((await idsOf(repo.findSubscriptionsByUserId(userId)))).toContain(seeded.id);
    expect((await idsOf(repo.findSubscriptionsByStatus('active')))).toContain(seeded.id);
    const ending = repo.findSubscriptionsEndingInRange(instant('2026-01-31T00:00:00Z'), instant('2026-02-02T00:00:00Z'));
    expect(await idsOf(ending)).toContain(seeded.id);
    expect(await repo.findSubscriptionById(orThrow(createSubscriptionId()))).toBeNull();
  });

  it('loads the subscription, its plan and the customer of a payment, and no subscription when it has none', async () => {
    const subscription = await seedSubscription(writes, 'active');
    const withSubscription = await seedPayment(writes, subscription.id);
    const withoutSubscription = await seedPayment(writes, null);

    const joined = await repo.findPaymentById(withSubscription.id);
    expect(joined).toMatchObject({
      subscription: { id: subscription.id, plan: { id: planId } },
      customer: { id: customerId },
    });

    const alone = await repo.findPaymentById(withoutSubscription.id);
    expect(alone?.id).toBe(withoutSubscription.id);
    expect(alone).toMatchObject({ customer: { id: customerId } });
    expect(alone).not.toHaveProperty('subscription.id');

    const byProvider = await repo.findPaymentByProviderPaymentId(withSubscription.providerPaymentId);
    expect(byProvider).toMatchObject({ id: withSubscription.id, subscription: { plan: { id: planId } } });

    const listed = await repo.findPayments({ userId, limit: 50, offset: 0 });
    const ids = listed.map(payment => payment.id);
    expect(ids).toContain(withSubscription.id);
    expect(ids).toContain(withoutSubscription.id);

    expect((await idsOf(repo.findPaymentsBySubscriptionId(subscription.id)))).toEqual([
      withSubscription.id,
    ]);
    expect((await idsOf(repo.findPaymentsByUserId(userId, 50)))).toContain(withSubscription.id);
    expect((await idsOf(repo.findPaymentsByStatus('pending')))).toContain(withoutSubscription.id);
  });

  it('reads the stats with the plan of each subscription and of each payment subscription', async () => {
    const subscription = await seedSubscription(writes, 'active');
    const payment = await seedPayment(writes, subscription.id);

    const subscriptionStats = await repo.getSubscriptionStats();
    expect(subscriptionStats.find(row => row.id === subscription.id)?.plan?.id).toBe(planId);

    const paymentStats = await repo.getPaymentStats();
    expect(paymentStats.find(row => row.id === payment.id)?.subscription?.plan?.id).toBe(planId);

    expect(await repo.getPaymentStats(instant('2999-01-01T00:00:00Z'))).toEqual([]);
    expect(await repo.getSubscriptionStats(undefined, instant('1999-01-01T00:00:00Z'))).toEqual([]);
  });

  it('reads webhook events', async () => {
    const created = await repo.createWebhookEvent({
      provider: 'stripe',
      eventType: 'customer.created',
      providerEventId: 'evt_no_relations',
      data: {},
    });

    expect((await valueOf(repo.findWebhookEventById(created.id), 'providerEventId'))).toBe('evt_no_relations');
    expect((await valueOf(repo.findWebhookEventByProviderEventId('evt_no_relations', 'stripe'), 'id'))).toBe(created.id);
    expect((await idsOf(repo.findUnprocessedWebhookEvents()))).toContain(created.id);
    expect((await idsOf(repo.findWebhookEventsByType('customer.created')))).toContain(created.id);
  });
});

describe('an insert that returns no row', () => {
  it('createPlan fails with the invariant failure code', async () => {
    await db.execute(
      sql`CREATE FUNCTION pay.skip_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER skip_plan_insert BEFORE INSERT ON pay.plans FOR EACH ROW EXECUTE FUNCTION pay.skip_row()`,
    );

    try {
      const error = await rejectionOf(repo.createPlan({ id: orThrow(createPlanId()), name: 'Skipped', priceMinor: 1 }));

      expect(error).toBeInstanceOf(FailureError);
      expect(error).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
    } finally {
      await db.execute(sql`DROP TRIGGER skip_plan_insert ON pay.plans`);
    }
  });
});
