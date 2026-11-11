import type { PGlite } from '@electric-sql/pglite';
import { expect } from 'vitest';

import { instant, isInstant } from '@arki/date';
import { orThrow } from '@arki/failure';
import { MoneyBag } from '@arki/money/bag';

import type { CustomerId } from '../core/primitives.js';
import type { UserId } from '../core/user-id.js';
import type { CreateCustomerSegmentInput, CreateDunningCampaignInput } from '../dunning/contracts.js';
import type { CustomerRiskProfile } from '../dunning/types.js';
import type { AppDb } from '../test-support.js';
import { createCustomerId } from '../core/primitives.js';
import { userIdFactory } from '../core/user-id.js';
import { analyticsRowId, sumMinorByCurrency } from '../dunning/analytics-money.js';
import { tickFault } from '../dunning/index.js';
import {
  createCustomerRiskProfileId,
  createCustomerSegmentId,
  createDunningCampaignId,
  createDunningCommunicationId,
  createDunningExecutionId,
  createDunningTemplateId,
} from '../dunning/primitives.js';
import {
  createCustomerRiskProfileRepository,
  createCustomerSegmentRepository,
  createDunningCampaignRepository,
  createDunningCommunicationRepository,
  createDunningExecutionRepository,
  createDunningRepository,
  createDunningTemplateRepository,
  CustomerRiskProfileRepository,
  CustomerSegmentRepository,
  DunningCampaignRepository,
  DunningCommunicationRepository,
  DunningExecutionRepository,
  DunningTemplateRepository,
} from '../dunning/repository.js';
import { valueList } from '../dunning/sql-list.js';
import { readCustomerRiskProfile } from '../dunning/stored-risk-profile.js';
import { createDunningTables } from '../dunning/tables.js';
import { core, openDb, schema, users } from '../test-support.js';
import { area, args, op } from './engine.js';

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});

type Ctx = { db: AppDb; client: PGlite; repos: ReturnType<typeof createDunningRepository> };

const actor: UserId = 'usr_test';
const noArgs = (): [] => [];

const freshSettings = () => ({
  enabled: true,
  priority: 1,
  cooldownPeriod: 1,
  maxExecutionsPerCustomer: 1,
  stopOnPaymentSuccess: true,
  respectUnsubscribe: true,
  businessHoursOnly: false,
});

