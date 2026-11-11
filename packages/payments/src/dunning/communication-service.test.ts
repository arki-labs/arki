/**
 * Notification providers and the orchestration service
 *
 * A dunning message goes to Resend, Twilio or a customer's webhook. Their answers are outside
 * data: a refusal, a slow provider or a body in another shape must come back as a failure with a
 * code the caller can branch on, and the communication row must say what happened. The providers
 * talk to a real local HTTP server that answers the way each API documents; the rows live in PGlite.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { add, fromDate, now, toMillis } from '@arki/date';
import { findDatabaseError } from '@arki/db/errors';
import { FAILURE_ERROR_CODES, InvalidInput, isFailure, orThrow } from '@arki/failure';

import type { DunningExecutionId } from './primitives.js';
import type {
  CommunicationRequest,
  InAppNotification,
  InAppNotificationStore,
  StoredInAppNotification,
} from './services/communication-service.js';
import { createCustomerId } from '../core/primitives.js';
import { PaymentProviderError } from '../core/providers/provider-error.js';
import { core, customerId, schema, userId, users } from '../test-support.js';
import {
  NotificationChannelUnavailable,
  NotificationProviderRejected,
  NotificationProviderResponseInvalid,
  NotificationProviderTimeout,
  NotificationWebhookHostNotAllowed,
} from './failures.js';
import { createDunningCommunicationId, createDunningExecutionId, createDunningTemplateId } from './primitives.js';
import { createDunningCommunicationRepository } from './repository.js';
import { DunningCampaignService } from './services/campaign-service.js';
import {
  CommunicationOrchestrationService,
  createCommunicationOrchestrationService,
  EmailProvider,
  InAppProvider,
  MAX_PROVIDER_BODY_BYTES,
  SMSProvider,
  WebhookProvider,
} from './services/communication-service.js';
import { createDunningTables } from './tables.js';

/** What the local server answers on the next request: a status, a body, and an optional delay. */
type Answer = { status: number; body: string; delayMs?: number; headers?: Record<string, string> };

let answer: Answer = { status: 200, body: '{}' };
let lastRequest: { url: string | undefined; body: string } | undefined;
let requestCount = 0;
let server: Server;
let origin: string;

function answerWith(next: Answer) {
  answer = next;
}

function handle(request: IncomingMessage, response: ServerResponse) {
  let body = '';
  request.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  request.on('end', () => {
    lastRequest = { url: request.url, body };
    requestCount += 1;
    const reply = answer;
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      response.end(reply.body);
    }, reply.delayMs ?? 0);
  });
}

const request: CommunicationRequest = {
  recipient: 'buyer@example.com',
  subject: 'Payment failed for {{customer_name}}',
  content: 'Hello {{customer_name}}, please update your card',
  template: { channel: 'email', content: 'Hello', variables: [] },
  personalizations: { customer_name: 'Ada' },
};

function emailResult(timeoutMs = 2000) {
  return EmailProvider.create({
    apiKey: 're_test',
    fromEmail: 'billing@example.com',
    fromName: 'Billing',
    timeoutMs,
    apiBaseUrl: origin,
  });
}

function email(timeoutMs = 2000) {
  return orThrow(emailResult(timeoutMs));
}

function smsResult(timeoutMs = 2000) {
  return SMSProvider.create({
    accountSid: 'AC123',
    authToken: 'secret',
    fromNumber: '+15550000000',
    timeoutMs,
    apiBaseUrl: origin,
  });
}

function sms(timeoutMs = 2000) {
  return orThrow(smsResult(timeoutMs));
}

/** The local test server is the only host the webhook may reach. */
function webhookResult(timeoutMs = 2000) {
  return WebhookProvider.create({ allowedHosts: ['127.0.0.1'], defaultHeaders: {}, timeoutMs });
}

function webhook(timeoutMs = 2000) {
  return orThrow(webhookResult(timeoutMs));
}

/** The code of the failure a boot-time setup returns; nothing is thrown. */
function bootFailureCode(build: () => unknown): string | undefined {
  const built = build();
  return isFailure(built) ? built.code : undefined;
}

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});
const tables = {
  dunningCampaigns: dunning.dunningCampaigns,
  dunningCampaignAnalytics: dunning.dunningCampaignAnalytics,
  dunningTemplates: dunning.dunningTemplates,
  dunningExecutions: dunning.dunningExecutions,
  dunningCommunications: dunning.dunningCommunications,
};
const relations = defineRelations(tables, () => ({}));

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof relations>>;

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') throw new Error('the test server has no port');
  origin = `http://127.0.0.1:${address.port}`;

  client = new PGlite('memory://');
  await client.waitReady;
  db = drizzle({ client, relations });
  const { apply } = await pushSchema(
    {
      schema,
      users,
      ...core.enums,
      plans: core.plans,
      customers: core.customers,
      subscriptions: core.subscriptions,
      payments: core.payments,
      ...dunning.enums,
      ...tables,
      customerRiskProfiles: dunning.customerRiskProfiles,
    },
    db,
  );
  await apply();
  await db.insert(users).values({ id: userId });
  await db
    .insert(core.customers)
    .values({ id: customerId, userId, providerCustomerId: 'cus_comm', email: 'buyer@example.com' });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await client.close();
});

