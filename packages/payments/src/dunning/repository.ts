import type { AnyRelations, SQL, SQLWrapper } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

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
 * `PaymentDatabase` doc in `../core/repository` — same contract: the host's
 * relations graph MUST register the dunning tables (`dunningCampaigns`,
 * `dunningTemplates`, `dunningExecutions`, `dunningCommunications`,
 * `customerSegments`, `customerRiskProfiles`) for the relational query
 * builder calls below to work at runtime.
 */
export type DunningDatabase =
  | NodePgDatabase<AnyRelations>
  | NodePgTransaction<AnyRelations>;

type FieldFilter<T> =
  | T
  | {
      eq?: T;
      ne?: T;
      gt?: T;
      gte?: T;
      lt?: T;
      lte?: T;
      in?: T[];
      notIn?: T[];
      like?: string;
      notLike?: string;
      ilike?: string;
      notIlike?: string;
      isNull?: boolean;
      isNotNull?: boolean;
    };

type WhereClause<T> = { [K in keyof T]?: FieldFilter<T[K]> } & {
  RAW?: SQL | SQLWrapper;
};

type OrderByReturn = SQL | SQLWrapper | (SQL | SQLWrapper)[];

type FindFirst<TResult> = (config: {
  where?: WhereClause<TResult>;
  columns?: Record<string, boolean>;
}) => Promise<TResult | undefined>;

type FindMany<TResult> = (config: {
  where?: WhereClause<TResult>;
  columns?: Record<string, boolean>;
  orderBy?: (
    table: TResult,
    helpers: { desc: (col: unknown) => SQL; asc: (col: unknown) => SQL },
  ) => OrderByReturn;
  limit?: number;
  offset?: number;
}) => Promise<TResult[]>;

type DunningDbInternal = {
  query: {
    dunningCampaigns: { findFirst: FindFirst<DunningCampaign>; findMany: FindMany<DunningCampaign> };
    dunningTemplates: { findFirst: FindFirst<DunningTemplate>; findMany: FindMany<DunningTemplate> };
    dunningExecutions: { findFirst: FindFirst<DunningExecution>; findMany: FindMany<DunningExecution> };
    dunningCommunications: {
      findFirst: FindFirst<DunningCommunication>;
      findMany: FindMany<DunningCommunication>;
    };
    customerSegments: {
      findFirst: FindFirst<DunningTables['customerSegments']['$inferSelect']>;
      findMany: FindMany<DunningTables['customerSegments']['$inferSelect']>;
    };
    customerRiskProfiles: {
      findFirst: FindFirst<CustomerRiskProfile>;
      findMany: FindMany<CustomerRiskProfile>;
    };
  };
};

type CampaignTables = Pick<
  DunningTables,
  'dunningCampaigns' | 'dunningCampaignAnalytics'
>;

export class DunningCampaignRepository {
  private readonly db: DunningDatabase;
  private readonly q: DunningDbInternal['query'];
  private readonly dunningCampaigns: DunningTables['dunningCampaigns'];
  private readonly dunningCampaignAnalytics: DunningTables['dunningCampaignAnalytics'];

  constructor(db: DunningDatabase, tables: CampaignTables) {
    this.db = db;
    this.q = db.query as unknown as DunningDbInternal['query'];
    this.dunningCampaigns = tables.dunningCampaigns;
    this.dunningCampaignAnalytics = tables.dunningCampaignAnalytics;
  }

  async findById(id: DunningCampaignId): Promise<DunningCampaign | null> {
    const result = await this.q.dunningCampaigns.findFirst({ where: { id } });
    return result ?? null;
  }

  async findMany(query: ListDunningCampaignsQuery): Promise<DunningCampaign[]> {
    const { limit, offset, type, status, search, sortBy, sortOrder } = query;

    const orderColumn = this.dunningCampaigns[sortBy as keyof DunningTables['dunningCampaigns']];
    const orderDirection = sortOrder === 'asc' ? orderColumn : desc(orderColumn as SQLWrapper);

    return this.q.dunningCampaigns.findMany({
      where: {
        ...(type && { type }),
        ...(status && { status }),
        ...(search && { name: { ilike: `%${search}%` } }),
      },
      orderBy: () => orderDirection as SQL | SQLWrapper,
      limit,
      offset,
    });
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

    if (!campaign) {
      throw new Error('Failed to create dunning campaign');
    }

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
    return this.q.dunningCampaigns.findMany({ where: { type, status: 'active' } });
  }

