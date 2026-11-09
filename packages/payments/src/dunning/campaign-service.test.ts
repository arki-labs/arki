// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
import { findDatabaseError } from '@arki/db/errors';
import { orThrow } from '@arki/failure';

/**
 * DunningCampaignService.createCampaign: one transaction
 *
 * A campaign without its templates never runs a step, and a retry would then
 * make a second campaign. The campaign and every template are written in one
 * transaction on PGlite, so a template that Postgres rejects leaves no campaign.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { count, defineRelations, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { add, now, sub, toMillis } from '@arki/date';

import type { CustomerId } from '../core/types.js';
import type { CreateDunningCampaignInput } from './contracts.js';
import { updateDunningCampaignInputSchema } from './contracts.js';
import type { DunningCampaignId } from './primitives.js';
import { DunningCampaignNotFound, DunningCampaignWithoutSteps, DunningTemplateInUse } from './failures.js';
import { createDunningCampaignId, createDunningExecutionId, createDunningTemplateId } from './primitives.js';
import { createCustomerId, createPaymentId, createSubscriptionId } from '../core/primitives.js';
import { userIdFactory } from '../core/user-id.js';
import { core, customerId, planId, schema, userId, users } from '../test-support.js';
import { DunningCampaignService } from './services/campaign-service.js';
import { CommunicationOrchestrationService, EmailProvider } from './services/communication-service.js';
import { createDunningTables } from './tables.js';
import {
  createDunningCampaignRepository,
  createDunningCommunicationRepository,
  createDunningExecutionRepository,
  createDunningTemplateRepository,
} from './repository.js';

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});

const tables = {
  dunningCampaigns: dunning.dunningCampaigns,
  dunningCampaignAnalytics: dunning.dunningCampaignAnalytics,
  dunningTemplates: dunning.dunningTemplates,
  dunningExecutions: dunning.dunningExecutions,
  dunningCommunications: dunning.dunningCommunications,
};

const relations = defineRelations(tables, () => ({}));

const serviceTables = {
  ...tables,
  customerRiskProfiles: dunning.customerRiskProfiles,
  customers: core.customers,
  payments: core.payments,
  subscriptions: core.subscriptions,
};

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof relations>>;
let service: DunningCampaignService;

/**
 * How the local stand-in for Resend answers the next sends: an accepted email, an error status, or a
 * connection it drops before answering (the provider cannot be reached).
 */
type ResendAnswer = { status: number; body: string; delayMs?: number } | 'drop';
let resendAnswer: ResendAnswer = { status: 200, body: '{"id":"email_sent"}' };
let resend: Server;

function answerResend(request: IncomingMessage, response: ServerResponse) {
  request.resume();
  request.on('end', () => {
    if (resendAnswer === 'drop') {
      request.socket.destroy();
      return;
    }
    const reply = resendAnswer;
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(reply.body);
    }, reply.delayMs ?? 0);
  });
}

beforeAll(async () => {
  resend = createServer(answerResend);
  await new Promise<void>(resolve => resend.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = resend.address();
  if (address === null || typeof address === 'string') throw new Error('the Resend stand-in has no port');

  client = new PGlite('memory://');
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
      customerRiskProfiles: dunning.customerRiskProfiles,
    },
    db,
  );
  await apply();
  await db.insert(users).values({ id: userId });
  await db
    .insert(core.customers)
    .values({ id: customerId, userId, providerCustomerId: 'cus_test', email: 'buyer@example.com' });
  const communications = new CommunicationOrchestrationService(db, tables);
  communications.registerProvider(
    new EmailProvider({
      apiKey: 're_test',
      fromEmail: 'billing@example.com',
      fromName: 'Billing',
      timeoutMs: 300,
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
    }),
  );
  service = new DunningCampaignService(db, serviceTables, () => communications);
});

afterAll(async () => {
  resend.closeAllConnections();
  await new Promise(resolve => resend.close(resolve));
  await client.close();
});

function campaignInput(
  delayHours: number[],
  trigger?: CreateDunningCampaignInput['trigger'],
): CreateDunningCampaignInput {
  return {
    name: 'Recover failed payments',
    type: 'payment_failed',
    trigger: trigger ?? { type: 'payment_failure', conditions: { paymentFailureCount: 1 } },
    settings: {
      enabled: true,
      priority: 1,
      cooldownPeriod: 24,
      maxExecutionsPerCustomer: 3,
      stopOnPaymentSuccess: true,
      respectUnsubscribe: true,
      businessHoursOnly: false,
    },
    targetSegments: [],
    templates: delayHours.map((delay, index) => ({
      name: `Step ${index + 1}`,
      stepNumber: index + 1,
      delayHours: delay,
      communication: { channel: 'email', subject: 'Payment failed', content: 'Please update your card', variables: [] },
    })),
  };
}

async function countOf(table: typeof tables.dunningCampaigns | typeof tables.dunningTemplates) {
  const [row] = await db.select({ total: count() }).from(table);

  return row?.total ?? 0;
}

describe('createCampaign', () => {
  it('writes the campaign and all its templates', async () => {
    const campaigns = await countOf(tables.dunningCampaigns);

    const created = orThrow(await service.createCampaign(campaignInput([0, 24]), 'usr_admin'));

    expect(created.templates.map(template => template.stepNumber)).toEqual([1, 2]);
    expect(await countOf(tables.dunningCampaigns)).toBe(campaigns + 1);
  });

  it('leaves no campaign behind when a template is rejected', async () => {
    const campaigns = await countOf(tables.dunningCampaigns);
    const templates = await countOf(tables.dunningTemplates);

    // 2^31 hours does not fit the integer column. The contract refuses it; a caller that skips the
    // contract gets Postgres's numeric_value_out_of_range (22003) on the second template
    await expect(service.createCampaign(campaignInput([0, 2_147_483_648]), 'usr_admin')).rejects.toSatisfy(
      error => findDatabaseError(error)?.sqlState === '22003',
    );

    expect(await countOf(tables.dunningCampaigns)).toBe(campaigns);
    expect(await countOf(tables.dunningTemplates)).toBe(templates);
  });
});

