import { createIdFactory } from '@arki/db/id-factory';

export type DunningCampaignId = `dc_${string}`;
export type DunningTemplateId = `dt_${string}`;
export type DunningExecutionId = `de_${string}`;
export type DunningCommunicationId = `dcm_${string}`;
export type CustomerSegmentId = `cs_${string}`;
export type CustomerRiskProfileId = `crp_${string}`;

const dunningCampaignId = createIdFactory<'dc', DunningCampaignId>('dc');
const dunningTemplateId = createIdFactory<'dt', DunningTemplateId>('dt');
const dunningExecutionId = createIdFactory<'de', DunningExecutionId>('de');
const dunningCommunicationId = createIdFactory<'dcm', DunningCommunicationId>('dcm');
const customerSegmentId = createIdFactory<'cs', CustomerSegmentId>('cs');
const customerRiskProfileId = createIdFactory<'crp', CustomerRiskProfileId>('crp');

export const createDunningCampaignId = dunningCampaignId.create;
export const createDunningTemplateId = dunningTemplateId.create;
export const createDunningExecutionId = dunningExecutionId.create;
export const createDunningCommunicationId = dunningCommunicationId.create;
export const createCustomerSegmentId = customerSegmentId.create;
export const createCustomerRiskProfileId = customerRiskProfileId.create;

export const dunningCampaignIdSchema = dunningCampaignId.schema;
export const dunningTemplateIdSchema = dunningTemplateId.schema;
export const dunningExecutionIdSchema = dunningExecutionId.schema;
export const dunningCommunicationIdSchema = dunningCommunicationId.schema;
export const customerSegmentIdSchema = customerSegmentId.schema;
export const customerRiskProfileIdSchema = customerRiskProfileId.schema;

export const dunningCampaignIdFactory = dunningCampaignId;
export const dunningTemplateIdFactory = dunningTemplateId;
export const dunningExecutionIdFactory = dunningExecutionId;
export const dunningCommunicationIdFactory = dunningCommunicationId;
export const customerSegmentIdFactory = customerSegmentId;
export const customerRiskProfileIdFactory = customerRiskProfileId;

export const dunningCampaignTypeValues = ['payment_failed', 'subscription_past_due', 'trial_ending', 'renewal_reminder'] as const;
export const dunningCampaignStatusValues = ['active', 'paused', 'archived', 'draft'] as const;
export const communicationChannelValues = ['email', 'sms', 'in_app', 'webhook'] as const;
export const communicationStatusValues = ['pending', 'sent', 'delivered', 'opened', 'clicked', 'failed', 'bounced'] as const;
export const executionStatusValues = ['scheduled', 'running', 'completed', 'failed', 'cancelled'] as const;
export const customerSegmentTypeValues = ['value_based', 'behavior_based', 'demographic', 'risk_based', 'custom'] as const;
export const riskCategoryValues = ['low', 'medium', 'high', 'critical'] as const;

export type DunningCampaignType = (typeof dunningCampaignTypeValues)[number];
export type DunningCampaignStatus = (typeof dunningCampaignStatusValues)[number];
export type CommunicationChannel = (typeof communicationChannelValues)[number];
export type CommunicationStatus = (typeof communicationStatusValues)[number];
export type ExecutionStatus = (typeof executionStatusValues)[number];
export type CustomerSegmentType = (typeof customerSegmentTypeValues)[number];
export type RiskCategory = (typeof riskCategoryValues)[number];
