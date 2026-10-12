import type { UserId } from '@arki/auth/ids';

import type { NotificationService } from '../core/notifications/service';
import type { StripeProvider } from '../core/providers/stripe-provider';
import type { PaymentRepository } from '../core/repository';
import type { PaymentId } from '../core/types';
import type { RefundWrites } from './journal';
import {
  type RefundsDatabase,
  type RefundRepository,
  createRefundRepository,
} from './repository';
import type { RefundsTables } from './tables';
import type {
  Refund,
  RefundApprovalData,
  RefundRejectionData,
  RefundRequestData,
} from './types';

export type RefundServiceConfig = {
  /** User ID attributed for system-driven auto-approvals (e.g. small-amount refunds). */
  systemUserId: UserId | string;
  /** Refund window in milliseconds. Defaults to 90 days. */
  refundWindowMs?: number;
};

/** The refund reads the service makes. A `RefundRepository` fits. */
type RefundReads = Pick<
  RefundRepository,
  'findById' | 'findByPaymentId' | 'getRefundMetrics' | 'getAverageProcessingTime' | 'searchRefunds'
>;

/** The provider call the service makes. A `StripeProvider` fits. */
type RefundProvider = Pick<StripeProvider, 'refundPayment'>;

/** The payment read the service makes. A `PaymentRepository` fits. */
type PaymentReads = Pick<PaymentRepository, 'findPaymentById'>;

/**
 * Reads come from the repositories. Every change of a `refunds` row goes
 * through `writes`: one journal command per step, so each step leaves an event.
 */
export class RefundService {
  private readonly refundWindow: number;
  private readonly systemUserId: UserId | string;

  constructor(
    private readonly refundRepository: RefundReads,
    private readonly writes: RefundWrites,
    private readonly paymentProvider: RefundProvider,
    private readonly paymentRepository: PaymentReads,
    config: RefundServiceConfig,
    private readonly notificationService?: NotificationService,
  ) {
    this.refundWindow = config.refundWindowMs ?? 90 * 24 * 60 * 60 * 1000;
    this.systemUserId = config.systemUserId;
  }

  async requestRefund(data: RefundRequestData): Promise<Refund> {
    await this.validateRefundEligibility(data.paymentId, data.amount);

    const refund = await this.writes.requestRefund({
      paymentId: data.paymentId,
      originalAmount: data.amount,
      refundAmount: data.amount,
      currency: 'USD',
      reason: data.reason,
      requestedBy: data.requestedBy,
      customerNote: data.customerNote,
      internalNotes: data.internalNotes,
      metadata: JSON.stringify({}),
    });

    if (await this.shouldAutoApprove(refund)) {
      return this.approveRefund({ refundId: refund.id, approvedBy: this.systemUserId as UserId });
    }

    if (this.notificationService) {
      await this.notifyApprovers(refund);
    }

    return refund;
  }

  async approveRefund(data: RefundApprovalData): Promise<Refund> {
    const refund = await this.refundRepository.findById(data.refundId);
    if (!refund || refund.status !== 'pending') {
      throw new Error(`Invalid refund state for ${data.refundId}`);
    }

    const approvedRefund = await this.writes.approveRefund({ refundId: data.refundId, approvedBy: data.approvedBy });

    return this.processRefund(approvedRefund);
  }

  async rejectRefund(data: RefundRejectionData): Promise<Refund> {
    const refund = await this.refundRepository.findById(data.refundId);
    if (!refund || refund.status !== 'pending') {
      throw new Error(`Invalid refund state for ${data.refundId}`);
    }

    const rejectedRefund = await this.writes.rejectRefund({
      refundId: data.refundId,
      rejectedBy: data.rejectedBy,
      rejectionReason: data.reason,
    });

    if (this.notificationService) {
      await this.notifyCustomer(rejectedRefund, 'rejected');
    }

    return rejectedRefund;
  }