describe('updateCampaign templates', () => {
  it('replaces the steps: updates a matching step in place, adds a new one, deletes the one that is gone', async () => {
    const created = orThrow(await service.createCampaign(campaignInput([0, 24]), 'usr_admin'));
    const [first, second] = created.templates;

    const updated = orThrow(
      await service.updateCampaign(
      created.id,
      {
        templates: [
          { name: 'SMS nudge', stepNumber: 1, delayHours: 2, communication: { channel: 'sms', content: 'Pay now', variables: [] } },
          { name: 'Final notice', stepNumber: 3, delayHours: 72, communication: { channel: 'email', subject: 'Last call', content: 'Final', variables: [] } },
        ],
      },
      'usr_admin',
    ));

    expect(updated?.templates.map(template => [template.stepNumber, template.communication.channel])).toEqual([
      [1, 'sms'],
      [3, 'email'],
    ]);
    // Step 1 keeps its id, so executions that point at it keep their history
    expect(updated?.templates[0]?.id).toBe(first?.id);
    expect(updated?.templates.some(template => template.id === second?.id)).toBe(false);
  });

  it('leaves the steps alone when templates is omitted', async () => {
    const created = orThrow(await service.createCampaign(campaignInput([0, 24]), 'usr_admin'));

    const updated = orThrow(await service.updateCampaign(created.id, { name: 'Renamed' }, 'usr_admin'));

    expect(updated?.name).toBe('Renamed');
    expect(updated?.templates.map(template => template.id)).toEqual(created.templates.map(template => template.id));
  });

  it('refuses to drop a step that already sent a communication, and changes nothing', async () => {
    const created = orThrow(await service.createCampaign({ ...campaignInput([0, 24]), name: 'Before' }, 'usr_admin'));
    const [first, second] = created.templates;
    if (!first || !second) throw new Error('campaign needs two steps');
    const sent = await execution(created.id, 'completed');
    await db.insert(tables.dunningCommunications).values({
      executionId: sent.id,
      customerId,
      templateId: second.id,
      channel: 'email',
      recipient: 'buyer@example.com',
      content: 'Please update your card',
      status: 'sent',
    });

    const result = await service.updateCampaign(
      created.id,
      {
        name: 'After',
        templates: [{ name: 'Step 1', stepNumber: 1, delayHours: 0, communication: { channel: 'email', subject: 'Payment failed', content: 'Please update your card', variables: [] } }],
      },
      'usr_admin',
    );

    expect(DunningTemplateInUse.is(result)).toBe(true);
    if (!DunningTemplateInUse.is(result)) return;
    expect(result.data).toEqual({ templateId: second.id, stepNumber: 2 });
    const after = await service.getCampaign(created.id);
    expect(after?.name).toBe('Before');
    expect(after?.templates?.map(template => template.id)).toEqual([first.id, second.id]);
  });

  it('rejects an empty set and duplicate step numbers at the contract', () => {
    const [step] = campaignInput([0]).templates;
    expect(updateDunningCampaignInputSchema.safeParse({ templates: [] }).success).toBe(false);
    expect(updateDunningCampaignInputSchema.safeParse({ templates: [step, step] }).success).toBe(false);
    expect(updateDunningCampaignInputSchema.safeParse({ templates: [step] }).success).toBe(true);
  });
});

describe('deleteCampaign', () => {
  it('deletes a campaign that never sent anything, with its steps', async () => {
    const created = orThrow(await service.createCampaign({ ...campaignInput([0, 24]), name: 'Never ran' }, 'usr_admin'));

    expect(await service.deleteCampaign(created.id)).toBeUndefined();

    expect(await service.getCampaign(created.id)).toBeNull();
    const steps = await db
      .select()
      .from(tables.dunningTemplates)
      .where(eq(tables.dunningTemplates.campaignId, created.id));
    expect(steps).toEqual([]);
  });

  // An admin deletes a campaign that already ran: the sent message keeps its step, so the route needs a 409 to answer with
  it('refuses a campaign whose step already sent a communication with payments.dunning_template_in_use, and deletes nothing', async () => {
    const created = orThrow(await service.createCampaign({ ...campaignInput([0, 24]), name: 'Already ran' }, 'usr_admin'));
    const [first, second] = created.templates;
    if (!first || !second) throw new Error('campaign needs two steps');
    const sent = await execution(created.id, 'completed');
    await db.insert(tables.dunningCommunications).values({
      executionId: sent.id,
      customerId,
      templateId: second.id,
      channel: 'email',
      recipient: 'buyer@example.com',
      content: 'Please update your card',
      status: 'sent',
    });

    const result = await service.deleteCampaign(created.id);

    expect(result?.code).toBe('payments.dunning_template_in_use');
    expect(DunningTemplateInUse.is(result) && result.data).toEqual({ templateId: second.id, stepNumber: 2 });
    const after = await service.getCampaign(created.id);
    expect(after?.templates.map(template => template.id)).toEqual([first.id, second.id]);
    const executions = await db
      .select()
      .from(tables.dunningExecutions)
      .where(eq(tables.dunningExecutions.campaignId, created.id));
    expect(executions.map(row => row.id)).toEqual([sent.id]);
  });
});

