import type { UserId } from '../core/user-id.js';
import type { Instant } from '@arki/date';
import type { Money } from '@arki/money';
import { z } from '@arki/contracts';
import { toMillis } from '@arki/date';
import { sum } from '@arki/money';
import { currencyCodeSchema } from '@arki/money/zod';

import type { NotificationService } from '../core/notifications/service.js';
import type { StripeProvider } from '../core/providers/stripe-provider.js';
import type { PaymentRepository } from '../core/repository.js';
import type { PaymentId } from '../core/types.js';
import type { RefundWrites } from './journal.js';
import type { RefundId } from './primitives.js';
import type { RefundRepository, RefundsDatabase } from './repository.js';
import type { RefundsTables } from './tables.js';
import type { Refund, RefundApprovalData, RefundRejectionData, RefundRequestData } from './types.js';
import { nonNegativeMoneySchema, paymentAmount } from '../core/money.js';
import { createRefundRepository, refundAmountOf } from './repository.js';
import { pendingRefundIndexName } from './tables.js';
import { RefundError } from './types.js';

/**
 * The largest refund approved without a person, per currency: `{ USD: '10.00', JPY: '1500' }`.
 * Each amount is exact text in its own currency, so 10 USD and 1500 JPY are both "small".
 * A currency missing here has no small-refund rule: its refunds wait for a person.
 * Parsed once when the service is built; a bad code or amount throws there, not on a refund.
 */
export const refundAutoApproveLimitsSchema = z.record(currencyCodeSchema, z.string()).transform((limits, ctx) => {
  const parsed = new Map<string, Money>();

  for (const [currency, amount] of Object.entries(limits)) {
    const limit = nonNegativeMoneySchema.safeParse({ amount, currency });

    if (limit.success) {
      parsed.set(currency, limit.data);
    } else {
      ctx.addIssue({ code: 'custom', path: [currency], message: `Not a ${currency} amount: ${amount}` });
    }
  }

  return parsed;
});

export type RefundAutoApproveLimits = z.input<typeof refundAutoApproveLimitsSchema>;

/** About ten dollars' worth where it is set; other currencies wait for a person. */
export const DEFAULT_REFUND_AUTO_APPROVE_LIMITS: RefundAutoApproveLimits = {
  USD: '10.00',
  EUR: '10.00',
  JPY: '1500',
};

export type RefundServiceConfig = {
  /** User ID attributed for system-driven auto-approvals (e.g. small-amount refunds). */
  systemUserId: UserId | string;
  /** Refund window in milliseconds. Defaults to 90 days. */
  refundWindowMs?: number;
  /** Small refunds approved without a person. Defaults to `DEFAULT_REFUND_AUTO_APPROVE_LIMITS`. */
  autoApproveLimits?: RefundAutoApproveLimits;
};

