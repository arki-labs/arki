import { EventEmitter } from 'node:events';

import { now, sub } from '@arki/date';
import { getLogger } from '@arki/log';
import { fromStripeAmount } from '@arki/money/stripe';

import type { CoreWrites } from '../journal.js';
import type { RefundWrites } from '../../refunds/journal.js';
import type { RefundRepository } from '../../refunds/repository.js';
import type { PaymentRepository } from '../repository.js';
import type { PaymentProviderType, PaymentStatus, WebhookEventType, WebhookId } from '../types.js';
import type { StripeChargeRefund } from './webhook-event-payloads.js';
import type { WebhookSecurityService } from './webhook-security.js';
import { refundIdSchema } from '../../refunds/primitives.js';
import { createWebhookId } from '../primitives.js';
import {
  parseStripeCharge,
  parseStripeDispute,
  parseStripePaymentIntent,
  parseStripeRefund,
  parseStripeSubscription,
} from './webhook-event-payloads.js';

/** Logs ids and event types only, never event data. */
const logger = getLogger('arki:payments:webhook');

/** The storage the handler needs: the event claims, and the two lookups by provider id. A `PaymentRepository` satisfies it. */
export type WebhookEventStore = Pick<
  PaymentRepository,
  | 'claimWebhookEvent'
  | 'reclaimWebhookEvent'
  | 'markWebhookEventAsProcessed'
  | 'findUnprocessedWebhookEvents'
  | 'updateWebhookEvent'
  | 'findSubscriptionByProviderSubscriptionId'
  | 'findPaymentByProviderPaymentId'
>;

/** The validation the handler needs. A `WebhookSecurityService` satisfies it. */
export type WebhookValidator = Pick<WebhookSecurityService, 'validateWebhook'>;

/** The journal writes the handler makes. A `CoreWrites` satisfies it. */
export type WebhookWrites = Pick<
  CoreWrites,
  | 'syncSubscription'
  | 'completePayment'
  | 'failPayment'
  | 'markPaymentRequiresAction'
  | 'recordPaymentRefund'
  | 'recordPaymentDispute'
>;

/**
 * What the handler needs to line a provider refund up with a `refunds` row. A `RefundRepository`
 * and `refundsJournal.writes(run)` satisfy it. Apps without the refunds module leave it out.
 */
export type WebhookRefunds = {
  reads: Pick<RefundRepository, 'findById' | 'findByProviderRefundId'>;
  writes: Pick<RefundWrites, 'completeRefund'>;
};

/** What a payment event says happened at the provider. */
type PaymentOutcome = 'succeeded' | 'failed' | 'requires_action';

/**
 * The local statuses each outcome moves a payment from; the same rules as the
 * commands. A `failed` payment can still succeed (the customer retried on the
 * same PaymentIntent); a `succeeded` one never fails. Any other status: the
 * event changes nothing, so a late, repeated or out-of-order event is safe.
 */
const paymentMovesFrom: Record<PaymentOutcome, readonly PaymentStatus[]> = {
  succeeded: ['pending', 'processing', 'requires_action', 'failed'],
  failed: ['pending', 'processing', 'requires_action'],
  requires_action: ['pending', 'processing'],
};

export type WebhookProcessingResult = {
  success: boolean;
  webhookId?: WebhookId;
  error?: string;
  retryable?: boolean;
}

export type WebhookEventData = {
  type: WebhookEventType;
  provider: PaymentProviderType;
  data: Record<string, unknown>;
  webhookId: WebhookId;
}

export type WebhookHandlerConfig = {
  /** Attempts after which an unprocessed event is given up on, and the provider told to stop resending. */
  maxRetries: number;
  retryDelayMs: number;
  /**
   * Answer before the event is processed. Off by default: the provider's
   * resends are the retry mechanism, and they only happen when the answer
   * says the event failed. An early answer turns every processing failure
   * into a lost event.
   */
  enableAsync: boolean;
  enableEventEmitter: boolean;
  /**
   * How long an attempt may run before another delivery may take the event
   * over. An attempt older than this with no recorded error is treated as
   * crashed.
   */
  processingLeaseMs: number;
  /** Skip the source-address check. For routes with no real client address; the signature check still runs. */
  skipIpValidation: boolean;
}