describe('the dunning repositories answer a missing or referenced row with a failure', () => {
  // An admin tool deletes through the repository: a campaign that already ran must answer 409, not a raw foreign key error
  it('DunningCampaignRepository.delete refuses a campaign whose step sent a communication with payments.dunning_template_in_use', async () => {
    const created = orThrow(await service.createCampaign({ ...campaignInput([0, 24]), name: 'Repository delete' }, 'usr_admin'));
    const [first, second] = created.templates;
    if (!first || !second) throw new Error('campaign needs two steps');
    const sent = await execution(created.id, 'completed');
    await db.insert(tables.dunningCommunications).values({
      executionId: sent.id,
      customerId,
      templateId: first.id,
      channel: 'email',
      recipient: 'buyer@example.com',
      content: 'Please update your card',
      status: 'sent',
    });

    const refused = await createDunningCampaignRepository(db, tables).delete(created.id);

    expect(refused).toMatchObject({
      code: 'payments.dunning_template_in_use',
      data: { templateId: first.id, stepNumber: 1 },
    });
    const kept = await service.getCampaign(created.id);
    expect(kept?.templates.map(template => template.id)).toEqual([first.id, second.id]);
  });

  it('DunningTemplateRepository.create for an unknown campaign returns payments.dunning_campaign_not_found and writes nothing', async () => {
    const unknown = orThrow(createDunningCampaignId());
    const templates = await countOf(tables.dunningTemplates);

    const refused = await createDunningTemplateRepository(db, tables).create({
      campaignId: unknown,
      name: 'Orphan step',
      stepNumber: 1,
      delayHours: 0,
      communication: { channel: 'email', content: 'Please update your card', variables: [] },
    });

    expect(DunningCampaignNotFound.is(refused)).toBe(true);
    expect(refused).toMatchObject({ code: 'payments.dunning_campaign_not_found', data: { campaignId: unknown } });
    expect(await countOf(tables.dunningTemplates)).toBe(templates);
  });

  it('DunningTemplateRepository.delete refuses a step that sent a communication with payments.dunning_template_in_use', async () => {
    const created = orThrow(await service.createCampaign({ ...campaignInput([0, 24]), name: 'Step delete' }, 'usr_admin'));
    const [first, second] = created.templates;
    if (!first || !second) throw new Error('campaign needs two steps');
    const sent = await execution(created.id, 'completed');
    await db.insert(tables.dunningCommunications).values({
      executionId: sent.id,
      customerId,
      templateId: second.id,
      channel: 'email',
      recipient: 'buyer@example.com',
      content: 'Please update your card',
      status: 'sent',
    });
    const steps = createDunningTemplateRepository(db, tables);

    const refused = await steps.delete(second.id);
    const deleted = await steps.delete(first.id);

    expect(refused).toMatchObject({
      code: 'payments.dunning_template_in_use',
      data: { templateId: second.id, stepNumber: 2 },
    });
    expect(deleted).toBeUndefined();
    const left = await service.getCampaign(created.id);
    expect(left?.templates.map(template => template.id)).toEqual([second.id]);
  });

  it('DunningExecutionRepository.create names the missing campaign, step or customer with its not-found code', async () => {
    const created = orThrow(await service.createCampaign({ ...campaignInput([0]), name: 'Execution refs' }, 'usr_admin'));
    const [step] = created.templates;
    if (!step) throw new Error('campaign needs a step');
    const executions = createDunningExecutionRepository(db, tables);
    const valid = {
      campaignId: created.id,
      templateId: step.id,
      customerId,
      triggerType: 'manual',
      triggerData: {},
      scheduledAt: now(),
    };
    const unknownCampaign = orThrow(createDunningCampaignId());
    const unknownStep = orThrow(createDunningTemplateId());
    const unknownCustomer = orThrow(createCustomerId());

    expect(await executions.create({ ...valid, campaignId: unknownCampaign })).toMatchObject({
      code: 'payments.dunning_campaign_not_found',
      data: { campaignId: unknownCampaign },
    });
    expect(await executions.create({ ...valid, templateId: unknownStep })).toMatchObject({
      code: 'payments.dunning_template_not_found',
      data: { templateId: unknownStep },
    });
    expect(await executions.create({ ...valid, customerId: unknownCustomer })).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'customer', id: unknownCustomer, missing: 'row' },
    });
    const rows = await db.select().from(tables.dunningExecutions).where(eq(tables.dunningExecutions.campaignId, created.id));
    expect(rows).toEqual([]);
  });

  it('DunningCommunicationRepository.create names a missing execution or step with its not-found code', async () => {
    const created = orThrow(await service.createCampaign({ ...campaignInput([0]), name: 'Communication refs' }, 'usr_admin'));
    const [step] = created.templates;
    if (!step) throw new Error('campaign needs a step');
    const ran = await execution(created.id, 'completed');
    const communications = createDunningCommunicationRepository(db, tables);
    const valid = {
      executionId: ran.id,
      customerId,
      templateId: step.id,
      channel: 'email' as const,
      recipient: 'buyer@example.com',
      content: 'Please update your card',
      status: 'pending' as const,
    };
    const unknownExecution = orThrow(createDunningExecutionId());
    const unknownStep = orThrow(createDunningTemplateId());

    expect(await communications.create({ ...valid, executionId: unknownExecution })).toMatchObject({
      code: 'payments.dunning_execution_not_found',
      data: { executionId: unknownExecution },
    });
    expect(await communications.create({ ...valid, templateId: unknownStep })).toMatchObject({
      code: 'payments.dunning_template_not_found',
      data: { templateId: unknownStep },
    });
    const unknownCustomer = orThrow(createCustomerId());
    expect(await communications.create({ ...valid, customerId: unknownCustomer })).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'customer', id: unknownCustomer, missing: 'row' },
    });
    const rows = await db
      .select()
      .from(tables.dunningCommunications)
      .where(eq(tables.dunningCommunications.executionId, ran.id));
    expect(rows).toEqual([]);
  });

  // PGlite has one connection, so the race itself cannot run here. A message written between the check and
  // the delete must wait on a row lock; the lock has to be taken before the check reads the communications.
  it('updateCampaign locks the steps before it checks them for sent communications', async () => {
    const created = orThrow(await service.createCampaign({ ...campaignInput([0, 24]), name: 'Locked update' }, 'usr_admin'));
    const queries: string[] = [];
    const logged = drizzle({ client, relations, logger: { logQuery: query => queries.push(query) } });
    const watched = new DunningCampaignService(logged, serviceTables, () => {
      throw new Error('no communications in this test');
    });

    orThrow(await watched.updateCampaign(created.id, { templates: campaignInput([0]).templates }, 'usr_admin'));

    const lock = queries.findIndex(query => query.includes('"dunning_templates"') && query.endsWith('for update'));
    const check = queries.findIndex(query => query.includes('from "pay"."dunning_communications"'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(lock);
    const updated = await service.getCampaign(created.id);
    expect(updated?.templates.map(template => template.stepNumber)).toEqual([1]);
  });
});

async function createdCampaign(
  name: string,
  status: 'active' | 'draft' = 'active',
  trigger?: CreateDunningCampaignInput['trigger'],
): Promise<DunningCampaignId> {
  const created = orThrow(await service.createCampaign({ ...campaignInput([0], trigger), name }, 'usr_admin'));
  orThrow(await service.updateCampaign(created.id, { status }, 'usr_admin'));

  return created.id;
}

async function execution(campaignId: DunningCampaignId, status: 'scheduled' | 'completed', scheduledAt = now()) {
  const [row] = await db
    .insert(tables.dunningExecutions)
    .values({ campaignId, customerId, triggerType: 'manual', triggerData: {}, status, scheduledAt })
    .returning();
  if (!row) throw new Error('execution not inserted');

  return row;
}

describe('listExecutions', () => {
  it('returns the executions of one campaign, filtered by status, newest scheduled first, one page at a time', async () => {
    const mine = await createdCampaign('List executions: mine');
    const other = await createdCampaign('List executions: other');
    const first = await execution(mine, 'scheduled', sub(now(), { hours: 3 }));
    const second = await execution(mine, 'completed', sub(now(), { hours: 2 }));
    const third = await execution(mine, 'scheduled', sub(now(), { hours: 1 }));
    await execution(other, 'scheduled');
    const query = { limit: 20, offset: 0, sortBy: 'scheduledAt', sortOrder: 'desc' } as const;

    const all = await service.listExecutions({ ...query, campaignId: mine });
    const scheduled = await service.listExecutions({ ...query, campaignId: mine, status: 'scheduled' });
    const secondPage = await service.listExecutions({ ...query, campaignId: mine, limit: 2, offset: 2 });

    expect(all.map(row => row.id)).toEqual([third.id, second.id, first.id]);
    expect(scheduled.map(row => row.id)).toEqual([third.id, first.id]);
    expect(secondPage.map(row => row.id)).toEqual([first.id]);
  });
});