/** Whether the error is the database refusing a second pending refund for a payment, at any depth of `cause`. */
function isPendingRefundConflict(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth += 1) {
    if ('constraint' in current && current.constraint === pendingRefundIndexName) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

/** A refund in these statuses has been, or will be, paid back, so it counts against what the payment can still refund. */
function refundHoldsMoney(status: Refund['status']): boolean {
  return status === 'pending' || status === 'approved' || status === 'processing' || status === 'completed';
}

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
  private readonly autoApproveLimits: ReadonlyMap<string, Money>;

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
    this.autoApproveLimits = refundAutoApproveLimitsSchema.parse(
      config.autoApproveLimits ?? DEFAULT_REFUND_AUTO_APPROVE_LIMITS,
    );
  }

  async requestRefund(data: RefundRequestData): Promise<Refund> {
    await this.validateRefundEligibility(data.paymentId, data.amount);

    const refund = await this.writes
      .requestRefund({
        paymentId: data.paymentId,
        originalAmount: data.amount.toJSON(),
        refundAmount: data.amount.toJSON(),
        reason: data.reason,
        requestedBy: data.requestedBy,
        customerNote: data.customerNote,
        internalNotes: data.internalNotes,
        metadata: JSON.stringify({}),
      })
      .catch((error: unknown) => {
        // Two requests can pass the check above together; the database lets only one stay pending
        if (isPendingRefundConflict(error)) {
          throw new RefundError(
            `Payment ${data.paymentId} already has a refund waiting for a decision`,
            'DUPLICATE_PENDING_REFUND',
            error,
          );
        }

        throw error;
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
    await this.requirePending(data.refundId);

    const approvedRefund = await this.writes.approveRefund({
      refundId: data.refundId,
      approvedBy: data.approvedBy,
      notes: data.notes ?? null,
    });

    return this.processRefund(approvedRefund);
  }

  async rejectRefund(data: RefundRejectionData): Promise<Refund> {
    if (data.reason.trim() === '') {
      throw new RefundError('A rejection needs a reason', 'REASON_REQUIRED');
    }

    await this.requirePending(data.refundId);

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

  /** A refund that can still be approved or rejected. A missing one and one past `pending` are different errors. */
  private async requirePending(refundId: RefundId): Promise<Refund> {
    const refund = await this.refundRepository.findById(refundId);
    if (!refund) {
      throw new RefundError(`Refund ${refundId} not found`, 'REFUND_NOT_FOUND');
    }

    if (refund.status !== 'pending') {
      throw new RefundError(`Invalid refund state for ${refundId}`, 'INVALID_STATE');
    }

    return refund;
  }

  private async processRefund(refund: Refund): Promise<Refund> {
    // Outside the `try`: a refund that could not start has nothing to mark as failed
    await this.writes.processRefund({ refundId: refund.id });

    try {
      const payment = await this.paymentRepository.findPaymentById(refund.paymentId as PaymentId);
      if (!payment) {
        throw new Error(`Payment ${refund.paymentId} not found`);
      }

      // The provider resolves its own payment from our payment id
      const providerResult = await this.paymentProvider.refundPayment(payment.id, {
        amount: refundAmountOf(refund),
        reason: refund.reason,
        metadata: {
          refundId: refund.id,
          internalReason: refund.reason,
        },
      });

      const completedRefund = await this.writes.completeRefund({
        refundId: refund.id,
        providerRefundId: providerResult.providerRefundId,
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

  private async validateRefundEligibility(paymentId: PaymentId, amount: Money): Promise<void> {
    const payment = await this.paymentRepository.findPaymentById(paymentId);
    if (!payment) {
      throw new Error('Payment not found');
    }

    const paid = paymentAmount(payment);
    if (!amount.hasSameCurrency(paid)) {
      throw new Error(
        `Refund currency ${amount.currency.code} differs from the payment currency ${paid.currency.code}`,
      );
    }

    if (payment.createdAt && Date.now() - toMillis(payment.createdAt) > this.refundWindow) {
      throw new Error('Refund window exceeded');
    }

    const existingRefunds = await this.refundRepository.findByPaymentId(paymentId);
    if (existingRefunds.some(existing => existing.status === 'pending')) {
      throw new RefundError(`Payment ${paymentId} already has a refund waiting for a decision`, 'DUPLICATE_PENDING_REFUND');
    }

    // Money already promised back counts, not only money already sent: an approved or processing
    // refund will be paid. Rejected and failed ones never move money.
    const totalRefunded = sum(
      existingRefunds.filter(r => refundHoldsMoney(r.status)).map(refund => refundAmountOf(refund)),
      paid.currency,
    );

    if (totalRefunded.plus(amount).gt(paid)) {
      throw new RefundError('Refund amount exceeds payment amount', 'AMOUNT_EXCEEDED');
    }
  }

  /**
   * The per-currency limit is the only rule, whatever the reason: a billing
   * error or technical issue of any size used to skip the person, so a large
   * refund in any currency could go out unreviewed.
   */
  private async shouldAutoApprove(refund: Refund): Promise<boolean> {
    const amount = refundAmountOf(refund);
    const limit = this.autoApproveLimits.get(amount.currency.code);
    return limit !== undefined && amount.lte(limit);
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
  async getRefundMetrics(startDate?: Instant, endDate?: Instant) {
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
