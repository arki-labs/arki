import type { Command } from '@event-driven-io/emmett';

import type { UserId } from '@arki/auth/ids';
import type { PaymentId } from '../../core/types';
import type { RefundId, RefundReason } from '../primitives';

export type RefundCommandMetadata = {
  userId: UserId;
  timestamp: Date;
  now: Date;
};

export type RequestRefundCommand = Command<
  'RequestRefund',
  {
    refundId: RefundId;
    paymentId: PaymentId;
    originalAmount: number;
    refundAmount: number;
    currency: string;
    reason: RefundReason;
    customerNote?: string;
    internalNotes?: string;
    requestedBy: UserId;
    requestedAt: Date;
  },
  RefundCommandMetadata
>;

export type ApproveRefundCommand = Command<
  'ApproveRefund',
  {
    refundId: RefundId;
    approvedBy: UserId;
    approvedAt: Date;
  },
  RefundCommandMetadata
>;

export type RejectRefundCommand = Command<
  'RejectRefund',
  {
    refundId: RefundId;
    rejectedBy: UserId;
    rejectionReason: string;
    rejectedAt: Date;
  },
  RefundCommandMetadata
>;

export type ProcessRefundCommand = Command<
  'ProcessRefund',
  {
    refundId: RefundId;
    providerRefundId: string;
    processedAt: Date;
  },
  RefundCommandMetadata
>;

export type CompleteRefundCommand = Command<
  'CompleteRefund',
  {
    refundId: RefundId;
    providerResponse?: string;
    completedAt: Date;
  },
  RefundCommandMetadata
>;

export type FailRefundCommand = Command<
  'FailRefund',
  {
    refundId: RefundId;
    errorMessage: string;
    failedAt: Date;
  },
  RefundCommandMetadata
>;

export type RefundCommand =
  | RequestRefundCommand
  | ApproveRefundCommand
  | RejectRefundCommand
  | ProcessRefundCommand
  | CompleteRefundCommand
  | FailRefundCommand;