async function analytics(
  campaignId: DunningCampaignId,
  at: ReturnType<typeof now>,
  row: {
    currency: string;
    revenueMinor: number;
    executions: number;
    conversionRate: number;
    paymentsRecovered: number;
  },
) {
  await db.insert(tables.dunningCampaignAnalytics).values({
    id: `${campaignId}-${at.toString()}-${row.currency}`,
    campaignId,
    date: at,
    currency: row.currency,
    revenueRecoveredMinor: row.revenueMinor,
    executions: row.executions,
    customersReached: row.executions,
    paymentsRecovered: row.paymentsRecovered,
    conversionRate: row.conversionRate,
  });
}

describe('getDashboardStats', () => {
  it('reads campaign counts, today, the month, the top campaign and the latest executions from the tables', async () => {
    // Each assertion below is about this campaign's rows; other tests' campaigns only add to the counts
    const before = await service.getDashboardStats();
    const winner = await createdCampaign('Dashboard: winner');
    await createdCampaign('Dashboard: idle', 'draft');
    await analytics(winner, now(), {
      currency: 'USD',
      revenueMinor: 1999,
      executions: 4,
      conversionRate: 0.5,
      paymentsRecovered: 400,
    });
    await analytics(winner, add(now(), { seconds: 1 }), {
      currency: 'EUR',
      revenueMinor: 500,
      executions: 1,
      conversionRate: 0.5,
      paymentsRecovered: 100,
    });
    await analytics(winner, sub(now(), { hours: 24 * 45 }), {
      currency: 'USD',
      revenueMinor: 99_999,
      executions: 70,
      conversionRate: 0.9,
      paymentsRecovered: 9000,
    });
    const latest = await execution(winner, 'scheduled');

    const stats = await service.getDashboardStats();

    expect(stats.totalCampaigns).toBe(before.totalCampaigns + 2);
    expect(stats.activeCampaigns).toBe(before.activeCampaigns + 1);
    expect(stats.executionsToday - before.executionsToday).toBe(5);
    expect(stats.customersReachedToday - before.customersReachedToday).toBe(5);
    expect(stats.revenueRecoveredToday.toJSON()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: 'USD' }),
        expect.objectContaining({ currency: 'EUR' }),
      ]),
    );
    // 45 days ago is outside today, the month and the top-campaign window
    expect(stats.revenueRecoveredThisMonth.toString()).not.toContain('999.99');
    expect(stats.topPerformingCampaign).toMatchObject({
      id: winner,
      name: 'Dashboard: winner',
      paymentsRecovered: 500,
    });
    expect(stats.topPerformingCampaign?.revenueRecovered.toJSON()).toHaveLength(2);
    expect(stats.recentExecutions[0]?.id).toBe(latest.id);
    expect(stats.recentExecutions.length).toBeLessThanOrEqual(10);
  });
});

describe('campaign analytics', () => {
  it('adds each metric to the day row of the campaign, in a schema that is not public', async () => {
    const campaignId = await createdCampaign('Analytics: counters');

    // The method is private: the execution paths that call it also need a mail provider
    await service['updateCampaignAnalytics'](campaignId, { customersReached: 1, communicationsSent: 1 });
    await service['updateCampaignAnalytics'](campaignId, { customersReached: 2, executions: 3 });

    const rows = await db
      .select()
      .from(tables.dunningCampaignAnalytics)
      .where(eq(tables.dunningCampaignAnalytics.campaignId, campaignId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customersReached: 3, communicationsSent: 1, executions: 3, paymentsRecovered: 0 });
  });
});

/** A customer of its own, so the eligibility queries see only the rows a test made. */
async function newCustomer(label: string) {
  const owner = orThrow(userIdFactory.create());
  const id = orThrow(createCustomerId());
  await db.insert(users).values({ id: owner });
  await db
    .insert(core.customers)
    .values({ id, userId: owner, providerCustomerId: `cus_${label}`, email: `${label}@example.com` });

  return { id, owner };
}

async function newPlan() {
  await db.insert(core.plans).values({ id: planId, name: 'Pro', tier: 'pro', priceMinor: 1999 }).onConflictDoNothing();
}

async function newSubscription(
  buyer: Awaited<ReturnType<typeof newCustomer>>,
  row: { status: 'past_due' | 'trialing'; currentPeriodEnd: ReturnType<typeof now>; trialEnd?: ReturnType<typeof now> },
) {
  await newPlan();
  const id = orThrow(createSubscriptionId());
  await db.insert(core.subscriptions).values({
    id,
    userId: buyer.owner,
    planId,
    customerId: buyer.id,
    providerSubscriptionId: `sub_${id}`,
    status: row.status,
    currentPeriodStart: sub(row.currentPeriodEnd, { hours: 720 }),
    currentPeriodEnd: row.currentPeriodEnd,
    trialEnd: row.trialEnd,
  });

  return id;
}

async function newPayment(
  buyer: Awaited<ReturnType<typeof newCustomer>>,
  status: 'failed' | 'succeeded',
  createdAt: ReturnType<typeof now>,
) {
  const id = orThrow(createPaymentId());
  await db.insert(core.payments).values({
    id,
    userId: buyer.owner,
    customerId: buyer.id,
    providerPaymentId: `pi_${id}`,
    amountMinor: 1999,
    currency: 'EUR',
    status,
    failureReason: status === 'failed' ? 'card_declined' : null,
    createdAt,
  });

  return id;
}