  async findActiveForTrigger(
    triggerType: string,
    customerSegmentIds?: string[],
  ): Promise<DunningCampaign[]> {
    // The trigger-type lookup hits a JSONB field (`trigger->>'type'`) and the
    // segment intersection uses a JSONB EXISTS subquery — both have no
    // structured-filter equivalent and stay as RAW.
    const triggerTypePredicate = sql`${this.dunningCampaigns.trigger}->>'type' = ${triggerType}`;
    const segmentPredicate =
      customerSegmentIds && customerSegmentIds.length > 0
        ? sql`
          EXISTS (
                    SELECT 1 FROM jsonb_array_elements_text(${this.dunningCampaigns.targetSegments}) AS segment
                    WHERE segment = ANY(${customerSegmentIds})
                  )
        `
        : undefined;
    const rawPredicate = segmentPredicate
      ? and(triggerTypePredicate, segmentPredicate)!
      : triggerTypePredicate;

    return this.q.dunningCampaigns.findMany({
      where: {
        status: 'active',
        RAW: rawPredicate,
      },
      orderBy: () => desc(sql`${this.dunningCampaigns.settings}->>'priority'`),
    });
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

    const inRange = and(
      gte(this.dunningCampaignAnalytics.date, fromDate(startDate)),
      campaignId ? eq(this.dunningCampaignAnalytics.campaignId, campaignId) : undefined,
    );

    const [counters] = await this.db
      .select({
        executions: sql<number>`COALESCE(SUM(${this.dunningCampaignAnalytics.executions}), 0)`,
        customersReached: sql<number>`COALESCE(SUM(${this.dunningCampaignAnalytics.customersReached}), 0)`,
        communicationsSent: sql<number>`COALESCE(SUM(${this.dunningCampaignAnalytics.communicationsSent}), 0)`,
        paymentsRecovered: sql<number>`COALESCE(SUM(${this.dunningCampaignAnalytics.paymentsRecovered}), 0)`,
        conversionRate: sql<number>`COALESCE(AVG(${this.dunningCampaignAnalytics.conversionRate}), 0)`,
        roi: sql<number>`COALESCE(AVG(${this.dunningCampaignAnalytics.roi}), 0)`,
      })
      .from(this.dunningCampaignAnalytics)
      .where(inRange);

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
  private readonly q: DunningDbInternal['query'];
  private readonly dunningTemplates: DunningTables['dunningTemplates'];

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'dunningTemplates'>) {
    this.db = db;
    this.q = db.query as unknown as DunningDbInternal['query'];
    this.dunningTemplates = tables.dunningTemplates;
  }

  async findById(id: DunningTemplateId): Promise<DunningTemplate | null> {
    const result = await this.q.dunningTemplates.findFirst({ where: { id } });
    return result ?? null;
  }

  async findByCampaignId(campaignId: DunningCampaignId): Promise<DunningTemplate[]> {
    return this.q.dunningTemplates.findMany({
      where: { campaignId },
      orderBy: (t) => t.stepNumber as unknown as SQLWrapper,
    });
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

    if (!template) {
      throw new Error('Failed to create dunning template');
    }

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
    return this.q.dunningTemplates.findMany({
      where: { campaignId, isActive: true },
      orderBy: (t) => t.stepNumber as unknown as SQLWrapper,
    });
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
  private readonly q: DunningDbInternal['query'];
  private readonly dunningExecutions: DunningTables['dunningExecutions'];

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'dunningExecutions'>) {
    this.db = db;
    this.q = db.query as unknown as DunningDbInternal['query'];
    this.dunningExecutions = tables.dunningExecutions;
  }

