import type { SQL } from 'drizzle-orm';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';

import type { Instant } from '@arki/date';
import type { Money } from '@arki/money';
import { z } from '@arki/contracts';
import { add, fromDate, instant, isAfter, now, sub, toMillis } from '@arki/date';
import { getLogger } from '@arki/log';
import type { FailureOf, SchemaFailure } from '@arki/failure';
import { invariant, isFailure, orThrow } from '@arki/failure';
import { AmountOutOfRange, Currency } from '@arki/money';
import { ensure, is, parse } from '@arki/schema';

import type { CoreTables } from '../../core/tables.js';
import type { PaymentRetryService } from '../../core/services/payment-retry-service.js';
import type { CustomerId, PaymentId, SubscriptionId } from '../../core/types.js';
import type { UserId } from '../../core/user-id.js';
import { customerIdSchema, paymentIdSchema, subscriptionIdSchema } from '../../core/primitives.js';
import { INT4_MAX, pgTextSchema } from '../../core/pg-values.js';
import { CounterExhausted } from '../../core/failures.js';
import { ReferenceNotFound } from '../../core/providers/provider-error.js';
import type {
  CreateDunningCampaignInput,
  ExecuteCampaignInput,
  ListDunningCampaignsQuery,
  ListExecutionsQuery,
  UpdateDunningCampaignInput,
} from '../contracts.js';
import { dunningCampaignTemplatesSchema, executeCampaignInputSchema } from '../contracts.js';
import type { CustomerSegmentId, DunningCampaignId, DunningCampaignStatus } from '../primitives.js';
import type { DunningDatabase, ExecutionReferenceMissing } from '../repository.js';
import { valueList } from '../sql-list.js';
import type { DunningTables } from '../tables.js';
import type {
  CampaignTrigger,
  CampaignExecutionFilters,
  CustomerData,
  DunningCampaign,
  DunningCampaignWithSteps,
  DunningCommunication,
  DunningDashboardStats,
  DunningExecution,
  ExecutionResultDb,
  DunningTemplate,
  PaymentFailureConditions,
  SubscriptionStatusConditions,
  TimeBasedConditions,
} from '../types.js';
import type { CommunicationOrchestrationService } from './communication-service.js';
import { fromMinorColumn, toMinorColumn } from '../../core/money.js';
import { analyticsRowId, DEFAULT_ANALYTICS_CURRENCY } from '../analytics-money.js';
import type { DunningTickReport } from '../failures.js';
import {
  DunningCampaignNotActive,
  DunningCampaignNotFound,
  DunningCampaignWithoutSteps,
  DunningTemplateInUse,
  NotificationProviderRejected,
  tickFault,
} from '../failures.js';
import {
  createDunningCampaignRepository,
  createDunningExecutionRepository,
  createDunningTemplateRepository,
} from '../repository.js';

// Define eligible customer type for campaign execution
type EligibleCustomer = {
  id: CustomerId;
  subscriptionId?: SubscriptionId;
  paymentId?: PaymentId;
  triggerData?: Record<string, unknown>;
};

const logger = getLogger('arki:payments:dunning');

/**
 * Narrows a cross-domain query to (or away from) the customers a caller named. An id no customer row can
 * hold (U+0000, which Postgres refuses as a parameter) names nobody, so it is left out: a list of only such
 * ids to include matches no customer.
 */
function customerFilters(column: SQL, filters?: CampaignExecutionFilters): SQL[] {
  const conditions: SQL[] = [];
  const storable = (ids: readonly CustomerId[]) => ids.filter(id => is(id, pgTextSchema));
  if (filters?.customerIds?.length) conditions.push(sql`${column} IN ${valueList(storable(filters.customerIds))}`);
  const excluded = storable(filters?.excludeCustomerIds ?? []);
  if (excluded.length > 0) conditions.push(sql`${column} NOT IN ${valueList(excluded)}`);

  return conditions;
}

/**
 * The rows the eligibility queries select (`customer_id`, `subscription_id`, `payment_id`, `trigger_data`).
 * They are our own query's columns, so a row that does not match is a bug and `ensure` throws.
 */
const eligibleRowsSchema = z.array(
  z.object({
    customer_id: customerIdSchema,
    subscription_id: subscriptionIdSchema.nullish(),
    payment_id: paymentIdSchema.nullish(),
    trigger_data: z.record(z.string(), z.unknown()),
  }),
);

/** The eligible customers of one eligibility query's rows. */
function eligibleCustomers(rows: unknown): EligibleCustomer[] {
  return ensure(rows, eligibleRowsSchema).map(row => ({
    id: row.customer_id,
    subscriptionId: row.subscription_id ?? undefined,
    paymentId: row.payment_id ?? undefined,
    triggerData: row.trigger_data,
  }));
}

/** How many times a failed execution is retried before it stays failed. */
const MAX_EXECUTION_RETRIES = 3;

/**
 * When to retry an execution that threw after `retryCount` retries: 30 minutes, then 60, then 120
 * (doubling), and `null` once it has used all `MAX_EXECUTION_RETRIES` retries.
 */
function nextRetryAfter(retryCount: number): Instant | null {
  if (retryCount >= MAX_EXECUTION_RETRIES) return null;

  return add(now(), { minutes: 2 ** retryCount * 30 });
}

/**
 * Why an execution sent nothing: the communication service's failure (a channel with no provider, a
 * provider refusal or timeout, a row deleted since scheduling), or a customer deleted since scheduling.
 */
type SendFailure =
  | Exclude<Awaited<ReturnType<CommunicationOrchestrationService['sendCommunication']>>, DunningCommunication>
  | FailureOf<typeof ReferenceNotFound>;

/**
 * A send a later try can fix: the provider refused with a 5xx (its own fault). A timeout is never
 * retried: the message may have gone out, and a retry could send it twice.
 */
function isRetryableSend(failure: SendFailure): boolean {
  return NotificationProviderRejected.is(failure) && failure.data.upstreamStatus >= 500;
}