describe('executeCampaign refusals', () => {
  // A router passes any campaign id it is given: each refusal is a code the caller branches on, and writes nothing
  async function executionCount(campaignId: DunningCampaignId) {
    const rows = await db
      .select()
      .from(tables.dunningExecutions)
      .where(eq(tables.dunningExecutions.campaignId, campaignId));
    return rows.length;
  }

  it('an unknown campaign id returns payments.dunning_campaign_not_found', async () => {
    const unknown = orThrow(createDunningCampaignId());

    const refused = await service.executeCampaign({ campaignId: unknown, dryRun: false }, 'usr_admin');

    expect(DunningCampaignNotFound.is(refused)).toBe(true);
    expect(refused).toMatchObject({ code: 'payments.dunning_campaign_not_found', data: { campaignId: unknown } });
  });

  it('a draft campaign returns payments.dunning_campaign_not_active and schedules nothing', async () => {
    const campaignId = await createdCampaign('Refused: draft', 'draft');

    const refused = await service.executeCampaign({ campaignId, dryRun: false }, 'usr_admin');

    expect(refused).toMatchObject({
      code: 'payments.dunning_campaign_not_active',
      data: { campaignId, status: 'draft' },
    });
    expect(await executionCount(campaignId)).toBe(0);
  });

  it('an active campaign with no active step returns payments.dunning_campaign_without_steps', async () => {
    const campaignId = await createdCampaign('Refused: no steps');
    await db
      .update(tables.dunningTemplates)
      .set({ isActive: false })
      .where(eq(tables.dunningTemplates.campaignId, campaignId));

    const refused = await service.executeCampaign({ campaignId, dryRun: false }, 'usr_admin');

    expect(DunningCampaignWithoutSteps.is(refused)).toBe(true);
    expect(await executionCount(campaignId)).toBe(0);
  });
});

describe('executeCampaign finds eligible customers in a named schema', () => {
  it('payment_failure: a customer whose payment failed and who has not paid since gets the campaign', async () => {
    const buyer = await newCustomer('failed');
    await newPayment(buyer, 'failed', sub(now(), { hours: 24 }));
    const campaignId = await createdCampaign('Eligible: failed payment');

    const executions = orThrow(await service.executeCampaign({ campaignId, dryRun: false }, 'usr_admin'));

    expect(executions.map(row => row.customerId)).toEqual([buyer.id]);
    expect(executions[0]?.triggerData).toMatchObject({ failure_reasons: ['card_declined'] });
  });

  it('payment_failure: a later successful payment takes the customer out, and the exclude list works alone', async () => {
    const paid = await newCustomer('paid');
    await newPayment(paid, 'failed', sub(now(), { hours: 48 }));
    await newPayment(paid, 'succeeded', sub(now(), { hours: 24 }));
    const excluded = await newCustomer('excluded');
    await newPayment(excluded, 'failed', sub(now(), { hours: 24 }));
    const campaignId = await createdCampaign('Eligible: paid and excluded');

    const executions = orThrow(
      await service.executeCampaign(
        { campaignId, dryRun: false, customFilters: { excludeCustomerIds: [excluded.id], testMode: false } },
        'usr_admin',
      ),
    );

    expect(executions.map(row => row.customerId)).not.toContain(paid.id);
    expect(executions.map(row => row.customerId)).not.toContain(excluded.id);
  });

  it('payment_failure: failures are counted per customer and subscription, so the failure count threshold can be met', async () => {
    const repeated = await newCustomer('repeated');
    await newPayment(repeated, 'failed', sub(now(), { hours: 72 }));
    await newPayment(repeated, 'failed', sub(now(), { hours: 48 }));
    const latest = await newPayment(repeated, 'failed', sub(now(), { hours: 24 }));
    const twice = await newCustomer('twice');
    await newPayment(twice, 'failed', sub(now(), { hours: 48 }));
    await newPayment(twice, 'failed', sub(now(), { hours: 24 }));
    const campaignId = await createdCampaign('Eligible: three failures', 'active', {
      type: 'payment_failure',
      conditions: { paymentFailureCount: 3 },
    });

    const executions = orThrow(await service.executeCampaign({ campaignId, dryRun: false }, 'usr_admin'));

    expect(executions.map(row => row.customerId)).toEqual([repeated.id]);
    expect(executions[0]?.paymentId).toBe(latest);
    expect(executions[0]?.triggerData).toMatchObject({ failure_count: 3 });
  });

  it('subscription_status: an overdue subscription is returned with the customer id, not the user id', async () => {
    const buyer = await newCustomer('pastdue');
    const subscriptionId = await newSubscription(buyer, {
      status: 'past_due',
      currentPeriodEnd: sub(now(), { hours: 72 }),
    });
    const campaignId = await createdCampaign('Eligible: past due', 'active', {
      type: 'subscription_status',
      conditions: { subscriptionStatus: ['past_due'] },
    });

    const executions = orThrow(
      await service.executeCampaign(
        { campaignId, dryRun: false, customFilters: { customerIds: [buyer.id], testMode: false } },
        'usr_admin',
      ),
    );

    expect(executions.map(row => [row.customerId, row.subscriptionId])).toEqual([[buyer.id, subscriptionId]]);
    expect(executions[0]?.triggerData).toMatchObject({ subscription_status: 'past_due' });
  });

  it('time_based: a trial that ends soon is returned', async () => {
    const buyer = await newCustomer('trial');
    const subscriptionId = await newSubscription(buyer, {
      status: 'trialing',
      currentPeriodEnd: add(now(), { hours: 48 }),
      trialEnd: add(now(), { hours: 48 }),
    });
    const campaignId = await createdCampaign('Eligible: trial ending', 'active', {
      type: 'time_based',
      conditions: { trialEndingDays: 3 },
    });

    const executions = orThrow(await service.executeCampaign({ campaignId, dryRun: false }, 'usr_admin'));

    expect(executions.map(row => row.subscriptionId)).toContain(subscriptionId);
  });
});

describe('a scheduled execution in a named schema', () => {
  it('stops on a successful payment and records the recovery in the campaign analytics', async () => {
    const buyer = await newCustomer('recovered');
    const campaignId = await createdCampaign('Recovery: analytics');
    const campaign = await service.getCampaign(campaignId);
    const templateId = campaign?.templates?.[0]?.id;
    await db.insert(tables.dunningExecutions).values({
      campaignId,
      templateId,
      customerId: buyer.id,
      triggerType: 'manual',
      triggerData: {},
      status: 'scheduled',
      scheduledAt: sub(now(), { minutes: 1 }),
      startedAt: sub(now(), { hours: 1 }),
    });
    await newPayment(buyer, 'succeeded', now());

    await service.processScheduledExecutions(1000);

    // The sent message counts in the default-currency row; the recovered payment in its own currency's row
    const rows = await db
      .select()
      .from(tables.dunningCampaignAnalytics)
      .where(eq(tables.dunningCampaignAnalytics.campaignId, campaignId));
    expect(rows.find(row => row.currency === 'EUR')).toMatchObject({ paymentsRecovered: 1, revenueRecoveredMinor: 1999 });
  });
});

