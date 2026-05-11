import type { Event } from '@event-driven-io/emmett';

import type { UserId } from '@arki/auth/ids';
import type { PaymentId } from '../../core/types';
import type { RefundId, RefundReason, RefundStatus } from '../primitives';

export type RefundEventMetadata = {
  userId: UserId;
  timestamp: Date;
};

export type RefundRequestedEvent = Event<
  'RefundRequested',
  {
    refundId: RefundId;
    paymentId: PaymentId;
    originalAmount: number;
    refundAmount: number;
    currency: string;
    reason: RefundReason;
    status: RefundStatus;
    customerNote?: string;
    internalNotes?: string;
    requestedBy: UserId;
    requestedAt: Date;
  },
  RefundEventMetadata
>;

export type RefundApprovedEvent = Event<
  'RefundApproved',
  {
    refundId: RefundId;
    status: RefundStatus;
    approvedBy: UserId;
    approvedAt: Date;
  },
  RefundEventMetadata
>;

export type RefundRejectedEvent = Event<
  'RefundRejected',
  {
    refundId: RefundId;
    status: RefundStatus;
    rejectedBy: UserId;
    rejectionReason: string;
    rejectedAt: Date;
  },
  RefundEventMetadata
>;

export type RefundProcessedEvent = Event<
  'RefundProcessed',
  {
    refundId: RefundId;
    status: RefundStatus;
    providerRefundId: string;
    processedAt: Date;
  },
  RefundEventMetadata
>;

export type RefundCompletedEvent = Event<
  'RefundCompleted',
  {
    refundId: RefundId;
    status: RefundStatus;
    providerResponse?: string;
    completedAt: Date;
  },
  RefundEventMetadata
>;

export type RefundFailedEvent = Event<
  'RefundFailed',
  {
    refundId: RefundId;
    status: RefundStatus;
    errorMessage: string;
    failedAt: Date;
  },
  RefundEventMetadata
>;

export type RefundEvent =
  | RefundRequestedEvent
  | RefundApprovedEvent
  | RefundRejectedEvent
  | RefundProcessedEvent
  | RefundCompletedEvent
  | RefundFailedEvent;
