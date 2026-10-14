import type { PgColumn, PgSchema } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, integer, jsonb, real, text, varchar } from 'drizzle-orm/pg-core';

import type { Instant } from '@arki/date';
import { instant } from '@arki/db/temporal';

import type {
  CommunicationChannel,
  CommunicationStatus,
  CustomerSegmentType,
  DunningCampaignStatus,
  DunningCampaignType,
  ExecutionStatus,
} from './primitives.js';
import type { SpendRange } from './types.js';
import { customerIdFactory, paymentIdFactory, subscriptionIdFactory } from '../core/primitives.js';
import {
  communicationChannelValues,
  communicationStatusValues,
  customerRiskProfileIdFactory,
  customerSegmentIdFactory,
  customerSegmentTypeValues,
  dunningCampaignIdFactory,
  dunningCampaignStatusValues,
  dunningCampaignTypeValues,
  dunningCommunicationIdFactory,
  dunningExecutionIdFactory,
  dunningTemplateIdFactory,
  executionStatusValues,
  riskCategoryValues,
} from './primitives.js';

export type CreateDunningTablesDeps = {
  schema: PgSchema;
  /** `() => customers.id` from the host app's payments-core tables. */
  customerIdRef: () => PgColumn;
  /** `() => payments.id` from the host app's payments-core tables. */
  paymentIdRef: () => PgColumn;
  /** `() => subscriptions.id` from the host app's payments-core tables. */
  subscriptionIdRef: () => PgColumn;
};

/**
 * The host app keeps the `result` JSON column free-form because the domain
 * shape (`ExecutionResultDb`) lives in `types.ts` which couples back to
 * tables for `InferSelectModel`. We type the column as `Record<string, unknown>`
 * here; the host can re-tag via `$type<ExecutionResultDb>()` after assembly
 * if it needs stricter typing in queries.
 */
type ExecutionResultJson = Record<string, unknown>;

