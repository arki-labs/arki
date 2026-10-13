import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

import type {
  BillingInterval,
  CustomerId,
  PaymentId,
  PaymentMethodType,
  PaymentProviderId,
  PaymentProviderType,
  PaymentStatus,
  PlanId,
  PlanTier,
  SubscriptionId,
  SubscriptionStatus,
  WebhookEventType,
  WebhookId,
} from './primitives.js';
import type { CoreTables } from './tables.js';

export type {
  BillingInterval,
  CustomerId,
  PaymentId,
  PaymentMethodType,
  PaymentProviderId,
  PaymentProviderType,
  PaymentStatus,
  PlanId,
  PlanTier,
  SubscriptionId,
  SubscriptionStatus,
  WebhookEventType,
  WebhookId,
};
export type { PaymentMethodInfo, SubscriptionPreview } from './contracts.js';

export type Plan = InferSelectModel<CoreTables['plans']>;
export type NewPlan = InferInsertModel<CoreTables['plans']>;
export type UpdatePlan = Partial<Omit<NewPlan, 'id' | 'createdAt' | 'updatedAt'>>;

export type Customer = InferSelectModel<CoreTables['customers']>;
export type NewCustomer = InferInsertModel<CoreTables['customers']>;
export type UpdateCustomer = Partial<Omit<NewCustomer, 'id' | 'createdAt' | 'updatedAt'>>;

// `version` belongs to the journal: rows leave the package without it, and no caller sets it
export type Subscription = Omit<InferSelectModel<CoreTables['subscriptions']>, 'version'>;
export type NewSubscription = Omit<InferInsertModel<CoreTables['subscriptions']>, 'version'>;
export type UpdateSubscription = Partial<Omit<NewSubscription, 'id' | 'createdAt' | 'updatedAt'>>;

export type SubscriptionWithPlan = Subscription & {
  plan: Plan;
  customer?: Customer;
};

export type SubscriptionWithRelations = Subscription & {
  plan?: Plan;
  customer?: Customer;
};

export type Payment = Omit<InferSelectModel<CoreTables['payments']>, 'version'>;
export type NewPayment = Omit<InferInsertModel<CoreTables['payments']>, 'version'>;
export type UpdatePayment = Partial<Omit<NewPayment, 'id' | 'createdAt' | 'updatedAt'>>;

export type PaymentWithRelations = Payment & {
  subscription?: SubscriptionWithRelations;
  customer?: Customer;
};

export type WebhookEvent = InferSelectModel<CoreTables['webhookEvents']>;
export type NewWebhookEvent = InferInsertModel<CoreTables['webhookEvents']>;
export type UpdateWebhookEvent = Partial<Omit<NewWebhookEvent, 'id' | 'createdAt' | 'updatedAt'>>;

export type WebhookValidationResult = {
  isValid: boolean;
  provider: PaymentProviderType;
  eventType?: WebhookEventType;
  error?: string;
  data?: Record<string, unknown>;
};
