// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * Refund notifications
 *
 * A notification that did not go out must say so: an admin who never gets the approval request,
 * or a customer who never hears about a refund, is a silent failure. These tests send through a
 * real HTTP server (Slack) and a real recording transport (email) and pin that every send that
 * does not arrive comes back as `payments.notification_failed`, and that a service that cannot
 * send at all is refused when it is built.
 */
import { createServer } from 'node:http';
import type { PGlite } from '@electric-sql/pglite';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { Refund } from '../../refunds/types.js';
import type { AppDb } from '../../test-support.js';
import type { CoreWrites } from '../journal.js';
import type { PaymentId } from '../types.js';
import type { NotificationMail } from './service.js';
import { createRefundId } from '../../refunds/primitives.js';
import { coreReads, runnerOn, seedPayment, seedSubscription } from '../../service-test-support.js';
import { openDb, typed, userId } from '../../test-support.js';
import { NotificationFailed } from '../failures.js';
import { createPaymentId } from '../primitives.js';
import { ReferenceNotFound } from '../providers/provider-error.js';
import { createNotificationService, MultiChannelNotificationService, SlackNotificationService } from './service.js';

let db: AppDb;
let client: PGlite;
let writes: CoreWrites;

/** A Slack stand-in: answers each POST with `status` (or never, when `status` is null) and keeps the bodies. */
type Hook = { url: string; bodies: unknown[]; server: Server };
const hooks: Hook[] = [];

async function slackHook(status: number | null): Promise<Hook> {
  const bodies: unknown[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      bodies.push(JSON.parse(body));
      if (status !== null) response.writeHead(status).end('ok');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const hook = { url: `http://127.0.0.1:${port}/hook`, bodies, server };
  hooks.push(hook);
  return hook;
}

function slackFor(url: string, timeoutMs?: number) {
  return new SlackNotificationService({
    webhookUrl: url,
    adminChannel: '#refunds',
    supportChannel: '#support',
    adminUrl: 'https://admin.example.com',
    timeoutMs,
  });
}

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

/** An email service whose transport records each mail and answers with `answer(mail)`. */
function emailWith(answer: (mail: NotificationMail) => unknown = () => ({ id: 'sent' })) {
  const sent: NotificationMail[] = [];
  const service = createNotificationService({
    type: 'email',
    email: {
      adminEmails: ['admin@example.com'],
      supportEmail: 'support@example.com',
      send: mail => {
        sent.push(mail);
        return Promise.resolve(answer(mail));
      },
      reads: coreReads(db),
    },
  });
  return { service, sent };
}

beforeAll(async () => {
  ({ db, client } = await openDb());
  writes = typed.core.writes(runnerOn(db));
});

afterEach(() => {
  for (const hook of hooks.splice(0)) hook.server.close();
});

afterAll(async () => {
  await client.close();
});

describe('SlackNotificationService', () => {
  it('posts the approval request to the webhook URL and resolves with nothing', async () => {
    const hook = await slackHook(200);
    const refund = refundOf(orThrow(createPaymentId()));

    expect(await slackFor(hook.url).sendRefundApprovalRequest(refund)).toBeUndefined();

    expect(hook.bodies).toEqual([
      expect.objectContaining({ channel: '#refunds', text: expect.stringContaining('requires approval') }),
    ]);
  });

  it('returns NotificationFailed with the status when Slack answers non-2xx', async () => {
    const hook = await slackHook(500);
    const result = await slackFor(hook.url).sendRefundFailureAlert(
      refundOf(orThrow(createPaymentId())),
      new Error('x'),
    );

    expect(NotificationFailed.is(result)).toBe(true);
    expect(result).toMatchObject({
      code: 'payments.notification_failed',
      data: { channel: 'slack', notification: 'refund_failure_alert', status: 500 },
    });
  });

  it('returns NotificationFailed when Slack does not answer before the timeout', async () => {
    const hook = await slackHook(null);
    const result = await slackFor(hook.url, 50).sendRefundStatusUpdate(
      refundOf(orThrow(createPaymentId())),
      'completed',
    );

    expect(result).toMatchObject({
      code: 'payments.notification_failed',
      data: { channel: 'slack', notification: 'refund_status_update' },
    });
    expect(result).toHaveProperty('cause');
  });

  it('returns NotificationFailed when nothing listens at the URL', async () => {
    const hook = await slackHook(200);
    await new Promise(resolve => hook.server.close(resolve));

    const result = await slackFor(hook.url).sendRefundApprovalRequest(refundOf(orThrow(createPaymentId())));

    expect(NotificationFailed.is(result)).toBe(true);
  });
});

describe('EmailNotificationService', () => {
  it('mails the approval request to the admins through the app transport', async () => {
    const { service, sent } = emailWith();

    expect(await service.sendRefundApprovalRequest?.(refundOf(orThrow(createPaymentId())))).toBeUndefined();

    expect(sent).toEqual([
      expect.objectContaining({ to: ['admin@example.com'], text: expect.stringContaining('10.00 USD') }),
    ]);
  });

  it("mails the status update to the email of the payment's customer", async () => {
    const { service, sent } = emailWith();
    const subscription = await seedSubscription(writes, 'active');
    const payment = await seedPayment(writes, subscription.id);

    expect(await service.sendRefundStatusUpdate?.(refundOf(payment.id), 'completed')).toBeUndefined();

    expect(sent).toEqual([
      expect.objectContaining({ to: ['buyer@example.com'], subject: expect.stringContaining('COMPLETED') }),
    ]);
  });

  it('returns ReferenceNotFound and sends nothing when the payment is gone', async () => {
    const { service, sent } = emailWith();
    const paymentId = orThrow(createPaymentId());

    expect(await service.sendRefundStatusUpdate?.(refundOf(paymentId), 'completed')).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'payment', id: paymentId, missing: 'row' },
    });
    expect(sent).toEqual([]);
  });

  it('returns NotificationFailed, with the transport failure as cause, when the transport refuses the mail', async () => {
    const refusal = ReferenceNotFound({ kind: 'customer', id: 'x', missing: 'row' });
    const { service } = emailWith(() => refusal);

    const result = await service.sendRefundFailureAlert?.(refundOf(orThrow(createPaymentId())), new Error('boom'));

    expect(result).toMatchObject({
      code: 'payments.notification_failed',
      data: { channel: 'email', notification: 'refund_failure_alert' },
      cause: refusal,
    });
  });

  it('returns NotificationFailed for the approval request and the status update when the transport refuses the mail', async () => {
    const refusal = ReferenceNotFound({ kind: 'customer', id: 'x', missing: 'row' });
    const { service } = emailWith(() => refusal);
    const subscription = await seedSubscription(writes, 'active');
    const payment = await seedPayment(writes, subscription.id);

    const approval = await service.sendRefundApprovalRequest?.(refundOf(payment.id));
    const update = await service.sendRefundStatusUpdate?.(refundOf(payment.id), 'completed');

    expect(NotificationFailed.is(approval)).toBe(true);
    expect(approval).toMatchObject({ data: { channel: 'email', notification: 'refund_approval_request' } });
    expect(NotificationFailed.is(update)).toBe(true);
    expect(update).toMatchObject({ data: { channel: 'email', notification: 'refund_status_update' } });
  });
});