const page = { limit: 10, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' } as const;
const dependencyKeep = {
  'args[0]': 'the database, a dependency, not input',
  'args[1]': 'the tables, a dependency, not input',
};

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}_${String(counter)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** A customer of its own: the fixture allows one customer per user, so each one gets a user. */
async function newCustomer(ctx: Ctx): Promise<CustomerId> {
  const userId = orThrow(userIdFactory.create());
  const id = orThrow(createCustomerId());
  await ctx.db.insert(users).values({ id: userId });
  await ctx.db
    .insert(core.customers)
    .values({ id, userId, providerCustomerId: unique('cus'), email: 'buyer@example.com' });
  return id;
}

function campaignInput(): CreateDunningCampaignInput & { createdBy: UserId } {
  return {
    name: unique('Campaign'),
    type: 'payment_failed',
    trigger: { type: 'payment_failure', conditions: {} },
    settings: freshSettings(),
    targetSegments: [],
    templates: [
      {
        name: 'Step one',
        stepNumber: 1,
        delayHours: 0,
        communication: { channel: 'email', subject: 'Hi', content: 'Pay up', variables: [] },
      },
    ],
    createdBy: actor,
  };
}

async function newCampaign(ctx: Ctx) {
  const campaign = orThrow(await ctx.repos.campaigns.create(campaignInput()));
  const template = orThrow(
    await ctx.repos.templates.create({
      campaignId: campaign.id,
      name: 'Step one',
      stepNumber: 1,
      delayHours: 0,
      communication: { channel: 'email', subject: 'Hi', content: 'Pay up', variables: [] },
    }),
  );
  return { campaign, template };
}

async function newExecution(ctx: Ctx) {
  const { campaign, template } = await newCampaign(ctx);
  const customerId = await newCustomer(ctx);
  const execution = orThrow(
    await ctx.repos.executions.create({
      campaignId: campaign.id,
      templateId: template.id,
      customerId,
      triggerType: 'payment_failure',
      triggerData: {},
      status: 'scheduled',
      scheduledAt: instant('2020-01-01T00:00:00Z'),
      retryCount: 0,
    }),
  );
  return { campaign, template, customerId, execution };
}

async function newCommunication(ctx: Ctx) {
  const base = await newExecution(ctx);
  const communication = orThrow(
    await ctx.repos.communications.create({
      executionId: base.execution.id,
      customerId: base.customerId,
      templateId: base.template.id,
      channel: 'email',
      recipient: 'buyer@example.com',
      content: 'Please update your card',
      status: 'pending',
      providerMessageId: unique('msg'),
    }),
  );
  return { ...base, communication };
}

function segmentInput(): CreateCustomerSegmentInput & { createdBy: UserId } {
  return {
    name: unique('Segment'),
    type: 'behavior_based',
    criteria: {},
    autoUpdate: true,
    updateFrequency: 1,
    createdBy: actor,
  };
}

async function newSegment(ctx: Ctx) {
  const segment = orThrow(await ctx.repos.customerSegments.create(segmentInput()));
  if (segment === undefined) throw new Error('the segment was created without a row');
  return segment;
}

function profileOf(customerId: CustomerId): Omit<CustomerRiskProfile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    customerId,
    segmentIds: [],
    riskScore: {
      overall: 40,
      factors: { recency: 0.4 },
      category: 'medium',
      lastCalculated: instant('2026-03-04T05:06:07.123Z'),
      trends: { direction: 'stable', changePercent: 0, timeframe: 30 },
    },
    paymentHistory: {
      totalPayments: 3,
      successfulPayments: 2,
      failedPayments: 1,
      averageAmount: 1000,
      lastPaymentDate: instant('2026-02-01T10:00:00Z'),
      streakDays: 5,
    },
    subscriptionHistory: {
      totalSubscriptions: 1,
      activeSubscriptions: 1,
      canceledSubscriptions: 0,
      averageDuration: 90,
    },
    engagementMetrics: {
      score: 70,
      lastActivity: instant('2026-03-01T08:30:00Z'),
      activityFrequency: 3,
      featureUsage: {},
    },
    communicationPreferences: { unsubscribed: false, unsubscribedChannels: [] },
    metadata: null,
  };
}

async function newProfile(ctx: Ctx) {
  const customerId = await newCustomer(ctx);
  const profile = orThrow(await ctx.repos.customerRiskProfiles.create(profileOf(customerId)));
  return { customerId, profile };
}

async function campaignIdOf(ctx: Ctx) {
  const { campaign } = await newCampaign(ctx);
  return campaign.id;
}
async function templateIdOf(ctx: Ctx) {
  const { template } = await newCampaign(ctx);
  return template.id;
}
async function executionIdOf(ctx: Ctx) {
  const { execution } = await newExecution(ctx);
  return execution.id;
}
async function communicationIdOf(ctx: Ctx) {
  const { communication } = await newCommunication(ctx);
  return communication.id;
}
async function communicationExecutionIdOf(ctx: Ctx) {
  const { execution } = await newCommunication(ctx);
  return execution.id;
}
async function providerMessageIdOf(ctx: Ctx) {
  const { communication } = await newCommunication(ctx);
  return communication.providerMessageId ?? '';
}
async function segmentIdOf(ctx: Ctx) {
  const segment = await newSegment(ctx);
  return segment.id;
}
async function profileCustomerIdOf(ctx: Ctx) {
  const { customerId } = await newProfile(ctx);
  return customerId;
}
async function storedProfileOf(ctx: Ctx) {
  const { profile } = await newProfile(ctx);
  return profile;
}

