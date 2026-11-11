import type { Instant } from '@arki/date';
import { fromDate, isSameOrBefore, now, toDate, toMillis } from '@arki/date';
import type { Failure, FailureOf } from '@arki/failure';
import { z } from '@arki/contracts';
import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { CoreWrites } from '../journal.js';
import type { BasePaymentProvider } from '../providers/base-provider.js';
import type { PaymentRepository } from '../repository.js';
import type { PaymentId, SubscriptionId } from '../types.js';
import { PaymentsConfigurationInvalid } from '../failures.js';
import { paymentAmount } from '../money.js';
import { MAX_BATCH_ITEMS } from '../pg-values.js';
import { ReferenceNotFound } from '../providers/provider-error.js';

const logger = getLogger('arki:payments:dunning');

export type DunningRule = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: {
    event: 'payment_failed' | 'invoice_payment_failed' | 'subscription_past_due';
    delayDays: number;
  };
  action: {
    type: 'email' | 'retry_payment' | 'pause_subscription' | 'cancel_subscription' | 'webhook';
    config: Record<string, unknown>;
  };
  retryCount?: number;
  maxRetries?: number;
}

export type DunningConfiguration = {
  gracePeriodDays: number;
  maxRetryAttempts: number;
  retrySchedule: number[]; // Days after failure to retry
  emailTemplates: {
    paymentFailed: string;
    trialEnding: string;
    subscriptionPaused: string;
    finalNotice: string;
  };
  rules: DunningRule[];
}

export type DunningEvent = {
  id: string;
  subscriptionId: SubscriptionId;
  paymentId?: PaymentId;
  userId: string;
  eventType: 'payment_failed' | 'retry_scheduled' | 'grace_period_ended' | 'subscription_recovered';
  /** The rule step a scheduled event runs. A recovery event has none. */
  action?: DunningRule['action'];
  data: Record<string, unknown>;
  scheduledFor?: Instant;
  processedAt?: Instant;
  createdAt: Instant;
}

export type DunningStats = {
  totalFailedPayments: number;
  recoveredPayments: number;
  recoveryRate: number;
  subscriptionsInDunning: number;
  revenueAtRisk: number;
}

/** The email an `email` step sends: the customer's address, the step's template, and what it is about. */
export type DunningEmail = {
  to: string;
  template: string;
  subscriptionId: SubscriptionId;
  paymentId: PaymentId | undefined;
  userId: string;
};

/** The call a `webhook` step makes: the step's own config, and the subscription, payment and user it is about. */
export type DunningWebhookCall = {
  eventId: string;
  subscriptionId: SubscriptionId;
  paymentId: PaymentId | undefined;
  userId: string;
  config: Record<string, unknown>;
};

/**
 * How the app delivers the steps the package cannot send itself. Each returns `undefined` once
 * delivered, or a failure when the transport refused (logged, and the step counts as done); a
 * thrown error leaves the step scheduled for the next run. A rule whose step needs a sender that is
 * missing fails when the service is built.
 */
export type DunningSenders = {
  sendEmail?: (email: DunningEmail) => Promise<Failure | undefined>;
  sendWebhook?: (call: DunningWebhookCall) => Promise<Failure | undefined>;
};

/** An `email` step's config: the template the app's mailer sends. */
const emailStepConfigSchema = z.looseObject({ template: z.string().min(1) });

/** A `cancel_subscription` step's config: the reason sent to the provider, when it names one. */
const cancelStepConfigSchema = z.looseObject({ reason: z.string().min(1) });

/** A rule's delay: whole days from 0 to ten years, so the scheduled day is always a real date. */
const delayDaysSchema = z.number().int().min(0).max(3650);

type ConfigurationInvalid = FailureOf<typeof PaymentsConfigurationInvalid>;

/** A list of rules or retry days: at most `MAX_BATCH_ITEMS` (1,000) items. */
const configListSchema = z.array(z.unknown()).max(MAX_BATCH_ITEMS);

