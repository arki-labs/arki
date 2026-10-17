import type { FailureOf, Result } from '@arki/failure';
import type { Money } from '@arki/money';

import type {
  BillingInterval,
  Customer,
  CustomerId,
  Payment,
  PaymentId,
  PaymentMethodInfo,
  PaymentMethodType,
  PaymentProviderType,
  Plan,
  PlanId,
  PlanTier,
  Subscription,
  SubscriptionId,
  SubscriptionPreview,
  SubscriptionStatus,
  WebhookValidationResult,
} from '../types.js';
import type { CardDeclined, IdempotencyConflict, ReferenceNotFound } from './provider-error.js';

type Declined = FailureOf<typeof CardDeclined>;
type Conflict = FailureOf<typeof IdempotencyConflict>;
type NotFound = FailureOf<typeof ReferenceNotFound>;

export type PaymentProviderConfig = {
  apiKey: string;
  webhookSecret: string;
  webhookEndpointSecret?: string;
  publicKey?: string;
  environment: 'sandbox' | 'production';
}

/** What a refund call answers: the provider's refund id, and the payment as the provider now has it. */
export type ProviderRefundResult = {
  providerRefundId: string;
  payment: Payment;
};

export abstract class BasePaymentProvider {
  protected config: PaymentProviderConfig;
  abstract readonly providerType: PaymentProviderType;

  constructor(config: PaymentProviderConfig) {
    this.config = config;
  }