export class WebhookHandler extends EventEmitter {
  private readonly config: WebhookHandlerConfig;
  private readonly eventHandlers = new Map<WebhookEventType, (data: WebhookEventData) => Promise<void>>();

  constructor(
    private readonly paymentRepository: WebhookEventStore,
    private readonly webhookSecurity: WebhookValidator,
    /** Every change of a `payments` or `subscriptions` row goes through the journal: `paymentsJournal.writes(run)`. */
    private readonly writes: WebhookWrites,
    config: Partial<WebhookHandlerConfig> = {},
    private readonly refunds?: WebhookRefunds,
  ) {
    super();
    this.config = {
      maxRetries: 3,
      retryDelayMs: 1000,
      enableAsync: false,
      enableEventEmitter: true,
      processingLeaseMs: 5 * 60 * 1000,
      skipIpValidation: false,
      ...config,
    };

    this.setupEventHandlers();
  }

  async processWebhook(
    provider: PaymentProviderType,
    payload: string | Buffer,
    signature: string,
    timestamp: string,
    sourceIp: string,
    webhookSecret: string,
  ): Promise<WebhookProcessingResult> {
    try {
      // 1. Validate webhook security
      const validation = await this.webhookSecurity.validateWebhook(
        provider,
        payload,
        signature,
        timestamp,
        sourceIp,
        webhookSecret,
        { skipIpValidation: this.config.skipIpValidation },
      );

      if (!validation.isValid) {
        return {
          success: false,
          error: validation.error || 'Webhook validation failed',
          retryable: false,
        };
      }

      // 2. Parse event data
      const eventData = this.parseEventData(payload);
      if (!eventData.type || !eventData.id) {
        return {
          success: false,
          error: 'Invalid webhook payload: missing type or id',
          retryable: false,
        };
      }

      // 3. An event type we do not handle: acknowledge it, store nothing.
      const eventType = validation.eventType;
      if (!eventType) {
        logger.debug('Ignoring unhandled webhook event type {type}', { type: eventData.type });
        return { success: true, error: `Unhandled event type: ${eventData.type}` };
      }

      // 4. Claim the event. Only the delivery whose insert wins goes on to
      //    process it; the database's unique index decides, so this holds
      //    across concurrent requests and across server instances.
      //    `attempts` counts started attempts.
      const data = validation.data || {};
      const { event, created } = await this.paymentRepository.claimWebhookEvent({
        id: createWebhookId(),
        provider,
        eventType,
        providerEventId: eventData.id,
        data,
        processed: false,
        attempts: 1,
        lastAttemptAt: now(),
        sourceIp,
        createdAt: now(),
        updatedAt: now(),
      });
      const webhookId = event.id;

      if (!created) {
        if (event.processed) {
          return { success: true, webhookId, error: 'Event already processed' };
        }
        if (event.attempts >= this.config.maxRetries) {
          logger.error('Webhook {webhookId} given up after {attempts} attempts', {
            webhookId,
            attempts: event.attempts,
          });
          return { success: false, webhookId, retryable: false, error: 'Max retry attempts exceeded' };
        }
        // A resend of an event that failed or whose attempt crashed takes it
        // over; a resend of one still inside its lease asks to be resent later.
        const reclaimed = await this.paymentRepository.reclaimWebhookEvent(
          webhookId,
          event.attempts,
          this.leaseCutoff(),
        );
        if (!reclaimed) {
          logger.debug('Webhook {webhookId} is being processed; asking for a resend', { webhookId });
          return { success: false, webhookId, retryable: true, error: 'Event is being processed' };
        }
      }

      // 5. Process the event. A failure is recorded on the row and answered
      //    as retryable, so the provider's resend takes it over.
      if (this.config.enableAsync) {
        void this.processEventAsync(webhookId, eventType, provider, data);
      } else {
        await this.runClaimed(webhookId, eventType, provider, data);
      }
      return { success: true, webhookId };
    } catch (error) {
      return {
        success: false,
        error: `Webhook processing error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        retryable: true,
      };
    }
  }

  /**
   * Re-run failed or crashed events without waiting for a resend. Optional:
   * provider resends already do this. Uses the same takeover as a resend, so
   * it never runs an event whose attempt is still inside its lease.
   */
  async retryFailedWebhooks(): Promise<void> {
    try {
      const unprocessedEvents = await this.paymentRepository.findUnprocessedWebhookEvents();

      for (const event of unprocessedEvents) {
        if (event.attempts < this.config.maxRetries) {
          const reclaimed = await this.paymentRepository.reclaimWebhookEvent(
            event.id,
            event.attempts,
            this.leaseCutoff(),
          );
          if (!reclaimed) {
            continue;
          }
          try {
            await this.runClaimed(event.id, event.eventType, event.provider, event.data);
          } catch (error) {
            this.emit('webhook:processing_error', {
              webhookId: event.id,
              eventType: event.eventType,
              provider: event.provider,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        } else {
          // Mark as failed after max retries
          await this.paymentRepository.updateWebhookEvent(event.id, {
            errorMessage: 'Max retry attempts exceeded',
          });

          this.emit('webhook:failed', {
            webhookId: event.id,
            eventType: event.eventType,
            provider: event.provider,
            error: 'Max retry attempts exceeded',
          });
        }
      }
    } catch (error) {
      this.emit('webhook:retry_error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async processEventAsync(
    webhookId: WebhookId,
    eventType: WebhookEventType,
    provider: PaymentProviderType,
    data: Record<string, unknown>,
  ): Promise<void> {
    // Process in background
    setImmediate(async () => {
      try {
        await this.runClaimed(webhookId, eventType, provider, data);
      } catch (error) {
        this.emit('webhook:processing_error', {
          webhookId,
          eventType,
          provider,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
  }

  /** The moment before which an attempt with no recorded error counts as crashed. */
  private leaseCutoff() {
    return sub(now(), { milliseconds: this.config.processingLeaseMs });
  }

  /**
   * Run an event this caller has claimed. On failure, record the error on the
   * row, so the next resend may take the event over, and rethrow.
   */
  private async runClaimed(
    webhookId: WebhookId,
    eventType: WebhookEventType,
    provider: PaymentProviderType,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.processEvent(webhookId, eventType, provider, data);
    } catch (error) {
      await this.paymentRepository.updateWebhookEvent(webhookId, {
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });
      logger.warn('Webhook {webhookId} failed; a resend may retry it', { webhookId });
      throw error;
    }
  }

  private async processEvent(
    webhookId: WebhookId,
    eventType: WebhookEventType,
    provider: PaymentProviderType,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      const eventData: WebhookEventData = {
        type: eventType,
        provider,
        data,
        webhookId,
      };

      // Execute specific event handler
      const handler = this.eventHandlers.get(eventType);
      if (handler) {
        await handler(eventData);
      } else {
        logger.warn('No handler for webhook event type {eventType}', { eventType });
      }

      // Mark as processed
      await this.paymentRepository.markWebhookEventAsProcessed(webhookId);

      // Emit success event
      if (this.config.enableEventEmitter) {
        this.emit('webhook:processed', eventData);
        this.emit(`webhook:${eventType}`, eventData);
      }
    } catch (error) {
      throw error;
    }
  }

  private parseEventData(payload: string | Buffer): { type: string; id: string; data: Record<string, unknown> } {
    try {
      const payloadStr = typeof payload === 'string' ? payload : payload.toString();
      return JSON.parse(payloadStr);
    } catch {
      return { type: '', id: '', data: {} };
    }
  }

  private setupEventHandlers(): void {
    // Subscription events
    this.eventHandlers.set('subscription.created', async (data: WebhookEventData) => {
      await this.handleSubscriptionCreated(data);
    });

    this.eventHandlers.set('subscription.updated', async (data: WebhookEventData) => {
      await this.handleSubscriptionUpdated(data);
    });

    this.eventHandlers.set('subscription.canceled', async (data: WebhookEventData) => {
      await this.handleSubscriptionCanceled(data);
    });

    this.eventHandlers.set('subscription.trial_will_end', async (data: WebhookEventData) => {
      await this.handleSubscriptionTrialWillEnd(data);
    });

    // Payment events
    this.eventHandlers.set('payment.refunded', async (data: WebhookEventData) => {
      await this.handlePaymentRefunded(data);
    });

    this.eventHandlers.set('refund.updated', async (data: WebhookEventData) => {
      await this.handleRefundUpdated(data);
    });

    this.eventHandlers.set('payment.dispute_created', async (data: WebhookEventData) => {
      await this.handlePaymentDisputeCreated(data);
    });

    this.eventHandlers.set('payment.succeeded', async (data: WebhookEventData) => {
      await this.handlePaymentSucceeded(data);
    });

    this.eventHandlers.set('payment.failed', async (data: WebhookEventData) => {
      await this.handlePaymentFailed(data);
    });

    this.eventHandlers.set('payment.requires_action', async (data: WebhookEventData) => {
      await this.handlePaymentRequiresAction(data);
    });

    // Customer events
    this.eventHandlers.set('customer.created', async (data: WebhookEventData) => {
      await this.handleCustomerCreated(data);
    });

    this.eventHandlers.set('customer.updated', async (data: WebhookEventData) => {
      await this.handleCustomerUpdated(data);
    });

    this.eventHandlers.set('customer.deleted', async (data: WebhookEventData) => {
      await this.handleCustomerDeleted(data);
    });

    // Invoice events
    this.eventHandlers.set('invoice.created', async (data: WebhookEventData) => {
      await this.handleInvoiceCreated(data);
    });

    this.eventHandlers.set('invoice.finalized', async (data: WebhookEventData) => {
      await this.handleInvoiceFinalized(data);
    });

    this.eventHandlers.set('invoice.paid', async (data: WebhookEventData) => {
      await this.handleInvoicePaid(data);
    });

    this.eventHandlers.set('invoice.payment_failed', async (data: WebhookEventData) => {
      await this.handleInvoicePaymentFailed(data);
    });
  }

  /**
   * Bring the local subscription in line with Stripe. The row must exist: a
   * subscription made outside the app has no owner here, so the event fails
   * and is retried (open item D4). `planId` and `metadata` stay as they are.
   * A delivery that changes nothing writes no event.
   */
  private async applySubscriptionEvent(data: WebhookEventData): Promise<void> {
    const snapshot = parseStripeSubscription(data.data);
    const row = await this.paymentRepository.findSubscriptionByProviderSubscriptionId(snapshot.providerSubscriptionId);
    if (!row) {
      throw new Error(`No local subscription for provider subscription ${snapshot.providerSubscriptionId}`);
    }

    await this.writes.syncSubscription({
      userId: row.userId,
      planId: row.planId,
      customerId: row.customerId,
      ...snapshot,
    });
  }

  /**
   * Move the local payment to what Stripe reports, following
   * `paymentMovesFrom`. A payment already where the event would put it, or
   * settled past it, is left alone and the event counts as done.
   */
  private async applyPaymentEvent(data: WebhookEventData, outcome: PaymentOutcome): Promise<void> {
    const intent = parseStripePaymentIntent(data.data);
    const row = await this.paymentRepository.findPaymentByProviderPaymentId(intent.providerPaymentId);
    if (!row) {
      throw new Error(`No local payment for provider payment ${intent.providerPaymentId}`);
    }

    if (!paymentMovesFrom[outcome].includes(row.status)) {
      logger.debug('Payment {paymentId} is {status}; webhook {webhookId} changes nothing', {
        paymentId: row.id,
        status: row.status,
        webhookId: data.webhookId,
      });
      return;
    }

    switch (outcome) {
      case 'succeeded': {
        await this.writes.completePayment({ paymentId: row.id });
        break;
      }
      case 'failed': {
        await this.writes.failPayment({ paymentId: row.id, failureReason: intent.failureReason ?? 'payment_failed' });
        break;
      }
      case 'requires_action': {
        await this.writes.markPaymentRequiresAction({ paymentId: row.id });
        break;
      }
    }
  }

  /**
   * Stripe reports the total refunded so far on the charge, so a resent or out-of-order event
   * cannot double or lower the amount. A charge made outside a PaymentIntent has no local payment.
   */
  private async handlePaymentRefunded(data: WebhookEventData): Promise<void> {
    try {
      const charge = parseStripeCharge(data.data);
      if (charge.providerPaymentId === null) {
        logger.warn('Refund webhook {webhookId} is for a charge without a payment intent; nothing to record', {
          webhookId: data.webhookId,
        });
        return;
      }

      const row = await this.paymentRepository.findPaymentByProviderPaymentId(charge.providerPaymentId);
      if (!row) {
        throw new Error(`No local payment for provider payment ${charge.providerPaymentId}`);
      }

      const refundedAmount = fromStripeAmount(charge.amountRefunded, charge.currency).toJSON();
      await this.writes.recordPaymentRefund({ paymentId: row.id, refundedAmount });
      await this.reconcileRefunds(charge.refunds);

      this.emit('payment:refunded', { paymentData: data.data, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle payment refunded: ${error instanceof Error ? error.message : 'Unknown error'}`, {
        cause: error,
      });
    }
  }