/**
 * Nothing, or `payments.configuration_invalid` when `rules` or `retrySchedule` holds more than
 * `MAX_BATCH_ITEMS` items, an enabled rule needs a sender the app did not pass, an `email` rule
 * names no template, or a rule's `trigger.delayDays` is not a whole number from 0 to 3650. Runs
 * when the service is built and when its configuration changes.
 */
function checkConfiguration(
  config: Pick<DunningConfiguration, 'rules' | 'retrySchedule'>,
  senders: DunningSenders,
): ConfigurationInvalid | undefined {
  for (const [setting, list] of [['rules', config.rules], ['retrySchedule', config.retrySchedule]] as const) {
    if (!configListSchema.safeParse(list).success) {
      return PaymentsConfigurationInvalid({ setting, problem: `at most ${MAX_BATCH_ITEMS} items` });
    }
  }
  for (const rule of config.rules) {
    if (!delayDaysSchema.safeParse(rule.trigger.delayDays).success) {
      return PaymentsConfigurationInvalid({
        setting: `rules.${rule.id}.trigger.delayDays`,
        problem: 'a delay is a whole number of days from 0 to 3650',
      });
    }
    if (!rule.enabled) continue;
    const { type, config: step } = rule.action;
    if (type === 'email') {
      if (!senders.sendEmail) {
        return PaymentsConfigurationInvalid({ setting: 'senders.sendEmail', problem: `rule ${rule.id} sends email` });
      }
      if (!emailStepConfigSchema.safeParse(step).success) {
        return PaymentsConfigurationInvalid({
          setting: `rules.${rule.id}.action.config.template`,
          problem: 'an email step needs a template name',
        });
      }
    }
    if (type === 'webhook' && !senders.sendWebhook) {
      return PaymentsConfigurationInvalid({ setting: 'senders.sendWebhook', problem: `rule ${rule.id} calls a webhook` });
    }
  }
  return;
}

const DEFAULT_DUNNING_CONFIG: DunningConfiguration = {
  gracePeriodDays: 7,
  maxRetryAttempts: 3,
  retrySchedule: [1, 3, 7], // Retry after 1, 3, and 7 days
  emailTemplates: {
    paymentFailed: 'payment_failed_template',
    trialEnding: 'trial_ending_template',
    subscriptionPaused: 'subscription_paused_template',
    finalNotice: 'final_notice_template',
  },
  rules: [
    {
      id: 'initial_payment_failure',
      name: 'Initial Payment Failure',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 0,
      },
      action: {
        type: 'email',
        config: { template: 'payment_failed_template' },
      },
    },
    {
      id: 'retry_payment_day_1',
      name: 'Retry Payment - Day 1',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 1,
      },
      action: {
        type: 'retry_payment',
        config: { attempt: 1 },
      },
    },
    {
      id: 'retry_payment_day_3',
      name: 'Retry Payment - Day 3',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 3,
      },
      action: {
        type: 'retry_payment',
        config: { attempt: 2 },
      },
    },
    {
      id: 'final_notice_day_7',
      name: 'Final Notice - Day 7',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 7,
      },
      action: {
        type: 'email',
        config: { template: 'final_notice_template' },
      },
    },
    {
      id: 'pause_subscription_day_10',
      name: 'Pause Subscription - Day 10',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 10,
      },
      action: {
        type: 'pause_subscription',
        config: {},
      },
    },
    {
      id: 'cancel_subscription_day_30',
      name: 'Cancel Subscription - Day 30',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 30,
      },
      action: {
        type: 'cancel_subscription',
        config: { reason: 'payment_failure' },
      },
    },
  ],
};

/** The provider calls dunning makes. A `BasePaymentProvider` fits. */
type DunningProvider = Pick<BasePaymentProvider, 'confirmPayment' | 'pauseSubscription' | 'cancelSubscription'>;

/** The repository reads dunning makes. A `PaymentRepository` fits. */
type DunningReads = Pick<
  PaymentRepository,
  'findPaymentById' | 'findSubscriptionById' | 'findCustomerById' | 'getPaymentStats' | 'getSubscriptionStats'