  private async processRefund(refund: Refund): Promise<Refund> {
    // Outside the `try`: a refund that could not start has nothing to mark as failed
    await this.writes.processRefund({ refundId: refund.id });

    try {
      const payment = await this.paymentRepository.findPaymentById(refund.paymentId as PaymentId);
      if (!payment) {
        throw new Error(`Payment ${refund.paymentId} not found`);
      }

      const providerPaymentId = payment.providerPaymentId || payment.id;

      const providerResult = await this.paymentProvider.refundPayment(providerPaymentId as PaymentId, {
        amount: Number.parseFloat(refund.refundAmount || '0'),
        reason: refund.reason,
        metadata: {
          refundId: refund.id,
          internalReason: refund.reason,
        },
      });

      const completedRefund = await this.writes.completeRefund({
        refundId: refund.id,
        providerRefundId: providerResult.id,
        providerResponse: JSON.stringify(providerResult),
      });

      if (this.notificationService) {
        await this.notifyCustomer(completedRefund, 'completed');
      }

      return completedRefund;
    } catch (error) {
      await this.writes.failRefund({
        refundId: refund.id,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });

      if (this.notificationService) {
        await this.notifySupportTeam(refund, error);
      }

      throw error;
    }
  }

  private async validateRefundEligibility(paymentId: PaymentId, amount: number): Promise<void> {
    const payment = await this.paymentRepository.findPaymentById(paymentId);
    if (!payment) {
      throw new Error('Payment not found');
    }

    if (payment.createdAt && Date.now() - payment.createdAt.getTime() > this.refundWindow) {
      throw new Error('Refund window exceeded');
    }

    const existingRefunds = await this.refundRepository.findByPaymentId(paymentId);
    const totalRefunded = existingRefunds
      .filter((r) => r.status === 'completed')
      .reduce((sum, r) => sum + Number.parseFloat(r.refundAmount || '0'), 0);

    if (totalRefunded + amount > Number.parseFloat(String(payment.amount || '0'))) {
      throw new Error('Refund amount exceeds payment amount');
    }
  }

  private async shouldAutoApprove(refund: Refund): Promise<boolean> {
    if (Number.parseFloat(refund.refundAmount || '0') <= 10) return true;
    if (['billing_error', 'technical_issue'].includes(refund.reason)) return true;
    return false;
  }

  private async notifyApprovers(refund: Refund): Promise<void> {
    if (this.notificationService?.sendRefundApprovalRequest) {
      try {
        await this.notificationService.sendRefundApprovalRequest(refund);
      } catch (error) {
        console.error('Failed to send refund approval notification:', error);
      }
    }
  }

  private async notifyCustomer(refund: Refund, event: 'completed' | 'rejected'): Promise<void> {
    if (this.notificationService?.sendRefundStatusUpdate) {
      try {
        await this.notificationService.sendRefundStatusUpdate(refund, event);
      } catch (error) {
        console.error('Failed to send customer notification:', error);
      }
    }
  }

  private async notifySupportTeam(refund: Refund, error: unknown): Promise<void> {
    if (this.notificationService?.sendRefundFailureAlert) {
      try {
        await this.notificationService.sendRefundFailureAlert(refund, error);
      } catch (error_) {
        console.error('Failed to send support team alert:', error_);
      }
    }
  }

  // Analytics methods
  async getRefundMetrics(startDate?: Date, endDate?: Date) {
    return this.refundRepository.getRefundMetrics(startDate, endDate);
  }

  async getAverageProcessingTime(): Promise<number> {
    return this.refundRepository.getAverageProcessingTime();
  }

  async searchRefunds(filters: Parameters<RefundRepository['searchRefunds']>[0]) {
    return this.refundRepository.searchRefunds(filters);
  }
}

export function createRefundService(
  db: RefundsDatabase,
  tables: Pick<RefundsTables, 'refunds'>,
  writes: RefundWrites,
  paymentProvider: StripeProvider,
  paymentRepository: PaymentRepository,
  config: RefundServiceConfig,
  notificationService?: NotificationService,
) {
  return new RefundService(
    createRefundRepository(db, tables),
    writes,
    paymentProvider,
    paymentRepository,
    config,
    notificationService,
  );
}
