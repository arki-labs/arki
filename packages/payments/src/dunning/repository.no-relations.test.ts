/**
 * Dunning repositories on a plain database
 *
 * The repositories read with `select`, so they must work on `drizzle({ client })` with no
 * relations registered. With the relational query builder, `db.query.dunningCampaigns` was
 * undefined there and every read threw a TypeError.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant } from '@arki/date';
import type { SchemaFailure } from '@arki/failure';
import { FAILURE_ERROR_CODES, FailureError, invariant, orThrow } from '@arki/failure';

import { core, customerId, rejectionOf, schema, userId, users } from '../test-support.js';
import type { UserId } from '../core/user-id.js';
import type { CreateCustomerSegmentInput, CreateDunningCampaignInput } from './contracts.js';
import { createDunningRepository } from './repository.js';
import { createDunningTables } from './tables.js';

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});

const settings = {
  enabled: true,
  priority: 1,
  cooldownPeriod: 1,
  maxExecutionsPerCustomer: 1,
  stopOnPaymentSuccess: true,
  respectUnsubscribe: true,
  businessHoursOnly: false,
};


/** The ids of the rows a read resolves to. */
async function idsOf<Row extends { id: string }>(rows: Promise<Row[] | SchemaFailure>): Promise<string[]> {
  const resolved = orThrow(await rows);
  return resolved.map(row => row.id);
}

/** The names of the rows a read resolves to. */
async function namesOf<Row extends { name: string }>(rows: Promise<Row[] | SchemaFailure>): Promise<string[]> {
  const resolved = orThrow(await rows);
  return resolved.map(row => row.name);
}
/** One field of the row a read resolves to, `undefined` when there is no row. */
async function valueOf<Row, Key extends keyof Row>(row: Promise<Row | null | undefined>, key: Key) {
  const resolved = await row;
  return resolved?.[key];
}

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let repositories: ReturnType<typeof createDunningRepository>;

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
      ...dunning,
    },
    db,
  );
  await apply();
  await db.insert(users).values({ id: userId });
  await db
    .insert(core.customers)
    .values({ id: customerId, userId, providerCustomerId: 'cus_test', email: 'buyer@example.com' });
  repositories = createDunningRepository(db, dunning);
});

afterAll(async () => {
  await client.close();
});

describe('reads on a database without relations', () => {
  it('reads campaigns, templates and executions', async () => {
    const [campaign] = await db
      .insert(dunning.dunningCampaigns)
      .values({
        name: 'Retry soon',
        type: 'payment_failed',
        status: 'active',
        trigger: { type: 'payment_failure', conditions: {} },
        settings,
        targetSegments: [],
        createdBy: 'usr_test',
      })
      .returning();
    invariant(campaign, 'seed failed');

    expect((await valueOf(repositories.campaigns.findById(campaign.id), 'name'))).toBe('Retry soon');
    const matching = repositories.campaigns.findMany({
      limit: 10,
      offset: 0,
      search: 'retry',
      sortBy: 'name',
      sortOrder: 'asc',
    });
    expect(await idsOf(matching)).toEqual([campaign.id]);
    expect((await idsOf(repositories.campaigns.findByType('payment_failed')))).toEqual([campaign.id]);
    expect((await idsOf(repositories.campaigns.findActiveForTrigger('payment_failure')))).toEqual([
      campaign.id,
    ]);

    const [template] = await db
      .insert(dunning.dunningTemplates)
      .values({
        campaignId: campaign.id,
        name: 'Step one',
        stepNumber: 1,
        delayHours: 0,
        communication: { channel: 'email', subject: 'Hi', content: 'Pay up', variables: [] },
      })
      .returning();
    invariant(template, 'seed failed');
    expect((await valueOf(repositories.templates.findById(template.id), 'name'))).toBe('Step one');
    expect((await idsOf(repositories.templates.findByCampaignId(campaign.id)))).toEqual([template.id]);
    expect((await idsOf(repositories.templates.findActiveTemplates(campaign.id)))).toEqual([template.id]);

    const stored = await repositories.executions.create({
      campaignId: campaign.id,
      templateId: template.id,
      customerId,
      triggerType: 'payment_failure',
      triggerData: {},
      status: 'scheduled',
      scheduledAt: instant('2020-01-01T00:00:00Z'),
      retryCount: 0,
    });
    const execution = orThrow(stored);
    expect((await valueOf(repositories.executions.findById(execution.id), 'status'))).toBe('scheduled');
    expect((await idsOf(repositories.executions.findScheduledExecutions()))).toEqual([execution.id]);
    expect(
      (await idsOf(repositories.executions.findRecentForCustomer(customerId, campaign.id))),
    ).toEqual([execution.id]);
  });

  it('reads segments and risk profiles', async () => {
    const input: CreateCustomerSegmentInput & { createdBy: UserId } = {
      name: 'High risk',
      type: 'behavior_based',
      criteria: {},
      autoUpdate: true,
      updateFrequency: 1,
      createdBy: 'usr_test',
    };
    const segment = orThrow(await repositories.customerSegments.create(input));

    expect(segment?.name).toBe('High risk');
    const matching = repositories.customerSegments.findMany({
      limit: 10,
      offset: 0,
      search: 'high',
      sortBy: 'name',
      sortOrder: 'desc',
    });
    expect(await namesOf(matching)).toEqual(['High risk']);
    expect((await namesOf(repositories.customerSegments.findSegmentsForAutoUpdate()))).toEqual([
      'High risk',
    ]);
    expect(await repositories.customerRiskProfiles.findByCustomerId(customerId)).toBeUndefined();
  });
});

