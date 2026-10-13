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
  Subscription,
  SubscriptionId,
  SubscriptionPreview,
  SubscriptionStatus,
  WebhookValidationResult,
} from '../types.js';

export type PaymentProviderConfig = {
  apiKey: string;
  webhookSecret: string;
  webhookEndpointSecret?: string;
  publicKey?: string;
  environment: 'sandbox' | 'production';
}

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
  ): Promise<Customer>;

  abstract deleteCustomer(customerId: CustomerId): Promise<void>;

  // Plan Management
  abstract createPlan(params: {
    name: string;
    amount: Money;
    interval: BillingInterval;
    intervalCount?: number;
    trialPeriodDays?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Plan>;

  abstract getPlan(planId: PlanId): Promise<Plan | null>;

  abstract updatePlan(
    planId: PlanId,
    params: {
      name?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Plan>;

  abstract deletePlan(planId: PlanId): Promise<void>;

  abstract listPlans(): Promise<Plan[]>;

  // Subscription Management
  abstract createSubscription(params: {
    customerId: CustomerId;
    planId: PlanId;
    paymentMethodId?: string;
    trialPeriodDays?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Subscription>;

  abstract getSubscription(subscriptionId: SubscriptionId): Promise<Subscription | null>;

  abstract updateSubscription(
    subscriptionId: SubscriptionId,
    params: {
      planId?: PlanId;
      paymentMethodId?: string;
      metadata?: Record<string, unknown>;
      cancelAtPeriodEnd?: boolean;
    },
  ): Promise<Subscription>;

  abstract cancelSubscription(
    subscriptionId: SubscriptionId,
    options: {
      immediately?: boolean;
      reason?: string;
    },
  ): Promise<Subscription>;

  abstract reactivateSubscription(subscriptionId: SubscriptionId): Promise<Subscription>;

  abstract pauseSubscription(subscriptionId: SubscriptionId): Promise<Subscription>;

  abstract resumeSubscription(subscriptionId: SubscriptionId): Promise<Subscription>;

  abstract previewSubscriptionChange(params: {
    subscriptionId: SubscriptionId;
    planId: PlanId;
    prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice';
  }): Promise<SubscriptionPreview>;

  // Payment Management
  abstract createPayment(params: {
    customerId: CustomerId;
    amount: Money;
    paymentMethodId: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Payment>;

  abstract getPayment(paymentId: PaymentId): Promise<Payment | null>;

  abstract confirmPayment(paymentId: PaymentId): Promise<Payment>;

  abstract cancelPayment(paymentId: PaymentId): Promise<Payment>;

  abstract refundPayment(
    paymentId: PaymentId,
    params: {
      /** Left out: the whole payment. */
      amount?: Money;
      reason?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Payment>;

  // Payment Methods
  abstract attachPaymentMethod(params: {
    customerId: CustomerId;
    paymentMethodId: string;
  }): Promise<PaymentMethodInfo>;

  abstract detachPaymentMethod(paymentMethodId: string): Promise<void>;

  abstract listPaymentMethods(customerId: CustomerId): Promise<PaymentMethodInfo[]>;

  abstract setDefaultPaymentMethod(params: {
    customerId: CustomerId;
    paymentMethodId: string;
  }): Promise<void>;

  // Webhook Validation
  abstract validateWebhook(
    payload: string | Buffer,
    signature: string,
    timestamp: string,
    sourceIp: string,
  ): Promise<WebhookValidationResult>;

  // Utility Methods
  abstract createSetupIntent(customerId: CustomerId): Promise<{
    clientSecret: string;
    setupIntentId: string;
  }>;

  abstract createPaymentIntent(params: {
    customerId: CustomerId;
    amount: Money;
    paymentMethodId?: string;
    automatic: boolean;
  }): Promise<{
    clientSecret: string;
    paymentIntentId: string;
  }>;

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