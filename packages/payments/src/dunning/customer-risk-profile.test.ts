/**
 * Customer risk profile dates on the way back from Postgres
 *
 * `risk_score`, `payment_history` and `engagement_metrics` are jsonb. Postgres
 * returns their dates as ISO text, but the column types say `Instant`. Code
 * that calls `isBefore` on them would break at runtime, so every read of the
 * table (`CustomerRiskProfileRepository`) turns the text back into an Instant.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instant } from '@arki/date';
import { instant, isInstant } from '@arki/date';
import { orThrow } from '@arki/failure';
import { AssertError } from '@arki/schema';

import type { CustomerRiskProfile } from './types.js';
import { createCustomerId } from '../core/primitives.js';
import { ReferenceNotFound } from '../core/providers/provider-error.js';
import { userIdFactory } from '../core/user-id.js';
import { core, customerId, schema, userId, users } from '../test-support.js';
import { createCustomerRiskProfileRepository } from './repository.js';
import { readCustomerRiskProfile } from './stored-risk-profile.js';
import { createDunningTables } from './tables.js';

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});

let client: PGlite;
let db: PgliteDatabase;

const calculatedAt = instant('2026-03-04T05:06:07.123Z');
const paidAt = instant('2026-02-01T10:00:00Z');
const activeAt = instant('2026-03-01T08:30:00Z');

function profile(): Omit<CustomerRiskProfile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    customerId,
    segmentIds: [],
    riskScore: {
      overall: 40,
      factors: { recency: 0.4 },
      category: 'medium',
      lastCalculated: calculatedAt,
      trends: { direction: 'stable', changePercent: 0, timeframe: 30 },
    },
    paymentHistory: {
      totalPayments: 3,
      successfulPayments: 2,
      failedPayments: 1,
      averageAmount: 1000,
      lastPaymentDate: paidAt,
      streakDays: 5,
    },
    subscriptionHistory: {
      totalSubscriptions: 1,
      activeSubscriptions: 1,
      canceledSubscriptions: 0,
      averageDuration: 90,
    },
    engagementMetrics: { score: 70, lastActivity: activeAt, activityFrequency: 3, featureUsage: {} },
    communicationPreferences: { unsubscribed: false, unsubscribedChannels: [] },
    metadata: null,
  };
}

function expectInstantAt(value: Instant | undefined, expected: Instant) {
  expect(isInstant(value)).toBe(true);
  expect(value?.epochNanoseconds).toBe(expected.epochNanoseconds);
}

beforeAll(async () => {
  client = new PGlite('memory://');
  await client.waitReady;
  db = drizzle({ client });
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
      customerRiskProfiles: dunning.customerRiskProfiles,
    },
    db,
  );
  await apply();
  await db.insert(users).values({ id: userId });
  await db
    .insert(core.customers)
    .values({ id: customerId, userId, providerCustomerId: 'cus_test', email: 'buyer@example.com' });
});

afterAll(async () => {
  await client.close();
});

describe('customer risk profile dates in jsonb', () => {
  it('come back from Postgres as ISO text, so a row must be read through readCustomerRiskProfile', async () => {
    const [created] = await db.insert(dunning.customerRiskProfiles).values(profile()).returning();

    // The column type says Instant; the database returns text. This is the bug the read fixes.
    expect(typeof Reflect.get(created?.riskScore ?? {}, 'lastCalculated')).toBe('string');

    const stored = await db.select().from(dunning.customerRiskProfiles);
    const [row] = stored.map(entry => readCustomerRiskProfile(entry));

    expectInstantAt(row?.riskScore.lastCalculated, calculatedAt);
    expectInstantAt(row?.paymentHistory.lastPaymentDate, paidAt);
    expectInstantAt(row?.engagementMetrics.lastActivity, activeAt);
  });

  it('keeps an absent optional date absent and the other fields as stored', async () => {
    const base = profile();
    const [stored] = await db
      .update(dunning.customerRiskProfiles)
      .set({
        paymentHistory: { ...base.paymentHistory, lastPaymentDate: undefined },
        engagementMetrics: { score: 0, activityFrequency: 0, featureUsage: {} },
      })
      .where(eq(dunning.customerRiskProfiles.customerId, customerId))
      .returning();
    const row = stored && readCustomerRiskProfile(stored);

    expect(row?.paymentHistory.lastPaymentDate).toBeUndefined();
    expect(row?.engagementMetrics.lastActivity).toBeUndefined();
    expect(row?.paymentHistory.streakDays).toBe(5);
    expect(row?.riskScore.overall).toBe(40);
  });

  it('throws the schema assert error, not a raw ZodError, for a stored date that is not an instant', async () => {
    // Corrupt the stored jsonb the way a bad migration or a hand edit would; the row comes back as Postgres holds it
    const { riskScore } = dunning.customerRiskProfiles;
    const [corrupt] = await db
      .update(dunning.customerRiskProfiles)
      .set({ riskScore: sql`jsonb_set(${riskScore}, '{lastCalculated}', '"not a date"')` })
      .where(eq(dunning.customerRiskProfiles.customerId, customerId))
      .returning();
    if (!corrupt) throw new Error('the risk profile row was not stored');

    expect(() => readCustomerRiskProfile(corrupt)).toThrow(AssertError);
  });
});

async function newCustomer(label: string) {
  const id = orThrow(createCustomerId());
  const owner = orThrow(userIdFactory.create());
  await db.insert(users).values({ id: owner });
  await db.insert(core.customers).values({ id, userId: owner, providerCustomerId: `cus_${label}`, email: `${label}@example.com` });
  return id;
}

async function profilesOf(id: CustomerRiskProfile['customerId']) {
  return db.select().from(dunning.customerRiskProfiles).where(eq(dunning.customerRiskProfiles.customerId, id));
}

describe('CustomerRiskProfileRepository writes', () => {
  // Two payment events for a new customer arrive together: both upserts are first, and a second profile would split its history
  it('two first upserts at once leave one profile, holding one of the two writes', async () => {
    const repository = createCustomerRiskProfileRepository(db, dunning);
    const buyer = await newCustomer('concurrent');
    const base = profile();

    const [first, second] = await Promise.all([
      repository.upsert({ ...base, customerId: buyer, riskScore: { ...base.riskScore, overall: 10 } }),
      repository.upsert({ ...base, customerId: buyer, riskScore: { ...base.riskScore, overall: 90 } }),
    ]);
    const rows = await profilesOf(buyer);

    expect(rows).toHaveLength(1);
    expect([10, 90]).toContain(rows[0]?.riskScore.overall);
    expect(orThrow(first).id).toBe(rows[0]?.id);
    expect(orThrow(second).id).toBe(rows[0]?.id);
  });

  it('a second upsert replaces the stored profile in place', async () => {
    const repository = createCustomerRiskProfileRepository(db, dunning);
    const buyer = await newCustomer('replaced');
    const base = profile();

    const created = orThrow(await repository.upsert({ ...base, customerId: buyer }));
    const replaced = orThrow(
      await repository.upsert({ ...base, customerId: buyer, segmentIds: ['seg_vip'], metadata: { source: 'retry' } }),
    );

    expect(replaced.id).toBe(created.id);
    expect(replaced).toMatchObject({ segmentIds: ['seg_vip'], metadata: { source: 'retry' } });
    expect(await profilesOf(buyer)).toHaveLength(1);
  });

  // A payment event for a customer the app never stored must name the missing customer, not leak a raw foreign key error
  it('upsert and create for an unknown customer return payments.reference_not_found and write nothing', async () => {
    const repository = createCustomerRiskProfileRepository(db, dunning);
    const unknown = orThrow(createCustomerId());

    const upserted = await repository.upsert({ ...profile(), customerId: unknown });
    const created = await repository.create({ ...profile(), customerId: unknown });

    for (const refused of [upserted, created]) {
      expect(ReferenceNotFound.is(refused)).toBe(true);
      expect(refused).toMatchObject({
        code: 'payments.reference_not_found',
        data: { kind: 'customer', id: unknown, missing: 'row' },
      });
    }
    expect(await profilesOf(unknown)).toEqual([]);
  });

  it('a second create for the same customer returns payments.customer_risk_profile_exists and keeps the stored profile', async () => {
    const repository = createCustomerRiskProfileRepository(db, dunning);
    const buyer = await newCustomer('created-twice');
    const base = profile();
    const first = orThrow(await repository.create({ ...base, customerId: buyer }));

    const second = await repository.create({ ...base, customerId: buyer, riskScore: { ...base.riskScore, overall: 99 } });

    expect(second).toMatchObject({ code: 'payments.customer_risk_profile_exists', data: { customerId: buyer } });
    const stored = await profilesOf(buyer);
    expect(stored).toEqual([expect.objectContaining({ id: first.id })]);
    expect(stored[0]?.riskScore.overall).toBe(first.riskScore.overall);
  });

  // The JSON columns refuse U+0000 (raw SQLSTATE 22P05) and the driver throws a TypeError on a bigint: each door must answer with a typed failure instead
  it('create, upsert and update return schema.invalid_input for U+0000 or a bigint in the JSON, and write nothing', async () => {
    const repository = createCustomerRiskProfileRepository(db, dunning);
    const fresh = await newCustomer('bad-json-fresh');
    const stored = await newCustomer('bad-json-stored');
    const base = profile();
    const kept = orThrow(await repository.create({ ...base, customerId: stored, metadata: { source: 'kept' } }));
    const badJson = [
      { metadata: { note: 'nul \u0000 here' } },
      { metadata: { ['key\u0000']: 'x' } },
      { metadata: { seats: 2n } },
      { communicationPreferences: { ...base.communicationPreferences, timezone: 'Europe/\u0000Paris' } },
    ];

    for (const bad of badJson) {
      const answers = [
        await repository.create({ ...base, ...bad, customerId: fresh }),
        await repository.upsert({ ...base, ...bad, customerId: fresh }),
        await repository.upsert({ ...base, ...bad, customerId: stored }),
        await repository.update(stored, bad),
      ];
      for (const answer of answers) expect(answer).toMatchObject({ code: 'schema.invalid_input' });
    }
    expect(await profilesOf(fresh)).toEqual([]);
    const after = await profilesOf(stored);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: kept.id, metadata: { source: 'kept' }, updatedAt: kept.updatedAt });
  });

  it('a refused write inside a caller transaction leaves that transaction usable', async () => {
    const buyer = await newCustomer('in-transaction');

    const written = await db.transaction(async tx => {
      const repository = createCustomerRiskProfileRepository(tx, dunning);
      const refused = await repository.upsert({ ...profile(), customerId: orThrow(createCustomerId()) });
      expect(refused).toMatchObject({ code: 'payments.reference_not_found' });
      return orThrow(await repository.upsert({ ...profile(), customerId: buyer }));
    });

    expect(await profilesOf(buyer)).toEqual([expect.objectContaining({ id: written.id })]);
  });
});