>;

/**
 * The schedule of dunning steps lives in memory. Every change of a
 * `subscriptions` row goes through `writes`: one journal command each.
 */
export class DunningService {
  private config: DunningConfiguration;
  private dunningEvents = new Map<string, DunningEvent>();

  /** Use `DunningService.create`: it checks the configuration first. */
  private constructor(
    private readonly paymentProvider: DunningProvider,
    private readonly paymentRepository: DunningReads,
    private readonly writes: CoreWrites,
    config: DunningConfiguration,
    private readonly senders: DunningSenders,
  ) {
    this.config = config;
  }

  /**
   * Build the service. Returns it, or `payments.configuration_invalid` when an enabled rule needs a
   * sender that `senders` lacks, a rule's delay is not whole days from 0 to 3650, or `rules` or
   * `retrySchedule` holds more than `MAX_BATCH_ITEMS` (1,000) items.
   */
  static create(
    paymentProvider: DunningProvider,
    paymentRepository: DunningReads,
    writes: CoreWrites,
    config: Partial<DunningConfiguration> = {},
    senders: DunningSenders = {},
  ): DunningService | ConfigurationInvalid {
    const resolved = { ...DEFAULT_DUNNING_CONFIG, ...config };
    const invalid = checkConfiguration(resolved, senders);
    if (invalid) return invalid;
    return new DunningService(paymentProvider, paymentRepository, writes, resolved, senders);
  }

  /**
   * Handle a payment failure and initiate dunning process. Returns nothing, or a failure:
   * `ReferenceNotFound` for an unknown payment or subscription, or the refusal of the journal write
   * that marks the subscription `past_due` (a canceled one, say). Nothing is scheduled then: the
   * steps are scheduled only once the subscription is stored as past due.
   */
  async handlePaymentFailure(
    paymentId: PaymentId,
    subscriptionId: SubscriptionId,
    failureReason?: string,
  ) {
    const payment = await this.paymentRepository.findPaymentById(paymentId);
    if (!payment) return ReferenceNotFound({ kind: 'payment', id: paymentId, missing: 'row' });
    const subscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
    if (!subscription) return ReferenceNotFound({ kind: 'subscription', id: subscriptionId, missing: 'row' });

    // Update subscription status to past_due. A refused write schedules nothing: the steps would
    // retry, pause or cancel a subscription the journal says is not past due.
    const marked = await this.writes.markSubscriptionPastDue({ subscriptionId });
    if (isFailure(marked)) return marked;

    // Create dunning events based on configured rules
    const failureDate = now();
    for (const rule of this.config.rules.filter(r => r.enabled && r.trigger.event === 'payment_failed')) {
      // Local-time calendar days, as before: the working value stays a `Date` until it is stored.
      const scheduledDate = toDate(failureDate);
      scheduledDate.setDate(scheduledDate.getDate() + rule.trigger.delayDays);

      const dunningEvent: DunningEvent = {
        id: `${paymentId}_${rule.id}_${Date.now()}`,
        subscriptionId,
        paymentId,
        userId: subscription.userId,
        eventType: 'payment_failed',
        action: rule.action,
        data: {
          ruleId: rule.id,
          ruleName: rule.name,
          failureReason,
          attempt: rule.retryCount || 0,
        },
        scheduledFor: fromDate(scheduledDate),
        createdAt: failureDate,
      };

      this.dunningEvents.set(dunningEvent.id, dunningEvent);
    }

    logger.debug('Initiated dunning for payment {paymentId} on subscription {subscriptionId}', {
      paymentId,
      subscriptionId,
    });
    return;
  }

