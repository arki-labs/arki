import type { UserId } from '../core/user-id.js';
import type { Instant } from '@arki/date';
import type { Money } from '@arki/money';
import { z } from '@arki/contracts';
import { toMillis } from '@arki/date';
import { TransactionDefect, TransactionRejected } from '@arki/db/errors';
import { isFailure } from '@arki/failure';
import { isJournalError } from '@arki/journal';
import { getLogger } from '@arki/log';
import { sum } from '@arki/money';
import { currencyCodeSchema } from '@arki/money/zod';
import { parse } from '@arki/schema';

import type { NotificationService } from '../core/notifications/service.js';
import type { PaymentRepository } from '../core/repository.js';
import type { PaymentId } from '../core/types.js';
import type { RefundWrites } from './journal.js';
import type { RefundId } from './primitives.js';
import type { RefundRepository, RefundsDatabase } from './repository.js';
import type { RefundsTables } from './tables.js';
import type { Refund, RefundApprovalData, RefundRejectionData, RefundRequestData } from './types.js';
import { misconfigured } from '../core/failures.js';
import { nonNegativeMoneySchema, paymentAmount } from '../core/money.js';
import { refundRejectionReasonSchema } from './contracts.js';
import {
  DuplicatePendingRefund,
  RefundAmountExceeded,
  RefundCurrencyMismatch,
  RefundInvalidState,
  RefundNotFound,
  RefundWindowExceeded,
  TransactionNotFound,
} from './failures.js';
import { createRefundRepository, refundAmountOf } from './repository.js';
import { pendingRefundIndexName } from './tables.js';

/** Logs ids only, never refund data. */
const logger = getLogger('arki:payments');

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
  systemUserId: UserId;
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

/**
 * Whether the refund write lost the race to another pending refund for the same payment.
 * Two shapes say so. A journal command throws `JournalError('CONFLICT')` for a row insert's
 * unique violation, and its transaction returns that as `TransactionDefect`. A plain database
 * write returns `TransactionRejected` with SQLSTATE 23505. Any other failure is kept as it is.
 */
