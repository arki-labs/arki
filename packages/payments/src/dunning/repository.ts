import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, gte, ilike, lt, lte, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';

import { z } from '@arki/contracts';
import { findDatabaseError } from '@arki/db/errors';
import type { FailureOf, SchemaFailure } from '@arki/failure';
import { invariant, isFailure } from '@arki/failure';
import { AmountOutOfRange } from '@arki/money';
import { is, parse } from '@arki/schema';

import type { Instant } from '@arki/date';
import { fromDate, now, sub } from '@arki/date';

import type { CustomerId } from '../core/primitives.js';
import type { UserId } from '../core/user-id.js';
import {
  INT4_MAX,
  isPgInstant,
  MAX_BATCH_ITEMS,
  pgInstantSchema,
  pgJsonRecordSchema,
  pgJsonSchema,
  pgTextSchema,
  pgVarcharSchema,
} from '../core/pg-values.js';
import { CounterExhausted } from '../core/failures.js';
import { ReferenceNotFound } from '../core/providers/provider-error.js';
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
import {
  campaignTriggerSchema,
  communicationChannelSchema,
  communicationStatusSchema,
  createCustomerSegmentInputSchema,
  createDunningCampaignInputSchema,
  createDunningTemplateInputSchema,
  dunningActorSchema,
  dunningCampaignStatusSchema,
  dunningCampaignTypeSchema,
  executionStatusSchema,
  listCommunicationsQuerySchema,
  listCustomerSegmentsQuerySchema,
  listDunningCampaignsQuerySchema,
  listExecutionsQuerySchema,
  MAX_DUNNING_DAYS,
  MAX_DUNNING_HOURS,
  riskCategorySchema,
  updateCustomerSegmentInputSchema,
  updateDunningCampaignInputSchema,
  updateDunningTemplateInputSchema,
} from './contracts.js';
import type {
  CustomerSegmentId,
  DunningCampaignId,
  DunningCampaignType,
  DunningCommunicationId,
  DunningExecutionId,
  DunningTemplateId,
  ExecutionStatus,
  RiskCategory,
} from './primitives.js';
import type { DunningTables } from './tables.js';
import type {
  CampaignTrigger,
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
import {
  CustomerRiskProfileExists,
  DunningCampaignNotFound,
  DunningExecutionNotFound,
  DunningTemplateInUse,
  DunningTemplateNotFound,
} from './failures.js';
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

/** An execution write that points at a campaign, step, customer, subscription or payment with no row. */
export type ExecutionReferenceMissing =
  | FailureOf<typeof DunningCampaignNotFound>
  | FailureOf<typeof DunningTemplateNotFound>
  | FailureOf<typeof ReferenceNotFound>;

/** A communication write that points at an execution, step or customer with no row. */
export type CommunicationReferenceMissing =
  | FailureOf<typeof DunningExecutionNotFound>
  | FailureOf<typeof DunningTemplateNotFound>
  | FailureOf<typeof ReferenceNotFound>;

/**
 * The text, JSON, counts and times a caller writes into an execution row, checked against the columns before
 * the write: a value Postgres refuses returns `schema.invalid_input` instead of a raw SQLSTATE error (an
 * `instant` column takes only the years 1 to 9999).
 */
const executionValuesSchema = z.looseObject({
  status: executionStatusSchema.optional(),
  triggerType: pgVarcharSchema(100).optional(),
  triggerData: pgJsonRecordSchema.optional(),
  result: pgJsonRecordSchema.nullish(),
  errorMessage: pgTextSchema.nullish(),
  retryCount: z.number().int().min(0).max(INT4_MAX).optional(),
  metadata: pgJsonRecordSchema.nullish(),
  scheduledAt: pgInstantSchema().optional(),
  startedAt: pgInstantSchema().nullish(),
  completedAt: pgInstantSchema().nullish(),
  nextRetryAt: pgInstantSchema().nullish(),
});

/**
 * The text, JSON and times a caller writes into a communication row, checked against the columns before the
 * write: an `instant` column takes only the years 1 to 9999.
 */
const communicationValuesSchema = z.looseObject({
  channel: communicationChannelSchema.optional(),
  status: communicationStatusSchema.optional(),
  recipient: pgVarcharSchema(255).optional(),
  subject: pgVarcharSchema(500).nullish(),
  content: pgTextSchema.optional(),
  failureReason: pgTextSchema.nullish(),
  providerMessageId: pgVarcharSchema(255).nullish(),
  providerResponse: pgJsonRecordSchema.nullish(),
  trackingData: pgJsonRecordSchema.nullish(),
  metadata: pgJsonRecordSchema.nullish(),
  sentAt: pgInstantSchema().nullish(),
  deliveredAt: pgInstantSchema().nullish(),
  openedAt: pgInstantSchema().nullish(),
  clickedAt: pgInstantSchema().nullish(),
});

/**
 * The JSON a caller writes into a risk profile row, checked against the jsonb columns before the write:
 * U+0000 in any key or string, or a bigint, returns `schema.invalid_input` instead of a raw SQLSTATE 22P05
 * or a driver TypeError.
 */
const riskProfileValuesSchema = z.looseObject({
  segmentIds: pgJsonSchema.optional(),
  riskScore: pgJsonRecordSchema.optional(),
  paymentHistory: pgJsonRecordSchema.optional(),
  subscriptionHistory: pgJsonRecordSchema.optional(),
  engagementMetrics: pgJsonRecordSchema.optional(),
  communicationPreferences: pgJsonRecordSchema.optional(),
  metadata: pgJsonRecordSchema.nullish(),
});

/** A customer count stored in the segment's `customer_count` (int4). */
const customerCountSchema = z.number().int().min(0).max(INT4_MAX);

/**
 * A campaign as `create` stores it: its contract (`createDunningCampaignInputSchema`, which also bounds the
 * settings and trigger the services turn into dates and SQL), without the steps, which the step repository
 * writes. The contract's output is a valid input (its spend range turns the money it checks back into JSON),
 * so a row read back from it parses again.
 */
const campaignCreateSchema = createDunningCampaignInputSchema.omit({ templates: true });

/** A campaign change as `update` stores it: `updateDunningCampaignInputSchema` without the steps. */
const campaignUpdateSchema = updateDunningCampaignInputSchema.omit({ templates: true });

/**
 * The JSON of a campaign row, checked against its jsonb columns: U+0000 or a lone surrogate in any key or
 * string, or a bigint, returns `schema.invalid_input` instead of a raw SQLSTATE 22P05 / 22P02 or a driver
 * TypeError. (The contract's text fields refuse U+0000 only: a `text` column takes a lone surrogate.)
 */
const campaignValuesSchema = z.looseObject({
  trigger: pgJsonRecordSchema.optional(),
  settings: pgJsonRecordSchema.optional(),
  targetSegments: pgJsonSchema.optional(),
});

/** The JSON of a step row, checked against its jsonb `communication` column as `campaignValuesSchema` does. */
const templateValuesSchema = z.looseObject({
  communication: pgJsonRecordSchema.optional(),
});

/**
 * The JSON of a segment row, checked against its jsonb `criteria` column as `campaignValuesSchema` does.
 * The text, numbers and criteria bounds come from the segment contract.
 */
const segmentValuesSchema = z.looseObject({
  criteria: pgJsonRecordSchema.optional(),
});

/**
 * The enum and sort fields of each list query, from the list contracts: a status, type or channel no row
 * has (SQLSTATE 22P02) or a `sortBy` that names no column returns `schema.invalid_input` before any query.
 */
const campaignListChoicesSchema = listDunningCampaignsQuerySchema.pick({ type: true, status: true, sortBy: true });
const segmentListChoicesSchema = listCustomerSegmentsQuerySchema.pick({ type: true, sortBy: true });
const executionListChoicesSchema = listExecutionsQuerySchema.pick({ status: true, sortBy: true });
const communicationListChoicesSchema = listCommunicationsQuerySchema.pick({
  channel: true,
  status: true,
  sortBy: true,
});

/** The ids that name the segments of a campaign filter: at most `MAX_BATCH_ITEMS`. */
const segmentIdsFilterSchema = z.array(z.string()).max(MAX_BATCH_ITEMS);

/** The most characters of an id column (`varchar(256)`): a reference longer than that is in no row. */
const ID_MAX_LENGTH = 256;

/**
 * The money of rows this package stored, summed per currency. Precondition (an invariant failure otherwise):
 * every row holds an ISO 4217 code and units that are a safe whole number. The upsert keeps each row within
 * 2^53 - 1, and `getAnalyticsSince` returns `money.out_of_range` before this for a sum past it.
 */
function storedRevenue(rows: readonly { currency: string; units: number | string }[]) {
  const revenue = sumMinorByCurrency(rows);
  invariant(!isFailure(revenue), '[@arki/payments] a stored analytics row holds money that cannot be read');
  return revenue;
}

/** The precondition of a page size, an offset or a row count: a whole number Postgres takes in LIMIT and OFFSET. */
function assertCount(value: number, name: string): void {
  invariant(Number.isSafeInteger(value) && value >= 0, () => `[@arki/payments] ${name} must be a whole number of 0 or more`);
}

/** The precondition of a span in whole days or hours: from 0 up to `max` (100 years), so the date it gives stays in range. */
function assertSpan(value: number, max: number, name: string): void {
  invariant(
    Number.isSafeInteger(value) && value >= 0 && value <= max,
    () => `[@arki/payments] ${name} must be a whole number from 0 to ${max}`,
  );
}

/** The precondition of a read bounded by a time: an `instant` column compares only with years 1 to 9999. */
function assertComparable(value: Instant | undefined, name: string): void {
  invariant(value === undefined || isPgInstant(value), () => `[@arki/payments] ${name} must fall in the years 1 to 9999`);
}

/**
 * Whether a caller's id or text can name a stored row. Text holding U+0000 cannot: no `text` or `varchar`
 * column holds it, and Postgres refuses it as a parameter (SQLSTATE 22021). A read by such a value answers
 * "not found" (null, `undefined`, `[]` or zero counts) without a query, as one for an unknown id does.
 */
function findable(...texts: (string | null | undefined)[]): boolean {
  return texts.every(text => text === undefined || text === null || is(text, pgTextSchema));
}

/** SQLSTATE `foreign_key_violation`: the row a new row points at does not exist. */
const FOREIGN_KEY_VIOLATION = '23503';

/** One foreign key of a new row: its column, the value written there, and the failure when no row has that value. */
type Reference<Missing> = { column: PgColumn; value: string | null | undefined; missing: () => Missing };

/**
 * Runs one insert in its own transaction (a savepoint inside the caller's), so a refused row leaves
 * the caller's transaction usable. A reference value no row can hold (U+0000) returns its `missing()`
 * failure before any query. When the database refuses the row with a foreign key violation,
 * each reference is looked up in the table its foreign key points at, and the first value with no row
 * returns its `missing()` failure; nothing is written. Any other error is thrown, and so is a
 * violation no reference explains.
 */
async function insertOrMissing<Row, Missing>(
  db: DunningDatabase,
  table: PgTable,
  insert: (tx: DunningDatabase) => Promise<Row>,
  references: readonly Reference<Missing>[],
): Promise<Row | Missing> {
  const unstorable = references.find(
    reference => !findable(reference.value) || (reference.value?.length ?? 0) > ID_MAX_LENGTH,
  );
  if (unstorable) return unstorable.missing();
  try {
    return await db.transaction(async tx => insert(tx));
  } catch (error) {
    if (findDatabaseError(error)?.sqlState !== FOREIGN_KEY_VIOLATION) throw error;
    const keys = getTableConfig(table).foreignKeys.map(key => key.reference());
    for (const { column, value, missing } of references) {
      const key = keys.find(candidate => candidate.columns[0] === column);
      const target = key?.foreignColumns[0];
      if (!key || !target || value === null || value === undefined) continue;
      const [found] = await db.select({ found: sql`1` }).from(key.foreignTable).where(eq(target, value)).limit(1);
      if (!found) return missing();
    }
    throw error;
  }
}

/** The tables the campaign repository reads: its steps and their communications decide whether a delete may run. */
type CampaignTables = Pick<
  DunningTables,
  'dunningCampaigns' | 'dunningCampaignAnalytics' | 'dunningTemplates' | 'dunningCommunications'
>;

export class DunningCampaignRepository {
  private readonly db: DunningDatabase;
  private readonly dunningCampaigns: DunningTables['dunningCampaigns'];
  private readonly dunningCampaignAnalytics: DunningTables['dunningCampaignAnalytics'];
  private readonly dunningTemplates: DunningTables['dunningTemplates'];
  private readonly dunningCommunications: DunningTables['dunningCommunications'];

  constructor(db: DunningDatabase, tables: CampaignTables) {
    this.db = db;
    this.dunningCampaigns = tables.dunningCampaigns;
    this.dunningCampaignAnalytics = tables.dunningCampaignAnalytics;
    this.dunningTemplates = tables.dunningTemplates;
    this.dunningCommunications = tables.dunningCommunications;
  }

  /** The campaign, or `null` for an unknown id (also one no row can hold, without a query). */
  async findById(id: DunningCampaignId): Promise<DunningCampaign | null> {
    if (!findable(id)) return null;
    const [result] = await this.db
      .select()
      .from(this.dunningCampaigns)
      .where(eq(this.dunningCampaigns.id, id))
      .limit(1);
    return result ?? null;
  }

  /**
   * One page of campaigns. Preconditions (anything else throws an invariant failure and runs no query):
   * `limit` and `offset` are whole numbers of 0 or more. A `search` holding U+0000 matches no campaign.
   */
  async findMany(query: ListDunningCampaignsQuery): Promise<DunningCampaign[] | SchemaFailure>{
    const { limit, offset, type, status, search, sortBy, sortOrder } = query;
    const choices = parse(campaignListChoicesSchema, query);
    if (isFailure(choices)) return choices;
    assertCount(limit, 'limit');
    assertCount(offset, 'offset');
    if (!findable(search)) return [];

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

  /**
   * The new campaign. The input is parsed with its contract (`createDunningCampaignInputSchema`, steps
   * aside): a value it refuses (a name over 255 characters or holding U+0000, a setting or trigger day count
   * outside its range, NaN, a status or tier no row has, an invalid spend range), an actor id that is not a
   * `usr_` id Postgres can store, or JSON a jsonb column cannot store (a lone surrogate, a bigint) returns
   * `schema.invalid_input` and writes nothing.
   */
  async create(input: CreateDunningCampaignInput & { createdBy: UserId }): Promise<DunningCampaign | SchemaFailure> {
    const actor = parse(dunningActorSchema, input.createdBy);
    if (isFailure(actor)) return actor;
    const valid = parse(campaignCreateSchema, input);
    if (isFailure(valid)) return valid;
    const values = parse(campaignValuesSchema, input);
    if (isFailure(values)) return values;
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

  /**
   * The updated campaign, `null` for an unknown id (also one no row can hold). A value
   * `updateDunningCampaignInputSchema` refuses, an actor id, or JSON Postgres cannot store returns
   * `schema.invalid_input` and writes nothing, as in `create`.
   */
  async update(
    id: DunningCampaignId,
    input: UpdateDunningCampaignInput & { updatedBy: UserId },
  ): Promise<DunningCampaign | null | SchemaFailure> {
    const actor = parse(dunningActorSchema, input.updatedBy);
    if (isFailure(actor)) return actor;
    const valid = parse(campaignUpdateSchema, input);
    if (isFailure(valid)) return valid;
    const values = parse(campaignValuesSchema, input);
    if (isFailure(values)) return values;
    if (!findable(id)) return null;
    const [campaign] = await this.db
      .update(this.dunningCampaigns)
      .set({ ...input, updatedAt: now() })
      .where(eq(this.dunningCampaigns.id, id))
      .returning();

    return (campaign) ?? null;
  }

  /**
   * Deletes the campaign with its steps, executions and analytics. A campaign whose step already sent
   * a communication is kept (the sent message keeps its step): it returns `DunningTemplateInUse` and
   * nothing changes. An unknown id (also one no row can hold) deletes nothing.
   */
  async delete(id: DunningCampaignId): Promise<FailureOf<typeof DunningTemplateInUse> | undefined> {
    if (!findable(id)) return;
    const campaigns = this.dunningCampaigns;
    const templates = this.dunningTemplates;
    const communications = this.dunningCommunications;

    return this.db.transaction(async tx => {
      // Lock the campaign, then its steps: a new step or a communication written for one now waits for
      // this transaction, and the check below sees every communication written before it
      await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, id)).for('update');
      await tx.select({ id: templates.id }).from(templates).where(eq(templates.campaignId, id)).for('update');
      const [used] = await tx
        .select({ templateId: templates.id, stepNumber: templates.stepNumber })
        .from(communications)
        .innerJoin(templates, eq(templates.id, communications.templateId))
        .where(eq(templates.campaignId, id))
        .limit(1);
      if (used) return DunningTemplateInUse(used);

      await tx.delete(campaigns).where(eq(campaigns.id, id));
      return;
    });
  }

  /** The active campaigns of the type. A type no campaign has returns `schema.invalid_input`. */
  async findByType(type: DunningCampaignType): Promise<DunningCampaign[] | SchemaFailure> {
    const checked = parse(dunningCampaignTypeSchema, type);
    if (isFailure(checked)) return checked;
    return this.db
      .select()
      .from(this.dunningCampaigns)
      .where(and(eq(this.dunningCampaigns.type, type), eq(this.dunningCampaigns.status, 'active')));
  }

  /**
   * The active campaigns of the trigger type, highest priority first. With segment ids, only the campaigns
   * that target one of them; a segment id no row can hold (U+0000) targets none, so a list of only such ids
   * answers `[]` without a query. A trigger type no campaign has, or more than `MAX_BATCH_ITEMS` (1,000)
   * segment ids, returns `schema.invalid_input`.
   */
  async findActiveForTrigger(
    triggerType: CampaignTrigger['type'],
    customerSegmentIds?: CustomerSegmentId[],
  ): Promise<DunningCampaign[] | SchemaFailure> {
    const checkedType = parse(campaignTriggerSchema.shape.type, triggerType);
    if (isFailure(checkedType)) return checkedType;
    const checkedIds = parse(segmentIdsFilterSchema.optional(), customerSegmentIds);
    if (isFailure(checkedIds)) return checkedIds;
    // The trigger-type lookup hits a JSONB field (`trigger->>'type'`) and the
    // segment intersection uses a JSONB EXISTS subquery — both have no
    // structured-filter equivalent and stay as RAW.
    const segmentIds = customerSegmentIds?.filter(segmentId => findable(segmentId));
    if (customerSegmentIds && customerSegmentIds.length > 0 && segmentIds?.length === 0) return [];
    const hasSegments = segmentIds && segmentIds.length > 0;

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
                sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${table.targetSegments}) AS segment WHERE segment IN ${segmentIds})`,
              )
            : triggerTypePredicate,
        ),
      )
      .orderBy(desc(sql`${table.settings}->>'priority'`));
  }

  /**
   * Set the campaign's status. An actor id that is not a `usr_` id Postgres can store returns
   * `schema.invalid_input`, and so does a status no campaign has; an unknown id (also one no row can hold)
   * returns `undefined`. Nothing is written then.
   */
  async updateStatus(
    id: DunningCampaignId,
    status: 'active' | 'draft' | 'archived' | 'paused',
    updatedBy: UserId,
  ): Promise<DunningCampaign | undefined | SchemaFailure> {
    const actor = parse(dunningActorSchema, updatedBy);
    if (isFailure(actor)) return actor;
    const checkedStatus = parse(dunningCampaignStatusSchema, status);
    if (isFailure(checkedStatus)) return checkedStatus;
    if (!findable(id)) return undefined;
    const [campaign] = await this.db
      .update(this.dunningCampaigns)
      .set({ status, updatedBy, updatedAt: now() })
      .where(eq(this.dunningCampaigns.id, id))
      .returning();

    return campaign;
  }

  /**
   * The analytics of the last `days` calendar days, summed, as `getAnalyticsSince` sums them (also its
   * `money.out_of_range`). Precondition (anything else throws an
   * invariant failure and runs no query): `days` is a whole number from 0 to `MAX_DUNNING_DAYS` (100 years).
   * A campaign id no row can hold sums no row: zero counts and no money.
   */
  async getAnalyticsSummary(campaignId?: DunningCampaignId, days = 30) {
    assertSpan(days, MAX_DUNNING_DAYS, 'days');
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
   * by count, not money, because campaigns recover in different currencies. Precondition (anything else
   * throws an invariant failure and runs no query): `since` falls in the years 1 to 9999.
   */
  async findTopPerformer(
    since: Instant,
  ): Promise<{ campaignId: DunningCampaignId; paymentsRecovered: number; conversionRate: number } | null> {
    assertComparable(since, 'since');
    const analytics = this.dunningCampaignAnalytics;
    // No `::int`: rows that each hold up to 2^31 - 1 sum past it, which an int cast refuses with SQLSTATE 22003
    const recovered = sql<number>`COALESCE(SUM(${analytics.paymentsRecovered}), 0)`.mapWith(Number);
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

  /**
   * The analytics rows from `since` on, summed. Money stays one balance per currency. Returns
   * `AmountOutOfRange` (`money.out_of_range`) when the revenue of one currency sums past 2^53 - 1 minor
   * units: each row holds at most that much, but many rows can add up past it. Precondition
   * (anything else throws an invariant failure and runs no query): `since` falls in the years 1 to 9999.
   * A campaign id no row can hold (U+0000) sums no row: zero counts and no money, without a query.
   */
  async getAnalyticsSince(since: Instant, campaignId?: DunningCampaignId) {
    assertComparable(since, 'since');
    if (!findable(campaignId)) {
      const none = { executions: 0, customersReached: 0, communicationsSent: 0, paymentsRecovered: 0, conversionRate: 0, roi: 0 };
      return { ...none, revenueRecovered: storedRevenue([]) };
    }
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
        // Compared in SQL, where the sum is exact: the text above is only read when this is false
        pastSafeRange: sql<boolean>`COALESCE(SUM(${this.dunningCampaignAnalytics.revenueRecoveredMinor}), 0) > ${Number.MAX_SAFE_INTEGER}`,
      })
      .from(this.dunningCampaignAnalytics)
      .where(inRange)
      .groupBy(this.dunningCampaignAnalytics.currency);
    if (recovered.some(row => row.pastSafeRange)) return AmountOutOfRange();

    return { ...counters, revenueRecovered: storedRevenue(recovered) };
  }
}

/** The tables the step repository reads: a step's communications decide whether it may be deleted. */
type TemplateTables = Pick<DunningTables, 'dunningTemplates' | 'dunningCommunications'>;

export class DunningTemplateRepository {
  private readonly db: DunningDatabase;
  private readonly dunningTemplates: DunningTables['dunningTemplates'];
  private readonly dunningCommunications: DunningTables['dunningCommunications'];

  constructor(db: DunningDatabase, tables: TemplateTables) {
    this.db = db;
    this.dunningTemplates = tables.dunningTemplates;
    this.dunningCommunications = tables.dunningCommunications;
  }

  /** The step, or `null` for an unknown id (also one no row can hold, without a query). */
  async findById(id: DunningTemplateId): Promise<DunningTemplate | null> {
    if (!findable(id)) return null;
    const [result] = await this.db
      .select()
      .from(this.dunningTemplates)
      .where(eq(this.dunningTemplates.id, id))
      .limit(1);
    return result ?? null;
  }

  /** The campaign's steps in step order; `[]` for an unknown campaign (also an id no row can hold). */
  async findByCampaignId(campaignId: DunningCampaignId): Promise<DunningTemplate[]> {
    if (!findable(campaignId)) return [];
    return this.db
      .select()
      .from(this.dunningTemplates)
      .where(eq(this.dunningTemplates.campaignId, campaignId))
      .orderBy(this.dunningTemplates.stepNumber);
  }

  /**
   * The new step. The input is parsed with `createDunningTemplateInputSchema` first: a value it refuses
   * (text over its length or holding U+0000, a step number or delay outside its range), or a message
   * its jsonb column cannot store (a lone surrogate), returns `schema.invalid_input`, and no campaign with
   * `input.campaignId` returns `DunningCampaignNotFound`; nothing is written then.
   */
  async create(
    input: CreateDunningTemplateInput,
  ): Promise<DunningTemplate | FailureOf<typeof DunningCampaignNotFound> | SchemaFailure> {
    const valid = parse(createDunningTemplateInputSchema, input);
    if (isFailure(valid)) return valid;
    const values = parse(templateValuesSchema, input);
    if (isFailure(values)) return values;
    const table = this.dunningTemplates;
    return insertOrMissing(
      this.db,
      table,
      async tx => {
        const [template] = await tx
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
      },
      [{ column: table.campaignId, value: input.campaignId, missing: () => DunningCampaignNotFound({ campaignId: input.campaignId }) }],
    );
  }

  /**
   * The updated step, `null` for an unknown id (also one no row can hold). The input is parsed with
   * `updateDunningTemplateInputSchema` first: a value it refuses, or a message its jsonb column cannot
   * store, returns `schema.invalid_input` and writes nothing.
   */
  async update(
    id: DunningTemplateId,
    input: UpdateDunningTemplateInput,
  ): Promise<DunningTemplate | null | SchemaFailure> {
    const valid = parse(updateDunningTemplateInputSchema, input);
    if (isFailure(valid)) return valid;
    const values = parse(templateValuesSchema, input);
    if (isFailure(values)) return values;
    if (!findable(id)) return null;
    const [template] = await this.db
      .update(this.dunningTemplates)
      .set({ ...input, updatedAt: now() })
      .where(eq(this.dunningTemplates.id, id))
      .returning();

    return (template) ?? null;
  }

  /**
   * Deletes the step. A step that already sent a communication is kept (the sent message keeps its
   * step): it returns `DunningTemplateInUse` and nothing changes. An unknown id (also one no row can hold)
   * deletes nothing.
   */
  async delete(id: DunningTemplateId): Promise<FailureOf<typeof DunningTemplateInUse> | undefined> {
    if (!findable(id)) return;
    const templates = this.dunningTemplates;
    const communications = this.dunningCommunications;

    return this.db.transaction(async tx => {
      // Lock the step first: a communication written for it now waits for this transaction, and the
      // check below sees every communication written before it
      const [step] = await tx
        .select({ templateId: templates.id, stepNumber: templates.stepNumber })
        .from(templates)
        .where(eq(templates.id, id))
        .for('update');
      if (!step) return;
      const [used] = await tx
        .select({ id: communications.id })
        .from(communications)
        .where(eq(communications.templateId, id))
        .limit(1);
      if (used) return DunningTemplateInUse(step);

      await tx.delete(templates).where(eq(templates.id, id));
      return;
    });
  }

  /** The campaign's active steps in step order; `[]` for an unknown campaign (also an id no row can hold). */
  async findActiveTemplates(campaignId: DunningCampaignId): Promise<DunningTemplate[]> {
    if (!findable(campaignId)) return [];
    return this.db
      .select()
      .from(this.dunningTemplates)
      .where(and(eq(this.dunningTemplates.campaignId, campaignId), eq(this.dunningTemplates.isActive, true)))
      .orderBy(this.dunningTemplates.stepNumber);
  }

  /** Turn the step on or off; `undefined` for an unknown id (also one no row can hold). */
  async updateStatus(
    id: DunningTemplateId,
    isActive: boolean,
  ): Promise<DunningTemplate | undefined> {
    if (!findable(id)) return undefined;
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

  /** The execution, or `null` for an unknown id (also one no row can hold, without a query). */
  async findById(id: DunningExecutionId): Promise<DunningExecution | null> {
    if (!findable(id)) return null;
    const [result] = await this.db
      .select()
      .from(this.dunningExecutions)
      .where(eq(this.dunningExecutions.id, id))
      .limit(1);
    return result ?? null;
  }

  /**
   * One page of executions. Preconditions (anything else throws an invariant failure and runs no query):
   * `limit` and `offset` are whole numbers of 0 or more; `scheduledAfter` and `scheduledBefore` fall in
   * the years 1 to 9999. A campaign or customer id no row can hold (U+0000) matches none: `[]`.
   */
  async findMany(query: ListExecutionsQuery): Promise<DunningExecution[] | SchemaFailure>{
    const { limit, offset, campaignId, customerId, status, scheduledAfter, scheduledBefore, sortBy, sortOrder } =
      query;
    const choices = parse(executionListChoicesSchema, query);
    if (isFailure(choices)) return choices;
    assertCount(limit, 'limit');
    assertCount(offset, 'offset');
    assertComparable(scheduledAfter, 'scheduledAfter');
    assertComparable(scheduledBefore, 'scheduledBefore');
    if (!findable(campaignId, customerId)) return [];

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

  /**
   * The new execution, or the failure that names the row it points at that does not exist:
   * `DunningCampaignNotFound`, `DunningTemplateNotFound`, or `ReferenceNotFound` for the customer,
   * subscription or payment (also for an id no row can hold). Text, JSON or a time its column cannot store
   * (a time outside the years 1 to 9999) returns `schema.invalid_input`. Nothing is written then.
   */
  async create(input: Omit<NewDunningExecution, 'id' | 'createdAt' | 'updatedAt'>): Promise<
    DunningExecution | ExecutionReferenceMissing | SchemaFailure
  > {
    const values = parse(executionValuesSchema, input);
    if (isFailure(values)) return values;
    const table = this.dunningExecutions;
    return insertOrMissing<DunningExecution, ExecutionReferenceMissing>(this.db, table, tx => this.insertExecution(tx, input), [
      { column: table.campaignId, value: input.campaignId, missing: () => DunningCampaignNotFound({ campaignId: input.campaignId }) },
      { column: table.templateId, value: input.templateId, missing: () => DunningTemplateNotFound({ templateId: String(input.templateId) }) },
      { column: table.customerId, value: input.customerId, missing: () => customerNotFound(input.customerId) },
      {
        column: table.subscriptionId,
        value: input.subscriptionId,
        missing: () => ReferenceNotFound({ kind: 'subscription', id: String(input.subscriptionId), missing: 'row' }),
      },
      {
        column: table.paymentId,
        value: input.paymentId,
        missing: () => ReferenceNotFound({ kind: 'payment', id: String(input.paymentId), missing: 'row' }),
      },
    ]);
  }

  private async insertExecution(
    db: DunningDatabase,
    input: Omit<NewDunningExecution, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<DunningExecution> {
    const [execution] = await db
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

  /**
   * Set the execution's status, with its result or error message. A result, message or `customScheduledAt`
   * its column cannot store (a time outside the years 1 to 9999) returns `schema.invalid_input` and writes
   * nothing; an unknown id (also one no row can hold) returns `undefined`.
   */
  async updateStatus(
    id: DunningExecutionId,
    status: ExecutionStatus,
    result?: ExecutionResultDb,
    errorMessage?: string,
    customScheduledAt?: Instant,
  ): Promise<DunningExecution | undefined | SchemaFailure> {
    const values = parse(executionValuesSchema, { status, result, errorMessage, scheduledAt: customScheduledAt });
    if (isFailure(values)) return values;
    if (!findable(id)) return undefined;
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

  /** The due scheduled executions, oldest first. `limit` is a whole number of 0 or more (a precondition: anything else throws an invariant failure). */
  async findScheduledExecutions(limit = 100): Promise<DunningExecution[]> {
    assertCount(limit, 'limit');
    return this.db
      .select()
      .from(this.dunningExecutions)
      .where(and(eq(this.dunningExecutions.status, 'scheduled'), lte(this.dunningExecutions.scheduledAt, now())))
      .orderBy(this.dunningExecutions.scheduledAt)
      .limit(limit);
  }

  /** The failed executions whose retry is due. `limit` is a whole number of 0 or more (a precondition: anything else throws an invariant failure). */
  async findRetryableExecutions(limit = 50): Promise<DunningExecution[]> {
    assertCount(limit, 'limit');
    return this.db
      .select()
      .from(this.dunningExecutions)
      .where(and(eq(this.dunningExecutions.status, 'failed'), lte(this.dunningExecutions.nextRetryAt, now())))
      .orderBy(this.dunningExecutions.nextRetryAt)
      .limit(limit);
  }

  /**
   * Start one retry of a failed execution, in one update: it is `running` again, its `retryCount`
   * goes up by one and it has no `nextRetryAt` until it fails again. Returns the updated row,
   * `undefined` for an unknown id (also one no row can hold), or `CounterExhausted`
   * (`payments.counter_exhausted`) when `retryCount` already holds `INT4_MAX` (nothing is written then).
   */
  async startRetry(
    id: DunningExecutionId,
  ): Promise<DunningExecution | FailureOf<typeof CounterExhausted> | undefined> {
    if (!findable(id)) return undefined;
    const executions = this.dunningExecutions;
    const [execution] = await this.db
      .update(executions)
      .set({
        status: 'running',
        startedAt: now(),
        retryCount: sql`${executions.retryCount} + 1`,
        nextRetryAt: null,
        updatedAt: now(),
      })
      // The guard sits in the update itself, so a full count is never raised past what the column holds
      .where(and(eq(executions.id, id), lt(executions.retryCount, INT4_MAX)))
      .returning();
    if (execution) return execution;

    // Nothing matched: an unknown id, or a row whose count is full (no call lowers it again)
    const [full] = await this.db.select({ id: executions.id }).from(executions).where(eq(executions.id, id));
    return full ? CounterExhausted({ counter: 'retryCount', id }) : undefined;
  }

  /**
   * Record a run that threw, in one update: status `failed`, the error message and when to retry it.
   * `findRetryableExecutions` picks it again once `nextRetryAt` has passed; `null` means it is never
   * retried. Returns the updated row, or `undefined` for an unknown id (also one no row can hold).
   * Precondition (anything else throws an invariant failure and writes nothing): `nextRetryAt` is `null`
   * or falls in the years 1 to 9999.
   */
  async recordFailure(
    id: DunningExecutionId,
    errorMessage: string,
    nextRetryAt: Instant | null,
  ): Promise<DunningExecution | undefined> {
    assertComparable(nextRetryAt ?? undefined, 'nextRetryAt');
    if (!findable(id)) return undefined;
    // The failure is recorded even when its message holds text the column cannot store: that text is dropped
    const message = pgTextSchema.safeParse(errorMessage);
    const [execution] = await this.db
      .update(this.dunningExecutions)
      .set({
        status: 'failed',
        errorMessage: message.success ? message.data : 'The error message cannot be stored',
        nextRetryAt,
        completedAt: now(),
        updatedAt: now(),
      })
      .where(eq(this.dunningExecutions.id, id))
      .returning();

    return execution;
  }

  /**
   * The customer's executions of the campaign created in the last `hours` hours, newest first.
   * Precondition (anything else throws an invariant failure and runs no query): `hours` is a whole
   * number from 0 to `MAX_DUNNING_HOURS` (100 years). An id no row can hold (U+0000) matches none: `[]`.
   */
  async findRecentForCustomer(
    customerId: CustomerId,
    campaignId: DunningCampaignId,
    hours = 24,
  ): Promise<DunningExecution[]> {
    assertSpan(hours, MAX_DUNNING_HOURS, 'hours');
    if (!findable(customerId, campaignId)) return [];
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

  /** The communication, or `null` for an unknown id (also one no row can hold, without a query). */
  async findById(id: DunningCommunicationId): Promise<DunningCommunication | null> {
    if (!findable(id)) return null;
    const [result] = await this.db
      .select()
      .from(this.dunningCommunications)
      .where(eq(this.dunningCommunications.id, id))
      .limit(1);
    return result ?? null;
  }

  /**
   * One page of communications. Preconditions (anything else throws an invariant failure and runs no
   * query): `limit` and `offset` are whole numbers of 0 or more; `sentAfter` and `sentBefore` fall in the
   * years 1 to 9999. An execution or customer id no row can hold (U+0000) matches none: `[]`.
   */
  async findMany(query: ListCommunicationsQuery): Promise<DunningCommunication[] | SchemaFailure>{
    const { limit, offset, executionId, customerId, channel, status, sentAfter, sentBefore, sortBy, sortOrder } =
      query;
    const choices = parse(communicationListChoicesSchema, query);
    if (isFailure(choices)) return choices;
    assertCount(limit, 'limit');
    assertCount(offset, 'offset');
    assertComparable(sentAfter, 'sentAfter');
    assertComparable(sentBefore, 'sentBefore');
    if (!findable(executionId, customerId)) return [];

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

  /**
   * The new communication, or the failure that names the row it points at that does not exist:
   * `DunningExecutionNotFound`, `DunningTemplateNotFound`, or `ReferenceNotFound` for the customer (also
   * for an id no row can hold). Text, JSON or a time its column cannot store (a recipient over 255
   * characters, U+0000, a lone surrogate in JSON, a time outside the years 1 to 9999) returns
   * `schema.invalid_input`. Nothing is written then.
   */
  async create(input: Omit<NewDunningCommunication, 'id' | 'createdAt' | 'updatedAt'>): Promise<
    DunningCommunication | CommunicationReferenceMissing | SchemaFailure
  > {
    const values = parse(communicationValuesSchema, input);
    if (isFailure(values)) return values;
    const table = this.dunningCommunications;
    return insertOrMissing<DunningCommunication, CommunicationReferenceMissing>(this.db, table, tx => this.insertCommunication(tx, input), [
      { column: table.executionId, value: input.executionId, missing: () => DunningExecutionNotFound({ executionId: input.executionId }) },
      { column: table.templateId, value: input.templateId, missing: () => DunningTemplateNotFound({ templateId: input.templateId }) },
      { column: table.customerId, value: input.customerId, missing: () => customerNotFound(input.customerId) },
    ]);
  }

  private async insertCommunication(
    db: DunningDatabase,
    input: Omit<NewDunningCommunication, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<DunningCommunication> {
    const [communication] = await db
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

  /**
   * Set the communication's status and the fields that go with it. Text, JSON or a time its column cannot
   * store (a time outside the years 1 to 9999) returns `schema.invalid_input` and writes nothing; `null` for
   * an unknown id (also one no row can hold).
   */
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
  ): Promise<DunningCommunication | null | SchemaFailure> {
    const values = parse(communicationValuesSchema, { ...updates, status });
    if (isFailure(values)) return values;
    if (!findable(id)) return null;
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

  /** The pending communications, oldest first. `limit` is a whole number of 0 or more (a precondition: anything else throws an invariant failure). */
  async findPendingCommunications(limit = 100): Promise<DunningCommunication[]> {
    assertCount(limit, 'limit');
    return this.db
      .select()
      .from(this.dunningCommunications)
      .where(eq(this.dunningCommunications.status, 'pending'))
      .orderBy(this.dunningCommunications.createdAt)
      .limit(limit);
  }

  /** The communication the provider knows by this id. An id the column cannot hold matches none. */
  async findByProviderMessageId(
    providerMessageId: string,
  ): Promise<DunningCommunication | undefined> {
    if (!pgVarcharSchema(255).safeParse(providerMessageId).success) return undefined;
    const [communication] = await this.db
      .select()
      .from(this.dunningCommunications)
      .where(eq(this.dunningCommunications.providerMessageId, providerMessageId))
      .limit(1);
    return communication;
  }

  /**
   * The execution's communications counted by outcome. An execution id no row can hold (U+0000) has none:
   * zero counts, without a query.
   */
  async getMetricsForExecution(executionId: DunningExecutionId) {
    if (!findable(executionId)) return { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, failed: 0 };
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

  /** The segment, or `undefined` for an unknown id (also one no row can hold, without a query). */
  async findById(id: CustomerSegmentId): Promise<CustomerSegmentRow | undefined> {
    if (!findable(id)) return undefined;
    const [segment] = await this.db
      .select()
      .from(this.customerSegments)
      .where(eq(this.customerSegments.id, id))
      .limit(1);
    return segment;
  }

  /**
   * One page of segments. Preconditions (anything else throws an invariant failure and runs no query):
   * `limit` and `offset` are whole numbers of 0 or more. A `search` holding U+0000 matches no segment.
   */
  async findMany(query: ListCustomerSegmentsQuery): Promise<CustomerSegmentRow[] | SchemaFailure>{
    const { limit, offset, type, isActive, search, sortBy, sortOrder } = query;
    const choices = parse(segmentListChoicesSchema, query);
    if (isFailure(choices)) return choices;
    assertCount(limit, 'limit');
    assertCount(offset, 'offset');
    if (!findable(search)) return [];

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

  /**
   * The new segment. The input is parsed with `createCustomerSegmentInputSchema`: a value it refuses (a name
   * over 255 characters or holding U+0000, a frequency outside int4, criteria outside their bounds such as a
   * plan tier no plan has or an invalid spend range), an actor id that is not a `usr_` id Postgres can store,
   * or criteria JSON a jsonb column cannot store (a lone surrogate, a bigint) returns `schema.invalid_input`
   * and writes nothing.
   */
  async create(
    input: CreateCustomerSegmentInput & { createdBy: UserId },
  ): Promise<CustomerSegmentRow | undefined | SchemaFailure> {
    const actor = parse(dunningActorSchema, input.createdBy);
    if (isFailure(actor)) return actor;
    const valid = parse(createCustomerSegmentInputSchema, input);
    if (isFailure(valid)) return valid;
    const values = parse(segmentValuesSchema, input);
    if (isFailure(values)) return values;
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

  /**
   * The updated segment, `undefined` for an unknown id (also one no row can hold). A value
   * `updateCustomerSegmentInputSchema` refuses, or criteria JSON Postgres cannot store, returns
   * `schema.invalid_input` and writes nothing, as in `create`.
   */
  async update(
    id: CustomerSegmentId,
    input: UpdateCustomerSegmentInput,
  ): Promise<CustomerSegmentRow | undefined | SchemaFailure> {
    const valid = parse(updateCustomerSegmentInputSchema, input);
    if (isFailure(valid)) return valid;
    const values = parse(segmentValuesSchema, input);
    if (isFailure(values)) return values;
    if (!findable(id)) return undefined;
    const [segment] = await this.db
      .update(this.customerSegments)
      .set({ ...input, updatedAt: now() })
      .where(eq(this.customerSegments.id, id))
      .returning();

    return segment;
  }

  /** Delete the segment. An unknown id (also one no row can hold) deletes nothing. */
  async delete(id: CustomerSegmentId): Promise<void> {
    if (!findable(id)) return;
    await this.db.delete(this.customerSegments).where(eq(this.customerSegments.id, id));
  }

  /**
   * Store the segment's customer count. A count `customer_count` (int4) cannot hold returns
   * `schema.invalid_input`; an unknown id (also one no row can hold) returns `undefined`.
   */
  async updateCustomerCount(
    id: CustomerSegmentId,
    count: number,
  ): Promise<CustomerSegmentRow | undefined | SchemaFailure> {
    const valid = parse(customerCountSchema, count);
    if (isFailure(valid)) return valid;
    if (!findable(id)) return undefined;
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

/** What a risk profile write takes: the stored row without its id and timestamps. */
type RiskProfileInput = Omit<CustomerRiskProfile, 'id' | 'createdAt' | 'updatedAt'>;

/** The risk profile write that names a customer with no row. */
type CustomerNotFound = FailureOf<typeof ReferenceNotFound>;

function customerNotFound(customerId: CustomerId): CustomerNotFound {
  return ReferenceNotFound({ kind: 'customer', id: customerId, missing: 'row' });
}

/** The columns a risk profile write sets, besides `customer_id`. */
function riskProfileFields(input: RiskProfileInput) {
  return {
    segmentIds: input.segmentIds,
    riskScore: input.riskScore,
    paymentHistory: input.paymentHistory,
    subscriptionHistory: input.subscriptionHistory,
    engagementMetrics: input.engagementMetrics,
    communicationPreferences: input.communicationPreferences,
    metadata: input.metadata,
  };
}

export class CustomerRiskProfileRepository {
  private readonly db: DunningDatabase;
  private readonly customerRiskProfiles: DunningTables['customerRiskProfiles'];

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'customerRiskProfiles'>) {
    this.db = db;
    this.customerRiskProfiles = tables.customerRiskProfiles;
  }

  /** The customer's profile, or `undefined` when there is none (also for an id no row can hold, without a query). */
  async findByCustomerId(customerId: CustomerId): Promise<CustomerRiskProfile | undefined> {
    if (!findable(customerId)) return undefined;
    const [profile] = await this.db
      .select()
      .from(this.customerRiskProfiles)
      .where(eq(this.customerRiskProfiles.customerId, customerId))
      .limit(1);

    return profile && readCustomerRiskProfile(profile);
  }

  /**
   * The new profile, or `ReferenceNotFound` (`kind: 'customer'`) when no customer has
   * `input.customerId` (also for an id no row can hold); nothing is written then. A customer has one profile: a second `create` for it
   * returns `CustomerRiskProfileExists` and changes nothing, so use `upsert` to replace one. JSON its
   * columns cannot store returns `schema.invalid_input` and writes nothing.
   */
  async create(
    input: RiskProfileInput,
  ): Promise<CustomerRiskProfile | CustomerNotFound | FailureOf<typeof CustomerRiskProfileExists> | SchemaFailure> {
    const checked = parse(riskProfileValuesSchema, input);
    if (isFailure(checked)) return checked;
    const table = this.customerRiskProfiles;
    return insertOrMissing(
      this.db,
      table,
      async tx => {
        const [profile] = await tx
          .insert(table)
          .values({ customerId: input.customerId, ...riskProfileFields(input) })
          .onConflictDoNothing({ target: table.customerId })
          .returning();
        if (!profile) return CustomerRiskProfileExists({ customerId: input.customerId });
        return readCustomerRiskProfile(profile);
      },
      [{ column: table.customerId, value: input.customerId, missing: () => customerNotFound(input.customerId) }],
    );
  }

  /**
   * The updated profile, or `undefined` when the customer has no profile (also for an id no row can hold).
   * JSON its columns cannot store returns `schema.invalid_input` and writes nothing.
   */
  async update(
    customerId: CustomerId,
    input: Partial<Omit<CustomerRiskProfile, 'id' | 'customerId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<CustomerRiskProfile | undefined | SchemaFailure> {
    const checked = parse(riskProfileValuesSchema, input);
    if (isFailure(checked)) return checked;
    if (!findable(customerId)) return undefined;
    const [profile] = await this.db
      .update(this.customerRiskProfiles)
      .set({ ...input, updatedAt: now() })
      .where(eq(this.customerRiskProfiles.customerId, customerId))
      .returning();

    return profile && readCustomerRiskProfile(profile);
  }

  /**
   * Writes the customer's one profile: inserts it, or replaces the stored one in the same statement
   * (the unique index on `customer_id`), so two first upserts at once still leave one row. Returns
   * `ReferenceNotFound` (`kind: 'customer'`) when no customer has `input.customerId` (also for an id no
   * row can hold), and
   * `schema.invalid_input` for JSON its columns cannot store; nothing is written then.
   */
  async upsert(input: RiskProfileInput): Promise<CustomerRiskProfile | CustomerNotFound | SchemaFailure> {
    const checked = parse(riskProfileValuesSchema, input);
    if (isFailure(checked)) return checked;
    const table = this.customerRiskProfiles;
    const fields = riskProfileFields(input);

    return insertOrMissing(
      this.db,
      table,
      async tx => {
        const [profile] = await tx
          .insert(table)
          .values({ customerId: input.customerId, ...fields })
          .onConflictDoUpdate({ target: table.customerId, set: { ...fields, updatedAt: now() } })
          .returning();
        invariant(profile, 'the risk profile upsert returned no row');
        return readCustomerRiskProfile(profile);
      },
      [{ column: table.customerId, value: input.customerId, missing: () => customerNotFound(input.customerId) }],
    );
  }

  /**
   * The profiles in the category, highest score first. `limit` is a whole number of 0 or more (a precondition:
   * anything else throws an invariant failure). A category no profile has returns `schema.invalid_input`.
   */
  async findByRiskCategory(category: RiskCategory, limit = 100): Promise<CustomerRiskProfile[] | SchemaFailure> {
    assertCount(limit, 'limit');
    const checked = parse(riskCategorySchema, category);
    if (isFailure(checked)) return checked;
    const table = this.customerRiskProfiles;
    const profiles = await this.db
      .select()
      .from(table)
      .where(sql`${table.riskScore}->>'category' = ${category}`)
      .orderBy(desc(sql`(${table.riskScore}->>'overall')::numeric`))
      .limit(limit);

    return profiles.map(profile => readCustomerRiskProfile(profile));
  }

  /**
   * The profiles in the segment. `limit` is a whole number of 0 or more (a precondition: anything else throws
   * an invariant failure). The id is compared as jsonb: one jsonb cannot hold (U+0000, a lone surrogate)
   * is in no profile's list, so it answers `[]` without a query.
   */
  async findBySegmentId(
    segmentId: CustomerSegmentId,
    limit = 100,
  ): Promise<CustomerRiskProfile[]> {
    assertCount(limit, 'limit');
    if (!is(segmentId, pgJsonSchema)) return [];
    const table = this.customerRiskProfiles;
    const profiles = await this.db
      .select()
      .from(table)
      .where(sql`${table.segmentIds} @> ${JSON.stringify([segmentId])}`)
      .limit(limit);

    return profiles.map(profile => readCustomerRiskProfile(profile));
  }

  /**
   * Replace the segments of the customer's profile. Segment ids the jsonb column cannot store (U+0000, a lone
   * surrogate) return `schema.invalid_input` and write nothing; `undefined` when the customer has no profile
   * (also for an id no row can hold).
   */
  async updateSegments(
    customerId: CustomerId,
    segmentIds: CustomerSegmentId[],
  ): Promise<CustomerRiskProfile | undefined | SchemaFailure> {
    const checked = parse(riskProfileValuesSchema, { segmentIds });
    if (isFailure(checked)) return checked;
    if (!findable(customerId)) return undefined;
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
  tables: TemplateTables,
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
