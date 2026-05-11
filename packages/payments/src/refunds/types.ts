import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

import type { UserId } from '@arki/auth/ids';

import type { PaymentId } from '../core/primitives';
import type { RefundId, RefundReason } from './primitives';
import type { RefundsTables } from './tables';

export type Refund = InferSelectModel<RefundsTables['refunds']>;
export type NewRefund = InferInsertModel<RefundsTables['refunds']>;
export type UpdateRefund = Partial<Omit<NewRefund, 'id'>>;

export type RefundRequestData = {
  paymentId: PaymentId;
  amount: number;
  reason: RefundReason;
  customerNote?: string;
  internalNotes?: string;
  requestedBy: UserId;
};

export type RefundApprovalData = {
  refundId: RefundId;
  approvedBy: UserId;
  notes?: string;
};

export type RefundRejectionData = {
  refundId: RefundId;
  rejectedBy: UserId;
  reason: string;
};

export type RefundProcessingResult = {
  success: boolean;
  providerRefundId?: string;
  providerResponse?: unknown;
  error?: string;
};

export type RefundMetrics = {
  totalRefunds: number;
  totalAmount: number;
  averageAmount: number;
  averageProcessingTime: number;
  successRate: number;
  rejectionRate: number;
  byReason: Record<RefundReason, number>;
};

export type RefundErrorCode =
  | 'TRANSACTION_NOT_FOUND'
  | 'INVALID_STATE'
  | 'AMOUNT_EXCEEDED'
  | 'WINDOW_EXCEEDED'
  | 'PROCESSING_FAILED'
  | 'APPROVAL_REQUIRED'
  | 'ALREADY_REFUNDED';

export class RefundError extends Error {
  constructor(
    message: string,
    public code: RefundErrorCode,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = 'RefundError';
  }
}