  /**
   * Lines each refund Stripe lists on the charge up with our `refunds` row:
   * - one we hold by its Stripe id is already linked, nothing to do (a resent event lands here);
   * - one `RefundService` made (its `metadata.refundId`) that is still `processing` is completed
   *   with Stripe's id: the service asked Stripe but died before it stored the answer;
   * - one made at Stripe, outside the service, has no row, and none is invented for it.
   * Refunds Stripe has not succeeded yet are left for the next event.
   */
  private async reconcileRefunds(listed: readonly StripeChargeRefund[]): Promise<void> {
    if (!this.refunds) {
      return;
    }

    for (const listedRefund of listed) {
      if (listedRefund.status !== 'succeeded') {
        continue;
      }

      if (await this.refunds.reads.findByProviderRefundId(listedRefund.providerRefundId)) {
        continue;
      }

      const parsed = refundIdSchema.safeParse(listedRefund.refundId);
      const ours = parsed.success ? await this.refunds.reads.findById(parsed.data) : null;
      if (!ours) {
        logger.debug('Refund {providerRefundId} was made outside RefundService; no refunds row to complete', {
          providerRefundId: listedRefund.providerRefundId,
        });
        continue;
      }

      if (ours.status !== 'processing') {
        logger.warn('Refund {refundId} is {status} but Stripe refunded it as {providerRefundId}; left as it is', {
          refundId: ours.id,
          status: ours.status,
          providerRefundId: listedRefund.providerRefundId,
        });
        continue;
      }

      await this.refunds.writes.completeRefund({
        refundId: ours.id,
        providerRefundId: listedRefund.providerRefundId,
      });
    }
  }

