import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, asc, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';

import { invariant } from '@arki/failure';

import type { Instant } from '@arki/date';
import { fromDate, now, sub } from '@arki/date';

import type { CustomerId } from '../core/primitives.js';
import type {
  CreateCustomerSegmentInput,
  CreateDunningCampaignInput,
  CreateDunningTemplateInput,
  ListCommunicationsQuery,
  ListCustomerSegmentsQuery,
  ListDunningCampaignsQuery,
  ListExecutionsQuery,
  UpdateCustomerSegmentInput,
  UpdateDunningCampaignInput,
  UpdateDunningTemplateInput,
} from './contracts.js';
import type {
  CustomerSegmentId,
  DunningCampaignId,
  DunningCampaignType,
  DunningCommunicationId,
  DunningExecutionId,
  DunningTemplateId,
  ExecutionStatus,
} from './primitives.js';
import type { DunningTables } from './tables.js';
import type {
  CustomerRiskProfile,
  DunningCampaign,
  DunningCommunication,
  DunningExecution,
  DunningTemplate,
  ExecutionResultDb,
  NewDunningCommunication,
  NewDunningExecution,
} from './types.js';
import { sumMinorByCurrency } from './analytics-money.js';
import { readCustomerRiskProfile } from './stored-risk-profile.js';

/**
 * Structural database type accepted by the dunning repositories. See the
 * `PaymentDatabase` doc in `../core/repository`: the repositories only use
 * `select / insert / update / delete`, so no relations graph is needed. PGlite
 * is accepted so the package can run these queries in its own tests.
 */
export type DunningDatabase =
  | NodePgDatabase<AnyRelations>
  | NodePgTransaction<AnyRelations>
  | PgliteDatabase<AnyRelations>;

type CampaignTables = Pick<
  DunningTables,
  'dunningCampaigns' | 'dunningCampaignAnalytics'
>;

export class DunningCampaignRepository {
  private readonly db: DunningDatabase;
  private readonly dunningCampaigns: DunningTables['dunningCampaigns'];
  private readonly dunningCampaignAnalytics: DunningTables['dunningCampaignAnalytics'];

  constructor(db: DunningDatabase, tables: CampaignTables) {
    this.db = db;
    this.dunningCampaigns = tables.dunningCampaigns;
    this.dunningCampaignAnalytics = tables.dunningCampaignAnalytics;
  }

  async findById(id: DunningCampaignId): Promise<DunningCampaign | null> {
    const [result] = await this.db
      .select()
      .from(this.dunningCampaigns)
      .where(eq(this.dunningCampaigns.id, id))
      .limit(1);
    return result ?? null;
  }

