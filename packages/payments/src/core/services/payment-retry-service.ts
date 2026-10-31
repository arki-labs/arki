import type { Instant } from '@arki/date';
import { add, isAfter, isBefore, isSameOrBefore, now, toMillis } from '@arki/date';
import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';
import { MoneyBag } from '@arki/money/bag';

import type { CoreWrites } from '../journal.js';
import type { BasePaymentProvider } from '../providers/base-provider.js';
import type { PaymentRepository } from '../repository.js';
import type { Payment, PaymentId, Subscription, SubscriptionId } from '../types.js';
import { PaymentWithoutSubscription } from '../failures.js';
import { paymentAmount } from '../money.js';
import { CardDeclined, ReferenceNotFound } from '../providers/provider-error.js';

const logger = getLogger('arki:payments:retry');

export type RetryStrategy = {
  name: string;
  maxAttempts: number;
  backoffStrategy: 'linear' | 'exponential' | 'custom';
  delayMinutes: number[];
  conditions: {
    paymentMethods: string[];
    failureReasons: string[];
    subscriptionStatuses: string[];
  };
};

export type RetryAttempt = {
  id: string;
  paymentId: PaymentId;
  subscriptionId: SubscriptionId;
  attemptNumber: number;
  scheduledFor: Instant;
  executedAt?: Instant;
  status: 'pending' | 'executing' | 'succeeded' | 'failed' | 'cancelled';
  failureReason?: string;
  strategyUsed: string;
  createdAt: Instant;
};

export type RetryAnalytics = {
  totalRetryAttempts: number;
  successfulRetries: number;
  failedRetries: number;
  retrySuccessRate: number;
  averageRetryTime: number;
  retrySuccessByAttempt: Record<number, number>;
  commonFailureReasons: Record<string, number>;
  /** The stored amounts of the payments a retry recovered, each payment once, one balance per currency. */
  revenueRecovered: MoneyBag;
};

const DEFAULT_RETRY_STRATEGIES: RetryStrategy[] = [
  {
    name: 'card_declined_standard',
    maxAttempts: 4,
    backoffStrategy: 'custom',
    delayMinutes: [60, 1440, 4320, 10_080],
    conditions: {
      paymentMethods: ['card'],
      failureReasons: ['card_declined', 'insufficient_funds', 'expired_card'],
      subscriptionStatuses: ['active', 'past_due'],
    },
  },
  {
    name: 'processing_error_fast',
    maxAttempts: 3,
    backoffStrategy: 'exponential',
    delayMinutes: [15, 60, 240],
    conditions: {
      paymentMethods: ['card', 'bank_account'],
      failureReasons: ['processing_error', 'issuer_not_available', 'try_again_later'],
      subscriptionStatuses: ['active', 'past_due'],
    },
  },
  {
    name: 'authentication_required',
    maxAttempts: 2,
    backoffStrategy: 'custom',
    delayMinutes: [10_080, 20_160],
    conditions: {
      paymentMethods: ['card'],
      failureReasons: ['authentication_required', 'requires_action'],
      subscriptionStatuses: ['active', 'past_due'],
    },
  },
  {
    name: 'bank_account_standard',
    maxAttempts: 2,
    backoffStrategy: 'custom',
    delayMinutes: [2880, 7200],
    conditions: {
      paymentMethods: ['bank_account'],
      failureReasons: ['insufficient_funds', 'account_closed', 'debit_not_authorized'],
      subscriptionStatuses: ['active', 'past_due'],
    },
  },
];

/** The provider call a retry makes. A `BasePaymentProvider` fits. */
type RetryProvider = Pick<BasePaymentProvider, 'confirmPayment'>;

/** The repository reads a retry makes. A `PaymentRepository` fits. */
type RetryReads = Pick<PaymentRepository, 'findPaymentById' | 'findSubscriptionById'>;

/**
 * The retry schedule lives in memory. Every change of a `subscriptions` row
 * goes through `writes`: one journal command each.
 */
export class PaymentRetryService {
  private retryAttempts = new Map<string, RetryAttempt>();
  private strategies: RetryStrategy[];

  constructor(
    private readonly paymentProvider: RetryProvider,
    private readonly paymentRepository: RetryReads,
    private readonly writes: CoreWrites,
    strategies: RetryStrategy[] = DEFAULT_RETRY_STRATEGIES,
  ) {
    this.strategies = strategies;
  }

