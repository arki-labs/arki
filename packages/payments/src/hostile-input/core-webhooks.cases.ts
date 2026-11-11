import { createServer } from 'node:http';
import type { PGlite } from '@electric-sql/pglite';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { expect } from 'vitest';

import { add, now, sub } from '@arki/date';
import { orThrow } from '@arki/failure';

import type { CoreWrites } from '../core/journal.js';
import type { NotificationMail } from '../core/notifications/service.js';
import type { PaymentId } from '../core/types.js';
import type { Refund } from '../refunds/types.js';
import type { AppDb } from '../test-support.js';
import {
  createNotificationService,
  EmailNotificationService,
  MultiChannelNotificationService,
  SlackNotificationService,
} from '../core/notifications/service.js';
import { createPaymentId } from '../core/primitives.js';
import { PaymentRepository } from '../core/repository.js';
import { createWebhookSecurityService } from '../core/security/webhook-security.js';
import { createWebhookAnalyticsService, WebhookAnalyticsService } from '../core/services/webhook-analytics-service.js';
import {
  parseStripeCharge,
  parseStripeDispute,
  parseStripePaymentIntent,
  parseStripeRefund,
  parseStripeSubscription,
} from '../core/services/webhook-event-payloads.js';
import { WebhookRejected } from '../core/services/webhook-failures.js';
import { createWebhookHandler, isWebhookFailure, WebhookHandler } from '../core/services/webhook-handler.js';
import { WebhookSecurityService } from '../core/services/webhook-security.js';
import { createRefundId } from '../refunds/primitives.js';
import { coreReads, runnerOn, seedPayment } from '../service-test-support.js';
import { core, openDb, typed, userId } from '../test-support.js';
import { area, args, op } from './engine.js';

type Ctx = {
  db: AppDb;
  client: PGlite;
  repo: PaymentRepository;
  writes: CoreWrites;
  security: WebhookSecurityService;
  handler: WebhookHandler;
  /** The analytics service the last `arrange` built. */
  analytics: WebhookAnalyticsService;
  /** The provider event id the last `retryFailedWebhooks` arrangement stored. */
  retryEventId: string;
  slackServer: Server;
  slackUrl: string;
  slackBodies: unknown[];
  mails: NotificationMail[];
  email: EmailNotificationService;
  slack: SlackNotificationService;
  multi: MultiChannelNotificationService;
};

const ALLOWED_IP = '203.0.113.10';
const SECRET = 'whsec_hostile_fake';
/** No network: only the test signer is used. */
const stripeSigner = new Stripe('sk_test_fake');

let eventCounter = 0;
function nextId(prefix: string): string {
  eventCounter += 1;
  return `${prefix}_hostile_${eventCounter}_${Date.now()}`;
}

