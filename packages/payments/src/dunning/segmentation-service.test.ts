// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.

/**
 * CustomerSegmentationService in a named schema
 *
 * The segment queries mix core tables (customers, payments, subscriptions,
 * plans) into raw SQL. Each table must carry its schema, the spend subquery
 * must name its `total` column, and counts must come back as numbers. These
 * tests run the real queries on PGlite under `pgSchema('pay')`.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { add, now, sub } from '@arki/date';
import { orThrow } from '@arki/failure';
import { UnknownCurrency } from '@arki/money';

import { fromMinorColumn } from '../core/money.js';
import { createCustomerId, createPaymentId, createSubscriptionId } from '../core/primitives.js';
import { userIdFactory } from '../core/user-id.js';
import { core, planId, schema, users } from '../test-support.js';
import { CustomerSegmentationService } from './services/segmentation-service.js';
import { createDunningTables } from './tables.js';

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});

const tables = { customerSegments: dunning.customerSegments, customerRiskProfiles: dunning.customerRiskProfiles };
// The engagement query reads `db.query.customers`, so the core tables are in the relations too
const relations = defineRelations(
  {
    ...tables,
    customers: core.customers,
    payments: core.payments,
    subscriptions: core.subscriptions,
    plans: core.plans,
  },
  () => ({}),
);

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof relations>>;
let service: CustomerSegmentationService;

async function newCustomer(label: string) {
  const owner = orThrow(userIdFactory.create());
  const id = orThrow(createCustomerId());
  await db.insert(users).values({ id: owner });
  await db
    .insert(core.customers)
    .values({ id, userId: owner, providerCustomerId: `cus_${label}`, email: `${label}@example.com` });

  return { id, owner };
}

async function pay(buyer: Awaited<ReturnType<typeof newCustomer>>, amountMinor: number, currency = 'EUR') {
  const id = orThrow(createPaymentId());
  await db.insert(core.payments).values({
    id,
    userId: buyer.owner,
    customerId: buyer.id,
    providerPaymentId: `pi_${id}`,
    amountMinor,
    currency,
    status: 'succeeded',
  });
}

beforeAll(async () => {
  // Bigint (OID 20) as text, the way node-postgres delivers COUNT and SUM
  client = new PGlite('memory://', { parsers: { 20: (value: string) => value } });
  await client.waitReady;
  db = drizzle({ client, relations });
  const { apply } = await pushSchema(
    {
      schema,
      users,
      ...core.enums,
      plans: core.plans,
      customers: core.customers,
      subscriptions: core.subscriptions,
      payments: core.payments,
      ...dunning.enums,
      ...tables,
    },
    db,
  );
  await apply();
  service = new CustomerSegmentationService(
    db,
    { customers: core.customers, payments: core.payments, subscriptions: core.subscriptions, plans: core.plans },
    tables,
  );
});

afterAll(async () => {
  await client.close();
});

describe('segment criteria', () => {
  it('totalSpent: only customers whose spend in the range currency reaches the minimum match', async () => {
    const big = await newCustomer('bigspender');
    const small = await newCustomer('smallspender');
    await pay(big, 3000);
    await pay(big, 2000);
    await pay(small, 500);

    const matches = orThrow(await service.getCustomersMatchingCriteria({
      totalSpent: { min: fromMinorColumn(1000, 'EUR').toJSON() },
    }));

    expect(matches.map(row => row.id)).toEqual([big.id]);
  });

  it('totalSpent: a stored range `@arki/money` refuses is returned as its failure, not read as a filter', async () => {
    const range = { totalSpent: { min: { amount: '10', currency: 'ZZZ' } } };

    expect(UnknownCurrency.is(await service.getCustomersMatchingCriteria(range))).toBe(true);
    expect(UnknownCurrency.is(await service['calculateSegmentCustomerCount'](range))).toBe(true);
  });

  it('createSegment and updateSegment with a bad spend range return the failure and write nothing', async () => {
    const before = await db.select().from(tables.customerSegments);
    const bad = { totalSpent: { min: { amount: '10', currency: 'ZZZ' } } };

    const created = await service.createSegment({ name: 'Bad range', type: 'custom', criteria: bad, autoUpdate: true, updateFrequency: 24 }, 'usr_admin');
    expect(UnknownCurrency.is(created)).toBe(true);
    expect(await db.select().from(tables.customerSegments)).toHaveLength(before.length);

    const good = orThrow(await service.createSegment({ name: 'Good', type: 'custom', criteria: {}, autoUpdate: false, updateFrequency: 24 }, 'usr_admin'));
    const updated = await service.updateSegment(good.id, { criteria: bad });
    expect(UnknownCurrency.is(updated)).toBe(true);
    expect((await service.getSegment(good.id))?.criteria).toEqual({});
  });

  it('a segment stored with a range money refuses makes every method that reads it return the failure', async () => {
    const [stored] = await db
      .insert(tables.customerSegments)
      .values({
        name: 'Stored bad range',
        type: 'custom',
        criteria: { totalSpent: { min: { amount: '10', currency: 'ZZZ' } } },
        autoUpdate: false,
        updateFrequency: 24,
        createdBy: 'usr_admin',
      })
      .returning();
    if (!stored) throw new Error('the segment was not stored');
    const buyer = await newCustomer('badsegment');
    await pay(buyer, 1000);

    try {
      expect(UnknownCurrency.is(await service.updateSegmentCustomerCount(stored.id))).toBe(true);
      expect(UnknownCurrency.is(await service.getCustomersInSegment(stored.id))).toBe(true);
      expect(UnknownCurrency.is(await service.getCustomerSegments(buyer.id))).toBe(true);
      expect(UnknownCurrency.is(await service.updateCustomerRiskProfile(buyer.id))).toBe(true);
    } finally {
      await db.delete(tables.customerSegments).where(eq(tables.customerSegments.id, stored.id));
    }
  });

  it('planTier: customers on a plan of that tier match', async () => {
    const pro = await newCustomer('protier');
    await newCustomer('notier');
    await db.insert(core.plans).values({ id: planId, name: 'Pro', tier: 'pro', priceMinor: 1999 });
    await db.insert(core.subscriptions).values({
      id: orThrow(createSubscriptionId()),
      userId: pro.owner,
      planId,
      customerId: pro.id,
      providerSubscriptionId: 'sub_pro',
      status: 'active',
      currentPeriodStart: sub(now(), { hours: 24 }),
      currentPeriodEnd: add(now(), { hours: 24 }),
    });

    const matches = orThrow(await service.getCustomersMatchingCriteria({ planTier: ['pro'] }));

    expect(matches.map(row => row.id)).toEqual([pro.id]);
  });

  it('counts the matching customers as a number', async () => {
    const count = orThrow(await service['calculateSegmentCustomerCount']({}));

    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThan(0);
  });
});

describe('customer history', () => {
  it('payment, subscription and engagement counts are numbers', async () => {
    const buyer = await newCustomer('history');
    await pay(buyer, 1500);

    const payments = await service['getCustomerPaymentHistory'](buyer.id);
    const subscriptions = await service['getCustomerSubscriptionHistory'](buyer.id);
    const engagement = await service['getCustomerEngagementMetrics'](buyer.id);

    expect(payments).toMatchObject({ totalPayments: 1, successfulPayments: 1, failedPayments: 0 });
    expect(subscriptions).toMatchObject({ totalSubscriptions: 0, activeSubscriptions: 0 });
    expect(typeof engagement.score).toBe('number');
  });

  it('averages in one currency, the one with most payments, and names it, never mixing currencies', async () => {
    const buyer = await newCustomer('twocurrencies');
    await pay(buyer, 1000, 'EUR');
    await pay(buyer, 3000, 'EUR');
    await pay(buyer, 900_000, 'JPY');

    const payments = await service['getCustomerPaymentHistory'](buyer.id);
    const profile = orThrow(await service.updateCustomerRiskProfile(buyer.id));

    expect(payments).toMatchObject({ totalPayments: 3, successfulPayments: 3, averageAmount: 2000, currency: 'EUR' });
    expect(profile.paymentHistory).toMatchObject({ averageAmount: 2000, currency: 'EUR' });
  });
});