  /**
   * Schedule the retries of a failed subscription payment by the first strategy that fits it.
   * Returns the scheduled attempts (none when no strategy fits), or a failure:
   * `ReferenceNotFound` (payment or subscription) or `PaymentWithoutSubscription`.
   */
  async scheduleRetries(paymentId: PaymentId, failureReason: string) {
    const payment = await this.paymentRepository.findPaymentById(paymentId);
    if (!payment) return ReferenceNotFound({ kind: 'payment', id: paymentId, missing: 'row' });

    if (!payment.subscriptionId) return PaymentWithoutSubscription({ paymentId });

    const subscription = await this.paymentRepository.findSubscriptionById(payment.subscriptionId);
    if (!subscription) {
      return ReferenceNotFound({ kind: 'subscription', id: payment.subscriptionId, missing: 'row' });
    }

    const strategy = this.selectRetryStrategy(payment, failureReason, subscription);
    if (!strategy) {
      logger.debug('No retry strategy fits payment {paymentId} with failure reason {failureReason}', {
        paymentId,
        failureReason,
      });
      const none: RetryAttempt[] = [];
      return none;
    }

    await this.cancelRetries(paymentId);

    const retryAttempts: RetryAttempt[] = [];
    const current = now();

    for (let i = 0; i < strategy.maxAttempts; i++) {
      const delayMinutes = this.calculateDelay(strategy, i);
      const scheduledFor = add(current, { minutes: delayMinutes });

      const attempt: RetryAttempt = {
        id: `retry_${paymentId}_${i + 1}_${Date.now()}`,
        paymentId,
        subscriptionId: subscription.id,
        attemptNumber: i + 1,
        scheduledFor,
        status: 'pending',
        strategyUsed: strategy.name,
        createdAt: current,
      };

      this.retryAttempts.set(attempt.id, attempt);
      retryAttempts.push(attempt);
    }

    logger.debug('Scheduled {count} retry attempts for payment {paymentId} using {strategy}', {
      count: retryAttempts.length,
      paymentId,
      strategy: strategy.name,
    });
    return retryAttempts;
  }

  async processRetries(): Promise<void> {
    const current = now();
    const pendingRetries = [...this.retryAttempts.values()]
      .filter((attempt) => attempt.status === 'pending' && isSameOrBefore(attempt.scheduledFor, current))
      .toSorted((a, b) => toMillis(a.scheduledFor) - toMillis(b.scheduledFor));

    logger.debug('Processing {count} pending retry attempts', { count: pendingRetries.length });

    for (const attempt of pendingRetries) {
      try {
        const executed = await this.executeRetry(attempt);
        if (isFailure(executed)) {
          logger.warn('Retry {attemptId} failed: {code}', {
            attemptId: attempt.id,
            code: executed.code,
            failure: executed,
          });
        }
      } catch (error) {
        // One broken attempt must not stop the others
        logger.error('Retry {attemptId} threw: {error}', {
          attemptId: attempt.id,
          error: error instanceof Error ? error : String(error),
        });
        attempt.status = 'failed';
        attempt.failureReason = error instanceof Error ? error.message : 'Unknown error';
      }
    }
  }