function lostPendingRefundRace(failure: unknown): boolean {
  if (TransactionDefect.is(failure)) {
    return isJournalError(failure.cause, 'CONFLICT') && isPendingRefundConflict(failure.cause);
  }
  return TransactionRejected.is(failure) && failure.data.sqlState === '23505' && isPendingRefundConflict(failure.cause);
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

/** The payment read the service makes. A `PaymentRepository` fits. */
type PaymentReads = Pick<PaymentRepository, 'findPaymentById'>;

/**
 * Reads come from the repositories. Every change of a `refunds` row goes
 * through `writes`: one journal command per step, so each step leaves an event.
 *
 * The service never calls the provider. Approval records `RefundApproved`, and that event starts the
 * `payments.refund` workflow (`createRefundWorkflow`), which pays the money back after the request has answered.
 */
export class RefundService {
  private readonly refundWindow: number;
  private readonly systemUserId: UserId;
  private readonly autoApproveLimits: ReadonlyMap<string, Money>;

  constructor(
    private readonly refundRepository: RefundReads,
    private readonly writes: RefundWrites,
    private readonly paymentRepository: PaymentReads,
    config: RefundServiceConfig,
    /** Sends the customer's rejection mail only. The approvers' mail is an effect: `createRefundEffects`. */
    private readonly notificationService?: NotificationService,
  ) {
    this.refundWindow = config.refundWindowMs ?? 90 * 24 * 60 * 60 * 1000;
    this.systemUserId = config.systemUserId;
    // A bad limit is a configuration fault: `payments.configuration_invalid` when the service is built
    const limits = refundAutoApproveLimitsSchema.safeParse(config.autoApproveLimits ?? DEFAULT_REFUND_AUTO_APPROVE_LIMITS);
    if (!limits.success) {
      throw misconfigured(
        'refunds.autoApproveLimits',
        limits.error.issues.map(issue => `${issue.path.join('.') || '(limits)'}: ${issue.message}`).join('; '),
      );
    }
    this.autoApproveLimits = limits.data;
  }

  async requestRefund(data: RefundRequestData) {
    const refused = await this.validateRefundEligibility(data.paymentId, data.amount);
    if (isFailure(refused)) return refused;

    const refund = await this.writes.requestRefund({
      paymentId: data.paymentId,
      originalAmount: data.amount.toJSON(),
      refundAmount: data.amount.toJSON(),
      reason: data.reason,
      requestedBy: data.requestedBy,
      customerNote: data.customerNote,
      internalNotes: data.internalNotes,
      metadata: JSON.stringify({}),
    });
    // Two requests can pass eligibility together; only this unique index proves another is pending.
    if (lostPendingRefundRace(refund)) {
      return DuplicatePendingRefund({ paymentId: data.paymentId }, { cause: refund });
    }
    if (isFailure(refund)) return refund;

    if (await this.shouldAutoApprove(refund)) {
      return this.approveRefund({ refundId: refund.id, approvedBy: this.systemUserId });
    }

    // The approvers hear from the `refund-approval-request` effect (`createRefundEffects`), after the commit
    return refund;
  }

  async approveRefund(data: RefundApprovalData) {
    const pending = await this.requirePending(data.refundId);
    if (isFailure(pending)) return pending;

    const approvedRefund = await this.writes.approveRefund({
      refundId: data.refundId,
      approvedBy: data.approvedBy,
      notes: data.notes ?? null,
    });
    // `approved`: the workflow the approval started pays it back after this answer
    return approvedRefund;
  }

  /** A blank `reason` is refused with the schema's `InvalidInput` before anything is read or written. */
  async rejectRefund(data: RefundRejectionData) {
    const reason = parse(refundRejectionReasonSchema, data.reason);
    if (isFailure(reason)) return reason;

    const pending = await this.requirePending(data.refundId);
    if (isFailure(pending)) return pending;

    const rejectedRefund = await this.writes.rejectRefund({
      refundId: data.refundId,
      rejectedBy: data.rejectedBy,
      rejectionReason: reason,
    });
    if (isFailure(rejectedRefund)) return rejectedRefund;

    if (this.notificationService) {
      await this.notifyCustomer(rejectedRefund, 'rejected');
    }

    return rejectedRefund;
  }

  /** A refund that can still be approved or rejected. A missing one and one past `pending` are different failures. */
  private async requirePending(refundId: RefundId) {
    const refund = await this.refundRepository.findById(refundId);
    if (!refund) {
      return RefundNotFound({ refundId });
    }

    if (refund.status !== 'pending') {
      return RefundInvalidState({ refundId, status: refund.status });
    }

    return refund;
  }

  /** Nothing when the payment can give back `amount`, or the failure that says why not. */
  private async validateRefundEligibility(paymentId: PaymentId, amount: Money) {
    const payment = await this.paymentRepository.findPaymentById(paymentId);
    if (!payment) {
      return TransactionNotFound({ paymentId });
    }

    const paid = paymentAmount(payment);
    if (!amount.hasSameCurrency(paid)) {
      return RefundCurrencyMismatch({
        paymentId,
        refundCurrency: amount.currency.code,
        paymentCurrency: paid.currency.code,
      });
    }

    if (payment.createdAt && Date.now() - toMillis(payment.createdAt) > this.refundWindow) {
      return RefundWindowExceeded({ paymentId });
    }

    const existingRefunds = await this.refundRepository.findByPaymentId(paymentId);
    if (existingRefunds.some(existing => existing.status === 'pending')) {
      return DuplicatePendingRefund({ paymentId });
    }

    // Money already promised back counts, not only money already sent: an approved or processing
    // refund will be paid. Rejected and failed ones never move money.
    const totalRefunded = sum(
      existingRefunds.filter(r => refundHoldsMoney(r.status)).map(refund => refundAmountOf(refund)),
      paid.currency,
    );

    if (totalRefunded.plus(amount).gt(paid)) {
      return RefundAmountExceeded({
        paymentId,
        requested: amount.toDecimalString(),
        refundable: paid.minus(totalRefunded).toDecimalString(),
        currency: paid.currency.code,
      });
    }

    return;
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

  private async notifyCustomer(refund: Refund, event: 'rejected'): Promise<void> {
    if (this.notificationService?.sendRefundStatusUpdate) {
      try {
        const sent = await this.notificationService.sendRefundStatusUpdate(refund, event);
        if (isFailure(sent)) {
          logger.warn('Refund {event} mail for {refundId} was not sent: {code}', {
            refundId: refund.id,
            event,
            code: sent.code,
            failure: sent,
          });
        }
      } catch (error) {
        logger.error('Refund {event} mail for {refundId} was not sent: {error}', {
          refundId: refund.id,
          event,
          error: error instanceof Error ? error.message : String(error),
        });
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
  paymentRepository: PaymentRepository,
  config: RefundServiceConfig,
  notificationService?: NotificationService,
) {
  return new RefundService(createRefundRepository(db, tables), writes, paymentRepository, config, notificationService);
}