  /**
   * Run the dunning steps that are due, oldest first, and report what each did, in that order:
   *
   * - `done`: the step ran.
   * - `refused`: the step returned a failure (the provider refused the pause, cancel or retry, the
   *   journal refused the write, a sender failed, or a row is gone). It is not run again; `failure`
   *   says why, so the caller can act on it (the subscription may still be `past_due`).
   * - `thrown`: the step threw (a fault). It stays scheduled and runs again on the next call.
   *
   * One broken step never stops the others.
   */
  async processDunningEvents() {
    const current = now();
    const eventsToProcess = [...this.dunningEvents.values()]
      .filter(event => !event.processedAt && event.scheduledFor && isSameOrBefore(event.scheduledFor, current))
      .toSorted((a, b) => (a.scheduledFor ? toMillis(a.scheduledFor) : 0) - (b.scheduledFor ? toMillis(b.scheduledFor) : 0));

    const reports = [];
    for (const event of eventsToProcess) {
      reports.push(await this.runStep(event));
    }
    return reports;
  }

  /** One due step, run and reported (see `processDunningEvents`). */
  private async runStep(event: DunningEvent) {
    try {
      const processed = await this.processEvent(event);
      event.processedAt = now();
      if (isFailure(processed)) {
        logger.warn('Dunning event {eventId} was refused: {code}', { eventId: event.id, code: processed.code });
        return { eventId: event.id, status: 'refused' as const, failure: processed };
      }
      logger.debug('Processed dunning event {eventId}', { eventId: event.id });
      return { eventId: event.id, status: 'done' as const };
    } catch (error) {
      logger.error('Dunning event {eventId} failed and stays scheduled: {error}', {
        eventId: event.id,
        error: error instanceof Error ? error : String(error),
      });
      return { eventId: event.id, status: 'thrown' as const, error };
    }
  }

  /** Process an individual dunning event. Nothing, or the failure that refused it. */
  private async processEvent(event: DunningEvent) {
    const { action } = event;
    if (action === undefined) return;

    switch (action.type) {
      case 'email': {
        return this.sendDunningEmail(event, action.config);
      }

      case 'retry_payment': {
        return this.retryPayment(event, action.config);
      }

      case 'pause_subscription': {
        return this.pauseSubscription(event);
      }

      case 'cancel_subscription': {
        return this.cancelSubscription(event, action.config);
      }

      case 'webhook': {
        return this.triggerWebhook(event, action.config);
      }

      default: {
        logger.warn('Unknown dunning action type {type} in event {eventId}', { type: action.type, eventId: event.id });
      }
    }
    return;
  }

  /**
   * Send the step's email to the subscription's customer through the app's `sendEmail`. Nothing, the
   * sender's failure, or `ReferenceNotFound` when the subscription or its customer is gone.
   */
  private async sendDunningEmail(event: DunningEvent, config: Record<string, unknown>) {
    const { sendEmail } = this.senders;
    // Checked when the rules were set: an enabled email rule always has a sender and a template
    const step = emailStepConfigSchema.safeParse(config);
    if (!sendEmail || !step.success) {
      return PaymentsConfigurationInvalid({ setting: 'senders.sendEmail', problem: 'an email step ran without a sender' });
    }

    const subscription = await this.paymentRepository.findSubscriptionById(event.subscriptionId);
    if (!subscription) return ReferenceNotFound({ kind: 'subscription', id: event.subscriptionId, missing: 'row' });
    const customer = await this.paymentRepository.findCustomerById(subscription.customerId);
    if (!customer) return ReferenceNotFound({ kind: 'customer', id: subscription.customerId, missing: 'row' });

    return sendEmail({
      to: customer.email,
      template: step.data.template,
      subscriptionId: event.subscriptionId,
      paymentId: event.paymentId,
      userId: event.userId,
    });
  }