  /**
   * A refund on its own, for Stripe API versions that do not list refunds on the charge.
   * It lines up with our `refunds` row the same way as a refund listed on a charge.
   */
  private async handleRefundUpdated(data: WebhookEventData): Promise<void> {
    try {
      await this.reconcileRefunds([parseStripeRefund(data.data)]);
    } catch (error) {
      throw new Error(`Failed to handle refund update: ${error instanceof Error ? error.message : 'Unknown error'}`, {
        cause: error,
      });
    }
  }

  private async handlePaymentDisputeCreated(data: WebhookEventData): Promise<void> {
    try {
      const dispute = parseStripeDispute(data.data);
      if (dispute.providerPaymentId === null) {
        logger.warn('Dispute webhook {webhookId} is for a charge without a payment intent; nothing to record', {
          webhookId: data.webhookId,
        });
        return;
      }

      const row = await this.paymentRepository.findPaymentByProviderPaymentId(dispute.providerPaymentId);
      if (!row) {
        throw new Error(`No local payment for provider payment ${dispute.providerPaymentId}`);
      }

      await this.writes.recordPaymentDispute({
        paymentId: row.id,
        disputeId: dispute.disputeId,
        status: dispute.status,
        reason: dispute.reason,
      });

      this.emit('payment:dispute_created', { paymentData: data.data, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(
        `Failed to handle payment dispute created: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error },
      );
    }
  }

  // Event handler implementations
  private async handleSubscriptionCreated(data: WebhookEventData): Promise<void> {
    try {
      const subscriptionData = data.data;
      logger.debug('Subscription created (webhook {webhookId})', { webhookId: data.webhookId });
      await this.applySubscriptionEvent(data);

      this.emit('subscription:created', { subscriptionData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle subscription created: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleSubscriptionUpdated(data: WebhookEventData): Promise<void> {
    try {
      const subscriptionData = data.data;
      logger.debug('Subscription updated (webhook {webhookId})', { webhookId: data.webhookId });
      await this.applySubscriptionEvent(data);

      this.emit('subscription:updated', { subscriptionData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle subscription updated: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleSubscriptionCanceled(data: WebhookEventData): Promise<void> {
    try {
      const subscriptionData = data.data;
      logger.debug('Subscription canceled (webhook {webhookId})', { webhookId: data.webhookId });
      await this.applySubscriptionEvent(data);

      this.emit('subscription:canceled', { subscriptionData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle subscription canceled: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleSubscriptionTrialWillEnd(data: WebhookEventData): Promise<void> {
    try {
      const subscriptionData = data.data;
      logger.debug('Subscription trial will end (webhook {webhookId})', { webhookId: data.webhookId });

      // Send trial ending notifications
      // Update user about upcoming charges

      this.emit('subscription:trial_ending', { subscriptionData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle trial will end: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handlePaymentSucceeded(data: WebhookEventData): Promise<void> {
    try {
      const paymentData = data.data;
      logger.debug('Payment succeeded (webhook {webhookId})', { webhookId: data.webhookId });
      await this.applyPaymentEvent(data, 'succeeded');

      this.emit('payment:succeeded', { paymentData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle payment succeeded: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handlePaymentFailed(data: WebhookEventData): Promise<void> {
    try {
      const paymentData = data.data;
      logger.debug('Payment failed (webhook {webhookId})', { webhookId: data.webhookId });
      await this.applyPaymentEvent(data, 'failed');

      this.emit('payment:failed', { paymentData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle payment failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handlePaymentRequiresAction(data: WebhookEventData): Promise<void> {
    try {
      const paymentData = data.data;
      logger.debug('Payment requires action (webhook {webhookId})', { webhookId: data.webhookId });
      await this.applyPaymentEvent(data, 'requires_action');

      this.emit('payment:requires_action', { paymentData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle payment requires action: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleCustomerCreated(data: WebhookEventData): Promise<void> {
    try {
      const customerData = data.data;
      logger.debug('Customer created (webhook {webhookId})', { webhookId: data.webhookId });

      this.emit('customer:created', { customerData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle customer created: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleCustomerUpdated(data: WebhookEventData): Promise<void> {
    try {
      const customerData = data.data;
      logger.debug('Customer updated (webhook {webhookId})', { webhookId: data.webhookId });

      this.emit('customer:updated', { customerData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle customer updated: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleCustomerDeleted(data: WebhookEventData): Promise<void> {
    try {
      const customerData = data.data;
      logger.debug('Customer deleted (webhook {webhookId})', { webhookId: data.webhookId });

      // Clean up customer data and subscriptions

      this.emit('customer:deleted', { customerData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle customer deleted: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleInvoiceCreated(data: WebhookEventData): Promise<void> {
    try {
      const invoiceData = data.data;
      logger.debug('Invoice created (webhook {webhookId})', { webhookId: data.webhookId });

      this.emit('invoice:created', { invoiceData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle invoice created: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleInvoiceFinalized(data: WebhookEventData): Promise<void> {
    try {
      const invoiceData = data.data;
      logger.debug('Invoice finalized (webhook {webhookId})', { webhookId: data.webhookId });

      this.emit('invoice:finalized', { invoiceData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle invoice finalized: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleInvoicePaid(data: WebhookEventData): Promise<void> {
    try {
      const invoiceData = data.data;
      logger.debug('Invoice paid (webhook {webhookId})', { webhookId: data.webhookId });

      this.emit('invoice:paid', { invoiceData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle invoice paid: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleInvoicePaymentFailed(data: WebhookEventData): Promise<void> {
    try {
      const invoiceData = data.data;
      logger.debug('Invoice payment failed (webhook {webhookId})', { webhookId: data.webhookId });

      this.emit('invoice:payment_failed', { invoiceData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle invoice payment failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Public utility methods
  public registerEventHandler(eventType: WebhookEventType, handler: (data: WebhookEventData) => Promise<void>): void {
    this.eventHandlers.set(eventType, handler);
  }

  public removeEventHandler(eventType: WebhookEventType): void {
    this.eventHandlers.delete(eventType);
  }

  public getProcessingStats(): {
    totalHandlers: number;
    supportedEventTypes: WebhookEventType[];
  } {
    return {
      totalHandlers: this.eventHandlers.size,
      supportedEventTypes: [...this.eventHandlers.keys()],
    };
  }
}

export function createWebhookHandler(
  paymentRepository: WebhookEventStore,
  webhookSecurity: WebhookValidator,
  writes: WebhookWrites,
  config?: Partial<WebhookHandlerConfig>,
  refunds?: WebhookRefunds,
) {
  return new WebhookHandler(paymentRepository, webhookSecurity, writes, config, refunds);
}