/** The payment row `checkAndStopOnPaymentSuccess` reads; node-postgres sends `bigint` as text. */
const paymentRowSchema = z.object({
  amount_minor: z.union([z.number().int(), z.string().regex(/^-?\d+$/)]),
  currency: z.string(),
});

/** The `integer` counters of a campaign's analytics row that `updateCampaignAnalytics` adds to. */
const ANALYTICS_COUNTERS = ['paymentsRecovered', 'executions', 'customersReached', 'communicationsSent'] as const;

/**
 * Service for managing dunning campaigns
 * Handles campaign CRUD operations, template management, and execution orchestration
 */
export class DunningCampaignService {
  private campaignRepo;
  private templateRepo;
  private executionRepo;

  constructor(
    private readonly db: DunningDatabase,
    private readonly tables: DunningCampaignServiceTables,
    private readonly communicationServiceFactory: () => CommunicationOrchestrationService,
    private readonly _paymentRetryService?: PaymentRetryService,
  ) {
    this.campaignRepo = createDunningCampaignRepository(db, tables);
    this.templateRepo = createDunningTemplateRepository(db, tables);
    this.executionRepo = createDunningExecutionRepository(db, {
      dunningExecutions: tables.dunningExecutions,
    });

    // Explicit indication that this parameter is reserved for future use
    void this._paymentRetryService;
  }

  private getCommunicationService(): CommunicationOrchestrationService {
    return this.communicationServiceFactory();
  }

  /**
   * Create a new dunning campaign with templates. The steps are parsed with `dunningCampaignTemplatesSchema`
   * and the campaign with `createDunningCampaignInputSchema` before any write; a value they refuse (a setting
   * or trigger count outside its range, NaN, a status no subscription has, an invalid spend range), or an
   * actor id or JSON Postgres cannot store, returns `schema.invalid_input` and writes nothing.
   */
  async createCampaign(
    input: CreateDunningCampaignInput,
    createdBy: UserId,
  ): Promise<DunningCampaignWithSteps | SchemaFailure> {
    const steps = parse(dunningCampaignTemplatesSchema, input.templates);
    if (isFailure(steps)) return steps;
    return this.db.transaction(async tx => {
      // The repositories run on the transaction: a template that fails takes the campaign with it
      const campaignRepo = createDunningCampaignRepository(tx, this.tables);
      const templateRepo = createDunningTemplateRepository(tx, this.tables);

      const campaignModel = await campaignRepo.create({
        ...input,
        createdBy,
      });

      if (isFailure(campaignModel)) return campaignModel;

      const templates = [];
      for (const templateInput of input.templates) {
        const template = await templateRepo.create({
          campaignId: campaignModel.id,
          name: templateInput.name,
          stepNumber: templateInput.stepNumber,
          delayHours: templateInput.delayHours,
          communication: templateInput.communication,
        });
        // The steps were parsed above, and the campaign was written in this transaction
        invariant(!isFailure(template), 'a parsed step of the campaign this transaction just wrote was refused');
        templates.push(template);
      }

      return {
        ...campaignModel,
        templates,
      };
    });
  }

  /**
   * Update an existing campaign.
   *
   * When `input.templates` is given it is the complete new set of steps (replace semantics, like create).
   * Steps are matched by `stepNumber`: a matching step is updated in place (its id, and so the history
   * that points at it, survives), a new number is inserted, and a number that is gone is deleted.
   * A step that already sent a communication cannot be deleted: the update returns
   * `DunningTemplateInUse` and nothing changes. Returns `null` for an unknown campaign (also an id no row
   * can hold), and `schema.invalid_input` for steps `dunningCampaignTemplatesSchema` refuses, campaign
   * fields `updateDunningCampaignInputSchema` refuses, or an actor id or JSON Postgres cannot store; nothing
   * is written then. Omit `templates` to leave the steps alone.
   */
  async updateCampaign(
    campaignId: DunningCampaignId,
    input: UpdateDunningCampaignInput,
    updatedBy: UserId,
  ): Promise<DunningCampaignWithSteps | null | FailureOf<typeof DunningTemplateInUse> | SchemaFailure> {
    const { templates: nextTemplates, ...campaignFields } = input;
    const { dunningCommunications, dunningTemplates } = this.tables;
    if (nextTemplates) {
      const steps = parse(dunningCampaignTemplatesSchema, nextTemplates);
      if (isFailure(steps)) return steps;
    }
    // No campaign has an id Postgres cannot take as a parameter (U+0000): unknown, before any query
    if (!is(campaignId, pgTextSchema)) return null;

    return this.db.transaction(async tx => {
      const campaignRepo = createDunningCampaignRepository(tx, this.tables);
      const templateRepo = createDunningTemplateRepository(tx, this.tables);

      // Lock the steps first: a communication written for one now waits for this transaction, and the
      // check below sees every communication written before it (the foreign key restricts the delete)
      const existing = nextTemplates
        ? await tx
            .select()
            .from(dunningTemplates)
            .where(eq(dunningTemplates.campaignId, campaignId))
            .orderBy(dunningTemplates.stepNumber)
            .for('update')
        : [];
      const keptSteps = new Set(nextTemplates?.map(template => template.stepNumber));
      const removed = existing.filter(template => !keptSteps.has(template.stepNumber));

      // A sent communication keeps its step (the foreign key restricts the delete): refuse before any write
      if (removed.length > 0) {
        const [used] = await tx
          .select({ templateId: dunningCommunications.templateId })
          .from(dunningCommunications)
          .where(inArray(dunningCommunications.templateId, removed.map(template => template.id)))
          .limit(1);
        const usedTemplate = used && removed.find(template => template.id === used.templateId);
        if (usedTemplate) {
          return DunningTemplateInUse({ templateId: usedTemplate.id, stepNumber: usedTemplate.stepNumber });
        }
      }

      const campaignModel = await campaignRepo.update(campaignId, { ...campaignFields, updatedBy });
      if (!campaignModel || isFailure(campaignModel)) return campaignModel;

      if (nextTemplates) {
        for (const template of removed) {
          const refused = await templateRepo.delete(template.id);
          invariant(!refused, 'a step the locked check found unused has a communication');
        }
        for (const next of nextTemplates) {
          const current = existing.find(template => template.stepNumber === next.stepNumber);
          // The steps were parsed above, and the campaign was updated in this transaction
          if (current) {
            const updated = await templateRepo.update(current.id, {
              name: next.name,
              delayHours: next.delayHours,
              communication: next.communication,
            });
            invariant(!isFailure(updated), 'a parsed step was refused');
          } else {
            const created = await templateRepo.create({ campaignId, ...next });
            invariant(!isFailure(created), 'a parsed step of the campaign this transaction just updated was refused');
          }
        }
      }

      const templates = await templateRepo.findByCampaignId(campaignId);

      return { ...campaignModel, templates };
    });
  }