const zeroAnalytics = {
  executions: 0,
  customersReached: 0,
  communicationsSent: 0,
  paymentsRecovered: 0,
  conversionRate: 0,
  roi: 0,
};
const longAgo = instant('2020-01-01T00:00:00Z');

export const dunningRepositoryArea = area<Ctx>({
  area: 'dunning-repository',
  async open() {
    const { db, client } = await openDb({ ...dunning.enums, ...dunning });
    return { db, client, repos: createDunningRepository(db, dunning) };
  },
  close: ctx => ctx.client.close(),
  cases: [
    // ------------------------------------------------------------ pure helpers
    op('dunning/analytics-money.ts::analyticsRowId', {
      arrange: () => args(orThrow(createDunningCampaignId()), '2026-11-09', 'usd'),
      call: (_ctx, campaignId, day, currency) => analyticsRowId(campaignId, day, currency),
      valid: result => expect(result).toMatch(/^dc.*-2026-11-09-USD$/),
    }),
    op('dunning/analytics-money.ts::sumMinorByCurrency', {
      arrange: () =>
        args([
          { currency: 'USD', units: 150 },
          { currency: 'eur', units: '200' },
        ]),
      call: (_ctx, rows) => sumMinorByCurrency(rows),
      valid: result => {
        expect(result).toBeInstanceOf(MoneyBag);
        expect(result).toMatchObject({});
        expect(String(JSON.stringify(result))).toContain('EUR');
      },
    }),
    op('dunning/index.ts::tickFault', {
      arrange: () => args('item_1', new Error('boom')),
      call: (_ctx, id, fault) => tickFault(id, fault),
      valid: result => expect(result).toEqual({ id: 'item_1', status: 'thrown', error: new Error('boom') }),
    }),
    op('dunning/primitives.ts::createCustomerRiskProfileId', {
      arrange: noArgs,
      call: () => createCustomerRiskProfileId(),
    }),
    op('dunning/primitives.ts::createCustomerSegmentId', { arrange: noArgs, call: () => createCustomerSegmentId() }),
    op('dunning/primitives.ts::createDunningCampaignId', { arrange: noArgs, call: () => createDunningCampaignId() }),
    op('dunning/primitives.ts::createDunningCommunicationId', {
      arrange: noArgs,
      call: () => createDunningCommunicationId(),
    }),
    op('dunning/primitives.ts::createDunningExecutionId', { arrange: noArgs, call: () => createDunningExecutionId() }),
    op('dunning/primitives.ts::createDunningTemplateId', { arrange: noArgs, call: () => createDunningTemplateId() }),
    op('dunning/sql-list.ts::valueList', {
      arrange: () => args(['a', 'b']),
      call: (_ctx, values) => valueList(values),
      valid: result => expect(result).toHaveProperty('queryChunks'),
    }),
    op('dunning/stored-risk-profile.ts::readCustomerRiskProfile', {
      arrange: async ctx => args(await storedProfileOf(ctx)),
      call: (_ctx, row) => readCustomerRiskProfile(row),
      valid: result =>
        expect(
          isInstant(
            result && typeof result === 'object' && 'riskScore' in result
              ? (result.riskScore as { lastCalculated: unknown }).lastCalculated
              : undefined,
          ),
        ).toBe(true),
    }),
    op('dunning/tables.ts::createDunningTables', {
      arrange: () =>
        args({
          schema,
          customerIdRef: () => core.customers.id,
          paymentIdRef: () => core.payments.id,
          subscriptionIdRef: () => core.subscriptions.id,
        }),
      call: (_ctx, deps) => createDunningTables(deps),
      keep: { 'args[0].schema': 'a schema object, a dependency, not input' },
      valid: result => expect(result).toHaveProperty('dunningCampaigns'),
    }),

    // ------------------------------------------------------------ factories
    op('dunning/repository.ts::createDunningRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => createDunningRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toHaveProperty('campaigns'),
    }),
    op('dunning/repository.ts::createDunningCampaignRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => createDunningCampaignRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(DunningCampaignRepository),
    }),
    op('dunning/repository.ts::createDunningTemplateRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => createDunningTemplateRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(DunningTemplateRepository),
    }),
    op('dunning/repository.ts::createDunningExecutionRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => createDunningExecutionRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(DunningExecutionRepository),
    }),
    op('dunning/repository.ts::createDunningCommunicationRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => createDunningCommunicationRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(DunningCommunicationRepository),
    }),
    op('dunning/repository.ts::createCustomerSegmentRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => createCustomerSegmentRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(CustomerSegmentRepository),
    }),
    op('dunning/repository.ts::createCustomerRiskProfileRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => createCustomerRiskProfileRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(CustomerRiskProfileRepository),
    }),

    // ------------------------------------------------------------ constructors
    op('dunning/repository.ts::DunningCampaignRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => new DunningCampaignRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(DunningCampaignRepository),
    }),
    op('dunning/repository.ts::DunningTemplateRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => new DunningTemplateRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(DunningTemplateRepository),
    }),
    op('dunning/repository.ts::DunningExecutionRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => new DunningExecutionRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(DunningExecutionRepository),
    }),
    op('dunning/repository.ts::DunningCommunicationRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => new DunningCommunicationRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(DunningCommunicationRepository),
    }),
    op('dunning/repository.ts::CustomerSegmentRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => new CustomerSegmentRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(CustomerSegmentRepository),
    }),
    op('dunning/repository.ts::CustomerRiskProfileRepository', {
      arrange: ctx => args(ctx.db, dunning),
      call: (_ctx, db, tables) => new CustomerRiskProfileRepository(db, tables),
      keep: dependencyKeep,
      valid: result => expect(result).toBeInstanceOf(CustomerRiskProfileRepository),
    }),

    // ------------------------------------------------------------ campaigns
    op('dunning/repository.ts::DunningCampaignRepository.create', {
      arrange: () => args(campaignInput()),
      call: (ctx, input) => ctx.repos.campaigns.create(input),
      valid: result => expect(result).toMatchObject({ type: 'payment_failed', status: 'draft' }),
    }),
    op('dunning/repository.ts::DunningCampaignRepository.findById', {
      arrange: async ctx => args(await campaignIdOf(ctx)),
      call: (ctx, id) => ctx.repos.campaigns.findById(id),
      valid: result => expect(result).toMatchObject({ type: 'payment_failed' }),
    }),
    op('dunning/repository.ts::DunningCampaignRepository.findMany', {
      arrange: async ctx => {
        const { campaign } = await newCampaign(ctx);
        return args({ ...page, search: campaign.name, type: 'payment_failed' as const });
      },
      call: (ctx, query) => ctx.repos.campaigns.findMany(query),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('dunning/repository.ts::DunningCampaignRepository.update', {
      arrange: async ctx => args(await campaignIdOf(ctx), { name: unique('Renamed'), updatedBy: actor }),
      call: (ctx, id, input) => ctx.repos.campaigns.update(id, input),
      valid: result => expect(result).toMatchObject({ name: expect.stringContaining('Renamed') }),
    }),
    op('dunning/repository.ts::DunningCampaignRepository.updateStatus', {
      arrange: async ctx => args(await campaignIdOf(ctx), 'active' as const, actor),
      call: (ctx, id, status, updatedBy) => ctx.repos.campaigns.updateStatus(id, status, updatedBy),
      valid: result => expect(result).toMatchObject({ status: 'active' }),
    }),
    op('dunning/repository.ts::DunningCampaignRepository.delete', {
      arrange: async ctx => args(await campaignIdOf(ctx)),
      call: (ctx, id) => ctx.repos.campaigns.delete(id),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('dunning/repository.ts::DunningCampaignRepository.findByType', {
      arrange: () => args('payment_failed' as const),
      call: (ctx, type) => ctx.repos.campaigns.findByType(type),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),
    op('dunning/repository.ts::DunningCampaignRepository.findActiveForTrigger', {
      arrange: () => args('payment_failure' as const),
      call: (ctx, triggerType) => ctx.repos.campaigns.findActiveForTrigger(triggerType),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),
    op('dunning/repository.ts::DunningCampaignRepository.countCampaigns', {
      arrange: () => args<[]>(),
      call: (ctx, ..._none) => ctx.repos.campaigns.countCampaigns(),
      valid: result => expect(result).toMatchObject({ total: expect.any(Number), active: expect.any(Number) }),
    }),
    op('dunning/repository.ts::DunningCampaignRepository.getAnalyticsSummary', {
      arrange: async ctx => args(await campaignIdOf(ctx), 30),
      call: (ctx, id, days) => ctx.repos.campaigns.getAnalyticsSummary(id, days),
      valid: result => expect(result).toMatchObject(zeroAnalytics),
    }),
    op('dunning/repository.ts::DunningCampaignRepository.getAnalyticsSince', {
      arrange: async ctx => args(longAgo, await campaignIdOf(ctx)),
      call: (ctx, since, id) => ctx.repos.campaigns.getAnalyticsSince(since, id),
      valid: result => expect(result).toMatchObject(zeroAnalytics),
    }),
    op('dunning/repository.ts::DunningCampaignRepository.findTopPerformer', {
      arrange: () => args(longAgo),
      call: (ctx, since) => ctx.repos.campaigns.findTopPerformer(since),
      valid: result => expect(result === null || typeof result === 'object').toBe(true),
    }),

    // ------------------------------------------------------------ templates
    op('dunning/repository.ts::DunningTemplateRepository.create', {
      arrange: async ctx =>
        args({
          campaignId: await campaignIdOf(ctx),
          name: 'Step two',
          stepNumber: 2,
          delayHours: 24,
          communication: { channel: 'email' as const, content: 'Again', variables: [] },
        }),
      call: (ctx, input) => ctx.repos.templates.create(input),
      valid: result => expect(result).toMatchObject({ name: 'Step two', stepNumber: 2 }),
    }),
    op('dunning/repository.ts::DunningTemplateRepository.findById', {
      arrange: async ctx => args(await templateIdOf(ctx)),
      call: (ctx, id) => ctx.repos.templates.findById(id),
      valid: result => expect(result).toMatchObject({ name: 'Step one' }),
    }),
    op('dunning/repository.ts::DunningTemplateRepository.findByCampaignId', {
      arrange: async ctx => args(await campaignIdOf(ctx)),
      call: (ctx, id) => ctx.repos.templates.findByCampaignId(id),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('dunning/repository.ts::DunningTemplateRepository.findActiveTemplates', {
      arrange: async ctx => args(await campaignIdOf(ctx)),
      call: (ctx, id) => ctx.repos.templates.findActiveTemplates(id),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('dunning/repository.ts::DunningTemplateRepository.update', {
      arrange: async ctx => args(await templateIdOf(ctx), { name: 'Step renamed' }),
      call: (ctx, id, input) => ctx.repos.templates.update(id, input),
      valid: result => expect(result).toMatchObject({ name: 'Step renamed' }),
    }),
    op('dunning/repository.ts::DunningTemplateRepository.updateStatus', {
      arrange: async ctx => args(await templateIdOf(ctx), false),
      call: (ctx, id, isActive) => ctx.repos.templates.updateStatus(id, isActive),
      valid: result => expect(result).toMatchObject({ isActive: false }),
    }),
    op('dunning/repository.ts::DunningTemplateRepository.delete', {
      arrange: async ctx => {
        const { campaign } = await newCampaign(ctx);
        const added = orThrow(
          await ctx.repos.templates.create({
            campaignId: campaign.id,
            name: 'Extra',
            stepNumber: 2,
            delayHours: 1,
            communication: { channel: 'email', content: 'x', variables: [] },
          }),
        );
        return args(added.id);
      },
      call: (ctx, id) => ctx.repos.templates.delete(id),
      valid: result => expect(result).toBeUndefined(),
    }),

    // ------------------------------------------------------------ executions
    op('dunning/repository.ts::DunningExecutionRepository.create', {
      arrange: async ctx => {
        const { campaign, template } = await newCampaign(ctx);
        return args({
          campaignId: campaign.id,
          templateId: template.id,
          customerId: await newCustomer(ctx),
          triggerType: 'payment_failure',
          triggerData: {},
          status: 'scheduled' as const,
          scheduledAt: instant('2020-01-01T00:00:00Z'),
          retryCount: 0,
        });
      },
      call: (ctx, input) => ctx.repos.executions.create(input),
      valid: result => expect(result).toMatchObject({ status: 'scheduled', retryCount: 0 }),
    }),
    op('dunning/repository.ts::DunningExecutionRepository.findById', {
      arrange: async ctx => args(await executionIdOf(ctx)),
      call: (ctx, id) => ctx.repos.executions.findById(id),
      valid: result => expect(result).toMatchObject({ status: 'scheduled' }),
    }),
    op('dunning/repository.ts::DunningExecutionRepository.findMany', {
      arrange: async ctx => {
        const { campaign } = await newExecution(ctx);
        return args({
          limit: 10,
          offset: 0,
          campaignId: campaign.id,
          status: 'scheduled' as const,
          sortBy: 'scheduledAt' as const,
          sortOrder: 'asc' as const,
        });
      },
      call: (ctx, query) => ctx.repos.executions.findMany(query),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('dunning/repository.ts::DunningExecutionRepository.updateStatus', {
      arrange: async ctx =>
        args(
          await executionIdOf(ctx),
          'running' as const,
          {
            customersProcessed: 0,
            communicationsSent: 0,
            errors: [],
            performance: { processingTime: 1, successRate: 1 },
          },
          'none',
          instant('2021-01-01T00:00:00Z'),
        ),
      call: (ctx, id, status, result, errorMessage, scheduledAt) =>
        ctx.repos.executions.updateStatus(id, status, result, errorMessage, scheduledAt),
      valid: result => expect(result).toMatchObject({ status: 'running' }),
    }),
    op('dunning/repository.ts::DunningExecutionRepository.findScheduledExecutions', {
      arrange: () => args(100),
      call: (ctx, limit) => ctx.repos.executions.findScheduledExecutions(limit),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),
    op('dunning/repository.ts::DunningExecutionRepository.findRetryableExecutions', {
      arrange: () => args(50),
      call: (ctx, limit) => ctx.repos.executions.findRetryableExecutions(limit),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),
    op('dunning/repository.ts::DunningExecutionRepository.startRetry', {
      arrange: async ctx => args(await executionIdOf(ctx)),
      call: (ctx, id) => ctx.repos.executions.startRetry(id),
      valid: result => expect(result).toMatchObject({ status: 'running', retryCount: 1 }),
    }),
    op('dunning/repository.ts::DunningExecutionRepository.recordFailure', {
      arrange: async ctx => args(await executionIdOf(ctx), 'provider down', instant('2021-01-01T00:00:00Z')),
      call: (ctx, id, errorMessage, nextRetryAt) => ctx.repos.executions.recordFailure(id, errorMessage, nextRetryAt),
      valid: result => expect(result).toMatchObject({ status: 'failed', errorMessage: 'provider down' }),
    }),
    op('dunning/repository.ts::DunningExecutionRepository.findRecentForCustomer', {
      arrange: async ctx => {
        const { customerId, campaign } = await newExecution(ctx);
        return args(customerId, campaign.id, 24);
      },
      call: (ctx, customerId, campaignId, hours) =>
        ctx.repos.executions.findRecentForCustomer(customerId, campaignId, hours),
      valid: result => expect(result).toHaveLength(1),
    }),

    // ------------------------------------------------------------ communications
    op('dunning/repository.ts::DunningCommunicationRepository.create', {
      arrange: async ctx => {
        const base = await newExecution(ctx);
        return args({
          executionId: base.execution.id,
          customerId: base.customerId,
          templateId: base.template.id,
          channel: 'email' as const,
          recipient: 'buyer@example.com',
          content: 'Please update your card',
          status: 'sent' as const,
          providerMessageId: unique('msg'),
        });
      },
      call: (ctx, input) => ctx.repos.communications.create(input),
      valid: result => expect(result).toMatchObject({ channel: 'email', status: 'sent' }),
    }),
    op('dunning/repository.ts::DunningCommunicationRepository.findById', {
      arrange: async ctx => args(await communicationIdOf(ctx)),
      call: (ctx, id) => ctx.repos.communications.findById(id),
      valid: result => expect(result).toMatchObject({ status: 'pending' }),
    }),
    op('dunning/repository.ts::DunningCommunicationRepository.findMany', {
      arrange: async ctx => {
        const { execution } = await newCommunication(ctx);
        return args({ ...page, executionId: execution.id, channel: 'email' as const });
      },
      call: (ctx, query) => ctx.repos.communications.findMany(query),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('dunning/repository.ts::DunningCommunicationRepository.updateStatus', {
      arrange: async ctx =>
        args(await communicationIdOf(ctx), 'sent' as const, {
          sentAt: instant('2021-01-01T00:00:00Z'),
          providerMessageId: unique('msg'),
          providerResponse: { ok: true },
          trackingData: { pixel: 'x' },
        }),
      call: (ctx, id, status, updates) => ctx.repos.communications.updateStatus(id, status, updates),
      valid: result => expect(result).toMatchObject({ status: 'sent' }),
    }),
    op('dunning/repository.ts::DunningCommunicationRepository.findPendingCommunications', {
      arrange: () => args(100),
      call: (ctx, limit) => ctx.repos.communications.findPendingCommunications(limit),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),
    op('dunning/repository.ts::DunningCommunicationRepository.findByProviderMessageId', {
      arrange: async ctx => args(await providerMessageIdOf(ctx)),
      call: (ctx, providerMessageId) => ctx.repos.communications.findByProviderMessageId(providerMessageId),
      valid: result => expect(result).toMatchObject({ channel: 'email' }),
    }),
    op('dunning/repository.ts::DunningCommunicationRepository.getMetricsForExecution', {
      arrange: async ctx => args(await communicationExecutionIdOf(ctx)),
      call: (ctx, id) => ctx.repos.communications.getMetricsForExecution(id),
      valid: result => expect(result).toEqual({ total: 1, sent: 0, delivered: 0, opened: 0, clicked: 0, failed: 0 }),
    }),

    // ------------------------------------------------------------ segments
    op('dunning/repository.ts::CustomerSegmentRepository.create', {
      arrange: () => args(segmentInput()),
      call: (ctx, input) => ctx.repos.customerSegments.create(input),
      valid: result => expect(result).toMatchObject({ type: 'behavior_based', autoUpdate: true }),
    }),
    op('dunning/repository.ts::CustomerSegmentRepository.findById', {
      arrange: async ctx => args(await segmentIdOf(ctx)),
      call: (ctx, id) => ctx.repos.customerSegments.findById(id),
      valid: result => expect(result).toMatchObject({ type: 'behavior_based' }),
    }),
    op('dunning/repository.ts::CustomerSegmentRepository.findMany', {
      arrange: async ctx => {
        const segment = await newSegment(ctx);
        return args({ ...page, search: segment.name, type: 'behavior_based' as const, isActive: true });
      },
      call: (ctx, query) => ctx.repos.customerSegments.findMany(query),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('dunning/repository.ts::CustomerSegmentRepository.update', {
      arrange: async ctx => args(await segmentIdOf(ctx), { name: unique('Segment renamed'), isActive: false }),
      call: (ctx, id, input) => ctx.repos.customerSegments.update(id, input),
      valid: result => expect(result).toMatchObject({ isActive: false }),
    }),
    op('dunning/repository.ts::CustomerSegmentRepository.updateCustomerCount', {
      arrange: async ctx => args(await segmentIdOf(ctx), 7),
      call: (ctx, id, count) => ctx.repos.customerSegments.updateCustomerCount(id, count),
      valid: result => expect(result).toMatchObject({ customerCount: 7 }),
    }),
    op('dunning/repository.ts::CustomerSegmentRepository.delete', {
      arrange: async ctx => args(await segmentIdOf(ctx)),
      call: (ctx, id) => ctx.repos.customerSegments.delete(id),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('dunning/repository.ts::CustomerSegmentRepository.findSegmentsForAutoUpdate', {
      arrange: () => args<[]>(),
      call: (ctx, ..._none) => ctx.repos.customerSegments.findSegmentsForAutoUpdate(),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),

    // ------------------------------------------------------------ risk profiles
    op('dunning/repository.ts::CustomerRiskProfileRepository.create', {
      arrange: async ctx => args(profileOf(await newCustomer(ctx))),
      call: (ctx, input) => ctx.repos.customerRiskProfiles.create(input),
      valid: result => expect(result).toMatchObject({ riskScore: { category: 'medium' } }),
    }),
    op('dunning/repository.ts::CustomerRiskProfileRepository.findByCustomerId', {
      arrange: async ctx => args(await profileCustomerIdOf(ctx)),
      call: (ctx, id) => ctx.repos.customerRiskProfiles.findByCustomerId(id),
      valid: result => expect(result).toMatchObject({ riskScore: { overall: 40 } }),
    }),
    op('dunning/repository.ts::CustomerRiskProfileRepository.update', {
      arrange: async ctx =>
        args(await profileCustomerIdOf(ctx), {
          engagementMetrics: { score: 10, activityFrequency: 1, featureUsage: {} },
        }),
      call: (ctx, id, input) => ctx.repos.customerRiskProfiles.update(id, input),
      valid: result => expect(result).toMatchObject({ engagementMetrics: { score: 10 } }),
    }),
    op('dunning/repository.ts::CustomerRiskProfileRepository.upsert', {
      arrange: async ctx => args(profileOf(await newCustomer(ctx))),
      call: (ctx, input) => ctx.repos.customerRiskProfiles.upsert(input),
      valid: result => expect(result).toMatchObject({ riskScore: { category: 'medium' } }),
    }),
    op('dunning/repository.ts::CustomerRiskProfileRepository.findByRiskCategory', {
      arrange: async ctx => {
        await newProfile(ctx);
        return args('medium' as const, 10);
      },
      call: (ctx, category, limit) => ctx.repos.customerRiskProfiles.findByRiskCategory(category, limit),
      valid: result => expect(Array.isArray(result) && result.length > 0).toBe(true),
    }),
    op('dunning/repository.ts::CustomerRiskProfileRepository.findBySegmentId', {
      arrange: async ctx => {
        const segment = await newSegment(ctx);
        const { customerId } = await newProfile(ctx);
        orThrow(await ctx.repos.customerRiskProfiles.updateSegments(customerId, [segment.id]));
        return args(segment.id, 10);
      },
      call: (ctx, segmentId, limit) => ctx.repos.customerRiskProfiles.findBySegmentId(segmentId, limit),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('dunning/repository.ts::CustomerRiskProfileRepository.updateSegments', {
      arrange: async ctx => {
        const segment = await newSegment(ctx);
        return args(await profileCustomerIdOf(ctx), [segment.id]);
      },
      call: (ctx, customerId, segmentIds) => ctx.repos.customerRiskProfiles.updateSegments(customerId, segmentIds),
      valid: result => expect(result).toMatchObject({ segmentIds: [expect.stringMatching(/^cs/)] }),
    }),
  ],
});
