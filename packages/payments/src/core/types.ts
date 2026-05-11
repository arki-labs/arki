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
} from './primitives';
import type { CoreTables } from './tables';

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
export type { PaymentMethodInfo, SubscriptionPreview } from './contracts';

export type Plan = InferSelectModel<CoreTables['plans']>;
export type NewPlan = InferInsertModel<CoreTables['plans']>;
export type UpdatePlan = Partial<Omit<NewPlan, 'id' | 'createdAt' | 'updatedAt'>>;

export type Customer = InferSelectModel<CoreTables['customers']>;
export type NewCustomer = InferInsertModel<CoreTables['customers']>;
export type UpdateCustomer = Partial<Omit<NewCustomer, 'id' | 'createdAt' | 'updatedAt'>>;

export type Subscription = InferSelectModel<CoreTables['subscriptions']>;
export type NewSubscription = InferInsertModel<CoreTables['subscriptions']>;
export type UpdateSubscription = Partial<Omit<NewSubscription, 'id' | 'createdAt' | 'updatedAt'>>;

export type SubscriptionWithPlan = Subscription & {
  plan: Plan;
  customer?: Customer;
};

export type SubscriptionWithRelations = Subscription & {
  plan?: Plan;
  customer?: Customer;
};

export type Payment = InferSelectModel<CoreTables['payments']>;
export type NewPayment = InferInsertModel<CoreTables['payments']>;
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