  /** Nothing, or the failure of a journal write; `attempt` then says `failed` with its message. */
  private async executeRetry(attempt: RetryAttempt) {
    attempt.status = 'executing';
    attempt.executedAt = now();

    try {
      const subscription = await this.paymentRepository.findSubscriptionById(attempt.subscriptionId);
      if (!subscription || !['active', 'past_due'].includes(subscription.status)) {
        attempt.status = 'cancelled';
        logger.debug('Cancelled retry {attemptId}: the subscription is no longer eligible', { attemptId: attempt.id });
        return;
      }

      const payment = await this.paymentRepository.findPaymentById(attempt.paymentId);
      if (!payment || payment.status === 'succeeded') {
        attempt.status = 'cancelled';
        logger.debug('Cancelled retry {attemptId}: the payment is gone or already succeeded', {
          attemptId: attempt.id,
        });
        return;
      }

      logger.debug('Executing retry attempt {attemptNumber} for payment {paymentId}', {
        attemptNumber: attempt.attemptNumber,
        paymentId: attempt.paymentId,
      });

      const result = await this.paymentProvider.confirmPayment(attempt.paymentId);
      if (isFailure(result)) {
        // A declined card or a missing payment row: this attempt failed, as when the provider threw
        attempt.status = 'failed';
        attempt.failureReason = result.message;
        logger.warn('Retry {attemptId} failed: {code}', { attemptId: attempt.id, code: result.code, failure: result });

        // A declined card is a failed retry like any other: the last one ends dunning
        if (CardDeclined.is(result) && (await this.isLastAttempt(attempt.paymentId, attempt.attemptNumber))) {
          const ended = await this.handleFinalFailure(attempt.paymentId, attempt.subscriptionId);
          if (isFailure(ended)) {
            attempt.failureReason = ended.message;
            return ended;
          }
        }
        return;
      }

      if (result.status === 'succeeded') {
        attempt.status = 'succeeded';
        await this.cancelRetries(attempt.paymentId, attempt.id);

        if (subscription.status === 'past_due') {
          const activated = await this.writes.activateSubscription({ subscriptionId: subscription.id });
          // The money came in, but the row could not follow: the attempt counts as failed, as when the write threw
          if (isFailure(activated)) {
            attempt.status = 'failed';
            attempt.failureReason = activated.message;
            return activated;
          }
        }

        logger.info('Retry {attemptId} succeeded: payment {paymentId} recovered', {
          attemptId: attempt.id,
          paymentId: attempt.paymentId,
        });
      } else {
        attempt.status = 'failed';
        attempt.failureReason = this.extractFailureReason(result);

        logger.info('Retry {attemptId} failed: {reason}', { attemptId: attempt.id, reason: attempt.failureReason });

        if (await this.isLastAttempt(attempt.paymentId, attempt.attemptNumber)) {
          const ended = await this.handleFinalFailure(attempt.paymentId, attempt.subscriptionId);
          if (isFailure(ended)) {
            attempt.failureReason = ended.message;
            return ended;
          }
        }
      }
      return;
    } catch (error) {
      attempt.status = 'failed';
      attempt.failureReason = error instanceof Error ? error.message : 'Retry execution error';
      throw error;
    }
  }

  private selectRetryStrategy(
    payment: Payment,
    failureReason: string,
    subscription: Subscription,
  ): RetryStrategy | null {
    for (const strategy of this.strategies) {
      const conditions = strategy.conditions;

      if (!conditions.paymentMethods.includes(payment.paymentMethod)) {
        continue;
      }

      if (
        !conditions.failureReasons.some((reason) =>
          failureReason.toLowerCase().includes(reason.toLowerCase()),
        )
      ) {
        continue;
      }

      if (!conditions.subscriptionStatuses.includes(subscription.status)) {
        continue;
      }

      return strategy;
    }

    return null;
  }

  private calculateDelay(strategy: RetryStrategy, attemptIndex: number): number {
    if (strategy.backoffStrategy === 'custom') {
      return strategy.delayMinutes[attemptIndex] ?? strategy.delayMinutes.at(-1) ?? 60;
    }

    const baseDelay = strategy.delayMinutes[0] ?? 60;

    switch (strategy.backoffStrategy) {
      case 'linear': {
        return baseDelay * (attemptIndex + 1);
      }
      case 'exponential': {
        return baseDelay * Math.pow(2, attemptIndex);
      }
      default: {
        return baseDelay;
      }
    }
  }

  private async isLastAttempt(paymentId: PaymentId, currentAttemptNumber: number): Promise<boolean> {
    const paymentRetries = [...this.retryAttempts.values()].filter(
      (attempt) => attempt.paymentId === paymentId,
    );

    const maxAttemptNumber = Math.max(...paymentRetries.map((r) => r.attemptNumber));
    return currentAttemptNumber === maxAttemptNumber;
  }

  /** Nothing, or the failure of the write: a subscription that is not there. */
  private async handleFinalFailure(paymentId: PaymentId, subscriptionId: SubscriptionId) {
    logger.info('All retry attempts exhausted for payment {paymentId}', { paymentId });

    const marked = await this.writes.markSubscriptionPastDue({ subscriptionId });
    if (isFailure(marked)) return marked;
    return;
  }

  async cancelRetries(paymentId: PaymentId, excludeId?: string): Promise<void> {
    const retriesToCancel = [...this.retryAttempts.entries()].filter(
      ([id, attempt]) =>
        attempt.paymentId === paymentId && attempt.status === 'pending' && id !== excludeId,
    );

    for (const [id, attempt] of retriesToCancel) {
      attempt.status = 'cancelled';
      this.retryAttempts.delete(id);
    }

    logger.debug('Cancelled {count} pending retry attempts for payment {paymentId}', {
      count: retriesToCancel.length,
      paymentId,
    });
  }