export function createDunningTables({
  schema,
  customerIdRef,
  paymentIdRef,
  subscriptionIdRef,
}: CreateDunningTablesDeps) {
  const customerFk = customerIdFactory.createForeignKeyFactory(customerIdRef);
  const paymentFk = paymentIdFactory.createForeignKeyFactory(paymentIdRef);
  const subscriptionFk = subscriptionIdFactory.createForeignKeyFactory(subscriptionIdRef);

  const dunningCampaignTypeEnum = schema.enum('dunning_campaign_type', dunningCampaignTypeValues);
  const dunningCampaignStatusEnum = schema.enum('dunning_campaign_status', dunningCampaignStatusValues);
  const communicationChannelEnum = schema.enum('communication_channel', communicationChannelValues);
  const communicationStatusEnum = schema.enum('communication_status', communicationStatusValues);
  const executionStatusEnum = schema.enum('execution_status', executionStatusValues);
  const customerSegmentTypeEnum = schema.enum('customer_segment_type', customerSegmentTypeValues);
  const riskCategoryEnum = schema.enum('risk_category', riskCategoryValues);

  const dunningCampaigns = schema.table('dunning_campaigns', {
    id: dunningCampaignIdFactory.primaryColumn(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    type: dunningCampaignTypeEnum('type').$type<DunningCampaignType>().notNull(),
    status: dunningCampaignStatusEnum('status').$type<DunningCampaignStatus>().notNull().default('draft'),
    trigger: jsonb('trigger')
      .$type<{
        type: 'payment_failure' | 'subscription_status' | 'time_based' | 'manual';
        conditions: {
          paymentFailureCount?: number;
          subscriptionStatus?: string[];
          daysSinceLastPayment?: number;
          daysSinceFailure?: number;
          trialEndingDays?: number;
          renewalReminderDays?: number;
        };
        filters?: {
          customerSegments?: string[];
          planTiers?: string[];
          subscriptionAge?: { min?: number; max?: number };
          totalSpent?: SpendRange;
        };
      }>()
      .notNull(),
    settings: jsonb('settings')
      .$type<{
        enabled: boolean;
        priority: number;
        cooldownPeriod: number;
        maxExecutionsPerCustomer: number;
        stopOnPaymentSuccess: boolean;
        respectUnsubscribe: boolean;
        businessHoursOnly: boolean;
        timezone?: string;
        allowedDays?: number[];
        abTestVariant?: string;
      }>()
      .notNull(),
    targetSegments: jsonb('target_segments').$type<string[]>().notNull().default([]),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: instant('created_at').notNull().default(sql`now()`),
    updatedAt: instant('updated_at').notNull().default(sql`now()`),
  });

  const dunningTemplates = schema.table('dunning_templates', {
    id: dunningTemplateIdFactory.primaryColumn(),
    campaignId: dunningCampaignIdFactory.foreignKey('campaign_id', () => dunningCampaigns.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    stepNumber: integer('step_number').notNull(),
    delayHours: integer('delay_hours').notNull().default(0),
    communication: jsonb('communication')
      .$type<{
        channel: 'email' | 'sms' | 'in_app' | 'webhook';
        subject?: string;
        content: string;
        variables: string[];
        design?: {
          theme?: string;
          brandColors?: Record<string, string>;
          logoUrl?: string;
        };
      }>()
      .notNull(),
    isActive: boolean('is_active').notNull().default(true),
    abTestVariant: varchar('ab_test_variant', { length: 50 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: instant('created_at').notNull().default(sql`now()`),
    updatedAt: instant('updated_at').notNull().default(sql`now()`),
  });

  const dunningExecutions = schema.table('dunning_executions', {
    id: dunningExecutionIdFactory.primaryColumn(),
    campaignId: dunningCampaignIdFactory.foreignKey('campaign_id', () => dunningCampaigns.id, { onDelete: 'cascade' }),
    templateId: dunningTemplateIdFactory.optionalForeignKey('template_id', () => dunningTemplates.id, {
      onDelete: 'set null',
    }),
    customerId: customerFk.required('customer_id', { onDelete: 'cascade' }),
    subscriptionId: subscriptionFk.optional('subscription_id', { onDelete: 'set null' }),
    paymentId: paymentFk.optional('payment_id', { onDelete: 'set null' }),
    triggerType: varchar('trigger_type', { length: 100 }).notNull(),
    triggerData: jsonb('trigger_data').$type<Record<string, unknown>>().notNull(),
    status: executionStatusEnum('status').$type<ExecutionStatus>().notNull().default('scheduled'),
    scheduledAt: instant('scheduled_at').notNull(),
    startedAt: instant('started_at'),
    completedAt: instant('completed_at'),
    result: jsonb('result').$type<ExecutionResultJson>(),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    nextRetryAt: instant('next_retry_at'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: instant('created_at').notNull().default(sql`now()`),
    updatedAt: instant('updated_at').notNull().default(sql`now()`),
  });

  const dunningCommunications = schema.table('dunning_communications', {
    id: dunningCommunicationIdFactory.primaryColumn(),
    executionId: dunningExecutionIdFactory.foreignKey('execution_id', () => dunningExecutions.id, {
      onDelete: 'cascade',
    }),
    customerId: customerFk.required('customer_id', { onDelete: 'cascade' }),
    templateId: dunningTemplateIdFactory.foreignKey('template_id', () => dunningTemplates.id, { onDelete: 'restrict' }),
    channel: communicationChannelEnum('channel').$type<CommunicationChannel>().notNull(),
    recipient: varchar('recipient', { length: 255 }).notNull(),
    subject: varchar('subject', { length: 500 }),
    content: text('content').notNull(),
    status: communicationStatusEnum('status').$type<CommunicationStatus>().notNull().default('pending'),
    sentAt: instant('sent_at'),
    deliveredAt: instant('delivered_at'),
    openedAt: instant('opened_at'),
    clickedAt: instant('clicked_at'),
    failureReason: text('failure_reason'),
    providerMessageId: varchar('provider_message_id', { length: 255 }),
    providerResponse: jsonb('provider_response').$type<Record<string, unknown>>(),
    trackingData: jsonb('tracking_data').$type<Record<string, unknown>>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: instant('created_at').notNull().default(sql`now()`),
    updatedAt: instant('updated_at').notNull().default(sql`now()`),
  });

  const customerSegments = schema.table('customer_segments', {
    id: customerSegmentIdFactory.primaryColumn(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    type: customerSegmentTypeEnum('type').$type<CustomerSegmentType>().notNull(),
    criteria: jsonb('criteria')
      .$type<{
        totalSpent?: SpendRange;
        subscriptionDuration?: { min?: number; max?: number };
        paymentFailureHistory?: { count: number; timeframe: number };
        planTier?: string[];
        lastPaymentDate?: { daysAgo: number };
        lifetimeValue?: { min?: number; max?: number };
        churnRisk?: 'low' | 'medium' | 'high';
        engagementScore?: { min?: number; max?: number };
        customAttributes?: Record<string, unknown>;
      }>()
      .notNull(),
    isActive: boolean('is_active').notNull().default(true),
    customerCount: integer('customer_count').default(0),
    lastCalculated: instant('last_calculated'),
    autoUpdate: boolean('auto_update').notNull().default(true),
    updateFrequency: integer('update_frequency').default(24),
    createdBy: text('created_by').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: instant('created_at').notNull().default(sql`now()`),
    updatedAt: instant('updated_at').notNull().default(sql`now()`),
  });

  const customerRiskProfiles = schema.table('customer_risk_profiles', {
    id: customerRiskProfileIdFactory.primaryColumn(),
    customerId: customerFk.required('customer_id', { onDelete: 'cascade' }),
    segmentIds: jsonb('segment_ids').$type<string[]>().notNull().default([]),
    riskScore: jsonb('risk_score')
      .$type<{
        overall: number;
        factors: Record<string, number>;
        category: 'low' | 'medium' | 'high' | 'critical';
        lastCalculated: Instant;
        trends: {
          direction: 'improving' | 'stable' | 'declining';
          changePercent: number;
          timeframe: number;
        };
      }>()
      .notNull(),
    paymentHistory: jsonb('payment_history')
      .$type<{
        totalPayments: number;
        successfulPayments: number;
        failedPayments: number;
        averageAmount: number;
        /** ISO currency code `averageAmount` is in; absent when the customer has no payments. */
        currency?: string;
        lastPaymentDate?: Instant;
        streakDays: number;
      }>()
      .notNull(),
    subscriptionHistory: jsonb('subscription_history')
      .$type<{
        totalSubscriptions: number;
        activeSubscriptions: number;
        canceledSubscriptions: number;
        averageDuration: number;
        currentStatus?: string;
      }>()
      .notNull(),
    engagementMetrics: jsonb('engagement_metrics')
      .$type<{
        score: number;
        lastActivity?: Instant;
        activityFrequency: number;
        featureUsage: Record<string, number>;
      }>()
      .notNull(),
    communicationPreferences: jsonb('communication_preferences')
      .$type<{
        preferredChannel?: 'email' | 'sms' | 'in_app' | 'webhook';
        unsubscribed: boolean;
        unsubscribedChannels: ('email' | 'sms' | 'in_app' | 'webhook')[];
        timezone?: string;
        language?: string;
      }>()
      .notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: instant('created_at').notNull().default(sql`now()`),
    updatedAt: instant('updated_at').notNull().default(sql`now()`),
  });

  const dunningCampaignAnalytics = schema.table('dunning_campaign_analytics', {
    id: varchar('id', { length: 255 }).primaryKey(),
    campaignId: dunningCampaignIdFactory.foreignKey('campaign_id', () => dunningCampaigns.id, { onDelete: 'cascade' }),
    date: instant('date').notNull(),
    executions: integer('executions').notNull().default(0),
    customersReached: integer('customers_reached').notNull().default(0),
    communicationsSent: integer('communications_sent').notNull().default(0),
    emailsSent: integer('emails_sent').notNull().default(0),
    emailsOpened: integer('emails_opened').notNull().default(0),
    emailsClicked: integer('emails_clicked').notNull().default(0),
    smsSent: integer('sms_sent').notNull().default(0),
    smsDelivered: integer('sms_delivered').notNull().default(0),
    paymentsRecovered: integer('payments_recovered').notNull().default(0),
    /** Money of one currency per row: `currency` names the unit of the three `*Minor` columns. Read and write through `core/money.ts`. */
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    revenueRecoveredMinor: bigint('revenue_recovered_minor', { mode: 'number' }).notNull().default(0),
    unsubscribes: integer('unsubscribes').notNull().default(0),
    complaints: integer('complaints').notNull().default(0),
    communicationCostsMinor: bigint('communication_costs_minor', { mode: 'number' }).notNull().default(0),
    processingCostsMinor: bigint('processing_costs_minor', { mode: 'number' }).notNull().default(0),
    conversionRate: real('conversion_rate').notNull().default(0),
    roi: real('roi').notNull().default(0),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: instant('created_at').notNull().default(sql`now()`),
    updatedAt: instant('updated_at').notNull().default(sql`now()`),
  }, (_table) => [
    check('dunning_analytics_revenue_recovered_minor_not_negative', sql`"revenue_recovered_minor" >= 0`),
    check('dunning_analytics_communication_costs_minor_not_negative', sql`"communication_costs_minor" >= 0`),
    check('dunning_analytics_processing_costs_minor_not_negative', sql`"processing_costs_minor" >= 0`),
  ]);

  const dunningCampaignForeignKeys = dunningCampaignIdFactory.createForeignKeyFactory(() => dunningCampaigns.id);
  const dunningTemplateForeignKeys = dunningTemplateIdFactory.createForeignKeyFactory(() => dunningTemplates.id);
  const dunningExecutionForeignKeys = dunningExecutionIdFactory.createForeignKeyFactory(() => dunningExecutions.id);
  const dunningCommunicationForeignKeys = dunningCommunicationIdFactory.createForeignKeyFactory(
    () => dunningCommunications.id,
  );
  const customerSegmentForeignKeys = customerSegmentIdFactory.createForeignKeyFactory(() => customerSegments.id);
  const customerRiskProfileForeignKeys = customerRiskProfileIdFactory.createForeignKeyFactory(
    () => customerRiskProfiles.id,
  );

  return {
    enums: {
      dunningCampaignTypeEnum,
      dunningCampaignStatusEnum,
      communicationChannelEnum,
      communicationStatusEnum,
      executionStatusEnum,
      customerSegmentTypeEnum,
      riskCategoryEnum,
    },
    dunningCampaigns,
    dunningTemplates,
    dunningExecutions,
    dunningCommunications,
    customerSegments,
    customerRiskProfiles,
    dunningCampaignAnalytics,
    foreignKeys: {
      dunningCampaignForeignKeys,
      dunningTemplateForeignKeys,
      dunningExecutionForeignKeys,
      dunningCommunicationForeignKeys,
      customerSegmentForeignKeys,
      customerRiskProfileForeignKeys,
    },
  };
}

export type DunningTables = ReturnType<typeof createDunningTables>;