  /**
   * Retry failed payment. Nothing (the retry ran; a payment that is still not paid is logged), or
   * the failure that refused it: `ReferenceNotFound` when the event names no payment or an unknown
   * one, the provider's refusal of the retry, or the journal's refusal to reactivate the subscription
   * after the money came in (a canceled subscription stays canceled).
   */
  private async retryPayment(event: DunningEvent, _config: Record<string, unknown>) {
    if (!event.paymentId) {
      return ReferenceNotFound({ kind: 'payment', id: event.id, missing: 'row' });
    }

    const payment = await this.paymentRepository.findPaymentById(event.paymentId);
    if (!payment) {
      return ReferenceNotFound({ kind: 'payment', id: event.paymentId, missing: 'row' });
    }

    // Attempt to retry the payment through the provider
    const retryResult = await this.paymentProvider.confirmPayment(event.paymentId);
    if (isFailure(retryResult)) return retryResult;

    if (retryResult.status === 'succeeded') {
      // Payment recovered - update subscription status.
      // A canceled subscription stays canceled: the command refuses, and the refusal is returned.
      const activated = await this.writes.activateSubscription({ subscriptionId: event.subscriptionId });
      if (isFailure(activated)) return activated;

      // Remove remaining dunning events for this subscription
      this.cancelDunningEventsForSubscription(event.subscriptionId);

      logger.info('Payment {paymentId} recovered on retry', { paymentId: event.paymentId });
    } else {
      logger.info('Payment retry for {paymentId} ended {status}', {
        paymentId: event.paymentId,
        status: retryResult.status,
      });
    }
    return;
  }

  /**
   * Pause subscription due to payment failure. Nothing, or the failure that refused it: the
   * provider's (the row is left as it is) or the journal's.
   */
  private async pauseSubscription(event: DunningEvent) {
    const paused = await this.paymentProvider.pauseSubscription(event.subscriptionId);
    // The provider did not pause it, so the row must not say paused
    if (isFailure(paused)) return paused;

    // Update local database
    const stored = await this.writes.pauseSubscription({ subscriptionId: event.subscriptionId });
    if (isFailure(stored)) return stored;

    logger.info('Paused subscription {subscriptionId} after a failed payment', {
      subscriptionId: event.subscriptionId,
    });
    return;
  }

  /**
   * Cancel subscription due to payment failure. Nothing, or the failure that refused it: the
   * provider's (the row is left as it is) or the journal's.
   */
  private async cancelSubscription(event: DunningEvent, config: Record<string, unknown>) {
    const step = cancelStepConfigSchema.safeParse(config);
    const canceled = await this.paymentProvider.cancelSubscription(event.subscriptionId, {
      immediately: true,
      reason: step.success ? step.data.reason : 'payment_failure',
    });
    // The provider did not cancel it, so the row must not say canceled
    if (isFailure(canceled)) return canceled;

    // Update local database
    const stored = await this.writes.cancelSubscription({
      subscriptionId: event.subscriptionId,
      status: 'canceled',
      canceledAt: now(),
    });
    if (isFailure(stored)) return stored;

    // Remove remaining dunning events
    this.cancelDunningEventsForSubscription(event.subscriptionId);

    logger.info('Canceled subscription {subscriptionId} after a failed payment', {
      subscriptionId: event.subscriptionId,
    });
    return;
  }

  /** Hand the step to the app's `sendWebhook`. Nothing, or the sender's failure. */
  private async triggerWebhook(event: DunningEvent, config: Record<string, unknown>) {
    const { sendWebhook } = this.senders;
    // Checked when the rules were set: an enabled webhook rule always has a sender
    if (!sendWebhook) {
      return PaymentsConfigurationInvalid({ setting: 'senders.sendWebhook', problem: 'a webhook step ran without a sender' });
    }

    return sendWebhook({
      eventId: event.id,
      subscriptionId: event.subscriptionId,
      paymentId: event.paymentId,
      userId: event.userId,
      config,
    });
  }

  /**
   * Cancel all pending dunning events for a subscription
   */
  private cancelDunningEventsForSubscription(subscriptionId: SubscriptionId): void {
    for (const [eventId] of [...this.dunningEvents.entries()]
      .filter(([_, event]) => event.subscriptionId === subscriptionId && !event.processedAt)) {
        this.dunningEvents.delete(eventId);
      }
  }