describe('EmailProvider (Resend)', () => {
  it('a sent email returns its Resend id and fills in the personalizations', async () => {
    answerWith({ status: 200, body: JSON.stringify({ id: 'email_123' }) });

    const sent = orThrow(await email().send(request));

    expect(sent.messageId).toBe('email_123');
    expect(lastRequest?.url).toBe('/emails');
    expect(JSON.parse(lastRequest?.body ?? '{}')).toMatchObject({
      subject: 'Payment failed for Ada',
      html: 'Hello Ada, please update your card',
    });
  });

  it('inserts a personalization literally: $& and $` in a value are not replacement patterns', async () => {
    answerWith({ status: 200, body: JSON.stringify({ id: 'email_124' }) });

    orThrow(await email().send({ ...request, personalizations: { customer_name: "A$&B$`C$'D$$" } }));

    expect(JSON.parse(lastRequest?.body ?? '{}')).toMatchObject({
      subject: "Payment failed for A$&B$`C$'D$$",
      html: "Hello A$&B$`C$'D$$, please update your card",
    });
  });

  it('a refusal returns payments.notification_provider_rejected with the status and Resend message', async () => {
    answerWith({
      status: 422,
      body: JSON.stringify({ statusCode: 422, name: 'validation_error', message: 'Invalid `to` field' }),
    });

    const refused = await email().send(request);

    expect(NotificationProviderRejected.is(refused)).toBe(true);
    expect(refused).toMatchObject({
      code: 'payments.notification_provider_rejected',
      data: { channel: 'email', provider: 'resend', upstreamStatus: 422, upstreamMessage: 'Invalid `to` field' },
    });
  });

  it('a refusal whose body is not JSON still returns the status, with no message', async () => {
    answerWith({ status: 503, body: '<html>Service Unavailable</html>' });

    const refused = await email().send(request);

    expect(refused).toMatchObject({ data: { upstreamStatus: 503, upstreamMessage: null } });
  });

  it('a provider slower than timeoutMs returns payments.notification_provider_timeout', async () => {
    answerWith({ status: 200, body: JSON.stringify({ id: 'late' }), delayMs: 500 });

    const late = await email(50).send(request);

    expect(NotificationProviderTimeout.is(late)).toBe(true);
    expect(late).toMatchObject({ data: { channel: 'email', provider: 'resend', timeoutMs: 50 } });
  });

  it('a success body without an id returns payments.notification_provider_response_invalid, caused by the schema failure', async () => {
    answerWith({ status: 200, body: JSON.stringify({ object: 'email' }) });

    const unreadable = await email().send(request);

    expect(NotificationProviderResponseInvalid.is(unreadable)).toBe(true);
    expect(unreadable).toMatchObject({ data: { upstreamStatus: 200 } });
    expect(NotificationProviderResponseInvalid.is(unreadable) && InvalidInput.is(unreadable.cause)).toBe(true);
  });

  it('a delivery status reads last_event and created_at, and a missing email is a rejection', async () => {
    answerWith({
      status: 200,
      body: JSON.stringify({ last_event: 'delivered', created_at: '2026-10-30T10:00:00.000Z' }),
    });
    const status = orThrow(await email().getDeliveryStatus('email_123'));
    answerWith({ status: 404, body: JSON.stringify({ message: 'Email not found' }) });
    const missing = await email().getDeliveryStatus('email_404');

    expect(status.status).toBe('delivered');
    expect(status.timestamp.toString()).toBe('2026-10-30T10:00:00Z');
    expect(missing).toMatchObject({ code: 'payments.notification_provider_rejected', data: { upstreamStatus: 404 } });
  });

  it('a delivery status with a created_at that is not a date is payments.notification_provider_response_invalid', async () => {
    answerWith({ status: 200, body: JSON.stringify({ last_event: 'sent', created_at: 'yesterday' }) });

    const unreadable = await email().getDeliveryStatus('email_123');

    expect(NotificationProviderResponseInvalid.is(unreadable)).toBe(true);
  });
});

/** A thrown provider fault that a later retry can fix. */
function unavailable(error: unknown) {
  return error instanceof PaymentProviderError && error.code === 'unavailable' && error.retryable;
}

describe('a provider that cannot be reached, or a message id it cannot be asked about', () => {
  // Nothing listens on port 1: the connection is refused before any answer
  const offline = {
    apiKey: 're_test',
    fromEmail: 'billing@example.com',
    fromName: 'Billing',
    apiBaseUrl: 'http://127.0.0.1:1',
  };

  it('send and getDeliveryStatus throw PaymentProviderError unavailable (retryable), with the network error as cause', async () => {
    const provider = orThrow(EmailProvider.create(offline));

    await expect(provider.send(request)).rejects.toSatisfy(unavailable);
    await expect(provider.getDeliveryStatus('email_123')).rejects.toSatisfy(
      error => unavailable(error) && error instanceof Error && error.cause instanceof Error,
    );
  });

  it('an apiKey, token or apiBaseUrl fetch would refuse before sending fails at boot, so unavailable means a real outage', () => {
    const base = { apiKey: 're_test', fromEmail: 'billing@example.com', fromName: 'Billing' };
    const smsBase = { accountSid: 'AC123', authToken: 'secret', fromNumber: '+15550000000' };
    for (const apiKey of ['re_\nInjected: 1', 're_\u0000', 're_\u2028', 're_\uD800']) {
      expect(bootFailureCode(() => EmailProvider.create({ ...base, apiKey }))).toBe('payments.configuration_invalid');
      expect(bootFailureCode(() => SMSProvider.create({ ...smsBase, authToken: apiKey }))).toBe(
        'payments.configuration_invalid',
      );
      expect(bootFailureCode(() => SMSProvider.create({ ...smsBase, accountSid: apiKey }))).toBe(
        'payments.configuration_invalid',
      );
    }
    for (const apiBaseUrl of ['not a url', 'ftp://api.resend.com', 'https://user:pass@api.resend.com', '']) {
      expect(bootFailureCode(() => EmailProvider.create({ ...base, apiBaseUrl }))).toBe(
        'payments.configuration_invalid',
      );
      expect(bootFailureCode(() => SMSProvider.create({ ...smsBase, apiBaseUrl }))).toBe(
        'payments.configuration_invalid',
      );
    }
    const badHeaders: Record<string, string>[] = [{ 'Bad Name': 'v' }, { 'X-Ok': 'line\r\nbreak' }];
    for (const defaultHeaders of badHeaders) {
      expect(
        bootFailureCode(() => WebhookProvider.create({ allowedHosts: ['127.0.0.1'], defaultHeaders, timeoutMs: 1000 })),
      ).toBe('payments.configuration_invalid');
    }
    // Latin-1 text a header carries is accepted
    expect(
      orThrow(EmailProvider.create({ ...base, apiKey: 're_\u00E9', apiBaseUrl: 'https://api.resend.com' })).channel,
    ).toBe('email');
  });

  it('a message id with a lone UTF-16 surrogate returns schema.invalid_input and makes no request', async () => {
    const before = requestCount;

    const fromEmail = await email().getDeliveryStatus('email_\uD800');
    const fromSms = await sms().getDeliveryStatus('SM\uDC00');

    expect(fromEmail).toMatchObject({ code: 'schema.invalid_input' });
    expect(fromSms).toMatchObject({ code: 'schema.invalid_input' });
    expect(requestCount).toBe(before);
  });
});

