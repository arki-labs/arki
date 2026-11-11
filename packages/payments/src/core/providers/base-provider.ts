import type { IdGenerationFailure } from '@arki/contracts';
import type { FailureOf, Result, SchemaFailure } from '@arki/failure';
import type { Money, MoneyFailure } from '@arki/money';

import type { RefundId } from '../../refunds/primitives.js';
import type { PaymentsConfigurationInvalid } from '../failures.js';
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
import type {
  CardDeclined,
  IdempotencyConflict,
  PaymentMethodRequired,
  PlanPriceNotFlat,
  ReferenceNotFound,
} from './provider-error.js';

type Declined = FailureOf<typeof CardDeclined>;
type Conflict = FailureOf<typeof IdempotencyConflict>;
type NotFound = FailureOf<typeof ReferenceNotFound>;
type NoPaymentMethod = FailureOf<typeof PaymentMethodRequired>;
/**
 * The provider was built without what the call needs (Stripe: `references`), returned before any request
 * as `payments.configuration_invalid`.
 */
type NotConfigured = FailureOf<typeof PaymentsConfigurationInvalid>;
/** A plan row whose provider price is not a flat recurring price (`payments.plan_price_not_flat`). */
type NotFlat = FailureOf<typeof PlanPriceNotFlat>;
/**
 * An amount `@arki/money` refuses at the provider boundary: in a provider answer, an unknown currency or units
 * off the provider's rule; in a request, an amount the provider cannot take (`money.provider_amount`: negative,
 * a currency it has no rule for, a fraction it lacks; `money.out_of_range`: past 2^53 units).
 */
type BadAmount = MoneyFailure;

export type PaymentProviderConfig = {
  apiKey: string;
  webhookSecret: string;
  webhookEndpointSecret?: string;
  publicKey?: string;
  environment: 'sandbox' | 'production';
}

/**
 * What a refund call answers: the provider's refund id and where the refund stands. A refund the
 * provider failed or canceled is an answer, not an error: the caller reads `status`.
 */
export type ProviderRefundResult = {
  providerRefundId: string;
  /** As the provider reports it. Stripe: `pending`, `requires_action`, `succeeded`, `failed` or `canceled`. */
  status: string | null;
  /** Why the provider failed the refund, in its own words (Stripe: `insufficient_funds`, `declined`, ...). Null otherwise. */
  failureReason: string | null;
};