  async findById(id: DunningExecutionId): Promise<DunningExecution | null> {
    const result = await this.q.dunningExecutions.findFirst({ where: { id } });
    return result ?? null;
  }

  async findMany(query: ListExecutionsQuery): Promise<DunningExecution[]> {
    const { limit, offset, campaignId, customerId, status, scheduledAfter, scheduledBefore, sortBy, sortOrder } =
      query;

    const orderColumn = this.dunningExecutions[sortBy as keyof DunningTables['dunningExecutions']];
    const orderDirection = sortOrder === 'asc' ? orderColumn : desc(orderColumn as SQLWrapper);

    const scheduledAt =
      scheduledAfter || scheduledBefore
        ? {
            ...(scheduledAfter && { gte: scheduledAfter }),
            ...(scheduledBefore && { lte: scheduledBefore }),
          }
        : undefined;

    return this.q.dunningExecutions.findMany({
      where: {
        ...(campaignId && { campaignId }),
        ...(customerId && { customerId }),
        ...(status && { status }),
        ...(scheduledAt && { scheduledAt }),
      },
      orderBy: () => orderDirection as SQL | SQLWrapper,
      limit,
      offset,
    });
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

    if (!execution) {
      throw new Error('Failed to create dunning execution');
    }

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
    return this.q.dunningExecutions.findMany({
      where: {
        status: 'scheduled',
        scheduledAt: { lte: now() },
      },
      orderBy: (t) => t.scheduledAt as unknown as SQLWrapper,
      limit,
    });
  }

  async findRetryableExecutions(limit = 50): Promise<DunningExecution[]> {
    return this.q.dunningExecutions.findMany({
      where: {
        status: 'failed',
        nextRetryAt: { lte: now() },
      },
      orderBy: (t) => t.nextRetryAt as unknown as SQLWrapper,
      limit,
    });
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

    return this.q.dunningExecutions.findMany({
      where: {
        customerId,
        campaignId,
        createdAt: { gte: since },
      },
      orderBy: (t, helpers) => helpers.desc(t.createdAt),
    });
  }
}

export class DunningCommunicationRepository {
  private readonly db: DunningDatabase;
  private readonly q: DunningDbInternal['query'];
  private readonly dunningCommunications: DunningTables['dunningCommunications'];

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'dunningCommunications'>) {
    this.db = db;
    this.q = db.query as unknown as DunningDbInternal['query'];
    this.dunningCommunications = tables.dunningCommunications;
  }

  async findById(id: DunningCommunicationId): Promise<DunningCommunication | null> {
    const result = await this.q.dunningCommunications.findFirst({ where: { id } });
    return result ?? null;
  }

  async findMany(query: ListCommunicationsQuery): Promise<DunningCommunication[]> {
    const { limit, offset, executionId, customerId, channel, status, sentAfter, sentBefore, sortBy, sortOrder } =
      query;

    const orderColumn =
      this.dunningCommunications[sortBy as keyof DunningTables['dunningCommunications']];
    const orderDirection = sortOrder === 'asc' ? orderColumn : desc(orderColumn as SQLWrapper);

    const sentAt =
      sentAfter || sentBefore
        ? {
            ...(sentAfter && { gte: sentAfter }),
            ...(sentBefore && { lte: sentBefore }),
          }
        : undefined;

    return this.q.dunningCommunications.findMany({
      where: {
        ...(executionId && { executionId }),
        ...(customerId && { customerId }),
        ...(channel && { channel }),
        ...(status && { status }),
        ...(sentAt && { sentAt }),
      },
      orderBy: () => orderDirection as SQL | SQLWrapper,
      limit,
      offset,
    });
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

    if (!communication) {
      throw new Error('Failed to create dunning communication');
    }

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
    return this.q.dunningCommunications.findMany({
      where: { status: 'pending' },
      orderBy: (t) => t.createdAt as unknown as SQLWrapper,
      limit,
    });
  }

  async findByProviderMessageId(
    providerMessageId: string,
  ): Promise<DunningCommunication | undefined> {
    return this.q.dunningCommunications.findFirst({ where: { providerMessageId } });
  }

  async getMetricsForExecution(executionId: DunningExecutionId) {
    const [result] = await this.db
      .select({
        total: sql<number>`COUNT(*)`,
        sent: sql<number>`COUNT(CASE WHEN ${this.dunningCommunications.status} = 'sent' THEN 1 END)`,
        delivered: sql<number>`COUNT(CASE WHEN ${this.dunningCommunications.status} = 'delivered' THEN 1 END)`,
        opened: sql<number>`COUNT(CASE WHEN ${this.dunningCommunications.openedAt} IS NOT NULL THEN 1 END)`,
        clicked: sql<number>`COUNT(CASE WHEN ${this.dunningCommunications.clickedAt} IS NOT NULL THEN 1 END)`,
        failed: sql<number>`COUNT(CASE WHEN ${this.dunningCommunications.status} = 'failed' THEN 1 END)`,
      })
      .from(this.dunningCommunications)
      .where(eq(this.dunningCommunications.executionId, executionId));

    return result;
  }
}

