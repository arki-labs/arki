import { EventEmitter } from 'node:events';

import { z } from '@arki/contracts';
import { now, sub } from '@arki/date';
import { InvalidInput, isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';
import { fromStripeAmount } from '@arki/money/stripe';
import type { SchemaInput } from '@arki/schema';
import { parse } from '@arki/schema';

import type { WebhookProcessingResult } from '../contracts.js';
import type { CoreWrites } from '../journal.js';
import type { RefundWorkflow } from '../../refunds/workflow.js';
import type { PaymentRepository } from '../repository.js';
import type { PaymentProviderType, PaymentStatus, WebhookEventType, WebhookId } from '../types.js';
import type { StripeChargeRefund } from './webhook-event-payloads.js';
import type { WebhookSecurityService } from './webhook-security.js';
import { refundIdSchema } from '../../refunds/primitives.js';
import { REFUND_SETTLED_STATUSES, refundRunId } from '../../refunds/workflow.js';
import { createWebhookId, webhookEventTypeValues } from '../primitives.js';
import { observePayments } from '../telemetry.js';
import {
  parseStripeCharge,
  parseStripeDispute,
  parseStripePaymentIntent,
  parseStripeRefund,
  parseStripeSubscription,
} from './webhook-event-payloads.js';
import {
  WebhookInProgress,
  WebhookPayloadInvalid,
  WebhookRejected,
  WebhookRetriesExhausted,
  WebhookTargetNotFound,
} from './webhook-failures.js';

export * from './webhook-failures.js';

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

/** The `stripe.refund.settled` signal of the refund workflow. */
type RefundSettled = ReturnType<RefundWorkflow['signal']>;

/**
 * How the handler tells a refund's workflow run that Stripe settled the refund: the app runs
 * `refundWorkflow.signal('stripe.refund.settled')` with its journal. Apps without the refunds module leave it out.
 */
export type WebhookRefunds = {
  signal: (input: SchemaInput<RefundSettled['input']>) => Promise<Awaited<ReturnType<RefundSettled['handler']>>>;
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

/** The two fields of a provider event the claim needs. */
const eventEnvelopeSchema = z.object({ id: z.string().min(1), type: z.string().min(1) });

export type WebhookEventData = {
  type: WebhookEventType;
  provider: PaymentProviderType;
  data: Record<string, unknown>;
  webhookId: WebhookId;
};

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
};

// eslint-disable-next-line unicorn/prefer-event-target -- public API: apps subscribe with `.on('payment:refunded', ...)`; Node's EventEmitter is what they listen on
export class WebhookHandler extends EventEmitter {
  private readonly config: WebhookHandlerConfig;
  /** Handlers the app registered. One replaces the built-in handling of its event type. */
  private readonly customHandlers = new Map<WebhookEventType, (data: WebhookEventData) => Promise<void>>();

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
  }

  /**
   * Validate, claim and process one delivery, in a `payments.webhook.process` span.
   *
   * Returns a `WebhookProcessingResult` (`processed`, `queued`, `duplicate` or `ignored`) when the
   * route may answer 2xx. Otherwise a returned failure: one of `WEBHOOK_FAILURES`, whose
   * `data.retryable` says whether a resend can succeed; a refused journal write, a money failure
   * or a refund signal failure, all of which a resend may get past (answer non-2xx); or a webhook
   * id failure. A fault (the database, a registered handler) throws after it is recorded on the
   * event's row; answer non-2xx.
   */
  async processWebhook(
    provider: PaymentProviderType,
    payload: string | Buffer,
    signature: string,
    timestamp: string,
    sourceIp: string,
    webhookSecret: string,
  ) {
    return observePayments('webhook.process', { 'payments.provider': provider }, () =>
      this.receive(provider, payload, signature, timestamp, sourceIp, webhookSecret),
    );
  }

  private async receive(
    provider: PaymentProviderType,
    payload: string | Buffer,
    signature: string,
    timestamp: string,
    sourceIp: string,
    webhookSecret: string,
  ) {
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
      return WebhookRejected({ reason: validation.error ?? 'Webhook validation failed', retryable: false });
    }

    // 2. Read the event's id and type
    const envelope = this.readEnvelope(payload);
    if (isFailure(envelope)) return envelope;

    // 3. An event type we do not handle: acknowledge it, store nothing.
    const eventType = validation.eventType;
    if (!eventType) {
      logger.debug('Ignoring unhandled webhook event type {type}', { type: envelope.type });
      return { status: 'ignored' } satisfies WebhookProcessingResult;
    }

    // 4. Claim the event. Only the delivery whose insert wins goes on to
    //    process it; the database's unique index decides, so this holds
    //    across concurrent requests and across server instances.
    //    `attempts` counts started attempts.
    const webhookIdResult = createWebhookId();
    if (isFailure(webhookIdResult)) return webhookIdResult;

    const data = validation.data ?? {};
    const claim = await this.paymentRepository.claimWebhookEvent({
      id: webhookIdResult,
      provider,
      eventType,
      providerEventId: envelope.id,
      data,
      processed: false,
      attempts: 1,
      lastAttemptAt: now(),
      sourceIp,
      createdAt: now(),
      updatedAt: now(),
    });
    if (isFailure(claim)) return claim;
    const { event, created } = claim;
    const webhookId = event.id;

    if (!created) {
      if (event.processed) {
        return { status: 'duplicate', webhookId } satisfies WebhookProcessingResult;
      }
      if (event.attempts >= this.config.maxRetries) {
        logger.error('Webhook {webhookId} given up after {attempts} attempts', {
          webhookId,
          attempts: event.attempts,
        });
        return WebhookRetriesExhausted({ webhookId, attempts: event.attempts, retryable: false });
      }
      // A resend of an event that failed or whose attempt crashed takes it
      // over; a resend of one still inside its lease asks to be resent later.
      const reclaimed = await this.paymentRepository.reclaimWebhookEvent(webhookId, event.attempts, this.leaseCutoff());
      if (!reclaimed) {
        logger.debug('Webhook {webhookId} is being processed; asking for a resend', { webhookId });
        return WebhookInProgress({ webhookId, retryable: true });
      }
    }

    // 5. Process the event. A failure is recorded on the row and returned,
    //    so the provider's resend takes it over.
    if (this.config.enableAsync) {
      this.processEventAsync(webhookId, eventType, provider, data);
      return { status: 'queued', webhookId } satisfies WebhookProcessingResult;
    }

    const outcome = await this.runClaimed(webhookId, eventType, provider, data);
    if (isFailure(outcome)) return outcome;
    return { status: 'processed', webhookId } satisfies WebhookProcessingResult;
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
            const outcome = await this.runClaimed(event.id, event.eventType, event.provider, event.data);
            if (isFailure(outcome)) {
              this.emit('webhook:processing_error', {
                webhookId: event.id,
                eventType: event.eventType,
                provider: event.provider,
                error: outcome.code,
              });
            }
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
          const marked = await this.paymentRepository.updateWebhookEvent(event.id, {
            errorMessage: 'Max retry attempts exceeded',
          });
          if (isFailure(marked)) {
            continue;
          }

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

  private processEventAsync(
    webhookId: WebhookId,
    eventType: WebhookEventType,
    provider: PaymentProviderType,
    data: Record<string, unknown>,
  ): void {
    // Process in background. Every outcome, and every throw, is reported as an event.
    setImmediate(() => {
      this.runClaimed(webhookId, eventType, provider, data).then(
        outcome => {
          if (isFailure(outcome)) {
            this.emit('webhook:processing_error', { webhookId, eventType, provider, error: outcome.code });
          }
        },
        (error: unknown) => {
          this.emit('webhook:processing_error', {
            webhookId,
            eventType,
            provider,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        },
      );
    });
  }

  /** The moment before which an attempt with no recorded error counts as crashed. */
  private leaseCutoff() {
    return sub(now(), { milliseconds: this.config.processingLeaseMs });
  }

  /** The event's `id` and `type` from the raw body, or `WebhookPayloadInvalid` when it has none. */
  private readEnvelope(payload: string | Buffer) {
    let body: unknown;
    try {
      body = JSON.parse(typeof payload === 'string' ? payload : payload.toString());
    } catch (error) {
      return WebhookPayloadInvalid({ retryable: false }, { cause: error });
    }
    const envelope = parse(eventEnvelopeSchema, body);
    return isFailure(envelope) ? WebhookPayloadInvalid({ retryable: false }, { cause: envelope }) : envelope;
  }

  /**
   * Run an event this caller has claimed, in a `payments.webhook.event` span. A returned failure is
   * recorded on the row as `<code>: <message>` and returned: the event is not marked processed, so
   * the next resend may take it over. A thrown error is recorded the same way and rethrown.
   */
  private async runClaimed(
    webhookId: WebhookId,
    eventType: WebhookEventType,
    provider: PaymentProviderType,
    data: Record<string, unknown>,
  ) {
    return observePayments(
      'webhook.event',
      { 'payments.provider': provider, 'payments.event_type': eventType },
      async () => {
        try {
          const outcome = await this.processEvent(webhookId, eventType, provider, data);
          if (isFailure(outcome)) {
            await this.recordError(webhookId, `${outcome.code}: ${outcome.message}`);
            logger.warn('Webhook {webhookId} was not processed: {code}', { webhookId, code: outcome.code });
          }
          return outcome;
        } catch (error) {
          await this.recordError(webhookId, error instanceof Error ? error.message : 'Unknown error');
          logger.warn('Webhook {webhookId} failed; a resend may retry it', { webhookId });
          throw error;
        }
      },
    );
  }

  /**
   * Store why the attempt failed, so the next resend may take the event over. A row deleted
   * meanwhile has nothing to take over: that is logged, and the attempt's own outcome still stands.
   */
  private async recordError(webhookId: WebhookId, errorMessage: string): Promise<void> {
    const recorded = await this.paymentRepository.updateWebhookEvent(webhookId, { errorMessage });
    if (isFailure(recorded)) {
      logger.warn('Webhook {webhookId} has no row to record its error on: {code}', { webhookId, code: recorded.code });
    }
  }

  private async processEvent(
    webhookId: WebhookId,
    eventType: WebhookEventType,
    provider: PaymentProviderType,
    data: Record<string, unknown>,
  ) {
    const eventData: WebhookEventData = { type: eventType, provider, data, webhookId };
    logger.debug('Handling {eventType} (webhook {webhookId})', { eventType, webhookId });

    const custom = this.customHandlers.get(eventType);
    const handled = custom ? await custom(eventData) : await this.handleEvent(eventData);
    // A body the event's schema refuses is final: every resend carries the same body.
    if (InvalidInput.is(handled)) return WebhookPayloadInvalid({ retryable: false }, { cause: handled });
    if (isFailure(handled)) return handled;

    const marked = await this.paymentRepository.markWebhookEventAsProcessed(webhookId);
    if (isFailure(marked)) return marked;

    if (this.config.enableEventEmitter) {
      this.emit('webhook:processed', eventData);
      this.emit(`webhook:${eventType}`, eventData);
    }
    return;
  }

  /** The built-in handling of each event type. A failure is returned, never thrown. */
  private async handleEvent(data: WebhookEventData) {
    const { webhookId } = data;
    switch (data.type) {
      case 'subscription.created': {
        return this.applySubscriptionEvent(data, 'subscription:created');
      }
      case 'subscription.updated': {
        return this.applySubscriptionEvent(data, 'subscription:updated');
      }
      case 'subscription.canceled': {
        return this.applySubscriptionEvent(data, 'subscription:canceled');
      }
      case 'subscription.trial_will_end': {
        this.emit('subscription:trial_ending', { subscriptionData: data.data, webhookId });
        return;
      }
      case 'payment.succeeded': {
        return this.applyPaymentEvent(data, 'succeeded');
      }
      case 'payment.failed': {
        return this.applyPaymentEvent(data, 'failed');
      }
      case 'payment.requires_action': {
        return this.applyPaymentEvent(data, 'requires_action');
      }
      case 'payment.refunded': {
        return this.handlePaymentRefunded(data);
      }
      case 'refund.updated': {
        return this.handleRefundUpdated(data);
      }
      case 'payment.dispute_created': {
        return this.handlePaymentDisputeCreated(data);
      }
      case 'customer.created': {
        this.emit('customer:created', { customerData: data.data, webhookId });
        return;
      }
      case 'customer.updated': {
        this.emit('customer:updated', { customerData: data.data, webhookId });
        return;
      }
      case 'customer.deleted': {
        this.emit('customer:deleted', { customerData: data.data, webhookId });
        return;
      }
      case 'invoice.created': {
        this.emit('invoice:created', { invoiceData: data.data, webhookId });
        return;
      }
      case 'invoice.finalized': {
        this.emit('invoice:finalized', { invoiceData: data.data, webhookId });
        return;
      }
      case 'invoice.paid': {
        this.emit('invoice:paid', { invoiceData: data.data, webhookId });
        return;
      }
      case 'invoice.payment_failed': {
        this.emit('invoice:payment_failed', { invoiceData: data.data, webhookId });
        return;
      }
    }
  }

  /**
   * Bring the local subscription in line with Stripe. The row must exist: a
   * subscription made outside the app has no owner here, so the event returns
   * `WebhookTargetNotFound` and is retried (open item D4). `planId` and
   * `metadata` stay as they are. A delivery that changes nothing writes no event.
   */
  private async applySubscriptionEvent(
    data: WebhookEventData,
    emitted: 'subscription:created' | 'subscription:updated' | 'subscription:canceled',
  ) {
    const snapshot = parseStripeSubscription(data.data);
    if (isFailure(snapshot)) return snapshot;
    const row = await this.paymentRepository.findSubscriptionByProviderSubscriptionId(snapshot.providerSubscriptionId);
    if (!row) {
      return WebhookTargetNotFound({
        kind: 'subscription',
        providerId: snapshot.providerSubscriptionId,
        retryable: true,
      });
    }

    const synced = await this.writes.syncSubscription({
      userId: row.userId,
      planId: row.planId,
      customerId: row.customerId,
      ...snapshot,
    });
    if (isFailure(synced)) return synced;

    this.emit(emitted, { subscriptionData: data.data, webhookId: data.webhookId });
    return;
  }

  /**
   * Move the local payment to what Stripe reports, following
   * `paymentMovesFrom`. A payment already where the event would put it, or
   * settled past it, is left alone and the event counts as done.
   *
   * A write the journal refuses is returned (AGENTS.md law 9): the event is
   * not processed, and the route answers non-2xx so the provider resends it.
   */
  private async applyPaymentEvent(data: WebhookEventData, outcome: PaymentOutcome) {
    const intent = parseStripePaymentIntent(data.data);
    if (isFailure(intent)) return intent;
    const row = await this.paymentRepository.findPaymentByProviderPaymentId(intent.providerPaymentId);
    if (!row) {
      return WebhookTargetNotFound({ kind: 'payment', providerId: intent.providerPaymentId, retryable: true });
    }

    if (paymentMovesFrom[outcome].includes(row.status)) {
      const moved = await (outcome === 'succeeded'
        ? this.writes.completePayment({ paymentId: row.id })
        : outcome === 'failed'
          ? this.writes.failPayment({ paymentId: row.id, failureReason: intent.failureReason ?? 'payment_failed' })
          : this.writes.markPaymentRequiresAction({ paymentId: row.id }));
      if (isFailure(moved)) return moved;
    } else {
      logger.debug('Payment {paymentId} is {status}; webhook {webhookId} changes nothing', {
        paymentId: row.id,
        status: row.status,
        webhookId: data.webhookId,
      });
    }

    this.emit(`payment:${outcome}`, { paymentData: data.data, webhookId: data.webhookId });
    return;
  }

  /**
   * Stripe reports the total refunded so far on the charge, so a resent or out-of-order event
   * cannot double or lower the amount. A charge made outside a PaymentIntent has no local payment.
   */
  private async handlePaymentRefunded(data: WebhookEventData) {
    const charge = parseStripeCharge(data.data);
    if (isFailure(charge)) return charge;
    if (charge.providerPaymentId === null) {
      logger.warn('Refund webhook {webhookId} is for a charge without a payment intent; nothing to record', {
        webhookId: data.webhookId,
      });
      return;
    }

    const row = await this.paymentRepository.findPaymentByProviderPaymentId(charge.providerPaymentId);
    if (!row) {
      return WebhookTargetNotFound({ kind: 'payment', providerId: charge.providerPaymentId, retryable: true });
    }

    // Stripe's amount is outside data: one `@arki/money` refuses is returned, and no refund is recorded
    const refunded = fromStripeAmount(charge.amountRefunded, charge.currency);
    if (isFailure(refunded)) return refunded;
    const recorded = await this.writes.recordPaymentRefund({ paymentId: row.id, refundedAmount: refunded.toJSON() });
    if (isFailure(recorded)) return recorded;
    const signalled = await this.reconcileRefunds(charge.refunds, data.webhookId);
    if (isFailure(signalled)) return signalled;

    this.emit('payment:refunded', { paymentData: data.data, webhookId: data.webhookId });
    return;
  }

  /**
   * Tells the workflow run of each refund `RefundService` made (its `metadata.refundId`) where Stripe settled it.
   * The run completes or fails the row; the handler writes no refund itself.
   * - `deliveryId` is `<webhookId>:<Stripe refund id>`: a resend of this event is the same delivery, so the run
   *   reports it `duplicate` and changes nothing.
   * - A refund made at Stripe, outside the service, has no `refundId` and is not signalled.
   * - No run for the refund (`no-run`) or a finished one is still a 2xx: a failure would make Stripe resend forever.
   * - A failure the signal returns is returned, so the event is not processed and Stripe resends it.
   * Refunds Stripe has not settled yet (`pending`, `requires_action`) wait for a later event.
   */
  private async reconcileRefunds(listed: readonly StripeChargeRefund[], webhookId: WebhookId) {
    if (!this.refunds) {
      return;
    }

    for (const { providerRefundId, status, refundId } of listed) {
      const settled = REFUND_SETTLED_STATUSES.find(final => final === status);
      if (settled === undefined) {
        continue;
      }

      const parsed = refundIdSchema.safeParse(refundId);
      if (!parsed.success) {
        logger.debug('Refund {providerRefundId} was made outside RefundService; nothing to signal', {
          providerRefundId,
        });
        continue;
      }

      const delivered = await this.refunds.signal({
        runId: refundRunId(parsed.data),
        deliveryId: `${webhookId}:${providerRefundId}`,
        payload: { providerRefundId, status: settled },
      });
      if (isFailure(delivered)) return delivered;
      logger.debug('Refund {refundId} settled as {status}; its run answered {delivery}', {
        refundId: parsed.data,
        status,
        delivery: delivered.status,
      });
    }
    return;
  }

  /**
   * A refund on its own, for Stripe API versions that do not list refunds on the charge.
   * It lines up with our `refunds` row the same way as a refund listed on a charge.
   */
  private async handleRefundUpdated(data: WebhookEventData) {
    const refund = parseStripeRefund(data.data);
    if (isFailure(refund)) return refund;
    return this.reconcileRefunds([refund], data.webhookId);
  }

  private async handlePaymentDisputeCreated(data: WebhookEventData) {
    const dispute = parseStripeDispute(data.data);
    if (isFailure(dispute)) return dispute;
    if (dispute.providerPaymentId === null) {
      logger.warn('Dispute webhook {webhookId} is for a charge without a payment intent; nothing to record', {
        webhookId: data.webhookId,
      });
      return;
    }

    const row = await this.paymentRepository.findPaymentByProviderPaymentId(dispute.providerPaymentId);
    if (!row) {
      return WebhookTargetNotFound({ kind: 'payment', providerId: dispute.providerPaymentId, retryable: true });
    }

    const recorded = await this.writes.recordPaymentDispute({
      paymentId: row.id,
      disputeId: dispute.disputeId,
      status: dispute.status,
      reason: dispute.reason,
    });
    if (isFailure(recorded)) return recorded;

    this.emit('payment:dispute_created', { paymentData: data.data, webhookId: data.webhookId });
    return;
  }

  /** Replace the built-in handling of `eventType` with `handler`. A throw from it is a fault: recorded, then rethrown. */
  public registerEventHandler(eventType: WebhookEventType, handler: (data: WebhookEventData) => Promise<void>): void {
    this.customHandlers.set(eventType, handler);
  }

  /** Remove a handler `registerEventHandler` set; the built-in handling of `eventType` applies again. */
  public removeEventHandler(eventType: WebhookEventType): void {
    this.customHandlers.delete(eventType);
  }

  /** Every event type has built-in handling, so every type is supported. */
  public getProcessingStats(): {
    totalHandlers: number;
    supportedEventTypes: WebhookEventType[];
  } {
    return {
      totalHandlers: webhookEventTypeValues.length,
      supportedEventTypes: [...webhookEventTypeValues],
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
