import type { PgColumn, PgSchema } from 'drizzle-orm/pg-core';
import { boolean, integer, jsonb, real, text, timestamp, varchar } from 'drizzle-orm/pg-core';

import type {
  CommunicationChannel,
  CommunicationStatus,
  CustomerSegmentType,
  DunningCampaignStatus,
  DunningCampaignType,
  ExecutionStatus,
} from './primitives';
import type { SpendRange } from './types';
import { customerIdFactory, paymentIdFactory, subscriptionIdFactory } from '../core/primitives';
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
} from './primitives';

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    result: jsonb('result').$type<ExecutionResultJson>(),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    clickedAt: timestamp('clicked_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    providerMessageId: varchar('provider_message_id', { length: 255 }),
    providerResponse: jsonb('provider_response').$type<Record<string, unknown>>(),
    trackingData: jsonb('tracking_data').$type<Record<string, unknown>>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
    lastCalculated: timestamp('last_calculated', { withTimezone: true }),
    autoUpdate: boolean('auto_update').notNull().default(true),
    updateFrequency: integer('update_frequency').default(24),
    createdBy: text('created_by').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
        lastCalculated: Date;
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
        lastPaymentDate?: Date;
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
        lastActivity?: Date;
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  });

  const dunningCampaignAnalytics = schema.table('dunning_campaign_analytics', {
    id: varchar('id', { length: 255 }).primaryKey(),
    campaignId: dunningCampaignIdFactory.foreignKey('campaign_id', () => dunningCampaigns.id, { onDelete: 'cascade' }),
    date: timestamp('date', { withTimezone: true }).notNull(),
    executions: integer('executions').notNull().default(0),
    customersReached: integer('customers_reached').notNull().default(0),
    communicationsSent: integer('communications_sent').notNull().default(0),
    emailsSent: integer('emails_sent').notNull().default(0),
    emailsOpened: integer('emails_opened').notNull().default(0),
    emailsClicked: integer('emails_clicked').notNull().default(0),
    smsSent: integer('sms_sent').notNull().default(0),
    smsDelivered: integer('sms_delivered').notNull().default(0),
    paymentsRecovered: integer('payments_recovered').notNull().default(0),
    revenueRecovered: real('revenue_recovered').notNull().default(0),
    unsubscribes: integer('unsubscribes').notNull().default(0),
    complaints: integer('complaints').notNull().default(0),
    communicationCosts: real('communication_costs').notNull().default(0),
    processingCosts: real('processing_costs').notNull().default(0),
    conversionRate: real('conversion_rate').notNull().default(0),
    roi: real('roi').notNull().default(0),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  });

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