describe('provider answers are read up to a size limit', () => {
  it('a refusal body past MAX_PROVIDER_BODY_BYTES is cut there, so its message is not read', async () => {
    // A complete JSON body would carry the message; cut at the limit it is no longer JSON
    const message = 'x'.repeat(MAX_PROVIDER_BODY_BYTES * 2);
    answerWith({ status: 400, body: JSON.stringify({ message }) });

    const refused = await email().send(request);

    expect(refused).toMatchObject({
      code: 'payments.notification_provider_rejected',
      data: { upstreamStatus: 400, upstreamMessage: null },
    });
  });
});

describe('SMSProvider (Twilio)', () => {
  it('a sent SMS returns its Twilio sid', async () => {
    answerWith({ status: 201, body: JSON.stringify({ sid: 'SM123', status: 'queued', uri: '/Messages/SM123.json' }) });

    const sent = orThrow(await sms().send({ ...request, recipient: '+15551234567' }));

    expect(sent.messageId).toBe('SM123');
    expect(lastRequest?.url).toBe('/2010-04-01/Accounts/AC123/Messages.json');
  });

  it('a Twilio error returns payments.notification_provider_rejected with its message', async () => {
    answerWith({
      status: 400,
      body: JSON.stringify({ code: 21_211, message: "The 'To' number is not valid", status: 400 }),
    });

    const refused = await sms().send({ ...request, recipient: 'not-a-number' });

    expect(refused).toMatchObject({
      code: 'payments.notification_provider_rejected',
      data: {
        channel: 'sms',
        provider: 'twilio',
        upstreamStatus: 400,
        upstreamMessage: "The 'To' number is not valid",
      },
    });
  });

  it('a success body without a sid returns payments.notification_provider_response_invalid', async () => {
    answerWith({ status: 201, body: JSON.stringify({ status: 'queued' }) });

    const unreadable = await sms().send({ ...request, recipient: '+15551234567' });

    expect(NotificationProviderResponseInvalid.is(unreadable)).toBe(true);
  });

  it('a slow Twilio returns payments.notification_provider_timeout', async () => {
    answerWith({ status: 201, body: JSON.stringify({ sid: 'late' }), delayMs: 500 });

    const late = await sms(50).send({ ...request, recipient: '+15551234567' });

    expect(late).toMatchObject({ code: 'payments.notification_provider_timeout', data: { channel: 'sms' } });
  });

  it('a delivery status maps the Twilio status, a missing message is a rejection and a body without a sid is invalid', async () => {
    answerWith({ status: 200, body: JSON.stringify({ sid: 'SM1', status: 'undelivered' }) });
    const status = orThrow(await sms().getDeliveryStatus('SM1'));
    answerWith({ status: 404, body: JSON.stringify({ message: 'The requested resource was not found' }) });
    const missing = await sms().getDeliveryStatus('SM404');
    answerWith({ status: 200, body: JSON.stringify({ status: 'delivered' }) });
    const unreadable = await sms().getDeliveryStatus('SM2');

    expect(status.status).toBe('failed');
    expect(NotificationProviderRejected.is(missing)).toBe(true);
    expect(missing).toMatchObject({ code: 'payments.notification_provider_rejected', data: { upstreamStatus: 404 } });
    expect(NotificationProviderResponseInvalid.is(unreadable)).toBe(true);
  });
});

