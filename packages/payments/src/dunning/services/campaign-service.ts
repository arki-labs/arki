import type { SQL } from 'drizzle-orm';
import { eq, sql } from 'drizzle-orm';

import type { Instant } from '@arki/date';
import type { Money } from '@arki/money';
import { z } from '@arki/contracts';
import { add, fromDate, instant, isAfter, now, sub, toMillis } from '@arki/date';
import { getLogger } from '@arki/log';

import type { CoreTables } from '../../core/tables.js';
import type { PaymentRetryService } from '../../core/services/payment-retry-service.js';
import type { CustomerId, PaymentId, SubscriptionId } from '../../core/types.js';
import type {
  CreateDunningCampaignInput,
  ExecuteCampaignInput,
  ListDunningCampaignsQuery,
  ListExecutionsQuery,
  UpdateDunningCampaignInput,
} from '../contracts.js';
import type { DunningCampaignId, DunningCampaignStatus } from '../primitives.js';
import type { DunningDatabase } from '../repository.js';
import { valueList } from '../sql-list.js';
import type { DunningTables } from '../tables.js';
import type {
  CampaignExecutionFilters,
  CustomerData,
  CustomerQueryRow,
  DunningCampaign,
  DunningDashboardStats,
  DunningExecution,
  DunningTemplate,
  PaymentFailureConditions,
  SubscriptionStatusConditions,
  TimeBasedConditions,
} from '../types.js';
import type { CommunicationOrchestrationService } from './communication-service.js';
import { fromMinorColumn, toMinorColumn } from '../../core/money.js';
import { analyticsRowId, DEFAULT_ANALYTICS_CURRENCY } from '../analytics-money.js';
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

const logger = getLogger('dunning.campaign');

/** Narrows a cross-domain query to (or away from) the customers a caller named. */
function customerFilters(column: SQL, filters?: CampaignExecutionFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters?.customerIds?.length) conditions.push(sql`${column} IN ${valueList(filters.customerIds)}`);
  if (filters?.excludeCustomerIds?.length) conditions.push(sql`${column} NOT IN ${valueList(filters.excludeCustomerIds)}`);

  return conditions;
}

