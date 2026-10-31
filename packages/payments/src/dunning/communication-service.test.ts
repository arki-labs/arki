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
import { defineRelations, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { add, now } from '@arki/date';
import { InvalidInput, orThrow, UnexpectedFailure } from '@arki/failure';

import type { DunningExecutionId } from './primitives.js';
import type {
  CommunicationRequest,
  InAppNotification,
  InAppNotificationStore,
  StoredInAppNotification,
} from './services/communication-service.js';
import { core, customerId, schema, userId, users } from '../test-support.js';
import {
  NotificationChannelUnavailable,
  NotificationProviderRejected,
  NotificationProviderResponseInvalid,
  NotificationProviderTimeout,
  NotificationWebhookHostNotAllowed,
} from './failures.js';
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

function email(timeoutMs = 2000) {
  return new EmailProvider({
    apiKey: 're_test',
    fromEmail: 'billing@example.com',
    fromName: 'Billing',
    timeoutMs,
    apiBaseUrl: origin,
  });
}

function sms(timeoutMs = 2000) {
  return new SMSProvider({
    accountSid: 'AC123',
    authToken: 'secret',
    fromNumber: '+15550000000',
    timeoutMs,
    apiBaseUrl: origin,
  });
}

/** The local test server is the only host the webhook may reach. */
function webhook(timeoutMs = 2000) {
  return new WebhookProvider({ allowedHosts: ['127.0.0.1'], defaultHeaders: {}, timeoutMs });
}

/** The code of the failure a boot-time setup throws. */
function bootFailureCode(build: () => unknown): string | undefined {
  try {
    build();
  } catch (error) {
    return error instanceof UnexpectedFailure ? error.code : undefined;
  }
  return undefined;
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
    const empty = () => new WebhookProvider({ allowedHosts: [], defaultHeaders: {}, timeoutMs: 1000 });
    const withScheme = () =>
      new WebhookProvider({ allowedHosts: ['https://hooks.example.com'], defaultHeaders: {}, timeoutMs: 1000 });
    const factory = () => createCommunicationOrchestrationService(db, tables, { webhook: { allowedHosts: [] } });

    expect(bootFailureCode(empty)).toBe('payments.configuration_invalid');
    expect(bootFailureCode(withScheme)).toBe('payments.configuration_invalid');
    expect(bootFailureCode(factory)).toBe('payments.configuration_invalid');
  });

  it('the webhook channel is off unless it is configured', async () => {
    const service = createCommunicationOrchestrationService(db, tables);

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
    const campaign = await campaigns.createCampaign(
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