describe('WebhookProvider', () => {
  it('a recipient that is not an http or https URL returns schema.invalid_input and sends nothing', async () => {
    lastRequest = undefined;

    const refused = await webhook().send({ ...request, recipient: 'ftp://hooks.example.com/dunning' });

    expect(InvalidInput.is(refused)).toBe(true);
    expect(lastRequest).toBeUndefined();
  });

  it('posts a JSON content as the payload, with the tracking metadata added', async () => {
    answerWith({ status: 204, body: '' });

    const sent = orThrow(
      await webhook().send({
        ...request,
        recipient: `${origin}/hook`,
        content: '{"event":"payment_failed","name":"{{customer_name}}"}',
        trackingData: { campaignId: 'dc_1' },
      }),
    );

    expect(sent.providerResponse).toMatchObject({ provider: 'webhook', status: 204 });
    expect(JSON.parse(lastRequest?.body ?? '{}')).toMatchObject({
      event: 'payment_failed',
      name: 'Ada',
      metadata: { campaignId: 'dc_1' },
    });
  });

  it('never keeps the reply: a refusal has no upstream message and a success records only the status', async () => {
    answerWith({ status: 400, body: JSON.stringify({ message: 'internal detail from the receiver' }) });
    const refused = await webhook().send({ ...request, recipient: `${origin}/hook` });
    answerWith({ status: 200, body: JSON.stringify({ secret: 'kept nowhere' }) });
    const sent = orThrow(await webhook().send({ ...request, recipient: `${origin}/hook` }));

    expect(refused).toMatchObject({ data: { upstreamStatus: 400, upstreamMessage: null } });
    expect(Object.keys(sent.providerResponse).toSorted()).toEqual(['provider', 'recipient', 'status', 'timestamp']);
  });

  it('a host that is not on allowedHosts returns payments.notification_webhook_host_not_allowed and makes no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    lastRequest = undefined;

    const metadata = await webhook().send({ ...request, recipient: 'http://169.254.169.254/latest/meta-data/' });
    const lookalike = await webhook().send({ ...request, recipient: 'http://127.0.0.1.example.com/hook' });

    expect(NotificationWebhookHostNotAllowed.is(metadata)).toBe(true);
    expect(metadata).toMatchObject({ data: { host: '169.254.169.254' } });
    expect(NotificationWebhookHostNotAllowed.is(lookalike)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lastRequest).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('a redirect is never followed: an allowed host cannot send the call to a host that is not allowed', async () => {
    answerWith({ status: 302, body: '', headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    requestCount = 0;

    const refused = await webhook(500).send({ ...request, recipient: `${origin}/hook` });

    expect(refused).toMatchObject({
      code: 'payments.notification_provider_rejected',
      data: { upstreamStatus: 302, upstreamMessage: null },
    });
    expect(requestCount).toBe(1);
  });

  it('an empty allowedHosts, or an entry that is not a bare hostname, fails at boot with payments.configuration_invalid', () => {
    const empty = () => WebhookProvider.create({ allowedHosts: [], defaultHeaders: {}, timeoutMs: 1000 });
    const withScheme = () =>
      WebhookProvider.create({ allowedHosts: ['https://hooks.example.com'], defaultHeaders: {}, timeoutMs: 1000 });
    const factory = () => createCommunicationOrchestrationService(db, tables, { webhook: { allowedHosts: [] } });

    expect(bootFailureCode(empty)).toBe('payments.configuration_invalid');
    expect(bootFailureCode(withScheme)).toBe('payments.configuration_invalid');
    expect(bootFailureCode(factory)).toBe('payments.configuration_invalid');
  });

  it('a recipient URL with a user name or password returns schema.invalid_input and sends nothing, where fetch would throw', async () => {
    const before = requestCount;

    const refused = await webhook().send({
      ...request,
      recipient: origin.replace('http://', 'http://user:pw@') + '/hook',
    });

    expect(refused).toMatchObject({ code: 'schema.invalid_input' });
    expect(requestCount).toBe(before);
  });

  it('tracking data with a bigint returns schema.invalid_input and sends nothing, where JSON.stringify would throw', async () => {
    lastRequest = undefined;

    const refused = await webhook().send({ ...request, recipient: `${origin}/hook`, trackingData: { amount: 10n } });

    expect(refused).toMatchObject({ code: 'schema.invalid_input' });
    expect(lastRequest).toBeUndefined();
  });

  it('a timeoutMs no timer can wait fails at boot with payments.configuration_invalid, for every timed provider', () => {
    for (const timeoutMs of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(bootFailureCode(() => webhookResult(timeoutMs))).toBe('payments.configuration_invalid');
      expect(bootFailureCode(() => emailResult(timeoutMs))).toBe('payments.configuration_invalid');
      expect(bootFailureCode(() => smsResult(timeoutMs))).toBe('payments.configuration_invalid');
    }
    const factory = () =>
      createCommunicationOrchestrationService(db, tables, {
        webhook: { allowedHosts: ['127.0.0.1'], timeoutMs: Number.NaN },
      });
    expect(bootFailureCode(factory)).toBe('payments.configuration_invalid');
    // The default and the bounds themselves are accepted
    expect(webhook(1).channel).toBe('webhook');
    expect(email(2 ** 31 - 1).channel).toBe('email');
  });

  it('the webhook channel is off unless it is configured', async () => {
    const service = orThrow(createCommunicationOrchestrationService(db, tables));

    expect(await service.validateProviders()).toEqual({});
  });

  it('an error status returns payments.notification_provider_rejected; a slow hook returns the timeout', async () => {
    answerWith({ status: 500, body: 'boom' });
    const refused = await webhook().send({ ...request, recipient: `${origin}/hook` });
    answerWith({ status: 200, body: '', delayMs: 500 });
    const late = await webhook(50).send({ ...request, recipient: `${origin}/hook` });

    expect(refused).toMatchObject({ code: 'payments.notification_provider_rejected', data: { upstreamStatus: 500 } });
    expect(late).toMatchObject({
      code: 'payments.notification_provider_timeout',
      data: { channel: 'webhook', timeoutMs: 50 },
    });
  });
});

/** The app's notifications, kept in a map: what an app's notifications table would hold. */
function notificationStore() {
  const rows = new Map<string, InAppNotification & StoredInAppNotification>();
  const store: InAppNotificationStore = {
    async save(notification) {
      const stored = { ...notification, id: `ntf_${rows.size + 1}`, createdAt: now(), readAt: null };
      rows.set(stored.id, stored);
      return stored;
    },
    async find(id) {
      return rows.get(id) ?? null;
    },
  };
  return { store, rows };
}

describe('InAppProvider', () => {
  it('stores the notification through the app store and returns the stored id', async () => {
    const { store, rows } = notificationStore();
    const inApp = new InAppProvider({ appUrl: 'https://app.example.com', store });

    const sent = await inApp.send({ ...request, recipient: customerId, trackingData: { campaignId: 'dc_1' } });

    expect(sent.messageId).toBe('ntf_1');
    expect(sent.providerResponse).toMatchObject({ appUrl: 'https://app.example.com/notifications/ntf_1' });
    expect(rows.get('ntf_1')).toMatchObject({
      recipient: customerId,
      title: 'Payment failed for Ada',
      content: 'Hello Ada, please update your card',
      trackingData: { campaignId: 'dc_1' },
    });
  });

  it('reports what the store holds: delivered, opened once read, and a rejection for an id it does not have', async () => {
    const { store, rows } = notificationStore();
    const inApp = new InAppProvider({ appUrl: 'https://app.example.com', store });
    const { messageId } = await inApp.send(request);

    const delivered = await inApp.getDeliveryStatus(messageId);
    const stored = rows.get(messageId);
    if (!stored) throw new Error('the notification was not stored');
    const readAt = add(stored.createdAt, { minutes: 5 });
    rows.set(messageId, { ...stored, readAt });
    const opened = await inApp.getDeliveryStatus(messageId);
    const unknown = await inApp.getDeliveryStatus('ntf_unknown');

    expect(delivered).toMatchObject({ status: 'delivered', timestamp: stored.createdAt });
    expect(opened).toMatchObject({ status: 'opened', timestamp: readAt });
    expect(unknown).toMatchObject({
      code: 'payments.notification_provider_rejected',
      data: { channel: 'in_app', upstreamStatus: 404 },
    });
  });
});

describe('CommunicationOrchestrationService.sendCommunication', () => {
  async function scheduledExecution() {
    const campaigns = new DunningCampaignService(
      db,
      {
        ...tables,
        customerRiskProfiles: dunning.customerRiskProfiles,
        customers: core.customers,
        payments: core.payments,
        subscriptions: core.subscriptions,
      },
      () => {
        throw new Error('not used');
      },
    );
    const created = await campaigns.createCampaign(
      {
        name: 'Notify',
        type: 'payment_failed',
        trigger: { type: 'payment_failure', conditions: { paymentFailureCount: 1 } },
        settings: {
          enabled: true,
          priority: 1,
          cooldownPeriod: 24,
          maxExecutionsPerCustomer: 3,
          stopOnPaymentSuccess: false,
          respectUnsubscribe: true,
          businessHoursOnly: false,
        },
        targetSegments: [],
        templates: [
          {
            name: 'Step 1',
            stepNumber: 1,
            delayHours: 0,
            communication: {
              channel: 'email',
              subject: 'Payment failed',
              content: 'Please update your card',
              variables: [],
            },
          },
        ],
      },
      'usr_admin',
    );
    const campaign = orThrow(created);
    const template = campaign.templates[0];
    if (!template) throw new Error('the campaign has no template');
    const [execution] = await db
      .insert(tables.dunningExecutions)
      .values({
        campaignId: campaign.id,
        templateId: template.id,
        customerId,
        triggerType: 'manual',
        triggerData: {},
        scheduledAt: now(),
      })
      .returning();
    if (!execution) throw new Error('the execution was not stored');

    return { execution, template };
  }

  async function communicationsOf(executionId: DunningExecutionId) {
    return db
      .select()
      .from(tables.dunningCommunications)
      .where(eq(tables.dunningCommunications.executionId, executionId));
  }

  const customer = { id: customerId, email: 'buyer@example.com', name: 'Ada' };

  it('a channel with no provider returns payments.notification_channel_unavailable and writes no row', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    const { execution, template } = await scheduledExecution();

    const refused = await service.sendCommunication(execution, template, customer);

    expect(NotificationChannelUnavailable.is(refused)).toBe(true);
    expect(refused).toMatchObject({ data: { channel: 'email' } });
    expect(await communicationsOf(execution.id)).toHaveLength(0);
  });

  it('a provider refusal is returned and the row is marked failed with its message', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    service.registerProvider(email());
    const { execution, template } = await scheduledExecution();
    answerWith({ status: 403, body: JSON.stringify({ message: 'The API key is not allowed to send' }) });

    const refused = await service.sendCommunication(execution, template, customer);
    const [row] = await communicationsOf(execution.id);

    expect(refused).toMatchObject({ code: 'payments.notification_provider_rejected', data: { upstreamStatus: 403 } });
    expect(row).toMatchObject({
      status: 'failed',
      failureReason: 'resend refused the notification with status 403: The API key is not allowed to send',
    });
  });

  it('a sent message returns the row as it is now: sent, with the provider message id', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    service.registerProvider(email());
    const { execution, template } = await scheduledExecution();
    answerWith({ status: 200, body: JSON.stringify({ id: 'email_sent' }) });

    const sent = orThrow(await service.sendCommunication(execution, template, customer));

    expect(sent).toMatchObject({ status: 'sent', providerMessageId: 'email_sent' });
  });

  it('an unknown execution, step or customer returns its not-found code, writes no row and sends nothing', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    service.registerProvider(email());
    const { execution, template } = await scheduledExecution();
    const unknownExecution = { ...execution, id: orThrow(createDunningExecutionId()) };
    const unknownStep = { ...template, id: orThrow(createDunningTemplateId()) };
    const unknownCustomer = { ...execution, customerId: orThrow(createCustomerId()) };
    const requestsBefore = requestCount;

    const answers = [
      await service.sendCommunication(unknownExecution, template, customer),
      await service.sendCommunication(execution, unknownStep, customer),
      await service.sendCommunication(unknownCustomer, template, customer),
    ];

    expect(answers).toMatchObject([
      { code: 'payments.dunning_execution_not_found', data: { executionId: unknownExecution.id } },
      { code: 'payments.dunning_template_not_found', data: { templateId: unknownStep.id } },
      { code: 'payments.reference_not_found', data: { kind: 'customer', id: unknownCustomer.customerId } },
    ]);
    expect(requestCount).toBe(requestsBefore);
    expect(await communicationsOf(execution.id)).toHaveLength(0);
    expect(await communicationsOf(unknownExecution.id)).toHaveLength(0);
  });

  it('a recipient the column cannot store returns schema.invalid_input, writes no row and sends nothing', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    service.registerProvider(email());
    const { execution, template } = await scheduledExecution();
    const requestsBefore = requestCount;

    const tooLong = await service.sendCommunication(execution, template, {
      ...customer,
      email: `${'a'.repeat(250)}@example.com`,
    });
    const withNul = await service.sendCommunication(execution, template, {
      ...customer,
      email: 'buyer\u0000@example.com',
    });

    expect(tooLong).toMatchObject({ code: 'schema.invalid_input' });
    expect(withNul).toMatchObject({ code: 'schema.invalid_input' });
    expect(requestCount).toBe(requestsBefore);
    expect(await communicationsOf(execution.id)).toHaveLength(0);
  });

  it('a refusal whose message holds U+0000 is still returned typed, with no upstream message, and the row is failed', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    service.registerProvider(email());
    const { execution, template } = await scheduledExecution();
    answerWith({ status: 422, body: JSON.stringify({ message: 'bad\u0000' }) });

    const refused = await service.sendCommunication(execution, template, customer);

    expect(refused).toMatchObject({
      code: 'payments.notification_provider_rejected',
      data: { upstreamStatus: 422, upstreamMessage: null },
    });
    expect(await communicationsOf(execution.id)).toEqual([
      expect.objectContaining({ status: 'failed', failureReason: 'resend refused the notification with status 422' }),
    ]);
  });

  it('an accepted message whose id the column cannot store is payments.notification_provider_response_invalid', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    service.registerProvider(email());
    service.registerProvider(sms());
    const { execution, template } = await scheduledExecution();
    answerWith({ status: 200, body: JSON.stringify({ id: 'e'.repeat(256) }) });

    const longId = await service.sendCommunication(execution, template, customer);
    answerWith({ status: 201, body: JSON.stringify({ sid: 'SM\u0000' }) });
    const nulSid = await sms().send({ ...request, recipient: '+15550000002' });

    expect(longId).toMatchObject({ code: 'payments.notification_provider_response_invalid' });
    expect(nulSid).toMatchObject({ code: 'payments.notification_provider_response_invalid' });
    expect(await communicationsOf(execution.id)).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('a provider that cannot be reached is thrown as unavailable after the row is marked failed', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    service.registerProvider(
      orThrow(
        EmailProvider.create({
          apiKey: 're_test',
          fromEmail: 'billing@example.com',
          fromName: 'Billing',
          apiBaseUrl: 'http://127.0.0.1:1',
        }),
      ),
    );
    const { execution, template } = await scheduledExecution();

    await expect(service.sendCommunication(execution, template, customer)).rejects.toSatisfy(
      error => error instanceof PaymentProviderError && error.code === 'unavailable',
    );
    expect(await communicationsOf(execution.id)).toEqual([
      expect.objectContaining({ status: 'failed', failureReason: 'The resend request failed' }),
    ]);
  });

  // The send error is what the caller must act on: a status write that fails as well may not replace it
  it('when marking the row failed fails too, both errors are thrown, the send error first', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    service.registerProvider(
      orThrow(
        EmailProvider.create({
          apiKey: 're_test',
          fromEmail: 'billing@example.com',
          fromName: 'Billing',
          apiBaseUrl: 'http://127.0.0.1:1',
        }),
      ),
    );
    const { execution, template } = await scheduledExecution();
    // New writes of `failed` are refused; rows other tests already failed stay as they are
    const communications = tables.dunningCommunications;
    await db.execute(
      sql`alter table ${communications} add constraint communications_never_failed check (status <> 'failed') not valid`,
    );

    try {
      const thrown: unknown = await service
        .sendCommunication(execution, template, customer)
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(AggregateError);
      const errors = thrown instanceof AggregateError ? thrown.errors : [];
      expect(errors[0]).toBeInstanceOf(PaymentProviderError);
      expect(errors[0]).toMatchObject({ code: 'unavailable' });
      expect(errors[1]).toSatisfy((error: unknown) => findDatabaseError(error)?.sqlState === '23514');
    } finally {
      await db.execute(sql`alter table ${communications} drop constraint communications_never_failed`);
    }
  });

  // Executions own the resend: a failed send is sent again by exactly one job, never by both
  it('retryFailedCommunications skips a send whose execution will be retried, and a send a later one replaced', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    service.registerProvider(email());
    answerWith({ status: 422, body: JSON.stringify({ message: 'refused' }) });
    const retried = await scheduledExecution();
    const givenUp = await scheduledExecution();
    // Two refused sends per execution: the second replaces the first
    for (const { execution, template } of [retried, givenUp]) {
      for (const attempt of [1, 2]) {
        expect(await service.sendCommunication(execution, template, customer), `attempt ${attempt}`).toMatchObject({
          code: 'payments.notification_provider_rejected',
        });
      }
    }
    // retryFailedExecutions will run the first execution again; no retry will run the second
    await db
      .update(tables.dunningExecutions)
      .set({ status: 'failed', nextRetryAt: add(now(), { minutes: 30 }) })
      .where(eq(tables.dunningExecutions.id, retried.execution.id));
    await db
      .update(tables.dunningExecutions)
      .set({ status: 'failed', nextRetryAt: null })
      .where(eq(tables.dunningExecutions.id, givenUp.execution.id));
    answerWith({ status: 200, body: JSON.stringify({ id: 'email_resent' }) });

    await service.retryFailedCommunications();

    const statuses = async (executionId: DunningExecutionId) => {
      const rows = await communicationsOf(executionId);
      return rows
        .toSorted((left, right) => toMillis(left.createdAt) - toMillis(right.createdAt))
        .map(row => row.status);
    };
    expect(await statuses(retried.execution.id)).toEqual(['failed', 'failed']);
    expect(await statuses(givenUp.execution.id)).toEqual(['failed', 'sent']);
  });

  it('a page size, offset or time that is not a precondition value throws the invariant failure before any query', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    const page = { offset: 0, sortBy: 'createdAt', sortOrder: 'desc' } as const;

    for (const limit of [1.5, -1, Number.NaN]) {
      await expect(service.processPendingCommunications(limit)).rejects.toMatchObject({
        code: FAILURE_ERROR_CODES.invariant,
      });
      await expect(service.retryFailedCommunications(limit)).rejects.toMatchObject({
        code: FAILURE_ERROR_CODES.invariant,
      });
      await expect(service.listCommunications({ ...page, limit })).rejects.toMatchObject({
        code: FAILURE_ERROR_CODES.invariant,
      });
    }
    await expect(service.listCommunications({ ...page, limit: 10, offset: -1 })).rejects.toMatchObject({
      code: FAILURE_ERROR_CODES.invariant,
    });
    await expect(
      service.listCommunications({ ...page, limit: 10, sentAfter: fromDate(new Date('+010000-01-01T00:00:00Z')) }),
    ).rejects.toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
    expect(await service.listCommunications({ ...page, limit: 0 })).toEqual([]);
  });

  it('processPendingCommunications lists each communication it could not send', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    const { execution, template } = await scheduledExecution();
    const [pending] = await db
      .insert(tables.dunningCommunications)
      .values({
        executionId: execution.id,
        customerId,
        templateId: template.id,
        channel: 'sms',
        recipient: '+15550000001',
        content: 'Please update your card',
        status: 'pending',
      })
      .returning();
    if (!pending) throw new Error('the communication was not stored');

    const report = await service.processPendingCommunications();

    expect(report.failed).toContainEqual({
      id: pending.id,
      code: 'payments.notification_channel_unavailable',
      message: 'No notification provider is registered for the sms channel',
    });
  });

  it('getDeliveryStatus returns the provider failure instead of null', async () => {
    const service = new CommunicationOrchestrationService(db, tables);
    service.registerProvider(email());
    const { execution, template } = await scheduledExecution();
    answerWith({ status: 200, body: JSON.stringify({ id: 'email_tracked' }) });
    const sent = orThrow(await service.sendCommunication(execution, template, customer));
    answerWith({ status: 500, body: JSON.stringify({ message: 'Resend is down' }) });

    const refused = await service.getDeliveryStatus(sent.id);

    expect(NotificationProviderRejected.is(refused)).toBe(true);
    expect(refused).toMatchObject({ code: 'payments.notification_provider_rejected', data: { upstreamStatus: 500 } });
  });
});

