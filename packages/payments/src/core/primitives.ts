import { createIdFactory } from '@arki/db/id-factory';

export type PaymentProviderId = `pprov_${string}`;
export type SubscriptionId = `sub_${string}`;
export type PaymentId = `pay_${string}`;
export type PlanId = `plan_${string}`;
export type CustomerId = `cust_${string}`;
export type WebhookId = `wh_${string}`;

const planId = createIdFactory<'plan', PlanId>('plan');
const subscriptionId = createIdFactory<'sub', SubscriptionId>('sub');
const paymentId = createIdFactory<'pay', PaymentId>('pay');
const customerId = createIdFactory<'cust', CustomerId>('cust');
const webhookId = createIdFactory<'wh', WebhookId>('wh');

export const createPlanId = planId.create;
export const createSubscriptionId = subscriptionId.create;
export const createPaymentId = paymentId.create;
export const createCustomerId = customerId.create;
export const createWebhookId = webhookId.create;

export const planIdSchema = planId.schema;
export const subscriptionIdSchema = subscriptionId.schema;
export const paymentIdSchema = paymentId.schema;
export const customerIdSchema = customerId.schema;
export const webhookIdSchema = webhookId.schema;

export const planIdFactory = planId;
export const subscriptionIdFactory = subscriptionId;
export const paymentIdFactory = paymentId;
export const customerIdFactory = customerId;
export const webhookIdFactory = webhookId;

export const paymentProviderValues = ['stripe', 'paypal', 'square', 'razorpay', 'revenuecat'] as const;

export const subscriptionStatusValues = [
  'active',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'past_due',
  'paused',
  'trialing',
  'unpaid',
] as const;

export const paymentStatusValues = [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'canceled',
  'requires_action',
] as const;

export const billingIntervalValues = ['monthly', 'yearly', 'weekly', 'daily'] as const;

export const planTierValues = ['basic', 'premium', 'pro', 'enterprise'] as const;

export const paymentMethodTypeValues = ['card', 'bank_account', 'paypal', 'apple_pay', 'google_pay'] as const;

export type PaymentProviderType = (typeof paymentProviderValues)[number];
export type SubscriptionStatus = (typeof subscriptionStatusValues)[number];
export type PaymentStatus = (typeof paymentStatusValues)[number];
export type BillingInterval = (typeof billingIntervalValues)[number];
export type PlanTier = (typeof planTierValues)[number];
export type PaymentMethodType = (typeof paymentMethodTypeValues)[number];

export const webhookEventTypeValues = [
  'subscription.created',
  'subscription.updated',
  'subscription.canceled',
  'subscription.trial_will_end',
  'payment.succeeded',
  'payment.failed',
  'payment.requires_action',
  'customer.created',
  'customer.updated',
  'customer.deleted',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

export type WebhookEventType = (typeof webhookEventTypeValues)[number];