describe('an insert that returns no row', () => {
  it('creating a campaign fails with the invariant failure code', async () => {
    await db.execute(
      sql`CREATE FUNCTION pay.skip_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER skip_campaign_insert BEFORE INSERT ON pay.dunning_campaigns FOR EACH ROW EXECUTE FUNCTION pay.skip_row()`,
    );

    try {
      const input: CreateDunningCampaignInput & { createdBy: UserId } = {
        name: 'Skipped',
        type: 'payment_failed',
        trigger: { type: 'payment_failure', conditions: {} },
        settings,
        targetSegments: [],
        templates: [
          { name: 'Step', stepNumber: 1, delayHours: 0, communication: { channel: 'email', content: 'x', variables: [] } },
        ],
        createdBy: 'usr_test',
      };
      const error = await rejectionOf(repositories.campaigns.create(input));

      expect(error).toBeInstanceOf(FailureError);
      expect(error).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
    } finally {
      await db.execute(sql`DROP TRIGGER skip_campaign_insert ON pay.dunning_campaigns`);
    }
  });
});

describe('hostile caller values return schema.invalid_input', () => {
  const invalid = { code: 'schema.invalid_input' };
  const page = { limit: 10, offset: 0, sortOrder: 'asc' } as const;
  const badName = 'nope';
  const nul = '\u0000';

  it('a sortBy that names no column is refused in all four list reads', async () => {
    // @ts-expect-error a value outside the declared type, as a hostile caller sends it
    expect(await repositories.campaigns.findMany({ ...page, sortBy: badName })).toMatchObject(invalid);
    // @ts-expect-error a value outside the declared type, as a hostile caller sends it
    expect(await repositories.customerSegments.findMany({ ...page, sortBy: badName })).toMatchObject(invalid);
    // @ts-expect-error a value outside the declared type, as a hostile caller sends it
    expect(await repositories.executions.findMany({ ...page, sortBy: badName })).toMatchObject(invalid);
    // @ts-expect-error a value outside the declared type, as a hostile caller sends it
    expect(await repositories.communications.findMany({ ...page, sortBy: badName })).toMatchObject(invalid);
  });

  it('a type, status or channel no row has is refused before any query, NUL included', async () => {
    for (const bad of [badName, nul]) {
      // @ts-expect-error a value outside the declared type, as a hostile caller sends it
      expect(await repositories.campaigns.findMany({ ...page, sortBy: 'name', type: bad })).toMatchObject(invalid);
      // @ts-expect-error a value outside the declared type, as a hostile caller sends it
      expect(await repositories.customerSegments.findMany({ ...page, sortBy: 'name', type: bad })).toMatchObject(
        invalid,
      );
      // @ts-expect-error a value outside the declared type, as a hostile caller sends it
      expect(await repositories.executions.findMany({ ...page, sortBy: 'createdAt', status: bad })).toMatchObject(
        invalid,
      );
      // @ts-expect-error a value outside the declared type, as a hostile caller sends it
      expect(await repositories.communications.findMany({ ...page, sortBy: 'createdAt', channel: bad })).toMatchObject(
        invalid,
      );
      // @ts-expect-error a value outside the declared type, as a hostile caller sends it
      expect(await repositories.campaigns.findByType(bad)).toMatchObject(invalid);
      // @ts-expect-error a value outside the declared type, as a hostile caller sends it
      expect(await repositories.campaigns.findActiveForTrigger(bad)).toMatchObject(invalid);
      // @ts-expect-error a value outside the declared type, as a hostile caller sends it
      expect(await repositories.customerRiskProfiles.findByRiskCategory(bad)).toMatchObject(invalid);
      // @ts-expect-error a value outside the declared type, as a hostile caller sends it
      expect(await repositories.campaigns.updateStatus('dc_x', bad, userId)).toMatchObject(invalid);
      // @ts-expect-error a value outside the declared type, as a hostile caller sends it
      expect(await repositories.executions.updateStatus('de_x', bad)).toMatchObject(invalid);
      // @ts-expect-error a value outside the declared type, as a hostile caller sends it
      expect(await repositories.communications.updateStatus('dcm_x', bad)).toMatchObject(invalid);
    }
  });

  it('more than 1,000 segment ids in a trigger lookup are refused', async () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `cs_${String(index)}`);
    // @ts-expect-error a value outside the declared type, as a hostile caller sends it
    expect(await repositories.campaigns.findActiveForTrigger('manual', ids)).toMatchObject(invalid);
  });

  it('a reference longer than the id column is a missing row, not a Postgres 22001', async () => {
    const profile = {
      customerId: 'x'.repeat(300),
      segmentIds: [],
      riskScore: {
        overall: 40,
        factors: {},
        category: 'medium',
        lastCalculated: instant('2026-03-04T05:06:07Z'),
        trends: { direction: 'stable', changePercent: 0, timeframe: 30 },
      },
      paymentHistory: {},
      subscriptionHistory: {},
      engagementMetrics: {},
      communicationPreferences: {},
      metadata: null,
    };
    // @ts-expect-error a value outside the declared type, as a hostile caller sends it
    expect(await repositories.customerRiskProfiles.upsert(profile)).toMatchObject({
      code: 'payments.reference_not_found',
    });
  });
});