describe('a tick reports a stored payment the stop check cannot read', () => {
  /**
   * A succeeded payment in a currency that does not exist. The message already went out, so the
   * execution stays complete; the stop check returns the money failure before it cancels anything.
   */
  async function executionWithBadPayment(label: string, row: Partial<typeof tables.dunningExecutions.$inferInsert>) {
    const buyer = await newCustomer(label);
    const campaignId = await createdCampaign(`Tick: ${label}`);
    const campaign = await service.getCampaign(campaignId);
    const templateId = campaign?.templates[0]?.id;
    await db.insert(core.payments).values({
      id: orThrow(createPaymentId()),
      userId: buyer.owner,
      customerId: buyer.id,
      providerPaymentId: `pi_${label}`,
      amountMinor: 1999,
      currency: 'ZZZ',
      status: 'succeeded',
      createdAt: now(),
    });
    const base = { campaignId, templateId, customerId: buyer.id, triggerType: 'manual', triggerData: {} } as const;
    const [inserted] = await db
      .insert(tables.dunningExecutions)
      .values({ ...base, scheduledAt: sub(now(), { minutes: 1 }), ...row })
      .returning();
    const [later] = await db
      .insert(tables.dunningExecutions)
      .values({ ...base, status: 'scheduled', scheduledAt: add(now(), { hours: 24 }) })
      .returning();
    if (!inserted || !later) throw new Error('execution not inserted');

    return { id: inserted.id, laterId: later.id, campaignId };
  }

  async function statusOf(id: (typeof tables.dunningExecutions.$inferSelect)['id']) {
    const [row] = await db.select().from(tables.dunningExecutions).where(eq(tables.dunningExecutions.id, id));
    return row?.status;
  }

  it('processScheduledExecutions lists the money failure, keeps the execution complete and cancels nothing', async () => {
    const { id, laterId, campaignId } = await executionWithBadPayment('tick-scheduled', { status: 'scheduled' });

    const report = await service.processScheduledExecutions(1000);

    const fault = report.failed.find(entry => entry.id === id);
    expect(fault?.code).toBe('money.unknown_currency');
    expect(await statusOf(id)).toBe('completed');
    expect(await statusOf(laterId)).toBe('scheduled');
    const analyticsRows = await db
      .select()
      .from(tables.dunningCampaignAnalytics)
      .where(eq(tables.dunningCampaignAnalytics.campaignId, campaignId));
    expect(analyticsRows.every(row => row.paymentsRecovered === 0)).toBe(true);
  });

  it('retryFailedExecutions lists the same failure and cancels nothing', async () => {
    const { id, laterId } = await executionWithBadPayment('tick-retry', {
      status: 'failed',
      retryCount: 0,
      nextRetryAt: sub(now(), { minutes: 1 }),
    });

    const report = await service.retryFailedExecutions(1000);

    expect(report.failed.find(entry => entry.id === id)?.code).toBe('money.unknown_currency');
    expect(await statusOf(laterId)).toBe('scheduled');
  });
});

describe('a run that throws is retried with backoff', () => {
  /**
   * The database refuses to record the completion of this one execution, so every run of it throws
   * after the message step. That is the fault retryFailedExecutions exists for.
   */
  async function refusedExecution() {
    await db.execute(
      sql.raw(
        [
          'CREATE OR REPLACE FUNCTION refuse_dunning_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN',
          "IF NEW.status = 'completed' AND NEW.trigger_data->>'refuse' = 'completion' THEN",
          "RAISE EXCEPTION 'the database refused the completion'; END IF; RETURN NEW; END $$",
        ].join(' '),
      ),
    );
    await db.execute(
      sql`CREATE TRIGGER refuse_dunning_completion BEFORE UPDATE ON ${tables.dunningExecutions} FOR EACH ROW EXECUTE FUNCTION refuse_dunning_completion()`,
    );
    const campaignId = await createdCampaign('Retry: refused completion');
    const campaign = await service.getCampaign(campaignId);
    const [row] = await db
      .insert(tables.dunningExecutions)
      .values({
        campaignId,
        templateId: campaign?.templates[0]?.id,
        customerId,
        triggerType: 'manual',
        triggerData: { refuse: 'completion' },
        status: 'scheduled',
        scheduledAt: sub(now(), { minutes: 1 }),
      })
      .returning();
    if (!row) throw new Error('execution not inserted');

    return row.id;
  }

  async function stored(id: (typeof tables.dunningExecutions.$inferSelect)['id']) {
    const [row] = await db.select().from(tables.dunningExecutions).where(eq(tables.dunningExecutions.id, id));
    if (!row) throw new Error('execution not found');

    return row;
  }

  /** Whole minutes from now until the stored next retry, or null when there is none. */
  async function minutesToNextRetry(id: (typeof tables.dunningExecutions.$inferSelect)['id']) {
    const { nextRetryAt } = await stored(id);

    return nextRetryAt ? Math.round((toMillis(nextRetryAt) - Date.now()) / 60_000) : null;
  }

  /** Time passes: the stored next retry is now due. */
  async function retryIsDue(id: (typeof tables.dunningExecutions.$inferSelect)['id']) {
    await db
      .update(tables.dunningExecutions)
      .set({ nextRetryAt: sub(now(), { minutes: 1 }) })
      .where(eq(tables.dunningExecutions.id, id));
  }

  it('fails with a next retry, is picked again each time it is due, counts each retry once, and stops after three', async () => {
    const id = await refusedExecution();
    try {
      const scheduled = await service.processScheduledExecutions(1000);
      expect(scheduled.failed.map(fault => fault.id)).toContain(id);
      expect(await stored(id)).toMatchObject({ status: 'failed', retryCount: 0 });
      expect(await minutesToNextRetry(id)).toBe(30);

      // Not due yet: nothing picks it
      const early = await service.retryFailedExecutions(1000);
      expect(early.failed.map(fault => fault.id)).not.toContain(id);

      for (const [retryCount, minutes] of [
        [1, 60],
        [2, 120],
      ] as const) {
        await retryIsDue(id);
        const report = await service.retryFailedExecutions(1000);
        expect(report.failed.map(fault => fault.id)).toContain(id);
        expect(await stored(id)).toMatchObject({ status: 'failed', retryCount });
        expect(await minutesToNextRetry(id)).toBe(minutes);
      }

      await retryIsDue(id);
      await service.retryFailedExecutions(1000);
      const last = await stored(id);
      expect(last).toMatchObject({ status: 'failed', retryCount: 3, nextRetryAt: null });
      expect(last.errorMessage).toMatch(/^Max retries exceeded: /);

      // Out of retries: a later tick never picks it again
      const after = await service.retryFailedExecutions(1000);
      expect(after.failed.map(fault => fault.id)).not.toContain(id);
      expect(await stored(id)).toMatchObject({ retryCount: 3 });
    } finally {
      await db.execute(sql`DROP TRIGGER refuse_dunning_completion ON ${tables.dunningExecutions}`);
    }
  });
});