  // Customer Management
  abstract createCustomer(params: {
    userId: string;
    email: string;
    name?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Customer>;

  abstract getCustomer(customerId: CustomerId): Promise<Customer | null>;

  abstract updateCustomer(
    customerId: CustomerId,
    params: {
      email?: string;
      name?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Result<Customer, NotFound>>;

  abstract deleteCustomer(customerId: CustomerId): Promise<Result<undefined, NotFound>>;

  // Plan Management
  abstract createPlan(params: {
    name: string;
    description?: string;
    tier: PlanTier;
    features?: string[];
    amount: Money;
    interval: BillingInterval;
    intervalCount?: number;
    trialPeriodDays?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Plan>;

  /** `null` when the plan has no row; `ReferenceNotFound` when its row has no provider price. */
  abstract getPlan(planId: PlanId): Promise<Result<Plan | null, NotFound>>;

  abstract updatePlan(
    planId: PlanId,
    params: {
      name?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Result<Plan, NotFound>>;

  abstract deletePlan(planId: PlanId): Promise<Result<undefined, NotFound>>;

  abstract listPlans(): Promise<Plan[]>;

  // Subscription Management
  abstract createSubscription(params: {
    customerId: CustomerId;
    planId: PlanId;
    paymentMethodId?: string;
    trialPeriodDays?: number;
    metadata?: Record<string, unknown>;
    /** Same key, same parameters: the provider returns the first result instead of creating a second subscription. */
    idempotencyKey?: string;
  }): Promise<Result<Subscription, Declined | Conflict | NotFound>>;

  abstract getSubscription(subscriptionId: SubscriptionId): Promise<Subscription | null>;

  abstract updateSubscription(
    subscriptionId: SubscriptionId,
    params: {
      planId?: PlanId;
      paymentMethodId?: string;
      metadata?: Record<string, unknown>;
      cancelAtPeriodEnd?: boolean;
      /** What happens to the charge when `planId` changes. The provider's default applies when left out. */
      prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice';
      idempotencyKey?: string;
    },
  ): Promise<Result<Subscription, Declined | Conflict | NotFound>>;

  abstract cancelSubscription(
    subscriptionId: SubscriptionId,
    options: {
      /** True: end it now. Otherwise it stays active until the end of the paid period. */
      immediately?: boolean;
      reason?: string;
      idempotencyKey?: string;
    },
  ): Promise<Result<Subscription, Conflict | NotFound>>;

  abstract reactivateSubscription(subscriptionId: SubscriptionId): Promise<Result<Subscription, NotFound>>;

  abstract pauseSubscription(subscriptionId: SubscriptionId): Promise<Result<Subscription, NotFound>>;

  abstract resumeSubscription(subscriptionId: SubscriptionId): Promise<Result<Subscription, NotFound>>;

  abstract previewSubscriptionChange(params: {
    subscriptionId: SubscriptionId;
    planId: PlanId;
    prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice';
  }): Promise<Result<SubscriptionPreview, NotFound>>;

  // Payment Management
  abstract createPayment(params: {
    customerId: CustomerId;
    amount: Money;
    paymentMethodId: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Result<Payment, Declined | NotFound>>;

  abstract getPayment(paymentId: PaymentId): Promise<Payment | null>;

  abstract confirmPayment(paymentId: PaymentId): Promise<Result<Payment, Declined | NotFound>>;

  abstract cancelPayment(paymentId: PaymentId): Promise<Result<Payment, NotFound>>;

  abstract refundPayment(
    paymentId: PaymentId,
    params: {
      /** Left out: the whole payment. */
      amount?: Money;
      reason?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Result<ProviderRefundResult, NotFound>>;

  // Payment Methods
  abstract attachPaymentMethod(params: {
    customerId: CustomerId;
    paymentMethodId: string;
  }): Promise<Result<PaymentMethodInfo, Declined | NotFound>>;

  abstract detachPaymentMethod(paymentMethodId: string): Promise<void>;

  abstract listPaymentMethods(customerId: CustomerId): Promise<Result<PaymentMethodInfo[], NotFound>>;

  abstract setDefaultPaymentMethod(params: {
    customerId: CustomerId;
    paymentMethodId: string;
  }): Promise<Result<undefined, NotFound>>;

  // Webhook Validation
  abstract validateWebhook(
    payload: string | Buffer,
    signature: string,
    timestamp: string,
    sourceIp: string,
  ): Promise<WebhookValidationResult>;

  // Utility Methods
  abstract createSetupIntent(
    customerId: CustomerId,
    options?: { idempotencyKey?: string },
  ): Promise<
    Result<
      {
        clientSecret: string;
        setupIntentId: string;
      },
      Conflict | NotFound
    >
  >;

  abstract createPaymentIntent(params: {
    customerId: CustomerId;
    amount: Money;
    paymentMethodId?: string;
    /**
     * True: charge now without the customer present. Needs `paymentMethodId`.
     * False: the customer finishes the payment in the client with the returned secret.
     */
    automatic: boolean;
    idempotencyKey?: string;
  }): Promise<
    Result<
      {
        clientSecret: string;
        paymentIntentId: string;
      },
      Declined | Conflict | NotFound
    >
  >;

  // Health Check
  abstract healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; details?: string }>;

  // Helper Methods
  protected mapSubscriptionStatus(providerStatus: string): SubscriptionStatus {
    // Default implementation - providers can override
    switch (providerStatus.toLowerCase()) {
      case 'active': {
        return 'active';
      }
      case 'canceled':
      case 'cancelled': {
        return 'canceled';
      }
      case 'incomplete': {
        return 'incomplete';
      }
      case 'incomplete_expired': {
        return 'incomplete_expired';
      }
      case 'past_due': {
        return 'past_due';
      }
      case 'paused': {
        return 'paused';
      }
      case 'trialing': {
        return 'trialing';
      }
      case 'unpaid': {
        return 'unpaid';
      }
      default: {
        return 'incomplete';
      }
    }
  }

  protected mapPaymentMethodType(providerType: string): PaymentMethodType {
    // Default implementation - providers can override
    switch (providerType.toLowerCase()) {
      case 'card': {
        return 'card';
      }
      case 'bank_account':
      case 'us_bank_account': {
        return 'bank_account';
      }
      case 'paypal': {
        return 'paypal';
      }
      case 'apple_pay': {
        return 'apple_pay';
      }
      case 'google_pay': {
        return 'google_pay';
      }
      default: {
        return 'card';
      }
    }
  }
}