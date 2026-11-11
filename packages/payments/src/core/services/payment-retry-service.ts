import type { Instant } from '@arki/date';
import { z } from '@arki/contracts';
import { add, isAfter, isBefore, isSameOrBefore, now, toMillis } from '@arki/date';
import type { FailureOf } from '@arki/failure';
import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';
import { MoneyBag } from '@arki/money/bag';

import type { CoreWrites } from '../journal.js';
import type { BasePaymentProvider } from '../providers/base-provider.js';
import type { PaymentRepository } from '../repository.js';
import type { Payment, PaymentId, Subscription, SubscriptionId } from '../types.js';
import { PaymentsConfigurationInvalid, PaymentWithoutSubscription, RetryStrategyNotFound } from '../failures.js';
import { paymentAmount } from '../money.js';
import { MAX_BATCH_ITEMS } from '../pg-values.js';
import { CardDeclined, ReferenceNotFound } from '../providers/provider-error.js';

const logger = getLogger('arki:payments:retry');

/**
 * A retry strategy. At most 10 attempts, so even an exponential backoff (the first delay doubled per
 * attempt) stays inside the dates `@arki/date` can hold; each delay is whole minutes, at most a year.
 * Each list holds at most `MAX_BATCH_ITEMS` (1,000) items.
 */
const retryStrategySchema = z.object({
  name: z.string().min(1),
  maxAttempts: z.number().int().min(1).max(10),
  backoffStrategy: z.enum(['linear', 'exponential', 'custom']),
  delayMinutes: z.array(z.number().int().min(0).max(525_600)).max(MAX_BATCH_ITEMS),
  conditions: z.object({
    paymentMethods: z.array(z.string()).max(MAX_BATCH_ITEMS),
    failureReasons: z.array(z.string()).max(MAX_BATCH_ITEMS),
    subscriptionStatuses: z.array(z.string()).max(MAX_BATCH_ITEMS),
  }),
});

export type RetryStrategy = z.output<typeof retryStrategySchema>;

type ConfigurationInvalid = FailureOf<typeof PaymentsConfigurationInvalid>;
type RetryStrategyMissing = FailureOf<typeof RetryStrategyNotFound>;