const riskProfile = (customer: CustomerId, unsubscribedChannels: ('email' | 'sms')[]) => ({
  customerId: customer,
  riskScore: {
    overall: 0,
    factors: {},
    category: 'low' as const,
    lastCalculated: now(),
    trends: { direction: 'stable' as const, changePercent: 0, timeframe: 30 },
  },
  paymentHistory: { totalPayments: 0, successfulPayments: 0, failedPayments: 0, averageAmount: 0, streakDays: 0 },
  subscriptionHistory: {
    totalSubscriptions: 0,
    activeSubscriptions: 0,
    canceledSubscriptions: 0,
    averageDuration: 0,
  },
  engagementMetrics: { score: 0, activityFrequency: 0, featureUsage: {} },
  communicationPreferences: { unsubscribed: false, unsubscribedChannels },
});

describe('channel opt-outs', () => {
  it('never sends on a channel the customer opted out of, and still reaches a customer who opted out of another', async () => {
    const optedOut = await newCustomer('optedout');
    const otherChannel = await newCustomer('otherchannel');
    await db
      .insert(dunning.customerRiskProfiles)
      .values([riskProfile(optedOut.id, ['email']), riskProfile(otherChannel.id, ['sms'])]);
    const campaignId = await createdCampaign('Opt-out: email');
    const campaign = await service.getCampaign(campaignId);
    const templateId = campaign?.templates[0]?.id;
    for (const buyer of [optedOut, otherChannel]) {
      await db.insert(tables.dunningExecutions).values({
        campaignId,
        templateId,
        customerId: buyer.id,
        triggerType: 'manual',
        triggerData: {},
        status: 'scheduled',
        scheduledAt: sub(now(), { minutes: 1 }),
      });
    }
    await service.processScheduledExecutions(1000);
    const sent = await db
      .select({ customerId: tables.dunningCommunications.customerId, status: tables.dunningCommunications.status })
      .from(tables.dunningCommunications)
      .innerJoin(tables.dunningExecutions, eq(tables.dunningExecutions.id, tables.dunningCommunications.executionId))
      .where(eq(tables.dunningExecutions.campaignId, campaignId));

    expect(sent).toEqual([{ customerId: otherChannel.id, status: 'sent' }]);
  });
});

describe('a message that did not go out fails the execution and is reported', () => {
  /** One execution of a fresh customer, due now. */
  async function dueExecution(label: string) {
    const buyer = await newCustomer(label);
    const campaignId = await createdCampaign(`Send: ${label}`);
    const campaign = await service.getCampaign(campaignId);
    const [row] = await db
      .insert(tables.dunningExecutions)
      .values({
        campaignId,
        templateId: campaign?.templates[0]?.id,
        customerId: buyer.id,
        triggerType: 'manual',
        triggerData: {},
        status: 'scheduled',
        scheduledAt: sub(now(), { minutes: 1 }),
      })
      .returning();
    if (!row) throw new Error('execution not inserted');

    return { id: row.id, campaignId };
  }

  /** Runs one scheduled tick while the Resend stand-in answers `answer`. */
  async function tickWhileResend(answer: ResendAnswer) {
    resendAnswer = answer;
    try {
      return await service.processScheduledExecutions(1000);
    } finally {
      resendAnswer = { status: 200, body: '{"id":"email_sent"}' };
    }
  }

  async function storedExecution(id: (typeof tables.dunningExecutions.$inferSelect)['id']) {
    const [row] = await db.select().from(tables.dunningExecutions).where(eq(tables.dunningExecutions.id, id));
    if (!row) throw new Error('execution not found');

    return row;
  }

  async function communicationsOf(id: (typeof tables.dunningExecutions.$inferSelect)['id']) {
    return db
      .select({ status: tables.dunningCommunications.status })
      .from(tables.dunningCommunications)
      .where(eq(tables.dunningCommunications.executionId, id));
  }

  /** Whole minutes from now until the stored next retry, or null when there is none. */
  function minutesUntil(nextRetryAt: ReturnType<typeof now> | null) {
    return nextRetryAt ? Math.round((toMillis(nextRetryAt) - Date.now()) / 60_000) : null;
  }

  it('a provider that cannot be reached is listed, and the execution is failed with a retry in 30 minutes', async () => {
    const { id } = await dueExecution('send-unreachable');

    const report = await tickWhileResend('drop');

    expect(report.failed.find(fault => fault.id === id)).toMatchObject({ code: null });
    const stored = await storedExecution(id);
    expect(stored.status).toBe('failed');
    expect(minutesUntil(stored.nextRetryAt)).toBe(30);
    expect(await communicationsOf(id)).toEqual([{ status: 'failed' }]);
  });

  it('a 5xx refusal is listed with its code, retried later, and counts as no message sent', async () => {
    const { id, campaignId } = await dueExecution('send-5xx');

    const report = await tickWhileResend({ status: 503, body: '{"message":"try later"}' });

    expect(report.failed.find(fault => fault.id === id)?.code).toBe('payments.notification_provider_rejected');
    const stored = await storedExecution(id);
    expect(stored).toMatchObject({ status: 'failed', errorMessage: 'resend refused the notification with status 503: try later' });
    expect(minutesUntil(stored.nextRetryAt)).toBe(30);
    const analyticsRows = await db
      .select()
      .from(tables.dunningCampaignAnalytics)
      .where(eq(tables.dunningCampaignAnalytics.campaignId, campaignId));
    expect(analyticsRows.every(row => row.communicationsSent === 0)).toBe(true);
  });

  // The message may have gone out: a retry could send it twice, so a timeout fails the execution for good
  it('a provider timeout is listed with its code and never retried', async () => {
    const { id } = await dueExecution('send-timeout');

    const report = await tickWhileResend({ status: 200, body: '{"id":"email_late"}', delayMs: 600 });

    expect(report.failed.find(fault => fault.id === id)?.code).toBe('payments.notification_provider_timeout');
    expect(await storedExecution(id)).toMatchObject({ status: 'failed', nextRetryAt: null });
    expect(await communicationsOf(id)).toEqual([{ status: 'failed' }]);
  });

  it('a 4xx refusal is listed with its code and never retried: the request itself is wrong', async () => {
    const { id } = await dueExecution('send-4xx');

    const report = await tickWhileResend({ status: 422, body: '{"message":"invalid recipient"}' });

    expect(report.failed.find(fault => fault.id === id)?.code).toBe('payments.notification_provider_rejected');
    expect(await storedExecution(id)).toMatchObject({ status: 'failed', nextRetryAt: null });
  });

  it('a sent message completes the execution and counts once in the analytics', async () => {
    const { id, campaignId } = await dueExecution('send-ok');

    const report = await service.processScheduledExecutions(1000);

    expect(report.failed.map(fault => fault.id)).not.toContain(id);
    expect(await storedExecution(id)).toMatchObject({ status: 'completed' });
    expect(await communicationsOf(id)).toEqual([{ status: 'sent' }]);
    const [row] = await db
      .select()
      .from(tables.dunningCampaignAnalytics)
      .where(eq(tables.dunningCampaignAnalytics.campaignId, campaignId));
    expect(row).toMatchObject({ communicationsSent: 1, customersReached: 1 });
  });
});

