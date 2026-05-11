import type { Event } from '@event-driven-io/emmett';

import type { UserId } from '@arki/auth/ids';
import type { CustomerId, PaymentId, PaymentMethodType, PaymentStatus, SubscriptionId } from '../types';

export type PaymentEventMetadata = {
  userId: UserId;
  timestamp: Date;
};

export type PaymentInitiatedEvent = Event<
  'PaymentInitiated',
  {
    paymentId: PaymentId;
    subscriptionId?: SubscriptionId;
    userId: UserId;
    customerId: CustomerId;
    amount: number;
    currency: string;
    status: PaymentStatus;
    paymentMethod: PaymentMethodType;
    description?: string;
    metadata?: Record<string, unknown>;
    providerPaymentId: string;
    refunded: boolean;
    refundedAmount: number;
    initiatedAt: Date;
  },
  PaymentEventMetadata
>;

export type PaymentCompletedEvent = Event<
  'PaymentCompleted',
  {
    paymentId: PaymentId;
    status: PaymentStatus;
    receiptUrl?: string;
    completedAt: Date;
  },
  PaymentEventMetadata
>;

export type PaymentFailedEvent = Event<
  'PaymentFailed',
  {
    paymentId: PaymentId;
    status: PaymentStatus;
    failureReason: string;
    failedAt: Date;
  },
  PaymentEventMetadata
>;

export type PaymentCanceledEvent = Event<
  'PaymentCanceled',
  {
    paymentId: PaymentId;
    status: PaymentStatus;
    canceledAt: Date;
  },
  PaymentEventMetadata
>;

export type PaymentEvent =
  | PaymentInitiatedEvent
  | PaymentCompletedEvent
  | PaymentFailedEvent
  | PaymentCanceledEvent;