/** Nothing, or `payments.configuration_invalid` for `setting` when a strategy breaks `retryStrategySchema`. */
function checkStrategies(strategies: readonly RetryStrategy[], setting: string): ConfigurationInvalid | undefined {
  const checked = z.array(retryStrategySchema).max(MAX_BATCH_ITEMS).safeParse(strategies);
  if (checked.success) return;
  return PaymentsConfigurationInvalid({
    setting,
    problem: checked.error.issues.map(issue => `${issue.path.join('.') || '(config)'}: ${issue.message}`).join('; '),
  });
}

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

  /** Use `PaymentRetryService.create`: it checks the strategies first. */
  private constructor(
    private readonly paymentProvider: RetryProvider,
    private readonly paymentRepository: RetryReads,
    private readonly writes: CoreWrites,
    strategies: RetryStrategy[],
  ) {
    // A copy: `addRetryStrategy` and `updateRetryStrategy` change this instance only, never the
    // shared defaults or the caller's array
    this.strategies = structuredClone(strategies);
  }

  /**
   * Build the service. Returns it, or `payments.configuration_invalid` when a strategy has more than
   * 10 attempts or a delay that is not whole minutes from 0 to a year. `strategies` default to the
   * built-in ones; it holds at most `MAX_BATCH_ITEMS` (1,000) strategies.
   */
  static create(
    paymentProvider: RetryProvider,
    paymentRepository: RetryReads,
    writes: CoreWrites,
    strategies: RetryStrategy[] = DEFAULT_RETRY_STRATEGIES,
  ): PaymentRetryService | ConfigurationInvalid {
    const invalid = checkStrategies(strategies, 'retry.strategies');
    if (invalid) return invalid;
    return new PaymentRetryService(paymentProvider, paymentRepository, writes, strategies);
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

  /**
   * Run the retry attempts that are due, oldest first, and report what each did, in that order:
   *
   * - `succeeded`: the provider took the payment. A past due subscription is active again, and the
   *   payment's other pending attempts are cancelled.
   * - `failed`: the payment was not recovered. `failure` is the declined card (`payments.card_declined`),
   *   or `payment` is the provider's answer when it is not `succeeded` (its `failureReason` says why).
   *   The last attempt of a payment then marks the subscription past due.
   * - `cancelled`: nothing was charged: the subscription is no longer active or past due, the payment
   *   is gone or already succeeded, or an earlier attempt of this run recovered it.
   * - `refused`: the package returned a failure, in `failure`. The provider refused the call (such as
   *   `payments.configuration_invalid` from a `StripeProvider` built without `references`, or
   *   `payments.reference_not_found`), or the journal refused the write after it: the money came in
   *   but the subscription is still past due, or the last failed attempt could not mark it past due.
   * - `thrown`: the attempt threw (a fault), in `error`.
   *
   * The attempt itself says `failed` for `refused` and `thrown`, with the failure's message. One broken
   * attempt never stops the others.
   */
  async processRetries() {
    const current = now();
    const pendingRetries = [...this.retryAttempts.values()]
      .filter((attempt) => attempt.status === 'pending' && isSameOrBefore(attempt.scheduledFor, current))
      .toSorted((a, b) => toMillis(a.scheduledFor) - toMillis(b.scheduledFor));

    logger.debug('Processing {count} pending retry attempts', { count: pendingRetries.length });

    const reports = [];
    for (const attempt of pendingRetries) {
      reports.push(await this.runRetry(attempt));
    }
    return reports;
  }

  /** One due attempt, run and reported (see `processRetries`). */
  private async runRetry(attempt: RetryAttempt) {
    // An earlier attempt of this run recovered the payment and cancelled this one
    if (attempt.status !== 'pending') return { attemptId: attempt.id, status: 'cancelled' as const };
    try {
      const report = await this.executeRetry(attempt);
      if (report.status === 'refused') {
        logger.warn('Retry {attemptId} was refused: {code}', {
          attemptId: attempt.id,
          code: report.failure.code,
          failure: report.failure,
        });
      }
      return report;
    } catch (error) {
      // One broken attempt must not stop the others
      logger.error('Retry {attemptId} threw: {error}', {
        attemptId: attempt.id,
        error: error instanceof Error ? error : String(error),
      });
      attempt.status = 'failed';
      attempt.failureReason = error instanceof Error ? error.message : 'Unknown error';
      return { attemptId: attempt.id, status: 'thrown' as const, error };
    }
  }

  /** Run one attempt and report it (see `processRetries`); `attempt` says what happened, with the failure's message. */
  private async executeRetry(attempt: RetryAttempt) {
    const attemptId = attempt.id;
    attempt.status = 'executing';
    attempt.executedAt = now();

    const subscription = await this.paymentRepository.findSubscriptionById(attempt.subscriptionId);
    if (!subscription || !['active', 'past_due'].includes(subscription.status)) {
      attempt.status = 'cancelled';
      logger.debug('Cancelled retry {attemptId}: the subscription is no longer eligible', { attemptId });
      return { attemptId, status: 'cancelled' as const };
    }

    const payment = await this.paymentRepository.findPaymentById(attempt.paymentId);
    if (!payment || payment.status === 'succeeded') {
      attempt.status = 'cancelled';
      logger.debug('Cancelled retry {attemptId}: the payment is gone or already succeeded', { attemptId });
      return { attemptId, status: 'cancelled' as const };
    }

    logger.debug('Executing retry attempt {attemptNumber} for payment {paymentId}', {
      attemptNumber: attempt.attemptNumber,
      paymentId: attempt.paymentId,
    });

    const result = await this.paymentProvider.confirmPayment(attempt.paymentId);
    if (isFailure(result)) {
      attempt.status = 'failed';
      attempt.failureReason = result.message;
      // Any other provider failure (a bad config, a missing payment row) is the package refusing the call
      if (!CardDeclined.is(result)) return { attemptId, status: 'refused' as const, failure: result };

      logger.info('Retry {attemptId} failed: the card was declined', { attemptId });
      // A declined card is a failed retry like any other: the last one ends dunning
      const ended = await this.endDunningAfterLast(attempt);
      if (isFailure(ended)) return { attemptId, status: 'refused' as const, failure: ended };
      return { attemptId, status: 'failed' as const, failure: result };
    }

    if (result.status === 'succeeded') {
      attempt.status = 'succeeded';
      await this.cancelRetries(attempt.paymentId, attemptId);

      if (subscription.status === 'past_due') {
        const activated = await this.writes.activateSubscription({ subscriptionId: subscription.id });
        // The money came in, but the row could not follow: the attempt counts as failed, as when the write threw
        if (isFailure(activated)) {
          attempt.status = 'failed';
          attempt.failureReason = activated.message;
          return { attemptId, status: 'refused' as const, failure: activated };
        }
      }

      logger.info('Retry {attemptId} succeeded: payment {paymentId} recovered', {
        attemptId,
        paymentId: attempt.paymentId,
      });
      return { attemptId, status: 'succeeded' as const };
    }

    attempt.status = 'failed';
    attempt.failureReason = this.extractFailureReason(result);
    logger.info('Retry {attemptId} failed: {reason}', { attemptId, reason: attempt.failureReason });

    const ended = await this.endDunningAfterLast(attempt);
    if (isFailure(ended)) return { attemptId, status: 'refused' as const, failure: ended };
    return { attemptId, status: 'failed' as const, payment: result };
  }

  /**
   * After a failed attempt: when it was the payment's last, mark the subscription past due. Nothing,
   * or the failure of that write (then also the attempt's `failureReason`).
   */
  private async endDunningAfterLast(attempt: RetryAttempt) {
    if (!(await this.isLastAttempt(attempt.paymentId, attempt.attemptNumber))) return;
    const ended = await this.handleFinalFailure(attempt.paymentId, attempt.subscriptionId);
    if (isFailure(ended)) {
      attempt.failureReason = ended.message;
      return ended;
    }
    return;
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

  /**
   * Add a strategy, or replace the one with its name. Returns nothing, or `payments.configuration_invalid`
   * (and changes nothing) for a strategy with more than 10 attempts or a delay that is not whole minutes from 0 to a year.
   */
  addRetryStrategy(strategy: RetryStrategy): ConfigurationInvalid | undefined {
    const invalid = checkStrategies([strategy], 'retry.strategy');
    if (invalid) return invalid;
    const existingIndex = this.strategies.findIndex((s) => s.name === strategy.name);
    if (existingIndex === -1) {
      this.strategies.push(strategy);
    } else {
      this.strategies[existingIndex] = strategy;
    }
    return;
  }

  getRetryStrategies(): RetryStrategy[] {
    return [...this.strategies];
  }

  /**
   * Change the named strategy. Returns nothing, `payments.retry_strategy_not_found` when no strategy has this name,
   * or `payments.configuration_invalid` when the result breaks the rules of `addRetryStrategy`. A failure changes nothing.
   */
  updateRetryStrategy(
    name: string,
    updates: Partial<RetryStrategy>,
  ): ConfigurationInvalid | RetryStrategyMissing | undefined {
    const strategy = this.strategies.find((s) => s.name === name);
    if (!strategy) return RetryStrategyNotFound({ name });
    const invalid = checkStrategies([{ ...strategy, ...updates }], 'retry.strategy');
    if (invalid) return invalid;
    Object.assign(strategy, updates);
    return;
  }
}

export function createPaymentRetryService(
  paymentProvider: BasePaymentProvider,
  paymentRepository: PaymentRepository,
  writes: CoreWrites,
  strategies?: RetryStrategy[],
): PaymentRetryService | ConfigurationInvalid {
  return PaymentRetryService.create(paymentProvider, paymentRepository, writes, strategies);
}
