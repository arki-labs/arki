import type { Command } from '@event-driven-io/emmett';

import type { UserId } from '@arki/auth/ids';
import type { CustomerId, PaymentId, PaymentMethodType, SubscriptionId } from '../types';

export type PaymentCommandMetadata = {
  userId: UserId;
  timestamp: Date;
  now: Date;
};

export type InitiatePaymentCommand = Command<
  'InitiatePayment',
  {
    paymentId: PaymentId;
    subscriptionId?: SubscriptionId;
    userId: UserId;
    customerId: CustomerId;
    amount: number;
    currency: string;
    paymentMethod: PaymentMethodType;
    description?: string;
    metadata?: Record<string, unknown>;
    providerPaymentId: string;
    initiatedAt: Date;
  },
  PaymentCommandMetadata
>;

export type CompletePaymentCommand = Command<
  'CompletePayment',
  {
    paymentId: PaymentId;
    receiptUrl?: string;
    completedAt: Date;
  },
  PaymentCommandMetadata
>;

export type FailPaymentCommand = Command<
  'FailPayment',
  {
    paymentId: PaymentId;
    failureReason: string;
    failedAt: Date;
  },
  PaymentCommandMetadata
>;

export type CancelPaymentCommand = Command<
  'CancelPayment',
  {
    paymentId: PaymentId;
    canceledAt: Date;
  },
  PaymentCommandMetadata
>;

export type PaymentCommand =
  | InitiatePaymentCommand
  | CompletePaymentCommand
  | FailPaymentCommand
  | CancelPaymentCommand;