// A repository is a public door too: a value its column refuses must come back as schema.invalid_input,
// never as a raw SQLSTATE error (22021 for U+0000, 22001 for a varchar overflow)
describe('the dunning repositories refuse what their columns refuse', () => {
  const NUL = '\u0000';

  it('campaign writes refuse an actor id Postgres cannot store and write nothing', async () => {
    const campaigns = createDunningCampaignRepository(db, tables);
    const before = await countOf(tables.dunningCampaigns);

    const created = await campaigns.create({ ...campaignInput([0]), name: 'Bad actor', createdBy: `usr_${NUL}` });
    const campaignId = await createdCampaign('Actor updates');
    const updated = await campaigns.update(campaignId, { name: 'Renamed', updatedBy: `usr_${NUL}` });
    const statusChanged = await campaigns.updateStatus(campaignId, 'paused', `usr_${NUL}`);

    for (const refused of [created, updated, statusChanged]) expect(refused).toMatchObject({ code: 'schema.invalid_input' });
    expect(await countOf(tables.dunningCampaigns)).toBe(before + 1);
    expect(await service.getCampaign(campaignId)).toMatchObject({ name: 'Actor updates', status: 'active' });
  });

  it('execution writes refuse text and JSON their columns cannot store; a failure is still recorded', async () => {
    const campaignId = await createdCampaign('Execution columns');
    const campaign = await service.getCampaign(campaignId);
    const executions = createDunningExecutionRepository(db, tables);
    const valid = {
      campaignId,
      templateId: campaign?.templates[0]?.id,
      customerId,
      triggerType: 'manual',
      triggerData: {},
      scheduledAt: add(now(), { hours: 24 }),
    };

    expect(await executions.create({ ...valid, triggerType: 't'.repeat(101) })).toMatchObject({ code: 'schema.invalid_input' });
    expect(await executions.create({ ...valid, triggerData: { note: NUL } })).toMatchObject({ code: 'schema.invalid_input' });
    const stored = orThrow(await executions.create(valid));
    expect(await executions.updateStatus(stored.id, 'failed', undefined, `bad${NUL}`)).toMatchObject({
      code: 'schema.invalid_input',
    });
    expect(await executions.recordFailure(stored.id, `bad${NUL}`, null)).toMatchObject({
      status: 'failed',
      errorMessage: 'The error message cannot be stored',
    });
    const rows = await db.select().from(tables.dunningExecutions).where(eq(tables.dunningExecutions.campaignId, campaignId));
    expect(rows).toHaveLength(1);
  });

  it('communication writes refuse a recipient, id or JSON their columns cannot store', async () => {
    const campaignId = await createdCampaign('Communication columns');
    const campaign = await service.getCampaign(campaignId);
    const ran = await execution(campaignId, 'completed');
    const communications = createDunningCommunicationRepository(db, tables);
    const valid = {
      executionId: ran.id,
      customerId,
      templateId: campaign?.templates[0]?.id ?? orThrow(createDunningTemplateId()),
      channel: 'email' as const,
      recipient: 'buyer@example.com',
      content: 'Please update your card',
      status: 'pending' as const,
    };

    expect(await communications.create({ ...valid, recipient: 'r'.repeat(256) })).toMatchObject({ code: 'schema.invalid_input' });
    expect(await communications.create({ ...valid, subject: 's'.repeat(501) })).toMatchObject({ code: 'schema.invalid_input' });
    const stored = orThrow(await communications.create(valid));
    expect(await communications.updateStatus(stored.id, 'sent', { providerMessageId: 'm'.repeat(256) })).toMatchObject({
      code: 'schema.invalid_input',
    });
    expect(await communications.updateStatus(stored.id, 'failed', { failureReason: `bad${NUL}` })).toMatchObject({
      code: 'schema.invalid_input',
    });
    expect(await communications.updateStatus(stored.id, 'sent', { trackingData: { [`k${NUL}`]: 1 } })).toMatchObject({
      code: 'schema.invalid_input',
    });
    expect(await communications.findByProviderMessageId(`m${NUL}`)).toBeUndefined();
    expect(await communications.findByProviderMessageId('m'.repeat(256))).toBeUndefined();
    const rows = await db.select().from(tables.dunningCommunications).where(eq(tables.dunningCommunications.executionId, ran.id));
    expect(rows).toEqual([expect.objectContaining({ status: 'pending', providerMessageId: null })]);
  });
});

describe('executeCampaign passes on the failure of a row deleted while it schedules', () => {
  it('a step deleted after the first customer was scheduled returns payments.dunning_template_not_found', async () => {
    const first = await newCustomer('deleted-step-1');
    const second = await newCustomer('deleted-step-2');
    for (const buyer of [first, second]) await newPayment(buyer, 'failed', now());
    const campaignId = await createdCampaign('Deleted step');
    const campaign = await service.getCampaign(campaignId);
    const step = campaign?.templates[0];
    if (!step) throw new Error('campaign needs a step');
    // The step goes away as soon as the first execution is written, before the second customer's is
    await db.execute(
      sql.raw(
        [
          'CREATE FUNCTION delete_step_after_first() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN',
          'DELETE FROM pay.dunning_templates WHERE id = NEW.template_id; RETURN NULL; END $$',
        ].join(' '),
      ),
    );
    await db.execute(
      sql`CREATE TRIGGER delete_step_after_first AFTER INSERT ON ${tables.dunningExecutions} FOR EACH ROW EXECUTE FUNCTION delete_step_after_first()`,
    );

    try {
      const answer = await service.executeCampaign(
        { campaignId, dryRun: false, customFilters: { customerIds: [first.id, second.id], testMode: false } },
        'usr_admin',
      );

      expect(answer).toMatchObject({ code: 'payments.dunning_template_not_found', data: { templateId: step.id } });
    } finally {
      await db.execute(sql`DROP TRIGGER delete_step_after_first ON ${tables.dunningExecutions}`);
    }
  });
});