  /**
   * Get campaign by ID with templates
   */
  async getCampaign(campaignId: DunningCampaignId): Promise<DunningCampaignWithSteps | null> {
    const campaign = await this.campaignRepo.findById(campaignId);
    if (!campaign) return null;

    const templates = await this.templateRepo.findByCampaignId(campaignId);

    return {
      ...campaign,
      templates,
    };
  }

  /**
   * List campaigns with filtering and pagination. `limit` and `offset` are whole numbers of 0 or more (a
   * precondition: anything else throws an invariant failure); a `search` holding U+0000 matches nothing. A
   * `type`, `status` or `sortBy` outside its list returns `schema.invalid_input`.
   */
  async listCampaigns(query: ListDunningCampaignsQuery): Promise<DunningCampaign[] | SchemaFailure> {
    return this.campaignRepo.findMany(query);
  }

  /**
   * Delete a campaign with its steps, executions and analytics. A campaign whose step already sent a
   * communication cannot be deleted (the sent message keeps its step): it returns
   * `DunningTemplateInUse` and nothing changes; archive the campaign instead. An unknown id deletes
   * nothing.
   */
  async deleteCampaign(campaignId: DunningCampaignId): Promise<FailureOf<typeof DunningTemplateInUse> | undefined> {
    return this.campaignRepo.delete(campaignId);
  }

  /**
   * Activate or deactivate a campaign. A status or actor id Postgres cannot store returns `schema.invalid_input`.
   */
  async updateCampaignStatus(
    campaignId: DunningCampaignId,
    status: DunningCampaignStatus,
    updatedBy: UserId,
  ): Promise<DunningCampaign | undefined | SchemaFailure> {
    return this.campaignRepo.updateStatus(campaignId, status, updatedBy);
  }

  /**
   * Execute a campaign manually or through automation: one scheduled execution per active step for
   * each eligible customer. An unknown campaign returns `DunningCampaignNotFound`, a campaign that is
   * not active `DunningCampaignNotActive`, one with no active step `DunningCampaignWithoutSteps`;
   * each writes nothing. A row deleted while the executions are written returns its not-found failure
   * (`ExecutionReferenceMissing`); the executions written before it stay. An input
   * `executeCampaignInputSchema` refuses (`customFilters.customerIds` or `excludeCustomerIds` with more than
   * `MAX_BATCH_ITEMS` (1,000) items) returns `schema.invalid_input` and runs nothing.
   */
  async executeCampaign(
    input: ExecuteCampaignInput,
    _executedBy: string,
  ): Promise<
    | DunningExecution[]
    | FailureOf<typeof DunningCampaignNotFound>
    | FailureOf<typeof DunningCampaignNotActive>
    | FailureOf<typeof DunningCampaignWithoutSteps>
    | ExecutionReferenceMissing
    | SchemaFailure
  > {
    const checked = parse(executeCampaignInputSchema, input);
    if (isFailure(checked)) return checked;
    const campaign = await this.campaignRepo.findById(input.campaignId);
    if (!campaign) {
      return DunningCampaignNotFound({ campaignId: input.campaignId });
    }

    if (campaign.status !== 'active') {
      return DunningCampaignNotActive({ campaignId: input.campaignId, status: campaign.status });
    }

    // Get campaign templates
    const templates = await this.templateRepo.findActiveTemplates(input.campaignId);
    if (templates.length === 0) {
      return DunningCampaignWithoutSteps({ campaignId: input.campaignId });
    }

    // Find eligible customers based on campaign trigger conditions
    const eligibleCustomers = await this.findEligibleCustomers(campaign, input.customFilters);

    if (input.dryRun) {
      logger.info('Dry run: Would execute campaign', { customerCount: eligibleCustomers.length });
      return [];
    }

    // Create executions for eligible customers
    const executions: DunningExecution[] = [];

    for (const customer of eligibleCustomers) {
      // Check cooldown period
      const recentExecutions = await this.executionRepo.findRecentForCustomer(
        customer.id,
        input.campaignId,
        campaign.settings.cooldownPeriod,
      );

      if (recentExecutions.length >= campaign.settings.maxExecutionsPerCustomer) {
        logger.info('Skipping customer - max executions reached', { customerId: customer.id });
        continue;
      }

      // Create execution for each template in sequence
      let currentDelay = 0;
      for (const template of templates) {
        const scheduledAt = add(now(), { hours: currentDelay });

        const execution = await this.executionRepo.create({
          campaignId: input.campaignId,
          templateId: template.id,
          customerId: customer.id,
          subscriptionId: customer.subscriptionId ?? null,
          paymentId: customer.paymentId ?? null,
          triggerType: campaign.trigger.type,
          triggerData: customer.triggerData || {},
          status: 'scheduled',
          scheduledAt,
          retryCount: 0,
        });
        // A row deleted since it was read (the campaign, a step or the customer), or stored trigger data
        // Postgres cannot hold: the executions written so far stay
        if (isFailure(execution)) return execution;

        executions.push(execution);
        currentDelay += template.delayHours;
      }
    }

    logger.info('Created campaign executions', {
      executionCount: executions.length,
      campaignId: input.campaignId,
    });
    return executions;
  }