describe('CommunicationOrchestrationService.handleCommunicationWebhook', () => {
  async function sentCommunication(providerMessageId: string) {
    const [execution] = await db.select().from(tables.dunningExecutions).limit(1);
    if (!execution?.templateId) throw new Error('no execution with a step to attach the communication to');
    const [row] = await db
      .insert(tables.dunningCommunications)
      .values({
        executionId: execution.id,
        customerId,
        templateId: execution.templateId,
        channel: 'email',
        recipient: 'buyer@example.com',
        content: 'Please update your card',
        status: 'sent',
        providerMessageId,
      })
      .returning();
    if (!row) throw new Error('the communication was not stored');

    return row;
  }

  const service = () => new CommunicationOrchestrationService(db, tables);

  it('a delivered callback records when it was delivered and returns the communication', async () => {
    const sent = await sentCommunication('email_delivered');
    const deliveredAt = now();

    const updated = await service().handleCommunicationWebhook({
      providerMessageId: 'email_delivered',
      event: 'delivered',
      timestamp: deliveredAt,
    });

    expect(updated).toMatchObject({ id: sent.id, status: 'sent', deliveredAt });
  });

  it('a provider message id no communication has returns payments.dunning_communication_not_found', async () => {
    const answer = await service().handleCommunicationWebhook({
      providerMessageId: 'email_unknown',
      event: 'opened',
      timestamp: now(),
    });

    expect(answer).toMatchObject({
      code: 'payments.dunning_communication_not_found',
      data: { providerMessageId: 'email_unknown' },
    });
  });

  it('a payload Postgres cannot store returns schema.invalid_input and writes nothing', async () => {
    const sent = await sentCommunication('email_nul_metadata');

    const answers = [
      await service().handleCommunicationWebhook({
        providerMessageId: 'email\u0000',
        event: 'opened',
        timestamp: now(),
      }),
      await service().handleCommunicationWebhook({
        providerMessageId: 'e'.repeat(256),
        event: 'opened',
        timestamp: now(),
      }),
      await service().handleCommunicationWebhook({
        providerMessageId: 'email_nul_metadata',
        event: 'opened',
        timestamp: now(),
        metadata: { note: 'x\u0000' },
      }),
    ];

    for (const answer of answers) expect(answer).toMatchObject({ code: 'schema.invalid_input' });
    const [row] = await db
      .select()
      .from(tables.dunningCommunications)
      .where(eq(tables.dunningCommunications.id, sent.id));
    expect(row).toMatchObject({ openedAt: null, trackingData: null });
  });
});