/**
 * What every payment provider implements. A call that takes `metadata` returns `SchemaFailure`
 * (`schema.invalid_input`) before any request for metadata a jsonb column cannot store (a `bigint`
 * anywhere, U+0000 in a key or a string). A call that takes an `idempotencyKey` returns it for a key
 * an HTTP header cannot carry unchanged (empty, over 255 characters, or not printable ASCII).
 */
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
  }): Promise<Result<Customer, IdGenerationFailure | SchemaFailure>>;

  abstract getCustomer(customerId: CustomerId): Promise<Result<Customer | null, NotConfigured>>;

  abstract updateCustomer(
    customerId: CustomerId,
    params: {
      email?: string;
      name?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Result<Customer, NotFound | NotConfigured | SchemaFailure>>;

  abstract deleteCustomer(customerId: CustomerId): Promise<Result<undefined, NotFound | NotConfigured>>;

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
  }): Promise<Result<Plan, IdGenerationFailure | BadAmount | SchemaFailure>>;

  /** `null` when the plan has no row; `ReferenceNotFound` when its row has no provider price. */
  abstract getPlan(planId: PlanId): Promise<Result<Plan | null, NotFound | NotFlat | BadAmount | NotConfigured>>;

  abstract updatePlan(
    planId: PlanId,
    params: {
      name?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Result<Plan, NotFound | NotFlat | BadAmount | NotConfigured | SchemaFailure>>;

  abstract deletePlan(planId: PlanId): Promise<Result<undefined, NotFound | NotConfigured>>;

  abstract listPlans(): Promise<Result<Plan[], NotFlat | BadAmount | NotConfigured>>;

  // Subscription Management
  abstract createSubscription(params: {
    customerId: CustomerId;
    planId: PlanId;
    paymentMethodId?: string;
    trialPeriodDays?: number;
    metadata?: Record<string, unknown>;
    /** Same key, same parameters: the provider returns the first result instead of creating a second subscription. */
    idempotencyKey?: string;
  }): Promise<
    Result<Subscription, Declined | Conflict | NotFound | NotConfigured | IdGenerationFailure | SchemaFailure>
  >;

  abstract getSubscription(subscriptionId: SubscriptionId): Promise<Result<Subscription | null, NotConfigured>>;

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
  ): Promise<Result<Subscription, Declined | Conflict | NotFound | NotConfigured | SchemaFailure>>;

  abstract cancelSubscription(
    subscriptionId: SubscriptionId,
    options: {
      /** True: end it now. Otherwise it stays active until the end of the paid period. */
      immediately?: boolean;
      reason?: string;
      idempotencyKey?: string;
    },
  ): Promise<Result<Subscription, Conflict | NotFound | NotConfigured | SchemaFailure>>;

  abstract reactivateSubscription(
    subscriptionId: SubscriptionId,
  ): Promise<Result<Subscription, NotFound | NotConfigured>>;

  abstract pauseSubscription(subscriptionId: SubscriptionId): Promise<Result<Subscription, NotFound | NotConfigured>>;

  abstract resumeSubscription(subscriptionId: SubscriptionId): Promise<Result<Subscription, NotFound | NotConfigured>>;

  abstract previewSubscriptionChange(params: {
    subscriptionId: SubscriptionId;
    planId: PlanId;
    prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice';
  }): Promise<Result<SubscriptionPreview, NotFound | BadAmount | NotConfigured | SchemaFailure>>;

  // Payment Management
  abstract createPayment(params: {
    customerId: CustomerId;
    amount: Money;
    paymentMethodId: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Result<Payment, Declined | NotFound | NotConfigured | IdGenerationFailure | BadAmount | SchemaFailure>>;

  abstract getPayment(paymentId: PaymentId): Promise<Result<Payment | null, BadAmount | NotConfigured>>;

  abstract confirmPayment(
    paymentId: PaymentId,
  ): Promise<Result<Payment, Declined | NotFound | NotConfigured | BadAmount>>;

  abstract cancelPayment(paymentId: PaymentId): Promise<Result<Payment, NotFound | NotConfigured | BadAmount>>;

  /** `amount` must be in the payment's currency: another currency throws (`RefundService` checks it first). */
  abstract refundPayment(
    paymentId: PaymentId,
    params: {
      /** Our refund id. Stored on the provider's refund as `metadata.refundId`, so it can be found again. */
      refundId: RefundId;
      /** Sent to the provider, so a retry with the same key makes no second refund. */
      idempotencyKey: string;
      /** Left out: the whole payment. */
      amount?: Money;
      reason?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Result<ProviderRefundResult, NotFound | NotConfigured | Conflict | BadAmount | SchemaFailure>>;

  // Payment Methods
  abstract attachPaymentMethod(params: {
    customerId: CustomerId;
    paymentMethodId: string;
  }): Promise<Result<PaymentMethodInfo, Declined | NotFound | NotConfigured | SchemaFailure>>;

  abstract detachPaymentMethod(paymentMethodId: string): Promise<Result<undefined, SchemaFailure>>;

  abstract listPaymentMethods(customerId: CustomerId): Promise<Result<PaymentMethodInfo[], NotFound | NotConfigured>>;

  abstract setDefaultPaymentMethod(params: {
    customerId: CustomerId;
    paymentMethodId: string;
  }): Promise<Result<undefined, NotFound | NotConfigured | SchemaFailure>>;

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
      Conflict | NotFound | NotConfigured | SchemaFailure
    >
  >;

  abstract createPaymentIntent(params: {
    customerId: CustomerId;
    amount: Money;
    paymentMethodId?: string;
    /**
     * True: charge now without the customer present. Needs `paymentMethodId`; without one, `PaymentMethodRequired` is returned.
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
      Declined | Conflict | NotFound | NotConfigured | NoPaymentMethod | BadAmount | SchemaFailure
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