  /**
   * Find customers eligible for a campaign based on trigger conditions
   */
  private async findEligibleCustomers(
    campaign: DunningCampaign,
    customFilters?: CampaignExecutionFilters,
  ): Promise<EligibleCustomer[]> {
    // This is a simplified implementation - in a real system this would involve
    // complex queries across customers, payments, subscriptions, and segments

    const { trigger } = campaign;
    const conditions = trigger.conditions;

    // Example implementation for payment failure trigger
    if (trigger.type === 'payment_failure') {
      // Query customers with recent payment failures
      // This would involve joining payments, customers, and checking failure counts
      return this.findCustomersWithPaymentFailures(conditions, customFilters);
    }

    if (trigger.type === 'subscription_status') {
      // Query customers with specific subscription statuses
      return this.findCustomersWithSubscriptionStatus(conditions, customFilters);
    }

    if (trigger.type === 'time_based') {
      // Query customers with trials ending soon or time-based triggers
      return this.findCustomersWithEndingTrials(conditions, customFilters);
    }

    // Default empty result
    return [];
  }

  private async findCustomersWithPaymentFailures(
    conditions: PaymentFailureConditions,
    customFilters?: CampaignExecutionFilters,
  ): Promise<EligibleCustomer[]> {
    const { paymentFailureCount = 1, daysSinceFailure = 7, daysSinceLastPayment = 30 } = conditions;

    // Raw `sql` parameters below bypass the column codec, so these working values stay `Date`s.
    const sinceFailure = new Date();
    sinceFailure.setDate(sinceFailure.getDate() - daysSinceFailure);

    const sinceLastPayment = new Date();
    sinceLastPayment.setDate(sinceLastPayment.getDate() - daysSinceLastPayment);

    // Cross-domain query: payments and customers belong to the core tables, not to dunning.
    // The tables are interpolated so the names carry their schema.
    const { customers: customersTable, payments } = this.tables;
    const customerConditions = customerFilters(sql`customer_id`, customFilters);
    const result = await this.db.execute(sql`
      WITH failed_payments AS (
        SELECT
          p.customer_id,
          p.subscription_id,
          (array_agg(p.id ORDER BY p.created_at DESC))[1] as payment_id,
          COUNT(*) as failure_count,
          MAX(p.created_at) as last_failure_date,
          json_build_object(
            'failure_count', COUNT(*),
            'last_failure_date', MAX(p.created_at),
            'failure_reasons', array_agg(DISTINCT p.failure_reason)
          ) as trigger_data
        FROM ${payments} p
        WHERE p.status = 'failed'
          AND p.created_at >= ${sinceFailure}
        GROUP BY p.customer_id, p.subscription_id
        HAVING COUNT(*) >= ${paymentFailureCount}
      ),
      recent_customers AS (
        SELECT
          fp.customer_id,
          fp.subscription_id,
          fp.payment_id,
          fp.trigger_data
        FROM failed_payments fp
        JOIN ${customersTable} c ON c.id = fp.customer_id
        LEFT JOIN ${payments} recent_success ON (
          recent_success.customer_id = fp.customer_id
          AND recent_success.status = 'succeeded'
          AND recent_success.created_at > fp.last_failure_date
        )
        WHERE recent_success.id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${payments} p2
            WHERE p2.customer_id = fp.customer_id
              AND p2.status = 'succeeded'
              AND p2.created_at >= ${sinceLastPayment}
          )
      )
      SELECT * FROM recent_customers
      ${customerConditions.length > 0 ? sql`WHERE ${sql.join(customerConditions, sql` AND `)}` : sql``}
      LIMIT 1000
    `);

    return eligibleCustomers(result.rows);
  }

  private async findCustomersWithSubscriptionStatus(
    conditions: SubscriptionStatusConditions,
    customFilters?: CampaignExecutionFilters,
  ): Promise<EligibleCustomer[]> {
    const { subscriptionStatus = ['past_due', 'unpaid'] } = conditions;

    // Cross-domain query: subscriptions and customers belong to the core tables.
    const { customers: customersTable, subscriptions } = this.tables;
    const filters = [
      sql`s.status IN ${valueList(subscriptionStatus)}`,
      sql`s.current_period_end < NOW()`,
      ...customerFilters(sql`c.id`, customFilters),
    ];
    const result = await this.db.execute(sql`
      SELECT
        c.id as customer_id,
        s.id as subscription_id,
        NULL as payment_id,
        json_build_object(
          'subscription_status', s.status,
          'current_period_end', s.current_period_end,
          'days_overdue', EXTRACT(days FROM NOW() - s.current_period_end)
        ) as trigger_data
      FROM ${subscriptions} s
      JOIN ${customersTable} c ON c.id = s.customer_id
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY s.current_period_end ASC
      LIMIT 1000
    `);

    return eligibleCustomers(result.rows);
  }

  private async findCustomersWithEndingTrials(
    conditions: TimeBasedConditions,
    customFilters?: CampaignExecutionFilters,
  ): Promise<EligibleCustomer[]> {
    const { trialEndingDays = 3, renewalReminderDays = 7 } = conditions;

    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + Math.max(trialEndingDays, renewalReminderDays));

    // Cross-domain query: subscriptions and customers belong to the core tables.
    const { customers: customersTable, subscriptions } = this.tables;
    const filters = [
      sql`s.status = 'trialing'`,
      sql`s.trial_end IS NOT NULL`,
      sql`s.trial_end BETWEEN NOW() AND ${targetDate}`,
      sql`s.trial_end > NOW()`,
      ...customerFilters(sql`c.id`, customFilters),
    ];
    const result = await this.db.execute(sql`
      SELECT
        c.id as customer_id,
        s.id as subscription_id,
        NULL as payment_id,
        json_build_object(
          'trial_end_date', s.trial_end,
          'days_until_end', EXTRACT(days FROM s.trial_end - NOW()),
          'subscription_status', s.status
        ) as trigger_data
      FROM ${subscriptions} s
      JOIN ${customersTable} c ON c.id = s.customer_id
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY s.trial_end ASC
      LIMIT 1000
    `);

