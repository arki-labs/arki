import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';

import { boundedIdSchema } from '../core/id-length.js';

export type DunningCampaignId = IdOf<typeof dunningCampaignId>;
export type DunningTemplateId = IdOf<typeof dunningTemplateId>;
export type DunningExecutionId = IdOf<typeof dunningExecutionId>;
export type DunningCommunicationId = IdOf<typeof dunningCommunicationId>;
export type CustomerSegmentId = IdOf<typeof customerSegmentId>;
export type CustomerRiskProfileId = IdOf<typeof customerRiskProfileId>;

const dunningCampaignId = defineId('dc');
const dunningTemplateId = defineId('dt');
const dunningExecutionId = defineId('de');
const dunningCommunicationId = defineId('dcm');
const customerSegmentId = defineId('cs');
const customerRiskProfileId = defineId('crp');

export const createDunningCampaignId = dunningCampaignId.create;
export const createDunningTemplateId = dunningTemplateId.create;
export const createDunningExecutionId = dunningExecutionId.create;
export const createDunningCommunicationId = dunningCommunicationId.create;
export const createCustomerSegmentId = customerSegmentId.create;
export const createCustomerRiskProfileId = customerRiskProfileId.create;

export const dunningCampaignIdSchema = boundedIdSchema(dunningCampaignId.schema);
export const dunningTemplateIdSchema = boundedIdSchema(dunningTemplateId.schema);
export const dunningExecutionIdSchema = boundedIdSchema(dunningExecutionId.schema);
export const dunningCommunicationIdSchema = boundedIdSchema(dunningCommunicationId.schema);
export const customerSegmentIdSchema = boundedIdSchema(customerSegmentId.schema);
export const customerRiskProfileIdSchema = boundedIdSchema(customerRiskProfileId.schema);

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
