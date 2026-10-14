import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

import type { UserId } from '../core/user-id.js';
import type { Money } from '@arki/money';

import type { PaymentId } from '../core/primitives.js';
import type { RefundId, RefundReason } from './primitives.js';
import type { RefundsTables } from './tables.js';

// `version` belongs to the journal: rows leave the package without it, and no caller sets it
export type Refund = Omit<InferSelectModel<RefundsTables['refunds']>, 'version'>;
export type NewRefund = Omit<InferInsertModel<RefundsTables['refunds']>, 'version'>;
export type UpdateRefund = Partial<Omit<NewRefund, 'id'>>;

export type RefundRequestData = {
  paymentId: PaymentId;
  /** In the payment's currency */
  amount: Money;
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
  | 'REFUND_NOT_FOUND'
  | 'DUPLICATE_PENDING_REFUND'
  | 'REASON_REQUIRED'
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