/** A Stripe `customer.created` delivery the real verifier accepts: the handler only emits for it, so no rows are needed. */
function signedDelivery(eventId = nextId('evt')) {
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type: 'customer.created',
    data: { object: { id: nextId('cus'), object: 'customer' } },
  });
  const header = stripeSigner.webhooks.generateTestHeaderString({
    payload,
    secret: SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return { payload, header, eventId };
}

/** Operations that take no argument name the empty rest in `call` so the engine's `NoInfer<[]>` spread type-checks. */
const handlerConfig = () => ({
  maxRetries: 3,
  retryDelayMs: 1000,
  enableAsync: false,
  enableEventEmitter: true,
  processingLeaseMs: 300_000,
  skipIpValidation: false,
});

const alertThresholds = () => ({ errorRate: 5, slowProcessing: 5000, maxAlerts: 100 });

/** A stripe event body for the payload parsers. */
const subscriptionEvent = () => ({
  data: {
    object: {
      id: 'sub_hostile',
      status: 'active',
      cancel_at_period_end: false,
      canceled_at: null,
      trial_start: null,
      trial_end: null,
      items: { data: [{ current_period_start: 1_767_225_600, current_period_end: 1_769_904_000 }] },
    },
  },
});
const paymentIntentEvent = () => ({
  data: { object: { id: 'pi_hostile', last_payment_error: { message: 'declined', code: 'card_declined' } } },
});
const chargeEvent = () => ({
  data: {
    object: {
      id: 'ch_hostile',
      payment_intent: 'pi_hostile',
      amount_refunded: 500,
      currency: 'usd',
      refunds: { data: [{ id: 're_hostile', status: 'succeeded', metadata: { refundId: 'rfd_hostile' } }] },
    },
  },
});
const refundEvent = () => ({
  data: { object: { id: 're_hostile', status: 'succeeded', metadata: { refundId: 'rfd_hostile' } } },
});
const disputeEvent = () => ({
  data: { object: { id: 'dp_hostile', payment_intent: 'pi_hostile', status: 'needs_response', reason: 'fraudulent' } },
});

/** A refund of 10.00 USD of `paymentId`, as the refunds table holds it. */
function refundOf(paymentId: PaymentId): Refund {
  return {
    id: orThrow(createRefundId()),
    paymentId,
    originalAmountMinor: 2500,
    refundAmountMinor: 1000,
    currency: 'USD',
    reason: 'customer_request',
    status: 'pending',
    providerRefundId: null,
    providerResponse: null,
    requestedBy: userId,
    approvedBy: null,
    rejectedBy: null,
    rejectionReason: null,
    approvalNotes: null,
    requestedAt: null,
    approvedAt: null,
    processedAt: null,
    completedAt: null,
    internalNotes: null,
    customerNote: 'wrong size',
    metadata: null,
    createdAt: null,
    updatedAt: null,
  };
}

/** A refund of a payment that does not exist: enough where the channel never reads the payment. */
const freshRefund = () => refundOf(orThrow(createPaymentId()));

/** A refund of a stored payment, for the email status update that reads the payment's customer. */
async function storedRefund(ctx: Ctx) {
  const payment = await seedPayment(ctx.writes, null);
  return refundOf(payment.id);
}

/** A new analytics service with one open alert, kept in `ctx.analytics`. */
function analyticsWithAlert(ctx: Ctx) {
  ctx.analytics = orThrow(WebhookAnalyticsService.create(ctx.repo, alertThresholds()));
  ctx.analytics.createAlert('slow_processing', 'high', 'Slow webhook processing detected', { processingTime: 9000 });
  return ctx.analytics;
}

/** Stores one processed `customer.created` event, so the analytics queries find a row. */
async function storeProcessedEvent(ctx: Ctx) {
  const event = orThrow(
    await ctx.repo.createWebhookEvent({
      provider: 'stripe',
      eventType: 'customer.created',
      providerEventId: nextId('evt_metrics'),
      data: {},
    }),
  );
  orThrow(await ctx.repo.markWebhookEventAsProcessed(event.id));
}

const window = () => args(sub(now(), { hours: 24 }), add(now(), { hours: 24 }));

export const coreWebhooksArea = area<Ctx>({
  area: 'core-webhooks',
  async open() {
    const { db, client } = await openDb();
    const repo = new PaymentRepository(db, core);
    const writes = typed.core.writes(runnerOn(db));
    const security = orThrow(
      WebhookSecurityService.create({ allowedIps: [ALLOWED_IP], replayWindowSeconds: 300, maxRetries: 3 }),
    );
    const handler = orThrow(WebhookHandler.create(repo, security, writes, handlerConfig()));

    // A real HTTP server stands in for Slack, as in the notification tests.
    const slackBodies: unknown[] = [];
    const slackServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        slackBodies.push(body);
        response.writeHead(200).end('ok');
      });
    });
    await new Promise<void>(resolve => slackServer.listen(0, '127.0.0.1', resolve));
    const address = slackServer.address();
    const slackUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/hook`;

    const mails: NotificationMail[] = [];
    const email = orThrow(
      EmailNotificationService.create({
        adminEmails: ['admin@example.com'],
        supportEmail: 'support@example.com',
        send: mail => {
          mails.push(mail);
          return Promise.resolve({ id: 'sent' });
        },
        reads: coreReads(db),
      }),
    );
    const slack = orThrow(
      SlackNotificationService.create({
        webhookUrl: slackUrl,
        adminChannel: '#refunds',
        supportChannel: '#support',
        adminUrl: 'https://admin.example.com',
      }),
    );
    return {
      db,
      client,
      repo,
      writes,
      security,
      handler,
      analytics: orThrow(WebhookAnalyticsService.create(repo)),
      retryEventId: '',
      slackServer,
      slackUrl,
      slackBodies,
      mails,
      email,
      slack,
      multi: new MultiChannelNotificationService([email, slack]),
    };
  },
  async close(ctx) {
    ctx.slackServer.closeAllConnections();
    ctx.slackServer.close();
    await ctx.client.close();
  },
  exempt: {},
  cases: [
    // ------------------------------------------------------------ webhook handler
    op('core/services/webhook-handler.ts::WebhookHandler.create', {
      arrange: ctx => args(ctx.repo, ctx.security, ctx.writes, handlerConfig()),
      call: (_ctx, repo, security, writes, config) => WebhookHandler.create(repo, security, writes, config),
      keep: { 'args[2]': 'the journal writes: a dependency, not input' },
      valid: result => {
        expect(result).toBeInstanceOf(WebhookHandler);
        expect((result as WebhookHandler).getProcessingStats().totalHandlers).toBeGreaterThan(0);
      },
    }),
    op('core/services/webhook-handler.ts::createWebhookHandler', {
      arrange: ctx => args(ctx.repo, ctx.security, ctx.writes, handlerConfig()),
      call: (_ctx, repo, security, writes, config) => createWebhookHandler(repo, security, writes, config),
      keep: { 'args[2]': 'the journal writes: a dependency, not input' },
      valid: result => expect(result).toBeInstanceOf(WebhookHandler),
    }),
    op('core/services/webhook-handler.ts::WebhookHandler.processWebhook', {
      arrange: () => {
        const { payload, header } = signedDelivery();
        return args('stripe' as const, payload, header, String(Math.floor(Date.now() / 1000)), ALLOWED_IP, SECRET);
      },
      call: (ctx, provider, payload, signature, timestamp, sourceIp, secret) =>
        ctx.handler.processWebhook(provider, payload, signature, timestamp, sourceIp, secret),
      valid: result => expect(result).toMatchObject({ status: 'processed' }),
    }),
    op<Ctx, []>('core/services/webhook-handler.ts::WebhookHandler.retryFailedWebhooks', {
      arrange: async ctx => {
        ctx.retryEventId = nextId('evt_retry');
        orThrow(
          await ctx.repo.createWebhookEvent({
            provider: 'stripe',
            eventType: 'customer.created',
            providerEventId: ctx.retryEventId,
            data: {},
          }),
        );
        return args();
      },
      call: (ctx, ..._noArguments) => ctx.handler.retryFailedWebhooks(),
      valid: async (_result, ctx) => {
        const [row] = await ctx.db
          .select()
          .from(core.webhookEvents)
          .where(eq(core.webhookEvents.providerEventId, ctx.retryEventId));
        expect(row).toMatchObject({ processed: true });
      },
    }),
    op('core/services/webhook-handler.ts::WebhookHandler.registerEventHandler', {
      arrange: () => args('customer.created' as const, () => Promise.resolve()),
      call: (ctx, eventType, handler) => ctx.handler.registerEventHandler(eventType, handler),
      keep: { 'args[1]': 'the handler callback: a dependency, not input' },
      valid: result => expect(result).toBeUndefined(),
    }),
    op('core/services/webhook-handler.ts::WebhookHandler.removeEventHandler', {
      arrange: () => args('customer.created' as const),
      call: (ctx, eventType) => ctx.handler.removeEventHandler(eventType),
      valid: result => expect(result).toBeUndefined(),
    }),
    op<Ctx, []>('core/services/webhook-handler.ts::WebhookHandler.getProcessingStats', {
      arrange: () => args(),
      call: (ctx, ..._noArguments) => ctx.handler.getProcessingStats(),
      valid: result => {
        const stats = result as ReturnType<WebhookHandler['getProcessingStats']>;
        expect(stats.totalHandlers).toBe(stats.supportedEventTypes.length);
        expect(stats.supportedEventTypes).toContain('customer.created');
      },
    }),
    op('core/services/webhook-handler.ts::isWebhookFailure', {
      arrange: () => args(WebhookRejected({ check: 'signature', reason: 'bad signature', retryable: false })),
      call: (_ctx, value) => isWebhookFailure(value),
      valid: result => expect(result).toBe(true),
    }),

    // ------------------------------------------------------------ webhook analytics
    op('core/services/webhook-analytics-service.ts::WebhookAnalyticsService.create', {
      arrange: ctx => args(ctx.repo, alertThresholds()),
      call: (_ctx, repo, thresholds) => WebhookAnalyticsService.create(repo, thresholds),
      valid: result => expect(result).toBeInstanceOf(WebhookAnalyticsService),
    }),
    op('core/services/webhook-analytics-service.ts::createWebhookAnalyticsService', {
      arrange: ctx => args(ctx.repo, alertThresholds()),
      call: (_ctx, repo, thresholds) => createWebhookAnalyticsService(repo, thresholds),
      valid: result => expect(result).toBeInstanceOf(WebhookAnalyticsService),
    }),
    op('core/services/webhook-analytics-service.ts::WebhookAnalyticsService.createAlert', {
      arrange: ctx => {
        ctx.analytics = orThrow(WebhookAnalyticsService.create(ctx.repo, alertThresholds()));
        return args('slow_processing' as const, 'high' as const, 'Slow webhook processing detected', {
          processingTime: 9000,
        });
      },
      call: (ctx, type, severity, message, data) => ctx.analytics.createAlert(type, severity, message, data),
      valid: (result, ctx) => {
        expect(result).toBeUndefined();
        expect(ctx.analytics.getActiveAlerts()).toMatchObject([
          { type: 'slow_processing', severity: 'high', data: { processingTime: 9000 } },
        ]);
      },
    }),
    op('core/services/webhook-analytics-service.ts::WebhookAnalyticsService.resolveAlert', {
      arrange: ctx => {
        const service = analyticsWithAlert(ctx);
        return args(service.getActiveAlerts()[0]?.id ?? 'missing');
      },
      call: (ctx, alertId) => ctx.analytics.resolveAlert(alertId),
      valid: (result, ctx) => {
        expect(result).toBeUndefined();
        expect(ctx.analytics.getActiveAlerts()).toEqual([]);
        expect(ctx.analytics.getAllAlerts()).toHaveLength(1);
      },
    }),
    op<Ctx, []>('core/services/webhook-analytics-service.ts::WebhookAnalyticsService.getActiveAlerts', {
      arrange: ctx => {
        analyticsWithAlert(ctx);
        return args();
      },
      call: (ctx, ..._noArguments) => ctx.analytics.getActiveAlerts(),
      valid: result => expect(result).toMatchObject([{ type: 'slow_processing', resolved: false }]),
    }),
    op<Ctx, []>('core/services/webhook-analytics-service.ts::WebhookAnalyticsService.getAllAlerts', {
      arrange: ctx => {
        analyticsWithAlert(ctx);
        return args();
      },
      call: (ctx, ..._noArguments) => ctx.analytics.getAllAlerts(),
      valid: result => expect(result).toMatchObject([{ type: 'slow_processing' }]),
    }),
    op('core/services/webhook-analytics-service.ts::WebhookAnalyticsService.recordProcessingTime', {
      arrange: ctx => {
        ctx.analytics = orThrow(WebhookAnalyticsService.create(ctx.repo, alertThresholds()));
        return args(12_000);
      },
      call: (ctx, processingTime) => ctx.analytics.recordProcessingTime(processingTime),
      // 12 s is over the 5 s slow threshold, so recording it raises the slow-processing alert
      valid: (result, ctx) => {
        expect(result).toBeUndefined();
        expect(ctx.analytics.getActiveAlerts()).toMatchObject([{ type: 'slow_processing' }]);
      },
    }),
    op('core/services/webhook-analytics-service.ts::WebhookAnalyticsService.getWebhookMetrics', {
      arrange: async ctx => {
        await storeProcessedEvent(ctx);
        return window();
      },
      call: (ctx, start, end) => ctx.analytics.getWebhookMetrics(start, end),
      valid: result => {
        const metrics = result as { totalEvents: number; processedEvents: number };
        expect(metrics.totalEvents).toBeGreaterThanOrEqual(1);
        expect(metrics.processedEvents).toBeGreaterThanOrEqual(1);
      },
    }),
    op('core/services/webhook-analytics-service.ts::WebhookAnalyticsService.getWebhookHealth', {
      arrange: async ctx => {
        await storeProcessedEvent(ctx);
        return args(sub(now(), { hours: 24 }));
      },
      call: (ctx, start) => ctx.analytics.getWebhookHealth(start),
      valid: result => {
        const health = result as { status: string; score: number };
        expect(['healthy', 'warning', 'critical']).toContain(health.status);
        expect(health.score).toBeGreaterThanOrEqual(0);
        expect(health.score).toBeLessThanOrEqual(100);
      },
    }),
    op('core/services/webhook-analytics-service.ts::WebhookAnalyticsService.getWebhookPerformance', {
      arrange: async ctx => {
        await storeProcessedEvent(ctx);
        return window();
      },
      call: (ctx, start, end) => ctx.analytics.getWebhookPerformance(start, end),
      valid: result => {
        const performance = result as { errorRate: number; throughput: { eventsPerDay: number } };
        expect(performance.errorRate).toBeGreaterThanOrEqual(0);
        expect(performance.throughput.eventsPerDay).toBeGreaterThanOrEqual(0);
      },
    }),
    op('core/services/webhook-analytics-service.ts::WebhookAnalyticsService.generateMonitoringReport', {
      arrange: async ctx => {
        await storeProcessedEvent(ctx);
        return window();
      },
      call: (ctx, start, end) => ctx.analytics.generateMonitoringReport(start, end),
      valid: result => {
        const report = result as { metrics: { totalEvents: number }; period: unknown };
        expect(report.metrics.totalEvents).toBeGreaterThanOrEqual(1);
        expect(report.period).toBeDefined();
      },
    }),

    // ------------------------------------------------------------ webhook security
    op('core/services/webhook-security.ts::WebhookSecurityService.create', {
      arrange: () => args({ allowedIps: [ALLOWED_IP, '198.51.100.0/24'], replayWindowSeconds: 300, maxRetries: 3 }),
      call: (_ctx, config) => WebhookSecurityService.create(config),
      valid: result => expect((result as WebhookSecurityService).isHealthy()).toBe(true),
    }),
    op('core/security/webhook-security.ts::createWebhookSecurityService', {
      arrange: () => args({ allowedIps: [ALLOWED_IP, '198.51.100.0/24'], replayWindowSeconds: 300, maxRetries: 3 }),
      call: (_ctx, config) => createWebhookSecurityService(config),
      valid: result => expect(result).toBeInstanceOf(WebhookSecurityService),
    }),
    op('core/services/webhook-security.ts::WebhookSecurityService.validateWebhook', {
      arrange: () => {
        const { payload, header } = signedDelivery();
        return args('stripe' as const, payload, header, String(Math.floor(Date.now() / 1000)), ALLOWED_IP, SECRET, {
          skipIpValidation: false,
          skipTimestampValidation: false,
          skipSignatureValidation: false,
        });
      },
      call: (ctx, provider, payload, signature, timestamp, sourceIp, secret, options) =>
        ctx.security.validateWebhook(provider, payload, signature, timestamp, sourceIp, secret, options),
      valid: result => expect(result).toMatchObject({ provider: 'stripe', eventType: 'customer.created' }),
    }),
    op<Ctx, []>('core/services/webhook-security.ts::WebhookSecurityService.getProcessedEventCount', {
      arrange: () => args(),
      call: (ctx, ..._noArguments) => ctx.security.getProcessedEventCount(),
      valid: result => expect(result).toBeGreaterThanOrEqual(0),
    }),
    op<Ctx, []>('core/services/webhook-security.ts::WebhookSecurityService.clearProcessedEvents', {
      arrange: () => args(),
      call: (ctx, ..._noArguments) => {
        ctx.security.clearProcessedEvents();
        return ctx.security.getProcessedEventCount();
      },
      valid: result => expect(result).toBe(0),
    }),
    op<Ctx, []>('core/services/webhook-security.ts::WebhookSecurityService.isHealthy', {
      arrange: () => args(),
      call: (ctx, ..._noArguments) => ctx.security.isHealthy(),
      valid: result => expect(result).toBe(true),
    }),

    // ------------------------------------------------------------ event payload parsers
    op('core/services/webhook-event-payloads.ts::parseStripeSubscription', {
      arrange: () => args(subscriptionEvent()),
      call: (_ctx, event) => parseStripeSubscription(event),
      valid: result => expect(result).toMatchObject({ providerSubscriptionId: 'sub_hostile', status: 'active' }),
    }),
    op('core/services/webhook-event-payloads.ts::parseStripePaymentIntent', {
      arrange: () => args(paymentIntentEvent()),
      call: (_ctx, event) => parseStripePaymentIntent(event),
      valid: result => expect(result).toMatchObject({ providerPaymentId: 'pi_hostile' }),
    }),
    op('core/services/webhook-event-payloads.ts::parseStripeCharge', {
      arrange: () => args(chargeEvent()),
      call: (_ctx, event) => parseStripeCharge(event),
      valid: result =>
        expect(result).toMatchObject({
          providerPaymentId: 'pi_hostile',
          amountRefunded: 500,
          refunds: [{ providerRefundId: 're_hostile', refundId: 'rfd_hostile' }],
        }),
    }),
    op('core/services/webhook-event-payloads.ts::parseStripeRefund', {
      arrange: () => args(refundEvent()),
      call: (_ctx, event) => parseStripeRefund(event),
      valid: result => expect(result).toMatchObject({ providerRefundId: 're_hostile', refundId: 'rfd_hostile' }),
    }),
    op('core/services/webhook-event-payloads.ts::parseStripeDispute', {
      arrange: () => args(disputeEvent()),
      call: (_ctx, event) => parseStripeDispute(event),
      valid: result => expect(result).toMatchObject({ disputeId: 'dp_hostile', status: 'needs_response' }),
    }),

    // ------------------------------------------------------------ notifications
    op('core/notifications/service.ts::EmailNotificationService.create', {
      arrange: ctx =>
        args({
          adminEmails: ['admin@example.com'],
          supportEmail: 'support@example.com',
          send: (mail: NotificationMail) => {
            ctx.mails.push(mail);
            return Promise.resolve({ id: 'sent' });
          },
          reads: coreReads(ctx.db),
        }),
      call: (_ctx, config) => EmailNotificationService.create(config),
      keep: { 'args[0].reads': 'the repository reads: a dependency, not input' },
      valid: result => expect(result).toBeInstanceOf(EmailNotificationService),
    }),
    op('core/notifications/service.ts::EmailNotificationService.sendRefundApprovalRequest', {
      arrange: () => args(freshRefund()),
      call: (ctx, refund) => ctx.email.sendRefundApprovalRequest(refund),
      valid: (result, ctx) => {
        expect(result).toBeUndefined();
        expect(ctx.mails.at(-1)).toMatchObject({
          to: ['admin@example.com'],
          subject: expect.stringContaining('Pending Approval'),
        });
      },
    }),
    op('core/notifications/service.ts::EmailNotificationService.sendRefundStatusUpdate', {
      arrange: async ctx => args(await storedRefund(ctx), 'completed'),
      call: (ctx, refund, status) => ctx.email.sendRefundStatusUpdate(refund, status),
      valid: (result, ctx) => {
        expect(result).toBeUndefined();
        expect(ctx.mails.at(-1)).toMatchObject({
          to: ['buyer@example.com'],
          subject: expect.stringContaining('COMPLETED'),
        });
      },
    }),
    op('core/notifications/service.ts::EmailNotificationService.sendRefundFailureAlert', {
      arrange: () => args(freshRefund(), new Error('provider down')),
      call: (ctx, refund, error) => ctx.email.sendRefundFailureAlert(refund, error),
      valid: (result, ctx) => {
        expect(result).toBeUndefined();
        expect(ctx.mails.at(-1)).toMatchObject({
          to: ['support@example.com'],
          text: expect.stringContaining('provider down'),
        });
      },
    }),
    op('core/notifications/service.ts::SlackNotificationService.create', {
      arrange: ctx =>
        args({
          webhookUrl: ctx.slackUrl,
          adminChannel: '#refunds',
          supportChannel: '#support',
          adminUrl: 'https://admin.example.com',
          timeoutMs: 5000,
        }),
      call: (_ctx, config) => SlackNotificationService.create(config),
      valid: result => expect(result).toBeInstanceOf(SlackNotificationService),
    }),
    op('core/notifications/service.ts::SlackNotificationService.sendRefundApprovalRequest', {
      arrange: () => args(freshRefund()),
      call: (ctx, refund) => ctx.slack.sendRefundApprovalRequest(refund),
      valid: (result, ctx) => {
        expect(result).toBeUndefined();
        expect(String(ctx.slackBodies.at(-1))).toContain('requires approval');
      },
    }),
    op('core/notifications/service.ts::SlackNotificationService.sendRefundStatusUpdate', {
      arrange: () => args(freshRefund(), 'completed'),
      call: (ctx, refund, status) => ctx.slack.sendRefundStatusUpdate(refund, status),
      valid: (result, ctx) => {
        expect(result).toBeUndefined();
        expect(String(ctx.slackBodies.at(-1))).toContain('completed');
      },
    }),
    op('core/notifications/service.ts::SlackNotificationService.sendRefundFailureAlert', {
      arrange: () => args(freshRefund(), new Error('provider down')),
      call: (ctx, refund, error) => ctx.slack.sendRefundFailureAlert(refund, error),
      valid: (result, ctx) => {
        expect(result).toBeUndefined();
        expect(String(ctx.slackBodies.at(-1))).toContain('provider down');
      },
    }),
    op('core/notifications/service.ts::MultiChannelNotificationService', {
      arrange: ctx => args([ctx.email, ctx.slack]),
      call: (_ctx, services) => new MultiChannelNotificationService(services),
      keep: { 'args[0]': 'the channel services: dependencies, not input' },
      valid: result => expect(result).toBeInstanceOf(MultiChannelNotificationService),
    }),
    op('core/notifications/service.ts::MultiChannelNotificationService.sendRefundApprovalRequest', {
      arrange: () => args(freshRefund()),
      call: (ctx, refund) => ctx.multi.sendRefundApprovalRequest(refund),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('core/notifications/service.ts::MultiChannelNotificationService.sendRefundStatusUpdate', {
      arrange: async ctx => args(await storedRefund(ctx), 'completed'),
      call: (ctx, refund, status) => ctx.multi.sendRefundStatusUpdate(refund, status),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('core/notifications/service.ts::MultiChannelNotificationService.sendRefundFailureAlert', {
      arrange: () => args(freshRefund(), new Error('provider down')),
      call: (ctx, refund, error) => ctx.multi.sendRefundFailureAlert(refund, error),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('core/notifications/service.ts::createNotificationService', {
      arrange: ctx =>
        args({
          type: 'multi' as const,
          email: {
            adminEmails: ['admin@example.com'],
            supportEmail: 'support@example.com',
            send: (mail: NotificationMail) => {
              ctx.mails.push(mail);
              return Promise.resolve({ id: 'sent' });
            },
            reads: coreReads(ctx.db),
          },
          slack: {
            webhookUrl: ctx.slackUrl,
            adminChannel: '#refunds',
            supportChannel: '#support',
            adminUrl: 'https://admin.example.com',
          },
        }),
      call: (_ctx, config) => createNotificationService(config),
      keep: { 'args[0].email.reads': 'the repository reads: a dependency, not input' },
      valid: result => expect(result).toBeInstanceOf(MultiChannelNotificationService),
    }),
  ],
});