describe('getDeliveryStatus of a slow provider', () => {
  it('EmailProvider and SMSProvider return payments.notification_provider_timeout', async () => {
    answerWith({ status: 200, body: '{}', delayMs: 500 });

    const fromEmail = await email(50).getDeliveryStatus('email_123');
    const fromSms = await sms(50).getDeliveryStatus('SM123');

    expect(fromEmail).toMatchObject({
      code: 'payments.notification_provider_timeout',
      data: { provider: 'resend', timeoutMs: 50 },
    });
    expect(fromSms).toMatchObject({
      code: 'payments.notification_provider_timeout',
      data: { provider: 'twilio', timeoutMs: 50 },
    });
  });
});

describe('the communication doors answer an id, time or JSON Postgres would refuse', () => {
  const NUL = '\u0000';
  const far = fromDate(new Date('+020000-01-01T00:00:00Z'));

  async function storedCommunication(providerMessageId: string) {
    const [execution] = await db.select().from(tables.dunningExecutions).limit(1);
    if (!execution?.templateId) throw new Error('no execution with a step to attach the communication to');
    const communications = createDunningCommunicationRepository(db, tables);
    const row = orThrow(
      await communications.create({
        executionId: execution.id,
        customerId,
        templateId: execution.templateId,
        channel: 'email',
        recipient: 'buyer@example.com',
        content: 'Please update your card',
        status: 'sent',
        providerMessageId,
      }),
    );

    return { row, execution };
  }

  it('an id holding U+0000 is answered as unknown (null, [] or zero counts), never a raw SQLSTATE 22021', async () => {
    const communications = createDunningCommunicationRepository(db, tables);
    const service = new CommunicationOrchestrationService(db, tables);
    const page = { limit: 10, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' } as const;
    const none = { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, failed: 0 };

    expect(await communications.findById(`dcm${NUL}`)).toBeNull();
    expect(await communications.findMany({ ...page, executionId: `de${NUL}` })).toEqual([]);
    expect(await communications.findMany({ ...page, customerId: `cust${NUL}` })).toEqual([]);
    expect(await communications.updateStatus(`dcm${NUL}`, 'opened')).toBeNull();
    expect(await communications.getMetricsForExecution(`de${NUL}`)).toEqual(none);
    expect(await service.getCommunication(`dcm${NUL}`)).toBeNull();
    expect(await service.getDeliveryStatus(`dcm${NUL}`)).toBeNull();
    expect(await service.getCommunicationMetrics(`de${NUL}`)).toEqual(none);
    expect(await service.updateCommunicationStatus({ communicationId: `dcm${NUL}`, status: 'opened' })).toBeNull();
  });

  it('a communication naming an execution, step or customer by an id holding U+0000 returns its not-found code', async () => {
    const { row, execution } = await storedCommunication('email_nul_references');
    const communications = createDunningCommunicationRepository(db, tables);
    const valid = {
      executionId: execution.id,
      customerId,
      templateId: row.templateId,
      channel: 'email' as const,
      recipient: 'buyer@example.com',
      content: 'Please update your card',
      status: 'pending' as const,
    };
    const before = await db.select().from(tables.dunningCommunications);

    expect(await communications.create({ ...valid, executionId: `de${NUL}` })).toMatchObject({
      code: 'payments.dunning_execution_not_found',
    });
    expect(await communications.create({ ...valid, templateId: `dt${NUL}` })).toMatchObject({
      code: 'payments.dunning_template_not_found',
    });
    expect(await communications.create({ ...valid, customerId: `cust${NUL}` })).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'customer' },
    });
    expect(await db.select().from(tables.dunningCommunications)).toHaveLength(before.length);
  });

  it('a time outside the years 1 to 9999, or JSON with a lone surrogate, is schema.invalid_input and writes nothing', async () => {
    const { row } = await storedCommunication('email_far_times');
    const communications = createDunningCommunicationRepository(db, tables);
    const service = new CommunicationOrchestrationService(db, tables);

    // Each was a raw SQLSTATE: 22009 from an instant column, 22P02 from a jsonb one
    const answers = [
      await communications.updateStatus(row.id, 'sent', { sentAt: far }),
      await communications.updateStatus(row.id, 'sent', { providerResponse: { note: 'x\uD800' } }),
      await service.updateCommunicationStatus({ communicationId: row.id, status: 'delivered', deliveredAt: far }),
      await service.handleCommunicationWebhook({
        providerMessageId: 'email_far_times',
        event: 'opened',
        timestamp: far,
      }),
      await service.handleCommunicationWebhook({
        providerMessageId: 'email_far_times',
        event: 'opened',
        timestamp: now(),
        metadata: { note: 'x\uD800' },
      }),
    ];

    for (const answer of answers) expect(answer).toMatchObject({ code: 'schema.invalid_input' });
    expect(await communications.findById(row.id)).toMatchObject({
      sentAt: null,
      deliveredAt: null,
      openedAt: null,
      providerResponse: null,
      trackingData: null,
    });
  });

  it('updateStatus with JSON nested 100,000 levels deep is schema.invalid_input and writes nothing', async () => {
    const { row } = await storedCommunication('email_deep_json');
    const communications = createDunningCommunicationRepository(db, tables);
    let deep: Record<string, unknown> = {};
    for (let level = 0; level < 100_000; level++) deep = { next: deep };

    const refused = await communications.updateStatus(row.id, 'sent', { providerResponse: deep });

    expect(refused).toMatchObject({ code: 'schema.invalid_input' });
    expect(await communications.findById(row.id)).toMatchObject({ providerResponse: null });
  });

  it('JSON nested 100 levels deep is stored; 101 levels is schema.invalid_input', async () => {
    const { row } = await storedCommunication('email_limit_json');
    const communications = createDunningCommunicationRepository(db, tables);
    // The record itself is level 1, so 99 more wrappers make 100 levels
    let atLimit: Record<string, unknown> = {};
    for (let level = 1; level < 100; level++) atLimit = { next: atLimit };

    expect(
      await communications.updateStatus(row.id, 'sent', { providerResponse: { next: { ...atLimit } } }),
    ).toMatchObject({
      code: 'schema.invalid_input',
    });
    expect(await communications.updateStatus(row.id, 'sent', { providerResponse: atLimit })).toMatchObject({
      providerResponse: atLimit,
    });
  });
});

describe('the communication doors refuse a choice no row has (hostile-input gate)', () => {
  it('listCommunications and updateCommunicationStatus return schema.invalid_input for a sortBy or status outside their lists', async () => {
    const service = orThrow(createCommunicationOrchestrationService(db, tables));

    expect(
      // @ts-expect-error a value outside the declared type, as a hostile caller sends it
      await service.listCommunications({ limit: 20, offset: 0, sortBy: 'bad column', sortOrder: 'desc' }),
    ).toMatchObject({
      code: 'schema.invalid_input',
    });
    expect(
      await service.updateCommunicationStatus({
        communicationId: orThrow(createDunningCommunicationId()),
        // @ts-expect-error a value outside the declared type, as a hostile caller sends it
        status: '\u0000',
      }),
    ).toMatchObject({ code: 'schema.invalid_input' });
  });
});