type CustomerSegmentRow = DunningTables['customerSegments']['$inferSelect'];

export class CustomerSegmentRepository {
  private readonly db: DunningDatabase;
  private readonly q: DunningDbInternal['query'];
  private readonly customerSegments: DunningTables['customerSegments'];

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'customerSegments'>) {
    this.db = db;
    this.q = db.query as unknown as DunningDbInternal['query'];
    this.customerSegments = tables.customerSegments;
  }

  async findById(id: CustomerSegmentId): Promise<CustomerSegmentRow | undefined> {
    return this.q.customerSegments.findFirst({ where: { id } });
  }

  async findMany(query: ListCustomerSegmentsQuery): Promise<CustomerSegmentRow[]> {
    const { limit, offset, type, isActive, search, sortBy, sortOrder } = query;

    const orderColumn = this.customerSegments[sortBy as keyof DunningTables['customerSegments']];
    const orderDirection = sortOrder === 'asc' ? orderColumn : desc(orderColumn as SQLWrapper);

    return this.q.customerSegments.findMany({
      where: {
        ...(type && { type }),
        ...(isActive !== undefined && { isActive }),
        ...(search && { name: { ilike: `%${search}%` } }),
      },
      orderBy: () => orderDirection as SQL | SQLWrapper,
      limit,
      offset,
    });
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
    return this.q.customerSegments.findMany({
      where: {
        isActive: true,
        autoUpdate: true,
        RAW: sql`${this.customerSegments.lastCalculated} IS NULL OR ${this.customerSegments.lastCalculated} + INTERVAL '1 hour' * ${this.customerSegments.updateFrequency} <= ${current}`,
      },
    });
  }
}

export class CustomerRiskProfileRepository {
  private readonly db: DunningDatabase;
  private readonly q: DunningDbInternal['query'];
  private readonly customerRiskProfiles: DunningTables['customerRiskProfiles'];

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'customerRiskProfiles'>) {
    this.db = db;
    this.q = db.query as unknown as DunningDbInternal['query'];
    this.customerRiskProfiles = tables.customerRiskProfiles;
  }

  async findByCustomerId(customerId: CustomerId): Promise<CustomerRiskProfile | undefined> {
    const profile = await this.q.customerRiskProfiles.findFirst({ where: { customerId } });

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
    const profiles = await this.q.customerRiskProfiles.findMany({
      where: { RAW: sql`${this.customerRiskProfiles.riskScore}->>'category' = ${category}` },
      orderBy: () =>
        desc(sql`(${this.customerRiskProfiles.riskScore}->>'overall')::numeric`),
      limit,
    });

    return profiles.map(profile => readCustomerRiskProfile(profile));
  }

  async findBySegmentId(
    segmentId: CustomerSegmentId,
    limit = 100,
  ): Promise<CustomerRiskProfile[]> {
    const profiles = await this.q.customerRiskProfiles.findMany({
      where: {
        RAW: sql`${this.customerRiskProfiles.segmentIds} @> ${JSON.stringify([segmentId])}`,
      },
      limit,
    });

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