  /**
   * Handle subscription recovery (payment succeeded after failure)
   */
  /** Nothing, or the failure of the write: a canceled subscription is not brought back. */
  async handleSubscriptionRecovery(subscriptionId: SubscriptionId) {
    // Cancel remaining dunning events
    this.cancelDunningEventsForSubscription(subscriptionId);

    // Update subscription status. A canceled subscription is not brought back: the command refuses.
    const activated = await this.writes.activateSubscription({ subscriptionId });
    if (isFailure(activated)) return activated;

    // Create recovery event for analytics
    const recoveryEvent: DunningEvent = {
      id: `recovery_${subscriptionId}_${Date.now()}`,
      subscriptionId,
      userId: activated.userId,
      eventType: 'subscription_recovered',
      data: { recoveredAt: now() },
      createdAt: now(),
    };

    this.dunningEvents.set(recoveryEvent.id, recoveryEvent);

    logger.info('Subscription {subscriptionId} recovered from dunning', { subscriptionId });
    return;
  }

  /**
   * Get dunning statistics for analytics. A time given falls in the years 1 to 9999 (a precondition: anything else throws an invariant failure).
   */
  async getDunningStats(startDate?: Instant, endDate?: Instant): Promise<DunningStats> {
    const payments = await this.paymentRepository.getPaymentStats(startDate, endDate);
    const subscriptions = await this.paymentRepository.getSubscriptionStats(startDate, endDate);

    const failedPayments = payments.filter(p => p.status === 'failed');
    void payments.filter(p => p.status === 'succeeded'); // For future use
    const pastDueSubscriptions = subscriptions.filter(s => s.status === 'past_due');

    // Calculate recovery metrics from dunning events
    const recoveryEvents = [...this.dunningEvents.values()]
      .filter(e => e.eventType === 'subscription_recovered');

    const totalFailedPayments = failedPayments.length;
    const recoveredPayments = recoveryEvents.length;
    const recoveryRate = totalFailedPayments > 0 ? (recoveredPayments / totalFailedPayments) * 100 : 0;

    const revenueAtRisk = failedPayments.reduce((sum, p) => sum + paymentAmount(p).toNumber(), 0);

    return {
      totalFailedPayments,
      recoveredPayments,
      recoveryRate: Math.round(recoveryRate * 100) / 100,
      subscriptionsInDunning: pastDueSubscriptions.length,
      revenueAtRisk: Math.round(revenueAtRisk * 100) / 100,
    };
  }

  /**
   * Get pending dunning events for a subscription
   */
  getPendingEventsForSubscription(subscriptionId: SubscriptionId): DunningEvent[] {
    return [...this.dunningEvents.values()]
      .filter(event => event.subscriptionId === subscriptionId && !event.processedAt)
      .toSorted((a, b) => (a.scheduledFor ? toMillis(a.scheduledFor) : 0) - (b.scheduledFor ? toMillis(b.scheduledFor) : 0));
  }

  /**
   * Update dunning configuration
   */
  /**
   * Returns nothing, or `payments.configuration_invalid` (and keeps the old configuration) when a new
   * rule needs a missing sender, has a delay outside whole days from 0 to 3650, or `rules` or
   * `retrySchedule` holds more than `MAX_BATCH_ITEMS` (1,000) items.
   */
  updateConfiguration(config: Partial<DunningConfiguration>): ConfigurationInvalid | undefined {
    const next = { ...this.config, ...config };
    const invalid = checkConfiguration(next, this.senders);
    if (invalid) return invalid;
    this.config = next;
    return;
  }

  /**
   * Get current dunning configuration
   */
  getConfiguration(): DunningConfiguration {
    return { ...this.config };
  }
}

export function createDunningService(
  paymentProvider: BasePaymentProvider,
  paymentRepository: PaymentRepository,
  writes: CoreWrites,
  config?: Partial<DunningConfiguration>,
  senders?: DunningSenders,
): DunningService | ConfigurationInvalid {
  return DunningService.create(paymentProvider, paymentRepository, writes, config, senders);
}