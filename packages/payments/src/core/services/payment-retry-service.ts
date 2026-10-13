import type { Instant } from '@arki/date';
import { add, isSameOrBefore, now, toMillis } from '@arki/date';

import type { CoreWrites } from '../journal.js';
import type { BasePaymentProvider } from '../providers/base-provider.js';
import type { PaymentRepository } from '../repository.js';
import type { Payment, PaymentId, PlanId, Subscription, SubscriptionId } from '../types.js';

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
  revenueRecovered: number;
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

  async scheduleRetries(paymentId: PaymentId, failureReason: string): Promise<RetryAttempt[]> {
    try {
      const payment = await this.paymentRepository.findPaymentById(paymentId);
      if (!payment) {
        throw new Error('Payment not found');
      }

      if (!payment.subscriptionId) {
        throw new Error('Payment must be associated with a subscription for retries');
      }

      // Minimal subscription used for strategy selection — real implementation
      // would load via subscription repository.
      const subscription: Subscription = {
        id: payment.subscriptionId,
        userId: payment.userId,
        status: 'active',
        currentPeriodStart: now(),
        currentPeriodEnd: now(),
        planId: 'default_plan_id' as PlanId,
        customerId: payment.customerId,
        providerSubscriptionId: 'default_provider_id',
        cancelAtPeriodEnd: false,
        metadata: null,
        trialStart: null,
        trialEnd: null,
        canceledAt: null,
        createdAt: now(),
        updatedAt: now(),
      };

      const domainPayment: Payment = {
        ...payment,
        subscriptionId: payment.subscriptionId ?? null,
        description: payment.description ?? null,
        failureReason: payment.failureReason ?? null,
        receiptUrl: payment.receiptUrl ?? null,
        metadata: payment.metadata ?? null,
      };

      const strategy = this.selectRetryStrategy(domainPayment, failureReason, subscription);
      if (!strategy) {
        console.log(
          `No retry strategy found for payment ${paymentId} with failure reason: ${failureReason}`,
        );
        return [];
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

      console.log(
        `Scheduled ${retryAttempts.length} retry attempts for payment ${paymentId} using strategy: ${strategy.name}`,
      );
      return retryAttempts;
    } catch (error) {
      console.error(`Failed to schedule retries for payment ${paymentId}:`, error);
      throw error;
    }
  }

  async processRetries(): Promise<void> {
    const current = now();
    const pendingRetries = [...this.retryAttempts.values()]
      .filter((attempt) => attempt.status === 'pending' && isSameOrBefore(attempt.scheduledFor, current))
      .sort((a, b) => toMillis(a.scheduledFor) - toMillis(b.scheduledFor));

    console.log(`Processing ${pendingRetries.length} pending retry attempts`);

    for (const attempt of pendingRetries) {
      try {
        await this.executeRetry(attempt);
      } catch (error) {
        console.error(`Failed to execute retry ${attempt.id}:`, error);
        attempt.status = 'failed';
        attempt.failureReason = error instanceof Error ? error.message : 'Unknown error';
      }
    }
  }

  private async executeRetry(attempt: RetryAttempt): Promise<void> {
    attempt.status = 'executing';
    attempt.executedAt = now();

    try {
      const subscription = await this.paymentRepository.findSubscriptionById(attempt.subscriptionId);
      if (!subscription || !['active', 'past_due'].includes(subscription.status)) {
        attempt.status = 'cancelled';
        console.log(`Cancelled retry ${attempt.id} - subscription no longer eligible`);
        return;
      }

      const payment = await this.paymentRepository.findPaymentById(attempt.paymentId);
      if (!payment || payment.status === 'succeeded') {
        attempt.status = 'cancelled';
        console.log(`Cancelled retry ${attempt.id} - payment already succeeded`);
        return;
      }

      console.log(`Executing retry attempt ${attempt.attemptNumber} for payment ${attempt.paymentId}`);

      const result = await this.paymentProvider.confirmPayment(attempt.paymentId);

      if (result.status === 'succeeded') {
        attempt.status = 'succeeded';
        await this.cancelRetries(attempt.paymentId, attempt.id);

        if (subscription.status === 'past_due') {
          await this.writes.activateSubscription({ subscriptionId: subscription.id });
        }

        console.log(`Retry attempt ${attempt.id} succeeded - payment recovered`);
      } else {
        attempt.status = 'failed';
        attempt.failureReason = this.extractFailureReason(result);

        console.log(`Retry attempt ${attempt.id} failed: ${attempt.failureReason}`);

        if (await this.isLastAttempt(attempt.paymentId, attempt.attemptNumber)) {
          await this.handleFinalFailure(attempt.paymentId, attempt.subscriptionId);
        }
      }
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

  private async handleFinalFailure(
    paymentId: PaymentId,
    subscriptionId: SubscriptionId,
  ): Promise<void> {
    console.log(`All retry attempts exhausted for payment ${paymentId}`);

    await this.writes.markSubscriptionPastDue({ subscriptionId });
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

    console.log(`Cancelled ${retriesToCancel.length} pending retry attempts for payment ${paymentId}`);
  }

  getRetryAttempts(paymentId: PaymentId): RetryAttempt[] {
    return [...this.retryAttempts.values()]
      .filter((attempt) => attempt.paymentId === paymentId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async getRetryAnalytics(startDate?: Instant, endDate?: Instant): Promise<RetryAnalytics> {
    const allRetries = [...this.retryAttempts.values()];

    const filteredRetries =
      startDate || endDate
        ? allRetries.filter((attempt) => {
            const date = attempt.createdAt;
            return (!startDate || date >= startDate) && (!endDate || date <= endDate);
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

    const revenueRecovered = successfulRetries * 50;

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