describe('MultiChannelNotificationService', () => {
  it('tries every channel and returns the failure of the one that did not send', async () => {
    const hook = await slackHook(503);
    const { service: email, sent } = emailWith();
    const multi = new MultiChannelNotificationService([email, slackFor(hook.url)]);

    const result = await multi.sendRefundApprovalRequest(refundOf(orThrow(createPaymentId())));

    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ code: 'payments.notification_failed', data: { channel: 'slack', status: 503 } });
  });

  it('returns the failure of the failing channel for the status update and the failure alert too', async () => {
    const hook = await slackHook(503);
    const { service: email } = emailWith();
    const multi = new MultiChannelNotificationService([email, slackFor(hook.url)]);
    const subscription = await seedSubscription(writes, 'active');
    const payment = await seedPayment(writes, subscription.id);

    const update = await multi.sendRefundStatusUpdate(refundOf(payment.id), 'completed');
    const alert = await multi.sendRefundFailureAlert(refundOf(payment.id), new Error('boom'));

    expect(NotificationFailed.is(update)).toBe(true);
    expect(update).toMatchObject({ data: { channel: 'slack', notification: 'refund_status_update', status: 503 } });
    expect(NotificationFailed.is(alert)).toBe(true);
    expect(alert).toMatchObject({ data: { channel: 'slack', notification: 'refund_failure_alert', status: 503 } });
  });
});

const sendNothing = () => Promise.resolve();

describe('createNotificationService refuses a config that cannot send, when it is built', () => {
  it.each([
    [
      'email with no admin address',
      () =>
        createNotificationService({
          type: 'email',
          email: { adminEmails: [], supportEmail: 'support@example.com', send: sendNothing, reads: coreReads(db) },
        }),
    ],
    [
      'email with a support address that is not one',
      () =>
        createNotificationService({
          type: 'email',
          email: { adminEmails: ['a@example.com'], supportEmail: 'support', send: sendNothing, reads: coreReads(db) },
        }),
    ],
    [
      'slack with no webhook URL',
      () =>
        createNotificationService({
          type: 'slack',
          slack: { webhookUrl: '', adminChannel: '#a', supportChannel: '#s', adminUrl: 'https://admin.example.com' },
        }),
    ],
    ['multi with no channel', () => createNotificationService({ type: 'multi' })],
  ])('%s throws payments.configuration_invalid', (_name, build) => {
    expect(build).toThrow(expect.objectContaining({ code: 'payments.configuration_invalid' }));
  });
});