    return eligibleCustomers(result.rows);
  }

  /**
   * Run the scheduled executions that are due. Returns how many ran and each one that failed: one that
   * threw (a provider that cannot be reached, a database error) is marked `failed` with a `nextRetryAt`,
   * so `retryFailedExecutions` retries it; one whose message was refused is listed with the failure's
   * code and marked `failed` (with a `nextRetryAt` only for a 5xx refusal; a timeout is not retried, the
   * message may have gone out). One that ran but whose campaign analytics are full is complete and listed
   * with `payments.counter_exhausted` or `money.out_of_range`. A fault that stops
   * the whole tick is thrown. `limit` is a whole number of 0 or more (a precondition: anything else throws
   * an invariant failure before any query).
   */
  async processScheduledExecutions(limit = 100): Promise<DunningTickReport> {
    const scheduledExecutions = await this.executionRepo.findScheduledExecutions(limit);
    const report: DunningTickReport = { processed: scheduledExecutions.length, failed: [] };

    for (const executionDb of scheduledExecutions) {
      try {
        // A message that did not go out, or a stop check that met a bad stored payment, is listed with its code
        const outcome = await this.executeIndividualExecution(executionDb, executionDb.retryCount);
        if (isFailure(outcome)) report.failed.push(tickFault(executionDb.id, outcome));
      } catch (error) {
        logger.error('Failed to execute campaign', {
          executionId: executionDb.id,
          error: error instanceof Error ? error.message : String(error),
        });
        report.failed.push(tickFault(executionDb.id, error));
        // A run that threw is retried later by retryFailedExecutions
        await this.executionRepo.recordFailure(
          executionDb.id,
          error instanceof Error ? error.message : 'Unknown error',
          nextRetryAfter(executionDb.retryCount),
        );
      }
    }
    return report;
  }

  /**
   * Execute a single scheduled execution. Returns the `SendFailure` of a message that did not go out:
   * the execution is then `failed`, with a `nextRetryAt` when a later try can work (a 5xx refusal,
   * within `MAX_EXECUTION_RETRIES`; `retryCount` is the retry this run counts as).
   * Returns the `MoneyFailure` of a stored payment the stop check could not read; the execution itself
   * is then complete and nothing was cancelled. Returns `CounterExhausted` (`payments.counter_exhausted`)
   * or `AmountOutOfRange` (`money.out_of_range`) when the campaign's analytics row cannot count what this
   * run did; the execution is complete and the stop check has run, only the analytics missed it.
   */
  private async executeIndividualExecution(execution: DunningExecution, retryCount: number) {
    // Update status to running
    orThrow(await this.executionRepo.updateStatus(execution.id, 'running'));

    // Get campaign and template details
    const campaign = await this.campaignRepo.findById(execution.campaignId);
    const template = execution.templateId ? await this.templateRepo.findById(execution.templateId) : null;

    // The campaign or its step was deleted after the execution was scheduled: record it, nothing to send
    if (!campaign || !template) {
      orThrow(await this.executionRepo.updateStatus(execution.id, 'failed', undefined, 'Campaign or template not found'));
      return;
    }

    // Check business hours and allowed days if configured
    if (
      campaign.settings.businessHoursOnly &&
      !this.isBusinessHours(campaign.settings.timezone, campaign.settings.allowedDays)
    ) {
      // Reschedule for next business hour
      const nextBusinessHour = this.getNextBusinessHour(campaign.settings.timezone, campaign.settings.allowedDays);

      logger.info('Execution rescheduled to next business hour', {
        executionId: execution.id,
        scheduledAt: nextBusinessHour.toString(),
      });

      // Update the execution to be scheduled for the next business hour
      orThrow(await this.executionRepo.updateStatus(execution.id, 'scheduled', undefined, undefined, nextBusinessHour));

      return;
    }

    // Execute the communication
    const result = await this.executeCommunication(execution, template, campaign);
    if (isFailure(result)) {
      const nextRetryAt = isRetryableSend(result) ? nextRetryAfter(retryCount) : null;
      const exhausted = isRetryableSend(result) && nextRetryAt === null;
      logger.warn('Execution {executionId} sent nothing: {code}', { executionId: execution.id, code: result.code });
      await this.executionRepo.recordFailure(
        execution.id,
        exhausted ? `Max retries exceeded: ${result.message}` : result.message,
        nextRetryAt,
      );
      return result;
    }

    // Update execution with result
    orThrow(await this.executionRepo.updateStatus(execution.id, 'completed', result));

    // Only a message that went out counts as reached and sent. A full counter is returned after the
    // stop check, so a customer who paid is still not sent the later steps.
    let counted;
    if (result.communicationsSent > 0) {
      counted = await this.updateCampaignAnalytics(execution.campaignId, { customersReached: 1, communicationsSent: 1 });
    }

    // Check if payment was successful and stop subsequent executions if configured
    if (campaign.settings.stopOnPaymentSuccess) {
      const stopped = await this.checkAndStopOnPaymentSuccess(execution);
      if (isFailure(stopped)) return stopped;
    }
    return counted;
  }

  /**
   * Send the execution's message. Returns the result to store on the completed execution, or the
   * `SendFailure` when no message went out. A provider that cannot be reached, or a database error,
   * is thrown: the tick marks the execution failed and retries it.
   */
  private async executeCommunication(
    execution: DunningExecution,
    template: DunningTemplate,
    campaign: DunningCampaign,
  ): Promise<ExecutionResultDb | SendFailure> {
    const startTime = Date.now();

    // Get customer information
    const { customers: customersTable, customerRiskProfiles } = this.tables;
    const [row] = await this.db
      .select({
        id: customersTable.id,
        email: customersTable.email,
        name: customersTable.name,
        communicationPreferences: customerRiskProfiles.communicationPreferences,
      })
      .from(customersTable)
      .leftJoin(customerRiskProfiles, eq(customerRiskProfiles.customerId, customersTable.id))
      .where(eq(customersTable.id, execution.customerId))
      .limit(1);

    // The customer was deleted after the execution was scheduled: nobody to send to
    if (!row) return ReferenceNotFound({ kind: 'customer', id: execution.customerId, missing: 'row' });

    const customer: CustomerData = {
      id: row.id,
      email: row.email ?? undefined,
      name: row.name ?? undefined,
      communicationPreferences: row.communicationPreferences ?? undefined,
    };
    const communicationPrefs = customer.communicationPreferences ?? {};

    // Check if customer has unsubscribed from this channel
    if (campaign.settings.respectUnsubscribe && communicationPrefs.unsubscribed) {
      logger.info('Customer has unsubscribed from communications', {
        customerId: execution.customerId,
      });
      return {
        customersProcessed: 1,
        communicationsSent: 0,
        errors: [],
        performance: { processingTime: Date.now() - startTime, successRate: 1 },
      };
    }

    if (communicationPrefs.unsubscribedChannels?.includes(template.communication.channel)) {
      logger.info('Customer has unsubscribed from channel', {
        customerId: execution.customerId,
        channel: template.communication.channel,
      });
      return {
        customersProcessed: 1,
        communicationsSent: 0,
        errors: [],
        performance: { processingTime: Date.now() - startTime, successRate: 1 },
      };
    }

    // Use the injected communication orchestration service
    const communicationService = this.getCommunicationService();

    // Prepare personalizations for the communication service
    const personalizations = {
      customer_name: customer.name || 'Customer',
      customer_email: customer.email || '',
      campaign_name: campaign.name,
      // Trigger data is stored JSON: text stays as it is, any other value is written as its JSON
      ...Object.fromEntries(
        Object.entries(execution.triggerData).map(([key, value]) => [
          key,
          typeof value === 'string' ? value : JSON.stringify(value),
        ]),
      ),
    };

    // Send communication using the correct service interface
    const communicationResult = await communicationService.sendCommunication(
      execution,
      template,
      customer,
      personalizations,
    );

    // A provider refusal, a timeout or a channel with no provider is returned (the communication row records it)
    if (isFailure(communicationResult)) return communicationResult;

    return {
      customersProcessed: 1,
      communicationsSent: 1,
      errors: [],
      performance: { processingTime: Date.now() - startTime, successRate: 1 },
    };
  }

  // Removed unused substituteVariables method - variable substitution
  // should be handled by the communication service when actually sending messages

  /**
   * Check if current time is within business hours
   */
  private isBusinessHours(timezone?: string, allowedDays?: number[]): boolean {
    try {
      // Use provided timezone or default to UTC
      const targetTimezone = timezone || 'UTC';

      // Get current time in the specified timezone
      const current = new Date();
      const timeInTimezone = new Intl.DateTimeFormat('en-US', {
        timeZone: targetTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(current);

      const hour = Number.parseInt(timeInTimezone.find(part => part.type === 'hour')?.value || '0');
      const dayOfWeek = current.getDay(); // 0 = Sunday, 6 = Saturday

      // Check if current day is allowed (if specified)
      if (allowedDays && allowedDays.length > 0) {
        if (!allowedDays.includes(dayOfWeek)) {
          return false;
        }
      } else {
        // Default: only weekdays (Monday-Friday)
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          // Sunday or Saturday
          return false;
        }
      }

      // Default business hours: 9 AM to 5 PM
      return hour >= 9 && hour < 17;
    } catch (error) {
      logger.error('Error checking business hours', { error: error instanceof Error ? error.message : String(error) });
      // Fallback to simple check if timezone parsing fails
      const hour = new Date().getHours();
      return hour >= 9 && hour < 17;
    }
  }

  /**
   * Get next business hour in the specified timezone
   */
  private getNextBusinessHour(timezone?: string, allowedDays?: number[]): Instant {
    const targetTimezone = timezone || 'UTC';
    // Local-time wall-clock steps, as before: the working value stays a `Date` until it is returned.
    const next = new Date();

    try {
      // Get current time in target timezone
      const timeInTimezone = new Intl.DateTimeFormat('en-US', {
        timeZone: targetTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(next);

      const hour = Number.parseInt(timeInTimezone.find(part => part.type === 'hour')?.value || '0');

      // Set to 9 AM in the target timezone
      if (hour < 9) {
        // If before 9 AM, schedule for 9 AM today
        next.setHours(9, 0, 0, 0);
      } else if (hour >= 17) {
        // If after 5 PM, schedule for 9 AM tomorrow
        next.setDate(next.getDate() + 1);
        next.setHours(9, 0, 0, 0);
      } else {
        // During business hours, schedule for next hour
        next.setHours(hour + 1, 0, 0, 0);
      }

      // Ensure the scheduled day is a business day
      while (!this.isBusinessDay(next, allowedDays)) {
        next.setDate(next.getDate() + 1);
        next.setHours(9, 0, 0, 0);
      }

      return fromDate(next);
    } catch (error) {
      logger.error('Error calculating next business hour', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallback implementation
      next.setHours(9, 0, 0, 0);
      if (new Date().getHours() >= 17) {
        next.setDate(next.getDate() + 1);
      }
      return fromDate(next);
    }
  }

  /**
   * Check if a given date falls on a business day
   */
  private isBusinessDay(date: Date, allowedDays?: number[]): boolean {
    const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday

    if (allowedDays && allowedDays.length > 0) {
      return allowedDays.includes(dayOfWeek);
    }

    // Default: weekdays only (Monday-Friday)
    return dayOfWeek >= 1 && dayOfWeek <= 5;
  }

  /**
   * Check if payment was successful and stop subsequent executions. The payment row is read and
   * checked first, so a stored currency `@arki/money` refuses returns its `MoneyFailure` before any
   * execution is cancelled. A row of another shape than the query selects is a bug (`AssertError`).
   * Returns the failure of the analytics write (`payments.counter_exhausted`, `money.out_of_range`)
   * when the recovery cannot be counted; the executions are cancelled by then.
   */
  private async checkAndStopOnPaymentSuccess(execution: DunningExecution) {
    // Check if the customer has made a successful payment since the execution started
    const paymentResult = await this.db.execute(sql`
      SELECT p.id, p.amount_minor, p.currency, p.created_at
      FROM ${this.tables.payments} p
      WHERE p.customer_id = ${execution.customerId}
        AND p.status = 'succeeded'
        AND p.created_at >= ${new Date(toMillis(execution.startedAt ?? execution.scheduledAt))}
      ORDER BY p.created_at DESC
      LIMIT 1
    `);

    const recentSuccessfulPayments = paymentResult.rows || [];
    if (recentSuccessfulPayments.length === 0) return;

    const payment = ensure(recentSuccessfulPayments[0], paymentRowSchema, { at: 'payments.row' });
    const currency = Currency.parse(payment.currency.toUpperCase());
    if (isFailure(currency)) return currency;
    const revenueRecovered = fromMinorColumn(payment.amount_minor, currency.code);

    logger.info('Payment success detected, stopping dunning campaign', {
      customerId: execution.customerId,
    });

    // Cancel future scheduled executions for this customer and campaign
    const scheduledExecutions = await this.executionRepo.findScheduledExecutions(100);

    for (const scheduledExec of scheduledExecutions) {
      if (
        scheduledExec.customerId === execution.customerId &&
        scheduledExec.campaignId === execution.campaignId &&
        scheduledExec.scheduledAt &&
        isAfter(scheduledExec.scheduledAt, now())
      ) {
        orThrow(await this.executionRepo.updateStatus(
          scheduledExec.id,
          'cancelled',
          undefined,
          'Cancelled due to successful payment',
        ));
      }
    }

    // Update campaign analytics with successful recovery
    return this.updateCampaignAnalytics(execution.campaignId, { paymentsRecovered: 1, revenueRecovered });
  }

  /**
   * Add the metrics to the campaign's analytics row of today and the currency, in one upsert. Returns
   * `CounterExhausted` (`payments.counter_exhausted`) when a counter would pass `INT4_MAX`, the most its
   * `integer` column holds, and `AmountOutOfRange` (`money.out_of_range`) when the recovered revenue
   * would pass 2^53 - 1 minor units, the most the column reads back exactly. Nothing is written then.
   */
  private async updateCampaignAnalytics(
    campaignId: DunningCampaignId,
    metrics: {
      paymentsRecovered?: number;
      revenueRecovered?: Money;
      executions?: number;
      customersReached?: number;
      communicationsSent?: number;
    },
  ) {
    const today = now().toString().slice(0, 10);
    // One row per campaign, day and currency. Counters with no payment go to the default-currency row.
    const currency = metrics.revenueRecovered?.currency.code ?? DEFAULT_ANALYTICS_CURRENCY;
    const analyticsId = analyticsRowId(campaignId, today, currency);
    const revenueMinor = metrics.revenueRecovered ? toMinorColumn(metrics.revenueRecovered) : 0;

    const analytics = this.tables.dunningCampaignAnalytics;
    const paymentsRecovered = metrics.paymentsRecovered ?? 0;
    const executions = metrics.executions ?? 0;
    const customersReached = metrics.customersReached ?? 0;
    const communicationsSent = metrics.communicationsSent ?? 0;
    const added = { paymentsRecovered, executions, customersReached, communicationsSent };

    const [counted] = await this.db
      .insert(analytics)
      .values({
        id: analyticsId,
        campaignId,
        date: instant(`${today}T00:00:00Z`),
        currency,
        paymentsRecovered,
        revenueRecoveredMinor: revenueMinor,
        executions,
        customersReached,
        communicationsSent,
      })
      .onConflictDoUpdate({
        target: analytics.id,
        set: {
          paymentsRecovered: sql`${analytics.paymentsRecovered} + ${paymentsRecovered}`,
          revenueRecoveredMinor: sql`${analytics.revenueRecoveredMinor} + ${revenueMinor}`,
          executions: sql`${analytics.executions} + ${executions}`,
          customersReached: sql`${analytics.customersReached} + ${customersReached}`,
          communicationsSent: sql`${analytics.communicationsSent} + ${communicationsSent}`,
          updatedAt: now(),
        },
        // The guard sits in the upsert itself, so a race between two calls never raises a sum past what its column holds
        setWhere: and(
          ...ANALYTICS_COUNTERS.map(counter => lte(analytics[counter], INT4_MAX - added[counter])),
          lte(analytics.revenueRecoveredMinor, Number.MAX_SAFE_INTEGER - revenueMinor),
        ),
      })
      .returning();
    if (counted) return;

    // Nothing was written: the row holds a sum that cannot take this much more (no call lowers one again)
    const [row] = await this.db.select().from(analytics).where(eq(analytics.id, analyticsId));
    // The row went with its campaign between the two statements: there is nothing left to count
    if (!row) return;
    const full = ANALYTICS_COUNTERS.find(counter => row[counter] > INT4_MAX - added[counter]);
    return full ? CounterExhausted({ counter: full, id: analyticsId }) : AmountOutOfRange();
  }

  /**
   * Campaign analytics of the last `days` days, or `AmountOutOfRange` (`money.out_of_range`) when the
   * revenue of one currency sums past 2^53 - 1 minor units. Precondition (anything else throws an invariant failure
   * and runs no query): `days` is a whole number from 0 to `MAX_DUNNING_DAYS` (100 years).
   */
  async getCampaignAnalytics(campaignId?: DunningCampaignId, days = 30) {
    return this.campaignRepo.getAnalyticsSummary(campaignId, days);
  }

  /**
   * One page of executions, filtered and sorted as `query` says. `limit` and `offset` are whole numbers of
   * 0 or more and the times fall in the years 1 to 9999 (preconditions: anything else throws an invariant failure).
   * A `status` or `sortBy` outside its list returns `schema.invalid_input`.
   */
  async listExecutions(query: ListExecutionsQuery): Promise<DunningExecution[] | SchemaFailure> {
    return this.executionRepo.findMany(query);
  }

  /**
   * The numbers on the dunning dashboard, all read from the tables: campaign counts, what ran
   * today (since 00:00 UTC), what was recovered today and this month, the conversion rate and
   * the top campaign over the last 30 days, and the latest executions. Returns `AmountOutOfRange`
   * (`money.out_of_range`) when a revenue total sums past 2^53 - 1 minor units (see `getAnalyticsSince`).
   */
  async getDashboardStats() {
    const current = new Date();
    const startOfToday = fromDate(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate())));
    const startOfMonth = fromDate(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1)));
    const last30Days = sub(now(), { hours: 30 * 24 });

    const [campaigns, today, month, recent, top, recentExecutions] = await Promise.all([
      this.campaignRepo.countCampaigns(),
      this.campaignRepo.getAnalyticsSince(startOfToday),
      this.campaignRepo.getAnalyticsSince(startOfMonth),
      this.campaignRepo.getAnalyticsSince(last30Days),
      this.campaignRepo.findTopPerformer(last30Days),
      this.executionRepo.findMany({ limit: 10, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' }),
    ]);
    // The query is built from constants, so a refusal is a bug
    const recentExecutionRows = orThrow(recentExecutions);
    // A revenue sum past 2^53 - 1 minor units is returned, not shown rounded
    if (isFailure(today)) return today;
    if (isFailure(month)) return month;
    if (isFailure(recent)) return recent;

    const topCampaign = top ? await this.campaignRepo.findById(top.campaignId) : null;
    const topRevenue = top ? await this.campaignRepo.getAnalyticsSince(last30Days, top.campaignId) : null;
    if (isFailure(topRevenue)) return topRevenue;

    const stats: DunningDashboardStats = {
      totalCampaigns: campaigns.total,
      activeCampaigns: campaigns.active,
      executionsToday: today.executions,
      customersReachedToday: today.customersReached,
      revenueRecoveredToday: today.revenueRecovered,
      revenueRecoveredThisMonth: month.revenueRecovered,
      averageConversionRate: recent.conversionRate,
      topPerformingCampaign:
        top && topCampaign && topRevenue
          ? {
              id: top.campaignId,
              name: topCampaign.name,
              paymentsRecovered: top.paymentsRecovered,
              conversionRate: top.conversionRate,
              revenueRecovered: topRevenue.revenueRecovered,
            }
          : null,
      recentExecutions: recentExecutionRows,
    };
    return stats;
  }

  /**
   * Retry the failed executions whose `nextRetryAt` has passed. Each retry counts once in
   * `retryCount` and runs the execution again. A retry that throws, or whose message is refused with
   * a 5xx, is `failed` again with the next
   * `nextRetryAt` (30 minutes, then 60, then 120), so a later call picks it again; after
   * `MAX_EXECUTION_RETRIES` (3) retries it stays failed with no `nextRetryAt`. An execution whose
   * `retryCount` is already full (`payments.counter_exhausted`) is not run: it is reported and stays
   * failed with no `nextRetryAt`. Returns how many were retried and each retry that threw again. `limit` is a whole number of 0 or more (a precondition:
   * anything else throws an invariant failure before any query).
   */
  async retryFailedExecutions(limit = 50): Promise<DunningTickReport> {
    const retryableExecutions = await this.executionRepo.findRetryableExecutions(limit);
    const report: DunningTickReport = { processed: retryableExecutions.length, failed: [] };

    for (const executionDb of retryableExecutions) {
      // The retry this run makes: startRetry writes the same count
      const retryCount = executionDb.retryCount + 1;
      try {
        const started = await this.executionRepo.startRetry(executionDb.id);
        if (isFailure(started)) {
          // `retryCount` is full, so this execution can never count another retry: it stays failed for good
          report.failed.push(tickFault(executionDb.id, started));
          await this.executionRepo.recordFailure(executionDb.id, `Max retries exceeded: ${started.message}`, null);
          continue;
        }

        const outcome = await this.executeIndividualExecution(executionDb, retryCount);
        if (isFailure(outcome)) report.failed.push(tickFault(executionDb.id, outcome));
      } catch (error) {
        logger.error('Retry failed for execution', {
          executionId: executionDb.id,
          retryCount,
          error: error instanceof Error ? error.message : String(error),
        });
        report.failed.push(tickFault(executionDb.id, error));

        const message = error instanceof Error ? error.message : 'Unknown error';
        const nextRetryAt = nextRetryAfter(retryCount);
        await this.executionRepo.recordFailure(
          executionDb.id,
          nextRetryAt ? message : `Max retries exceeded: ${message}`,
          nextRetryAt,
        );
      }
    }
    return report;
  }

  /**
   * Find active campaigns for a specific trigger. A trigger type or segment id Postgres cannot store returns
   * `schema.invalid_input`.
   */
  async findActiveCampaignsForTrigger(
    triggerType: CampaignTrigger['type'],
    customerSegmentIds?: CustomerSegmentId[],
  ): Promise<DunningCampaign[] | SchemaFailure> {
    return this.campaignRepo.findActiveForTrigger(triggerType, customerSegmentIds);
  }
}

export type DunningCampaignServiceTables = Pick<
  DunningTables,
  | 'dunningCampaigns'
  | 'dunningCampaignAnalytics'
  | 'dunningTemplates'
  | 'dunningExecutions'
  | 'dunningCommunications'
  | 'customerRiskProfiles'
> &
  Pick<CoreTables, 'customers' | 'payments' | 'subscriptions'>;

/**
 * Factory function to create DunningCampaignService.
 */
export function createDunningCampaignService(
  db: DunningDatabase,
  tables: DunningCampaignServiceTables,
  communicationServiceFactory: () => CommunicationOrchestrationService,
  paymentRetryService?: PaymentRetryService,
) {
  return new DunningCampaignService(db, tables, communicationServiceFactory, paymentRetryService);
}