  async findMany(query: ListDunningCampaignsQuery): Promise<DunningCampaign[]> {
    const { limit, offset, type, status, search, sortBy, sortOrder } = query;

    const sortColumn = this.dunningCampaigns[sortBy];

    return this.db
      .select()
      .from(this.dunningCampaigns)
      .where(
        and(
          type ? eq(this.dunningCampaigns.type, type) : undefined,
          status ? eq(this.dunningCampaigns.status, status) : undefined,
          search ? ilike(this.dunningCampaigns.name, `%${search}%`) : undefined,
        ),
      )
      .orderBy(sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn))
      .limit(limit)
      .offset(offset);
  }

  async create(input: CreateDunningCampaignInput & { createdBy: string }): Promise<DunningCampaign> {
    const [campaign] = await this.db
      .insert(this.dunningCampaigns)
      .values({
        name: input.name,
        description: input.description,
        type: input.type,
        trigger: input.trigger,
        settings: input.settings,
        targetSegments: input.targetSegments,
        createdBy: input.createdBy,
      })
      .returning();

    invariant(campaign, 'Failed to create dunning campaign');

    return campaign;
  }

  async update(
    id: DunningCampaignId,
    input: UpdateDunningCampaignInput & { updatedBy: string },
  ): Promise<DunningCampaign | null> {
    const [campaign] = await this.db
      .update(this.dunningCampaigns)
      .set({ ...input, updatedAt: now() })
      .where(eq(this.dunningCampaigns.id, id))
      .returning();

    return (campaign) ?? null;
  }

  async delete(id: DunningCampaignId): Promise<void> {
    await this.db.delete(this.dunningCampaigns).where(eq(this.dunningCampaigns.id, id));
  }

  async findByType(type: DunningCampaignType): Promise<DunningCampaign[]> {
    return this.db
      .select()
      .from(this.dunningCampaigns)
      .where(and(eq(this.dunningCampaigns.type, type), eq(this.dunningCampaigns.status, 'active')));
  }

  async findActiveForTrigger(
    triggerType: string,
    customerSegmentIds?: string[],
  ): Promise<DunningCampaign[]> {
    // The trigger-type lookup hits a JSONB field (`trigger->>'type'`) and the
    // segment intersection uses a JSONB EXISTS subquery — both have no
    // structured-filter equivalent and stay as RAW.
    const hasSegments = customerSegmentIds && customerSegmentIds.length > 0;

    const table = this.dunningCampaigns;
    const triggerTypePredicate = sql`${table.trigger}->>'type' = ${triggerType}`;

    return this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.status, 'active'),
          hasSegments
            ? and(
                triggerTypePredicate,
                sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${table.targetSegments}) AS segment WHERE segment IN ${customerSegmentIds})`,
              )
            : triggerTypePredicate,
        ),
      )
      .orderBy(desc(sql`${table.settings}->>'priority'`));
  }

  async updateStatus(
    id: DunningCampaignId,
    status: 'active' | 'draft' | 'archived' | 'paused',
    updatedBy: string,
  ): Promise<DunningCampaign | undefined> {
    const [campaign] = await this.db
      .update(this.dunningCampaigns)
      .set({ status, updatedBy, updatedAt: now() })
      .where(eq(this.dunningCampaigns.id, id))
      .returning();

    return campaign;
  }

  async getAnalyticsSummary(campaignId?: DunningCampaignId, days = 30) {
    // Local-time calendar days, as before: the working value stays a `Date` until the query.
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return this.getAnalyticsSince(fromDate(startDate), campaignId);
  }

  /** How many campaigns exist, and how many of them are `active`. */
  async countCampaigns(): Promise<{ total: number; active: number }> {
    const rows = await this.db
      .select({
        status: this.dunningCampaigns.status,
        total: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(this.dunningCampaigns)
      .groupBy(this.dunningCampaigns.status);

    return {
      total: rows.reduce((sum, row) => sum + row.total, 0),
      active: rows.find((row) => row.status === 'active')?.total ?? 0,
    };
  }

  /**
   * The campaign that recovered the most payments since `since`, its conversion rate the
   * tie-break. Null when no campaign recovered a payment: there is no top to name. Ranked
   * by count, not money, because campaigns recover in different currencies.
   */
  async findTopPerformer(
    since: Instant,
  ): Promise<{ campaignId: DunningCampaignId; paymentsRecovered: number; conversionRate: number } | null> {
    const analytics = this.dunningCampaignAnalytics;
    const recovered = sql<number>`COALESCE(SUM(${analytics.paymentsRecovered}), 0)::int`.mapWith(Number);
    const conversion = sql<number>`COALESCE(AVG(${analytics.conversionRate}), 0)`.mapWith(Number);

    const [top] = await this.db
      .select({ campaignId: analytics.campaignId, paymentsRecovered: recovered, conversionRate: conversion })
      .from(analytics)
      .where(gte(analytics.date, since))
      .groupBy(analytics.campaignId)
      .having(sql`SUM(${analytics.paymentsRecovered}) > 0`)
      .orderBy(desc(recovered), desc(conversion), analytics.campaignId)
      .limit(1);

    return top ?? null;
  }

  /** The analytics rows from `since` on, summed. Money stays one balance per currency. */
  async getAnalyticsSince(since: Instant, campaignId?: DunningCampaignId) {
    const inRange = and(
      gte(this.dunningCampaignAnalytics.date, since),
      campaignId ? eq(this.dunningCampaignAnalytics.campaignId, campaignId) : undefined,
    );

    const [counters] = await this.db
      .select({
        executions: sql<number>`COALESCE(SUM(${this.dunningCampaignAnalytics.executions}), 0)`.mapWith(Number),
        customersReached: sql<number>`COALESCE(SUM(${this.dunningCampaignAnalytics.customersReached}), 0)`.mapWith(Number),
        communicationsSent: sql<number>`COALESCE(SUM(${this.dunningCampaignAnalytics.communicationsSent}), 0)`.mapWith(Number),
        paymentsRecovered: sql<number>`COALESCE(SUM(${this.dunningCampaignAnalytics.paymentsRecovered}), 0)`.mapWith(Number),
        conversionRate: sql<number>`COALESCE(AVG(${this.dunningCampaignAnalytics.conversionRate}), 0)`.mapWith(Number),
        roi: sql<number>`COALESCE(AVG(${this.dunningCampaignAnalytics.roi}), 0)`.mapWith(Number),
      })
      .from(this.dunningCampaignAnalytics)
      .where(inRange);

    // An aggregate without GROUP BY always answers one row
    invariant(counters, 'Campaign analytics aggregate returned no row');

    // Money is summed per currency: rows of different currencies never add up.
    const recovered = await this.db
      .select({
        currency: this.dunningCampaignAnalytics.currency,
        units: sql<string>`COALESCE(SUM(${this.dunningCampaignAnalytics.revenueRecoveredMinor}), 0)::text`,
      })
      .from(this.dunningCampaignAnalytics)
      .where(inRange)
      .groupBy(this.dunningCampaignAnalytics.currency);

    return { ...counters, revenueRecovered: sumMinorByCurrency(recovered) };
  }
}

export class DunningTemplateRepository {
  private readonly db: DunningDatabase;
  private readonly dunningTemplates: DunningTables['dunningTemplates'];

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'dunningTemplates'>) {
    this.db = db;
    this.dunningTemplates = tables.dunningTemplates;
  }

  async findById(id: DunningTemplateId): Promise<DunningTemplate | null> {
    const [result] = await this.db
      .select()
      .from(this.dunningTemplates)
      .where(eq(this.dunningTemplates.id, id))
      .limit(1);
    return result ?? null;
  }

  async findByCampaignId(campaignId: DunningCampaignId): Promise<DunningTemplate[]> {
    return this.db
      .select()
      .from(this.dunningTemplates)
      .where(eq(this.dunningTemplates.campaignId, campaignId))
      .orderBy(this.dunningTemplates.stepNumber);
  }

  async create(input: CreateDunningTemplateInput): Promise<DunningTemplate> {
    const [template] = await this.db
      .insert(this.dunningTemplates)
      .values({
        campaignId: input.campaignId,
        name: input.name,
        description: input.description,
        stepNumber: input.stepNumber,
        delayHours: input.delayHours,
        communication: input.communication,
        abTestVariant: input.abTestVariant,
      })
      .returning();

    invariant(template, 'Failed to create dunning template');

    return template;
  }

  async update(
    id: DunningTemplateId,
    input: UpdateDunningTemplateInput,
  ): Promise<DunningTemplate | null> {
    const [template] = await this.db
      .update(this.dunningTemplates)
      .set({ ...input, updatedAt: now() })
      .where(eq(this.dunningTemplates.id, id))
      .returning();

    return (template) ?? null;
  }

  async delete(id: DunningTemplateId): Promise<void> {
    await this.db.delete(this.dunningTemplates).where(eq(this.dunningTemplates.id, id));
  }

  async findActiveTemplates(campaignId: DunningCampaignId): Promise<DunningTemplate[]> {
    return this.db
      .select()
      .from(this.dunningTemplates)
      .where(and(eq(this.dunningTemplates.campaignId, campaignId), eq(this.dunningTemplates.isActive, true)))
      .orderBy(this.dunningTemplates.stepNumber);
  }

  async updateStatus(
    id: DunningTemplateId,
    isActive: boolean,
  ): Promise<DunningTemplate | undefined> {
    const [template] = await this.db
      .update(this.dunningTemplates)
      .set({ isActive, updatedAt: now() })
      .where(eq(this.dunningTemplates.id, id))
      .returning();

    return template;
  }
}

export class DunningExecutionRepository {
  private readonly db: DunningDatabase;
  private readonly dunningExecutions: DunningTables['dunningExecutions'];

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'dunningExecutions'>) {
    this.db = db;
    this.dunningExecutions = tables.dunningExecutions;
  }

  async findById(id: DunningExecutionId): Promise<DunningExecution | null> {
    const [result] = await this.db
      .select()
      .from(this.dunningExecutions)
      .where(eq(this.dunningExecutions.id, id))
      .limit(1);
    return result ?? null;
  }

  async findMany(query: ListExecutionsQuery): Promise<DunningExecution[]> {
    const { limit, offset, campaignId, customerId, status, scheduledAfter, scheduledBefore, sortBy, sortOrder } =
      query;

    const sortColumn = this.dunningExecutions[sortBy];

    return this.db
      .select()
      .from(this.dunningExecutions)
      .where(
        and(
          campaignId ? eq(this.dunningExecutions.campaignId, campaignId) : undefined,
          customerId ? eq(this.dunningExecutions.customerId, customerId) : undefined,
          status ? eq(this.dunningExecutions.status, status) : undefined,
          scheduledAfter ? gte(this.dunningExecutions.scheduledAt, scheduledAfter) : undefined,
          scheduledBefore ? lte(this.dunningExecutions.scheduledAt, scheduledBefore) : undefined,
        ),
      )
      .orderBy(sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn))
      .limit(limit)
      .offset(offset);
  }

  async create(
    input: Omit<NewDunningExecution, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<DunningExecution> {
    const [execution] = await this.db
      .insert(this.dunningExecutions)
      .values({
        campaignId: input.campaignId,
        templateId: input.templateId,
        customerId: input.customerId,
        subscriptionId: input.subscriptionId,
        paymentId: input.paymentId,
        triggerType: input.triggerType,
        triggerData: input.triggerData,
        status: input.status,
        scheduledAt: input.scheduledAt,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        result: input.result,
        errorMessage: input.errorMessage,
        retryCount: input.retryCount,
        nextRetryAt: input.nextRetryAt,
        metadata: input.metadata,
      })
      .returning();

    invariant(execution, 'Failed to create dunning execution');

    return execution;
  }

  async updateStatus(
    id: DunningExecutionId,
    status: ExecutionStatus,
    result?: ExecutionResultDb,
    errorMessage?: string,
    customScheduledAt?: Instant,
  ): Promise<DunningExecution | undefined> {
    const updateData: Partial<DunningExecution> = {
      status,
      updatedAt: now(),
    };

    if (status === 'running' && !result) {
      updateData.startedAt = now();
    } else
      switch (status) {
        case 'completed':
        case 'failed': {
          updateData.completedAt = now();
          break;
        }
        case 'cancelled': {
          updateData.completedAt = now();
          break;
        }
        case 'scheduled': {
          updateData.scheduledAt = customScheduledAt || now();
          break;
        }
        // No default
      }

    if (result) {
      updateData.result = result;
    }

    if (errorMessage) {
      updateData.errorMessage = errorMessage;
    }

    const [execution] = await this.db
      .update(this.dunningExecutions)
      .set(updateData)
      .where(eq(this.dunningExecutions.id, id))
      .returning();

    return execution;
  }

  async findScheduledExecutions(limit = 100): Promise<DunningExecution[]> {
    return this.db
      .select()
      .from(this.dunningExecutions)
      .where(and(eq(this.dunningExecutions.status, 'scheduled'), lte(this.dunningExecutions.scheduledAt, now())))
      .orderBy(this.dunningExecutions.scheduledAt)
      .limit(limit);
  }

  async findRetryableExecutions(limit = 50): Promise<DunningExecution[]> {
    return this.db
      .select()
      .from(this.dunningExecutions)
      .where(and(eq(this.dunningExecutions.status, 'failed'), lte(this.dunningExecutions.nextRetryAt, now())))
      .orderBy(this.dunningExecutions.nextRetryAt)
      .limit(limit);
  }

  async incrementRetryCount(
    id: DunningExecutionId,
    nextRetryAt?: Instant,
  ): Promise<DunningExecution | undefined> {
    const [execution] = await this.db
      .update(this.dunningExecutions)
      .set({
        retryCount: sql`${this.dunningExecutions.retryCount} + 1`,
        nextRetryAt,
        updatedAt: now(),
      })
      .where(eq(this.dunningExecutions.id, id))
      .returning();

    return execution;
  }

  async findRecentForCustomer(
    customerId: CustomerId,
    campaignId: DunningCampaignId,
    hours = 24,
  ): Promise<DunningExecution[]> {
    const since = sub(now(), { hours });

    return this.db
      .select()
      .from(this.dunningExecutions)
      .where(
        and(
          eq(this.dunningExecutions.customerId, customerId),
          eq(this.dunningExecutions.campaignId, campaignId),
          gte(this.dunningExecutions.createdAt, since),
        ),
      )
      .orderBy(desc(this.dunningExecutions.createdAt));
  }
}

export class DunningCommunicationRepository {
  private readonly db: DunningDatabase;
  private readonly dunningCommunications: DunningTables['dunningCommunications'];

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'dunningCommunications'>) {
    this.db = db;
    this.dunningCommunications = tables.dunningCommunications;
  }

  async findById(id: DunningCommunicationId): Promise<DunningCommunication | null> {
    const [result] = await this.db
      .select()
      .from(this.dunningCommunications)
      .where(eq(this.dunningCommunications.id, id))
      .limit(1);
    return result ?? null;
  }

  async findMany(query: ListCommunicationsQuery): Promise<DunningCommunication[]> {
    const { limit, offset, executionId, customerId, channel, status, sentAfter, sentBefore, sortBy, sortOrder } =
      query;

    const sortColumn = this.dunningCommunications[sortBy];

    return this.db
      .select()
      .from(this.dunningCommunications)
      .where(
        and(
          executionId ? eq(this.dunningCommunications.executionId, executionId) : undefined,
          customerId ? eq(this.dunningCommunications.customerId, customerId) : undefined,
          channel ? eq(this.dunningCommunications.channel, channel) : undefined,
          status ? eq(this.dunningCommunications.status, status) : undefined,
          sentAfter ? gte(this.dunningCommunications.sentAt, sentAfter) : undefined,
          sentBefore ? lte(this.dunningCommunications.sentAt, sentBefore) : undefined,
        ),
      )
      .orderBy(sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn))
      .limit(limit)
      .offset(offset);
  }

  async create(
    input: Omit<NewDunningCommunication, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<DunningCommunication> {
    const [communication] = await this.db
      .insert(this.dunningCommunications)
      .values({
        executionId: input.executionId,
        customerId: input.customerId,
        templateId: input.templateId,
        channel: input.channel,
        recipient: input.recipient,
        subject: input.subject,
        content: input.content,
        status: input.status,
        sentAt: input.sentAt,
        deliveredAt: input.deliveredAt,
        openedAt: input.openedAt,
        clickedAt: input.clickedAt,
        failureReason: input.failureReason,
        providerMessageId: input.providerMessageId,
        providerResponse: input.providerResponse,
        trackingData: input.trackingData,
        metadata: input.metadata,
      })
      .returning();

    invariant(communication, 'Failed to create dunning communication');

    return communication;
  }

  async updateStatus(
    id: DunningCommunicationId,
    status: DunningCommunication['status'],
    updates: {
      sentAt?: Instant;
      deliveredAt?: Instant;
      openedAt?: Instant;
      clickedAt?: Instant;
      failureReason?: string;
      providerMessageId?: string;
      providerResponse?: Record<string, unknown>;
      trackingData?: Record<string, unknown>;
    } = {},
  ): Promise<DunningCommunication | null> {
    const [communication] = await this.db
      .update(this.dunningCommunications)
      .set({
        status,
        ...updates,
        updatedAt: now(),
      })
      .where(eq(this.dunningCommunications.id, id))
      .returning();

    return (communication) ?? null;
  }

  async findPendingCommunications(limit = 100): Promise<DunningCommunication[]> {
    return this.db
      .select()
      .from(this.dunningCommunications)
      .where(eq(this.dunningCommunications.status, 'pending'))
      .orderBy(this.dunningCommunications.createdAt)
      .limit(limit);
  }

  async findByProviderMessageId(
    providerMessageId: string,
  ): Promise<DunningCommunication | undefined> {
    const [communication] = await this.db
      .select()
      .from(this.dunningCommunications)
      .where(eq(this.dunningCommunications.providerMessageId, providerMessageId))
      .limit(1);
    return communication;
  }

  async getMetricsForExecution(executionId: DunningExecutionId) {
    const [result] = await this.db
      .select({
        total: sql<number>`COUNT(*)`.mapWith(Number),
        sent: sql<number>`COUNT(CASE WHEN ${this.dunningCommunications.status} = 'sent' THEN 1 END)`.mapWith(Number),
        delivered: sql<number>`COUNT(CASE WHEN ${this.dunningCommunications.status} = 'delivered' THEN 1 END)`.mapWith(Number),
        opened: sql<number>`COUNT(CASE WHEN ${this.dunningCommunications.openedAt} IS NOT NULL THEN 1 END)`.mapWith(Number),
        clicked: sql<number>`COUNT(CASE WHEN ${this.dunningCommunications.clickedAt} IS NOT NULL THEN 1 END)`.mapWith(Number),
        failed: sql<number>`COUNT(CASE WHEN ${this.dunningCommunications.status} = 'failed' THEN 1 END)`.mapWith(Number),
      })
      .from(this.dunningCommunications)
      .where(eq(this.dunningCommunications.executionId, executionId));

    return result;
  }
}

type CustomerSegmentRow = DunningTables['customerSegments']['$inferSelect'];

export class CustomerSegmentRepository {
  private readonly db: DunningDatabase;
  private readonly customerSegments: DunningTables['customerSegments'];

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'customerSegments'>) {
    this.db = db;
    this.customerSegments = tables.customerSegments;
  }

  async findById(id: CustomerSegmentId): Promise<CustomerSegmentRow | undefined> {
    const [segment] = await this.db
      .select()
      .from(this.customerSegments)
      .where(eq(this.customerSegments.id, id))
      .limit(1);
    return segment;
  }

  async findMany(query: ListCustomerSegmentsQuery): Promise<CustomerSegmentRow[]> {
    const { limit, offset, type, isActive, search, sortBy, sortOrder } = query;

    const sortColumn = this.customerSegments[sortBy];

    return this.db
      .select()
      .from(this.customerSegments)
      .where(
        and(
          type ? eq(this.customerSegments.type, type) : undefined,
          isActive === undefined ? undefined : eq(this.customerSegments.isActive, isActive),
          search ? ilike(this.customerSegments.name, `%${search}%`) : undefined,
        ),
      )
      .orderBy(sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn))
      .limit(limit)
      .offset(offset);
  }

  async create(
    input: CreateCustomerSegmentInput & { createdBy: string },
  ): Promise<CustomerSegmentRow | undefined> {
    const [segment] = await this.db
      .insert(this.customerSegments)
      .values({
        name: input.name,
        description: input.description,
        type: input.type,
        criteria: input.criteria,
        autoUpdate: input.autoUpdate,
        updateFrequency: input.updateFrequency,
        createdBy: input.createdBy,
      })
      .returning();

    return segment;
  }

  async update(
    id: CustomerSegmentId,
    input: UpdateCustomerSegmentInput,
  ): Promise<CustomerSegmentRow | undefined> {
    const [segment] = await this.db
      .update(this.customerSegments)
      .set({ ...input, updatedAt: now() })
      .where(eq(this.customerSegments.id, id))
      .returning();

    return segment;
  }

  async delete(id: CustomerSegmentId): Promise<void> {
    await this.db.delete(this.customerSegments).where(eq(this.customerSegments.id, id));
  }

  async updateCustomerCount(
    id: CustomerSegmentId,
    count: number,
  ): Promise<CustomerSegmentRow | undefined> {
    const [segment] = await this.db
      .update(this.customerSegments)
      .set({
        customerCount: count,
        lastCalculated: now(),
        updatedAt: now(),
      })
      .where(eq(this.customerSegments.id, id))
      .returning();

    return segment;
  }

  async findSegmentsForAutoUpdate(): Promise<CustomerSegmentRow[]> {
    // The interval-arithmetic comparison
    // (`lastCalculated + INTERVAL '1 hour' * updateFrequency <= now`)
    // has no structured equivalent — keep it as RAW alongside the structured
    // boolean filters.
    // A raw `sql` parameter bypasses the column codec, so it stays a `Date`.
    const current = new Date();
    const table = this.customerSegments;
    return this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.isActive, true),
          eq(table.autoUpdate, true),
          sql`(${table.lastCalculated} IS NULL OR ${table.lastCalculated} + INTERVAL '1 hour' * ${table.updateFrequency} <= ${current})`,
        ),
      );
  }
}

export class CustomerRiskProfileRepository {
  private readonly db: DunningDatabase;
  private readonly customerRiskProfiles: DunningTables['customerRiskProfiles'];

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'customerRiskProfiles'>) {
    this.db = db;
    this.customerRiskProfiles = tables.customerRiskProfiles;
  }

  async findByCustomerId(customerId: CustomerId): Promise<CustomerRiskProfile | undefined> {
    const [profile] = await this.db
      .select()
      .from(this.customerRiskProfiles)
      .where(eq(this.customerRiskProfiles.customerId, customerId))
      .limit(1);

    return profile && readCustomerRiskProfile(profile);
  }

  async create(
    input: Omit<CustomerRiskProfile, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<CustomerRiskProfile | undefined> {
    const [profile] = await this.db
      .insert(this.customerRiskProfiles)
      .values({
        customerId: input.customerId,
        segmentIds: input.segmentIds,
        riskScore: input.riskScore,
        paymentHistory: input.paymentHistory,
        subscriptionHistory: input.subscriptionHistory,
        engagementMetrics: input.engagementMetrics,
        communicationPreferences: input.communicationPreferences,
        metadata: input.metadata,
      })
      .returning();

    return profile && readCustomerRiskProfile(profile);
  }

  async update(
    customerId: CustomerId,
    input: Partial<Omit<CustomerRiskProfile, 'id' | 'customerId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<CustomerRiskProfile | undefined> {
    const [profile] = await this.db
      .update(this.customerRiskProfiles)
      .set({ ...input, updatedAt: now() })
      .where(eq(this.customerRiskProfiles.customerId, customerId))
      .returning();

    return profile && readCustomerRiskProfile(profile);
  }

  async upsert(
    input: Omit<CustomerRiskProfile, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<CustomerRiskProfile | undefined> {
    const existing = await this.findByCustomerId(input.customerId);

    if (existing) {
      return this.update(input.customerId, input);
    } else {
      return this.create(input);
    }
  }

  async findByRiskCategory(category: string, limit = 100): Promise<CustomerRiskProfile[]> {
    const table = this.customerRiskProfiles;
    const profiles = await this.db
      .select()
      .from(table)
      .where(sql`${table.riskScore}->>'category' = ${category}`)
      .orderBy(desc(sql`(${table.riskScore}->>'overall')::numeric`))
      .limit(limit);

    return profiles.map(profile => readCustomerRiskProfile(profile));
  }

  async findBySegmentId(
    segmentId: CustomerSegmentId,
    limit = 100,
  ): Promise<CustomerRiskProfile[]> {
    const table = this.customerRiskProfiles;
    const profiles = await this.db
      .select()
      .from(table)
      .where(sql`${table.segmentIds} @> ${JSON.stringify([segmentId])}`)
      .limit(limit);

    return profiles.map(profile => readCustomerRiskProfile(profile));
  }

  async updateSegments(
    customerId: CustomerId,
    segmentIds: CustomerSegmentId[],
  ): Promise<CustomerRiskProfile | undefined> {
    const [profile] = await this.db
      .update(this.customerRiskProfiles)
      .set({ segmentIds, updatedAt: now() })
      .where(eq(this.customerRiskProfiles.customerId, customerId))
      .returning();

    return profile && readCustomerRiskProfile(profile);
  }
}

export type DunningRepositoryTables = Pick<
  DunningTables,
  | 'dunningCampaigns'
  | 'dunningCampaignAnalytics'
  | 'dunningTemplates'
  | 'dunningExecutions'
  | 'dunningCommunications'
  | 'customerSegments'
  | 'customerRiskProfiles'
>;

export function createDunningCampaignRepository(
  db: DunningDatabase,
  tables: CampaignTables,
): DunningCampaignRepository {
  return new DunningCampaignRepository(db, tables);
}

export function createDunningTemplateRepository(
  db: DunningDatabase,
  tables: Pick<DunningTables, 'dunningTemplates'>,
): DunningTemplateRepository {
  return new DunningTemplateRepository(db, tables);
}

export function createDunningExecutionRepository(
  db: DunningDatabase,
  tables: Pick<DunningTables, 'dunningExecutions'>,
): DunningExecutionRepository {
  return new DunningExecutionRepository(db, tables);
}

export function createDunningCommunicationRepository(
  db: DunningDatabase,
  tables: Pick<DunningTables, 'dunningCommunications'>,
): DunningCommunicationRepository {
  return new DunningCommunicationRepository(db, tables);
}

export function createCustomerSegmentRepository(
  db: DunningDatabase,
  tables: Pick<DunningTables, 'customerSegments'>,
): CustomerSegmentRepository {
  return new CustomerSegmentRepository(db, tables);
}

export function createCustomerRiskProfileRepository(
  db: DunningDatabase,
  tables: Pick<DunningTables, 'customerRiskProfiles'>,
): CustomerRiskProfileRepository {
  return new CustomerRiskProfileRepository(db, tables);
}

/**
 * Aggregate factory for all dunning repositories.
 */
export function createDunningRepository(db: DunningDatabase, tables: DunningRepositoryTables) {
  return {
    campaigns: createDunningCampaignRepository(db, tables),
    templates: createDunningTemplateRepository(db, tables),
    executions: createDunningExecutionRepository(db, tables),
    communications: createDunningCommunicationRepository(db, tables),
    customerSegments: createCustomerSegmentRepository(db, tables),
    customerRiskProfiles: createCustomerRiskProfileRepository(db, tables),
  };
}