  getRetryAttempts(paymentId: PaymentId): RetryAttempt[] {
    return [...this.retryAttempts.values()]
      .filter((attempt) => attempt.paymentId === paymentId)
      .toSorted((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async getRetryAnalytics(startDate?: Instant, endDate?: Instant): Promise<RetryAnalytics> {
    const allRetries = [...this.retryAttempts.values()];

    const filteredRetries =
      startDate || endDate
        ? allRetries.filter((attempt) => {
            // Temporal instants have no `<`/`>`: their `valueOf` throws, so compare with the date helpers
            const date = attempt.createdAt;
            return (!startDate || !isBefore(date, startDate)) && (!endDate || !isAfter(date, endDate));
          })
        : allRetries;

    const totalRetryAttempts = filteredRetries.length;
    const successfulRetries = filteredRetries.filter((r) => r.status === 'succeeded').length;
    const failedRetries = filteredRetries.filter((r) => r.status === 'failed').length;

    const retrySuccessRate =
      totalRetryAttempts > 0 ? (successfulRetries / totalRetryAttempts) * 100 : 0;

    const successfulWithExecutionTime = filteredRetries.filter(
      (r) => r.status === 'succeeded' && r.executedAt && r.createdAt,
    );

    const averageRetryTime =
      successfulWithExecutionTime.length > 0
        ? successfulWithExecutionTime.reduce((sum, attempt) => {
            const hours =
              (toMillis(attempt.executedAt!) - toMillis(attempt.createdAt)) / (1000 * 60 * 60);
            return sum + hours;
          }, 0) / successfulWithExecutionTime.length
        : 0;

    const retrySuccessByAttempt: Record<number, number> = {};
    for (let i = 1; i <= 5; i++) {
      const attemptsAtNumber = filteredRetries.filter((r) => r.attemptNumber === i);
      const successfulAtNumber = attemptsAtNumber.filter((r) => r.status === 'succeeded').length;
      retrySuccessByAttempt[i] =
        attemptsAtNumber.length > 0 ? (successfulAtNumber / attemptsAtNumber.length) * 100 : 0;
    }

    const commonFailureReasons: Record<string, number> = {};
    for (const attempt of filteredRetries.filter((r) => r.failureReason)) {
      const reason = attempt.failureReason!;
      commonFailureReasons[reason] = (commonFailureReasons[reason] || 0) + 1;
    }

    // Each recovered payment counts once, at the amount stored on its row; a deleted payment adds nothing
    const recoveredIds = new Set(filteredRetries.filter(r => r.status === 'succeeded').map(r => r.paymentId));
    const recoveredPayments = await Promise.all(
      [...recoveredIds].map(paymentId => this.paymentRepository.findPaymentById(paymentId)),
    );
    const revenueRecovered = MoneyBag.of(
      ...recoveredPayments.flatMap(payment => (payment ? [paymentAmount(payment)] : [])),
    );

    return {
      totalRetryAttempts,
      successfulRetries,
      failedRetries,
      retrySuccessRate: Math.round(retrySuccessRate * 100) / 100,
      averageRetryTime: Math.round(averageRetryTime * 100) / 100,
      retrySuccessByAttempt,
      commonFailureReasons,
      revenueRecovered,
    };
  }

  private extractFailureReason(paymentResult: Payment): string {
    return paymentResult.failureReason || 'Unknown failure reason';
  }

  addRetryStrategy(strategy: RetryStrategy): void {
    const existingIndex = this.strategies.findIndex((s) => s.name === strategy.name);
    if (existingIndex === -1) {
      this.strategies.push(strategy);
    } else {
      this.strategies[existingIndex] = strategy;
    }
  }

  getRetryStrategies(): RetryStrategy[] {
    return [...this.strategies];
  }

  updateRetryStrategy(name: string, updates: Partial<RetryStrategy>): void {
    const strategy = this.strategies.find((s) => s.name === name);
    if (strategy) {
      Object.assign(strategy, updates);
    }
  }
}

export function createPaymentRetryService(
  paymentProvider: BasePaymentProvider,
  paymentRepository: PaymentRepository,
  writes: CoreWrites,
  strategies?: RetryStrategy[],
): PaymentRetryService {
  return new PaymentRetryService(paymentProvider, paymentRepository, writes, strategies);
}