/** The payment row `checkAndStopOnPaymentSuccess` reads; node-postgres sends `bigint` as text. */
const paymentRowSchema = z.object({ amount_minor: z.union([z.number(), z.string()]), currency: z.string() });

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
    this.campaignRepo = createDunningCampaignRepository(db, {
      dunningCampaigns: tables.dunningCampaigns,
      dunningCampaignAnalytics: tables.dunningCampaignAnalytics,
    });
    this.templateRepo = createDunningTemplateRepository(db, {
      dunningTemplates: tables.dunningTemplates,
    });
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
   * Create a new dunning campaign with templates
   */
  async createCampaign(
    input: CreateDunningCampaignInput,
    createdBy: string,
  ): Promise<DunningCampaign & { templates: DunningTemplate[] }> {
    return this.db.transaction(async tx => {
      // The repositories run on the transaction: a template that fails takes the campaign with it
      const campaignRepo = createDunningCampaignRepository(tx, {
        dunningCampaigns: this.tables.dunningCampaigns,
        dunningCampaignAnalytics: this.tables.dunningCampaignAnalytics,
      });
      const templateRepo = createDunningTemplateRepository(tx, { dunningTemplates: this.tables.dunningTemplates });

      const campaignModel = await campaignRepo.create({
        ...input,
        createdBy,
      });

      if (!campaignModel) {
        throw new Error('Failed to create campaign');
      }

      const templates = [];
      for (const templateInput of input.templates) {
        const template = await templateRepo.create({
          campaignId: campaignModel.id,
          name: templateInput.name,
          stepNumber: templateInput.stepNumber,
          delayHours: templateInput.delayHours,
          communication: templateInput.communication,
        });
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
   * A step that already sent a communication cannot be deleted (the database refuses), so the whole
   * update fails and nothing changes. Omit `templates` to leave the steps alone.
   */
  async updateCampaign(
    campaignId: DunningCampaignId,
    input: UpdateDunningCampaignInput,
    updatedBy: string,
  ): Promise<(DunningCampaign & { templates: DunningTemplate[] }) | null> {
    const { templates: nextTemplates, ...campaignFields } = input;

    return this.db.transaction(async tx => {
      const campaignRepo = createDunningCampaignRepository(tx, {
        dunningCampaigns: this.tables.dunningCampaigns,
        dunningCampaignAnalytics: this.tables.dunningCampaignAnalytics,
      });
      const templateRepo = createDunningTemplateRepository(tx, { dunningTemplates: this.tables.dunningTemplates });

      const campaignModel = await campaignRepo.update(campaignId, { ...campaignFields, updatedBy });
      if (!campaignModel) {
        return null;
      }

      if (nextTemplates) {
        const existing = await templateRepo.findByCampaignId(campaignId);
        const keptSteps = new Set(nextTemplates.map(template => template.stepNumber));

        for (const template of existing) {
          if (!keptSteps.has(template.stepNumber)) await templateRepo.delete(template.id);
        }
        for (const next of nextTemplates) {
          const current = existing.find(template => template.stepNumber === next.stepNumber);
          if (current) {
            await templateRepo.update(current.id, {
              name: next.name,
              delayHours: next.delayHours,
              communication: next.communication,
            });
          } else {
            await templateRepo.create({ campaignId, ...next });
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
  async getCampaign(campaignId: DunningCampaignId) {
    const campaign = await this.campaignRepo.findById(campaignId);
    if (!campaign) return null;

    const templates = await this.templateRepo.findByCampaignId(campaignId);

    return {
      ...campaign,
      templates,
    };
  }

  /**
   * List campaigns with filtering and pagination
   */
  async listCampaigns(query: ListDunningCampaignsQuery) {
    return this.campaignRepo.findMany(query);
  }

  /**
   * Delete a campaign and all related data
   */
  async deleteCampaign(campaignId: DunningCampaignId): Promise<void> {
    await this.campaignRepo.delete(campaignId);
  }

  /**
   * Activate or deactivate a campaign
   */
  async updateCampaignStatus(campaignId: DunningCampaignId, status: DunningCampaignStatus, updatedBy: string) {
    return this.campaignRepo.updateStatus(campaignId, status, updatedBy);
  }

  /**
   * Execute a campaign manually or through automation
   */
  async executeCampaign(input: ExecuteCampaignInput, _executedBy: string): Promise<DunningExecution[]> {
    const campaign = await this.campaignRepo.findById(input.campaignId);
    if (!campaign) {
      throw new Error(`Campaign ${input.campaignId} not found`);
    }

    if (campaign.status !== 'active') {
      throw new Error(`Campaign ${input.campaignId} is not active`);
    }

    // Get campaign templates
    const templates = await this.templateRepo.findActiveTemplates(input.campaignId);
    if (templates.length === 0) {
      throw new Error(`No active templates found for campaign ${input.campaignId}`);
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

    const customers = (result.rows || []) as unknown as CustomerQueryRow[];
    return customers.map(row => ({
      id: row.customer_id as CustomerId,
      subscriptionId: row.subscription_id as SubscriptionId,
      paymentId: row.payment_id as PaymentId,
      triggerData: row.trigger_data,
    }));
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

    const customers = (result.rows || []) as unknown as CustomerQueryRow[];
    return customers.map(row => ({
      id: row.customer_id as CustomerId,
      subscriptionId: row.subscription_id as SubscriptionId,
      paymentId: row.payment_id as PaymentId,
      triggerData: row.trigger_data,
    }));
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

    const customers = (result.rows || []) as unknown as CustomerQueryRow[];
    return customers.map(row => ({
      id: row.customer_id as CustomerId,
      subscriptionId: row.subscription_id as SubscriptionId,
      paymentId: row.payment_id as PaymentId,
      triggerData: row.trigger_data,
    }));
  }

  /**
   * Process scheduled executions
   */
  async processScheduledExecutions(limit = 100): Promise<void> {
    const scheduledExecutions = await this.executionRepo.findScheduledExecutions(limit);

    for (const executionDb of scheduledExecutions) {
      try {
        const execution = executionDb;
        await this.executeIndividualExecution(execution);
      } catch (error) {
        logger.error('Failed to execute campaign', {
          executionId: executionDb.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.executionRepo.updateStatus(
          executionDb.id,
          'failed',
          undefined,
          error instanceof Error ? error.message : 'Unknown error',
        );
      }
    }
  }

  /**
   * Execute a single scheduled execution
   */
  private async executeIndividualExecution(execution: DunningExecution): Promise<void> {
    // Update status to running
    await this.executionRepo.updateStatus(execution.id, 'running');

    // Get campaign and template details
    const campaign = await this.campaignRepo.findById(execution.campaignId);
    const template = execution.templateId ? await this.templateRepo.findById(execution.templateId) : null;

    if (!campaign || !template) {
      throw new Error('Campaign or template not found');
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
      await this.executionRepo.updateStatus(execution.id, 'scheduled', undefined, undefined, nextBusinessHour);

      return;
    }

    // Execute the communication
    const result = await this.executeCommunication(execution, template, campaign);

    // Update execution with result
    await this.executionRepo.updateStatus(execution.id, 'completed', result);

    // Check if payment was successful and stop subsequent executions if configured
    if (campaign.settings.stopOnPaymentSuccess) {
      await this.checkAndStopOnPaymentSuccess(execution);
    }
  }

  /**
   * Execute communication for an execution
   */
  private async executeCommunication(
    execution: DunningExecution,
    template: DunningTemplate,
    campaign: DunningCampaign,
  ) {
    const startTime = Date.now();
    const errors: { customerId: CustomerId; error: string; timestamp: Instant }[] = [];

    try {
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

      if (!row) {
        throw new Error(`Customer ${execution.customerId} not found`);
      }

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
        ...(execution.triggerData as Record<string, string>),
      };

      // Send communication using the correct service interface
      const communicationResult = await communicationService.sendCommunication(
        execution,
        template,
        customer,
        personalizations,
      );

      // Update analytics
      await this.updateCampaignAnalytics(execution.campaignId, {
        customersReached: 1,
        communicationsSent: 1,
      });

      // Check if communication was sent successfully
      const wasSuccessful = communicationResult.status === 'sent' || communicationResult.status === 'pending';

      return {
        customersProcessed: 1,
        communicationsSent: wasSuccessful ? 1 : 0,
        errors: wasSuccessful
          ? []
          : [
              {
                customerId: execution.customerId,
                error: communicationResult.failureReason || 'Communication failed',
                timestamp: now(),
              },
            ],
        performance: {
          processingTime: Date.now() - startTime,
          successRate: wasSuccessful ? 1 : 0,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      errors.push({
        customerId: execution.customerId,
        error: errorMessage,
        timestamp: now(),
      });

      return {
        customersProcessed: 1,
        communicationsSent: 0,
        errors,
        performance: {
          processingTime: Date.now() - startTime,
          successRate: 0,
        },
      };
    }
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
   * Check if payment was successful and stop subsequent executions
   */
  private async checkAndStopOnPaymentSuccess(execution: DunningExecution): Promise<void> {
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
    if (recentSuccessfulPayments.length > 0) {
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
          await this.executionRepo.updateStatus(
            scheduledExec.id,
            'cancelled',
            undefined,
            'Cancelled due to successful payment',
          );
        }
      }

      // Update campaign analytics with successful recovery
      const payment = paymentRowSchema.parse(recentSuccessfulPayments[0]);
      await this.updateCampaignAnalytics(execution.campaignId, {
        paymentsRecovered: 1,
        revenueRecovered: fromMinorColumn(payment.amount_minor, payment.currency),
      });
    }
  }

  /**
   * Update campaign analytics with new metrics
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
  ): Promise<void> {
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

    await this.db
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
      });
  }

  /**
   * Get campaign analytics and performance metrics
   */
  async getCampaignAnalytics(campaignId?: DunningCampaignId, days = 30) {
    return this.campaignRepo.getAnalyticsSummary(campaignId, days);
  }

  /** One page of executions, filtered and sorted as `query` says. */
  async listExecutions(query: ListExecutionsQuery): Promise<DunningExecution[]> {
    return this.executionRepo.findMany(query);
  }

  /**
   * The numbers on the dunning dashboard, all read from the tables: campaign counts, what ran
   * today (since 00:00 UTC), what was recovered today and this month, the conversion rate and
   * the top campaign over the last 30 days, and the latest executions.
   */
  async getDashboardStats(): Promise<DunningDashboardStats> {
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

    const topCampaign = top ? await this.campaignRepo.findById(top.campaignId) : null;
    const topRevenue = top ? await this.campaignRepo.getAnalyticsSince(last30Days, top.campaignId) : null;

    return {
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
      recentExecutions,
    };
  }

  /**
   * Retry failed executions with exponential backoff
   * This method finds executions that are ready to retry (nextRetryAt is in the past)
   * and attempts to execute them again. If they fail again, it schedules the next retry
   * with exponential backoff.
   */
  async retryFailedExecutions(limit = 50): Promise<void> {
    const retryableExecutions = await this.executionRepo.findRetryableExecutions(limit);

    for (const executionDb of retryableExecutions) {
      try {
        // Increment retry count
        await this.executionRepo.incrementRetryCount(executionDb.id);

        // Reset status to running for immediate execution
        await this.executionRepo.updateStatus(executionDb.id, 'running');

        // Execute the retry
        const execution = executionDb;
        await this.executeIndividualExecution(execution);
      } catch (error) {
        logger.error('Retry failed for execution', {
          executionId: executionDb.id,
          error: error instanceof Error ? error.message : String(error),
        });

        // If max retries reached, mark as permanently failed
        if (executionDb.retryCount >= 3) {
          await this.executionRepo.updateStatus(executionDb.id, 'failed', undefined, 'Max retries exceeded');
        } else {
          // Schedule next retry with exponential backoff
          const nextRetry = add(now(), { minutes: Math.pow(2, executionDb.retryCount) * 30 });
          await this.executionRepo.incrementRetryCount(executionDb.id, nextRetry);
        }
      }
    }
  }

  /**
   * Find active campaigns for a specific trigger
   */
  async findActiveCampaignsForTrigger(triggerType: string, customerSegmentIds?: string[]) {
    return this.campaignRepo.findActiveForTrigger(triggerType, customerSegmentIds);
  }
}

export type DunningCampaignServiceTables = Pick<
  DunningTables,
  'dunningCampaigns' | 'dunningCampaignAnalytics' | 'dunningTemplates' | 'dunningExecutions' | 'customerRiskProfiles'
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
