import { createServer } from 'node:http';
import type { PGlite } from '@electric-sql/pglite';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';

import { now } from '@arki/date';
import { orThrow } from '@arki/failure';
import { money } from '@arki/money';

import type { CreateDunningCampaignInput } from '../dunning/contracts.js';
import type {
  CommunicationRequest,
  InAppNotification,
  InAppNotificationStore,
  StoredInAppNotification,
} from '../dunning/services/communication-service.js';
import type { AppDb } from '../test-support.js';
import {
  createDunningCampaignRepository,
  createDunningCommunicationRepository,
  createDunningExecutionRepository,
  createDunningTemplateRepository,
} from '../dunning/repository.js';
import { createDunningCampaignService, DunningCampaignService } from '../dunning/services/campaign-service.js';
import {
  CommunicationOrchestrationService,
  createCommunicationOrchestrationService,
  EmailProvider,
  InAppProvider,
  SMSProvider,
  WebhookProvider,
} from '../dunning/services/communication-service.js';
import { createDunningIntegrationService, DunningIntegrationService } from '../dunning/services/integration-service.js';
import {
  createCustomerSegmentationService,
  CustomerSegmentationService,
} from '../dunning/services/segmentation-service.js';
import { createDunningTables } from '../dunning/tables.js';
import { runnerOn, seedPayment, seedSubscription } from '../service-test-support.js';
import { adminId, core, customerId, openDb, schema, typed } from '../test-support.js';
import { area, args, op } from './engine.js';

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});

/** Every dunning table and enum, pushed with the payments tables. */
const dunningExtra = {
  ...dunning.enums,
  dunningCampaigns: dunning.dunningCampaigns,
  dunningCampaignAnalytics: dunning.dunningCampaignAnalytics,
  dunningTemplates: dunning.dunningTemplates,
  dunningExecutions: dunning.dunningExecutions,
  dunningCommunications: dunning.dunningCommunications,
  customerSegments: dunning.customerSegments,
  customerRiskProfiles: dunning.customerRiskProfiles,
};

const coreTables = {
  customers: core.customers,
  payments: core.payments,
  subscriptions: core.subscriptions,
  plans: core.plans,
};
const campaignTables = {
  dunningCampaigns: dunning.dunningCampaigns,
  dunningCampaignAnalytics: dunning.dunningCampaignAnalytics,
  dunningTemplates: dunning.dunningTemplates,
  dunningExecutions: dunning.dunningExecutions,
  dunningCommunications: dunning.dunningCommunications,
  customerRiskProfiles: dunning.customerRiskProfiles,
  customers: core.customers,
  payments: core.payments,
  subscriptions: core.subscriptions,
};
const communicationTables = {
  dunningCommunications: dunning.dunningCommunications,
  dunningExecutions: dunning.dunningExecutions,
};
const segmentTables = {
  customerSegments: dunning.customerSegments,
  customerRiskProfiles: dunning.customerRiskProfiles,
};

/** The app's in-app notification table, here in memory: the package has none of its own. */
function memoryNotificationStore(): InAppNotificationStore {
  const rows = new Map<string, StoredInAppNotification>();
  let next = 0;

  return {
    save(_notification: InAppNotification) {
      next += 1;
      const row = { id: `notif_${next}`, createdAt: now(), readAt: null };
      rows.set(row.id, row);

      return Promise.resolve(row);
    },
    find(id: string) {
      return Promise.resolve(rows.get(id) ?? null);
    },
  };
}

type Ctx = {
  db: AppDb;
  client: PGlite;
  server: Server;
  origin: string;
  store: InAppNotificationStore;
  email: EmailProvider;
  sms: SMSProvider;
  inApp: InAppProvider;
  webhook: WebhookProvider;
  communications: CommunicationOrchestrationService;
  campaigns: DunningCampaignService;
  segments: CustomerSegmentationService;
  integration: DunningIntegrationService;
  executions: ReturnType<typeof createDunningExecutionRepository>;
  communicationRows: ReturnType<typeof createDunningCommunicationRepository>;
  templates: ReturnType<typeof createDunningTemplateRepository>;
  campaignRows: ReturnType<typeof createDunningCampaignRepository>;
};

let counter = 0;
/** A number no earlier call used. */
function unique(): number {
  counter += 1;

  return counter;
}

/** A local server that answers the way Resend, Twilio and a customer's webhook document. */
function answerProviders(request: IncomingMessage, response: ServerResponse) {
  request.resume();
  request.on('end', () => {
    const url = request.url ?? '';
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'POST' && url === '/emails') return json(200, { id: `email_${unique()}` });
    if (request.method === 'GET' && url.startsWith('/emails/')) {
      return json(200, { last_event: 'delivered', created_at: '2026-01-01T00:00:00.000Z' });
    }
    if (request.method === 'GET' && url === '/domains') return json(200, { data: [] });
    if (request.method === 'POST' && url.endsWith('/Messages.json')) {
      return json(201, { sid: `SM${unique()}`, status: 'queued' });
    }
    if (request.method === 'GET' && url.includes('/Messages/')) return json(200, { sid: 'SM1', status: 'delivered' });
    if (request.method === 'GET' && url.endsWith('.json')) return json(200, { sid: 'AC123' });
    response.writeHead(204);
    response.end();
  });
}

const customer = { id: customerId, name: 'Buyer', email: 'buyer@example.com' };

function campaignInput(): CreateDunningCampaignInput {
  return {
    name: `Recover failed payments ${unique()}`,
    type: 'payment_failed',
    trigger: { type: 'payment_failure', conditions: { paymentFailureCount: 1 } },
    settings: {
      enabled: true,
      priority: 1,
      cooldownPeriod: 24,
      maxExecutionsPerCustomer: 3,
      stopOnPaymentSuccess: true,
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
  };
}

/** A campaign with one email step, written through the service. */
async function newCampaign(ctx: Ctx, status: 'active' | 'draft' = 'active') {
  const created = orThrow(await ctx.campaigns.createCampaign(campaignInput(), adminId));
  orThrow(await ctx.campaigns.updateCampaign(created.id, { status }, adminId));

  return created;
}

async function newCampaignId(ctx: Ctx) {
  const campaign = await newCampaign(ctx);

  return campaign.id;
}

async function newSegmentId(ctx: Ctx) {
  const segment = await newSegment(ctx);

  return segment.id;
}

async function newCommunicationId(ctx: Ctx) {
  const { communication } = await newCommunication(ctx);

  return communication.id;
}

async function newExecutionId(ctx: Ctx) {
  const { execution } = await newCommunication(ctx);

  return execution.id;
}

async function newStoredNotificationId(ctx: Ctx) {
  const stored = await ctx.store.save({ recipient: customerId, title: 't', content: 'c', trackingData: {} });

  return stored.id;
}

/** A scheduled execution of a new campaign, written through the execution repository. */
async function newExecution(ctx: Ctx, status: 'scheduled' | 'completed' = 'scheduled') {
  const campaign = await newCampaign(ctx);
  const template = campaign.templates[0];
  if (!template) throw new Error('the campaign has no step');
  const execution = orThrow(
    await ctx.executions.create({
      campaignId: campaign.id,
      customerId,
      triggerType: 'manual',
      triggerData: {},
      status,
      scheduledAt: now(),
    }),
  );

  return { campaign, template, execution };
}

/** A communication row of a new execution, written through the communication repository. */
async function newCommunication(
  ctx: Ctx,
  options: {
    status?: 'pending' | 'sent' | 'failed';
    channel?: 'email' | 'sms';
    providerMessageId?: string | null;
  } = {},
) {
  const { execution, template, campaign } = await newExecution(ctx);
  const communication = orThrow(
    await ctx.communicationRows.create({
      executionId: execution.id,
      customerId,
      templateId: template.id,
      channel: options.channel ?? 'email',
      recipient: 'buyer@example.com',
      subject: 'Payment failed',
      content: 'Please update your card',
      status: options.status ?? 'sent',
      providerMessageId: options.providerMessageId === undefined ? `email_seed_${unique()}` : options.providerMessageId,
    }),
  );

  return { campaign, template, execution, communication };
}

const segmentInput = () => ({
  name: `Big spenders ${unique()}`,
  type: 'custom' as const,
  criteria: { totalSpent: { min: money('10', 'USD').toJSON() } },
  autoUpdate: false,
  updateFrequency: 24,
});

async function newSegment(ctx: Ctx) {
  return orThrow(await ctx.segments.createSegment(segmentInput(), adminId));
}

function request(ctx: Ctx, channel: 'email' | 'sms' | 'in_app' | 'webhook'): CommunicationRequest {
  return {
    recipient:
      channel === 'webhook' ? `${ctx.origin}/hook` : channel === 'email' ? 'buyer@example.com' : '+15551230000',
    subject: 'Payment failed for {{customer_name}}',
    content: 'Hello {{customer_name}}, please update your card',
    template: { channel, content: 'Hello', variables: [] },
    personalizations: { customer_name: 'Ada' },
  };
}

const noArgs = (): unknown[] => [];

const isReport = (result: unknown) => {
  expect(result).toMatchObject({ failed: [] });
};

export const dunningServicesArea = area<Ctx>({
  area: 'dunning-services',
  async open() {
    const { db, client } = await openDb(dunningExtra);
    const server = createServer(answerProviders);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === 'string') throw new Error('the provider stand-in has no port');
    const origin = `http://127.0.0.1:${address.port}`;
    const store = memoryNotificationStore();

    const email = orThrow(
      EmailProvider.create({
        apiKey: 're_test',
        fromEmail: 'billing@example.com',
        fromName: 'Billing',
        timeoutMs: 2000,
        apiBaseUrl: origin,
      }),
    );
    const sms = orThrow(
      SMSProvider.create({
        accountSid: 'AC123',
        authToken: 'secret',
        fromNumber: '+15550000000',
        timeoutMs: 2000,
        apiBaseUrl: origin,
      }),
    );
    const inApp = new InAppProvider({ appUrl: 'https://app.example.com', store });
    const webhook = orThrow(
      WebhookProvider.create({ allowedHosts: ['127.0.0.1'], defaultHeaders: {}, timeoutMs: 2000 }),
    );
    const communications = new CommunicationOrchestrationService(db, communicationTables);
    for (const provider of [email, sms, inApp, webhook]) communications.registerProvider(provider);

    return {
      db,
      client,
      server,
      origin,
      store,
      email,
      sms,
      inApp,
      webhook,
      communications,
      campaigns: new DunningCampaignService(db, campaignTables, () => communications),
      segments: new CustomerSegmentationService(db, coreTables, segmentTables),
      integration: orThrow(
        DunningIntegrationService.create(db, coreTables, dunning, {
          systemUserId: 'usr_system',
          communication: { inApp: { appUrl: 'https://app.example.com', store } },
        }),
      ),
      executions: createDunningExecutionRepository(db, { dunningExecutions: dunning.dunningExecutions }),
      communicationRows: createDunningCommunicationRepository(db, communicationTables),
      templates: createDunningTemplateRepository(db, campaignTables),
      campaignRows: createDunningCampaignRepository(db, campaignTables),
    };
  },
  async close(ctx) {
    ctx.server.closeAllConnections();
    await new Promise(resolve => ctx.server.close(resolve));
    await ctx.client.close();
  },
  cases: [
    // ------------------------------------------------------------ DunningCampaignService
    op('dunning/services/campaign-service.ts::DunningCampaignService', {
      arrange: ctx => args(ctx.db, campaignTables, () => ctx.communications),
      call: (_ctx, db, tables, factory) => new DunningCampaignService(db, tables, factory),
      valid: result => expect(result).toBeInstanceOf(DunningCampaignService),
      keep: {
        'args[0]': 'the database handle, a dependency',
        'args[1]': 'the table definitions, a dependency',
        'args[2]': 'a factory callback, a dependency',
      },
    }),
    op('dunning/services/campaign-service.ts::createDunningCampaignService', {
      arrange: ctx => args(ctx.db, campaignTables, () => ctx.communications),
      call: (_ctx, db, tables, factory) => createDunningCampaignService(db, tables, factory),
      valid: result => expect(result).toBeInstanceOf(DunningCampaignService),
      keep: {
        'args[0]': 'the database handle, a dependency',
        'args[1]': 'the table definitions, a dependency',
        'args[2]': 'a factory callback, a dependency',
      },
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.createCampaign', {
      arrange: () => args(campaignInput(), adminId),
      call: (ctx, input, createdBy) => ctx.campaigns.createCampaign(input, createdBy),
      valid: result => expect(result).toMatchObject({ type: 'payment_failed', templates: [{ stepNumber: 1 }] }),
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.updateCampaign', {
      arrange: async ctx => args(await newCampaignId(ctx), { name: 'Renamed' }, adminId),
      call: (ctx, id, input, updatedBy) => ctx.campaigns.updateCampaign(id, input, updatedBy),
      valid: result => expect(result).toMatchObject({ name: 'Renamed' }),
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.getCampaign', {
      arrange: async ctx => args(await newCampaignId(ctx)),
      call: (ctx, id) => ctx.campaigns.getCampaign(id),
      valid: result => expect(result).toMatchObject({ templates: [{ stepNumber: 1 }] }),
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.listCampaigns', {
      arrange: async ctx => {
        await newCampaign(ctx);
        return args({
          limit: 20,
          offset: 0,
          status: 'active' as const,
          sortBy: 'createdAt' as const,
          sortOrder: 'desc' as const,
        });
      },
      call: (ctx, query) => ctx.campaigns.listCampaigns(query),
      valid: result => {
        expect(Array.isArray(result) && result.length > 0 && result.every(row => row.status === 'active')).toBe(true);
      },
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.deleteCampaign', {
      arrange: async ctx => args(await newCampaignId(ctx)),
      call: (ctx, id) => ctx.campaigns.deleteCampaign(id),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.updateCampaignStatus', {
      arrange: async ctx => args(await newCampaignId(ctx), 'paused' as const, adminId),
      call: (ctx, id, status, updatedBy) => ctx.campaigns.updateCampaignStatus(id, status, updatedBy),
      valid: result => expect(result).toMatchObject({ status: 'paused' }),
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.executeCampaign', {
      arrange: async ctx => {
        const campaign = await newCampaign(ctx);
        return args(
          { campaignId: campaign.id, dryRun: true, customFilters: { customerIds: [customerId], testMode: false } },
          adminId,
        );
      },
      call: (ctx, input, executedBy) => ctx.campaigns.executeCampaign(input, executedBy),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.processScheduledExecutions', {
      arrange: async ctx => {
        await newExecution(ctx);
        return args(100);
      },
      call: (ctx, limit) => ctx.campaigns.processScheduledExecutions(limit),
      valid: result => expect(result).toMatchObject({ failed: [] }),
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.retryFailedExecutions', {
      arrange: () => args(50),
      call: (ctx, limit) => ctx.campaigns.retryFailedExecutions(limit),
      valid: isReport,
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.getCampaignAnalytics', {
      arrange: async ctx => args(await newCampaignId(ctx), 30),
      call: (ctx, id, days) => ctx.campaigns.getCampaignAnalytics(id, days),
      valid: result => expect(result).toBeDefined(),
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.listExecutions', {
      arrange: async ctx => {
        const { campaign } = await newExecution(ctx);
        return args({
          limit: 20,
          offset: 0,
          campaignId: campaign.id,
          sortBy: 'scheduledAt' as const,
          sortOrder: 'desc' as const,
        });
      },
      call: (ctx, query) => ctx.campaigns.listExecutions(query),
      valid: result => expect(Array.isArray(result) ? result.length : -1).toBe(1),
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.getDashboardStats', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.campaigns.getDashboardStats(),
      valid: result => expect(result).toBeTypeOf('object'),
    }),
    op('dunning/services/campaign-service.ts::DunningCampaignService.findActiveCampaignsForTrigger', {
      arrange: async ctx => {
        await newCampaign(ctx);
        return args('payment_failure' as const, []);
      },
      call: (ctx, trigger, segmentIds) => ctx.campaigns.findActiveCampaignsForTrigger(trigger, segmentIds),
      valid: result => {
        expect(
          Array.isArray(result) && result.length > 0 && result.every(row => row.trigger.type === 'payment_failure'),
        ).toBe(true);
      },
    }),

    // ------------------------------------------------------------ providers
    op('dunning/services/communication-service.ts::EmailProvider.create', {
      arrange: ctx =>
        args({
          apiKey: 're_test',
          fromEmail: 'billing@example.com',
          fromName: 'Billing',
          timeoutMs: 2000,
          apiBaseUrl: ctx.origin,
        }),
      call: (_ctx, config) => EmailProvider.create(config),
      valid: result => expect(result).toBeInstanceOf(EmailProvider),
    }),
    op('dunning/services/communication-service.ts::EmailProvider.send', {
      arrange: ctx => args(request(ctx, 'email')),
      call: (ctx, req) => ctx.email.send(req),
      valid: result => expect(result).toMatchObject({ messageId: expect.stringMatching(/^email_/) }),
    }),
    op('dunning/services/communication-service.ts::EmailProvider.validateConfiguration', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.email.validateConfiguration(),
      valid: result => expect(result).toBe(true),
    }),
    op('dunning/services/communication-service.ts::EmailProvider.getDeliveryStatus', {
      arrange: () => args('email_1'),
      call: (ctx, messageId) => ctx.email.getDeliveryStatus(messageId),
      valid: result => expect(result).toMatchObject({ status: 'delivered' }),
    }),
    op('dunning/services/communication-service.ts::SMSProvider.create', {
      arrange: ctx =>
        args({
          accountSid: 'AC123',
          authToken: 'secret',
          fromNumber: '+15550000000',
          timeoutMs: 2000,
          apiBaseUrl: ctx.origin,
        }),
      call: (_ctx, config) => SMSProvider.create(config),
      valid: result => expect(result).toBeInstanceOf(SMSProvider),
    }),
    op('dunning/services/communication-service.ts::SMSProvider.send', {
      arrange: ctx => args(request(ctx, 'sms')),
      call: (ctx, req) => ctx.sms.send(req),
      valid: result => expect(result).toMatchObject({ messageId: expect.stringMatching(/^SM/) }),
    }),
    op('dunning/services/communication-service.ts::SMSProvider.validateConfiguration', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.sms.validateConfiguration(),
      valid: result => expect(result).toBe(true),
    }),
    op('dunning/services/communication-service.ts::SMSProvider.getDeliveryStatus', {
      arrange: () => args('SM1'),
      call: (ctx, messageId) => ctx.sms.getDeliveryStatus(messageId),
      valid: result => expect(result).toMatchObject({ status: 'delivered' }),
    }),
    op('dunning/services/communication-service.ts::InAppProvider', {
      arrange: ctx => args({ appUrl: 'https://app.example.com', store: ctx.store }),
      call: (_ctx, config) => new InAppProvider(config),
      valid: result => expect(result).toBeInstanceOf(InAppProvider),
    }),
    op('dunning/services/communication-service.ts::InAppProvider.send', {
      arrange: ctx => args(request(ctx, 'in_app')),
      call: (ctx, req) => ctx.inApp.send(req),
      valid: result => expect(result).toMatchObject({ messageId: expect.stringMatching(/^notif_/) }),
    }),
    op('dunning/services/communication-service.ts::InAppProvider.validateConfiguration', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.inApp.validateConfiguration(),
      valid: result => expect(result).toBe(true),
    }),
    op('dunning/services/communication-service.ts::InAppProvider.getDeliveryStatus', {
      arrange: async ctx => args(await newStoredNotificationId(ctx)),
      call: (ctx, messageId) => ctx.inApp.getDeliveryStatus(messageId),
      valid: result => expect(result).toMatchObject({ status: 'delivered' }),
    }),
    op('dunning/services/communication-service.ts::WebhookProvider.create', {
      arrange: () =>
        args({ allowedHosts: ['127.0.0.1'], defaultHeaders: { 'X-Source': 'dunning-system' }, timeoutMs: 2000 }),
      call: (_ctx, config) => WebhookProvider.create(config),
      valid: result => expect(result).toBeInstanceOf(WebhookProvider),
    }),
    op('dunning/services/communication-service.ts::WebhookProvider.send', {
      arrange: ctx => args(request(ctx, 'webhook')),
      call: (ctx, req) => ctx.webhook.send(req),
      valid: result => expect(result).toMatchObject({ messageId: expect.any(String) }),
    }),
    op('dunning/services/communication-service.ts::WebhookProvider.validateConfiguration', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.webhook.validateConfiguration(),
      valid: result => expect(result).toBe(true),
    }),

    // ------------------------------------------------------------ CommunicationOrchestrationService
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService', {
      arrange: ctx => args(ctx.db, communicationTables),
      call: (_ctx, db, tables) => new CommunicationOrchestrationService(db, tables),
      valid: result => expect(result).toBeInstanceOf(CommunicationOrchestrationService),
      keep: { 'args[0]': 'the database handle, a dependency', 'args[1]': 'the table definitions, a dependency' },
    }),
    op('dunning/services/communication-service.ts::createCommunicationOrchestrationService', {
      arrange: ctx =>
        args(ctx.db, communicationTables, {
          email: { apiKey: 're_test', fromEmail: 'billing@example.com', fromName: 'Billing', timeoutMs: 2000 },
          sms: { accountSid: 'AC123', authToken: 'secret', fromNumber: '+15550000000', timeoutMs: 2000 },
          inApp: { appUrl: 'https://app.example.com', store: ctx.store },
          webhook: { allowedHosts: ['127.0.0.1'], defaultHeaders: { 'X-Source': 'dunning-system' }, timeoutMs: 2000 },
        }),
      call: (_ctx, db, tables, config) => createCommunicationOrchestrationService(db, tables, config),
      valid: result => expect(result).toBeInstanceOf(CommunicationOrchestrationService),
      keep: { 'args[0]': 'the database handle, a dependency', 'args[1]': 'the table definitions, a dependency' },
    }),
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService.registerProvider', {
      arrange: ctx => args(ctx.email),
      call: (ctx, provider) => ctx.communications.registerProvider(provider),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService.sendCommunication', {
      arrange: async ctx => {
        const { execution, template } = await newExecution(ctx);
        return args(execution, template, customer, { plan_name: 'Pro' });
      },
      call: (ctx, execution, template, who, personalizations) =>
        ctx.communications.sendCommunication(execution, template, who, personalizations),
      valid: result => expect(result).toMatchObject({ status: 'sent', channel: 'email' }),
    }),
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService.processPendingCommunications', {
      arrange: async ctx => {
        await newCommunication(ctx, { status: 'pending' });
        return args(100);
      },
      call: (ctx, limit) => ctx.communications.processPendingCommunications(limit),
      valid: result => expect(result).toMatchObject({ failed: [] }),
    }),
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService.handleCommunicationWebhook', {
      arrange: async ctx => {
        const { communication } = await newCommunication(ctx);
        return args({
          providerMessageId: communication.providerMessageId ?? '',
          event: 'delivered' as const,
          timestamp: now(),
        });
      },
      call: (ctx, payload) => ctx.communications.handleCommunicationWebhook(payload),
      valid: result => expect(result).toMatchObject({ deliveredAt: expect.anything() }),
    }),
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService.getCommunication', {
      arrange: async ctx => args(await newCommunicationId(ctx)),
      call: (ctx, id) => ctx.communications.getCommunication(id),
      valid: result => expect(result).toMatchObject({ channel: 'email', status: 'sent' }),
    }),
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService.listCommunications', {
      arrange: async ctx => {
        const { execution } = await newCommunication(ctx);
        return args({
          limit: 20,
          offset: 0,
          executionId: execution.id,
          sortBy: 'createdAt' as const,
          sortOrder: 'desc' as const,
        });
      },
      call: (ctx, query) => ctx.communications.listCommunications(query),
      valid: result => expect(Array.isArray(result) ? result.length : -1).toBe(1),
    }),
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService.updateCommunicationStatus', {
      arrange: async ctx => {
        const { communication } = await newCommunication(ctx);
        return args({ communicationId: communication.id, status: 'delivered' as const, deliveredAt: now() });
      },
      call: (ctx, input) => ctx.communications.updateCommunicationStatus(input),
      valid: result => expect(result).toMatchObject({ status: 'delivered' }),
    }),
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService.getCommunicationMetrics', {
      arrange: async ctx => args(await newExecutionId(ctx)),
      call: (ctx, executionId) => ctx.communications.getCommunicationMetrics(executionId),
      valid: result => expect(result).toMatchObject({ total: 1 }),
    }),
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService.validateProviders', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.communications.validateProviders(),
      valid: result => expect(result).toEqual({ email: true, sms: true, in_app: true, webhook: true }),
    }),
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService.getDeliveryStatus', {
      arrange: async ctx => args(await newCommunicationId(ctx)),
      call: (ctx, id) => ctx.communications.getDeliveryStatus(id),
      valid: result => expect(result).toMatchObject({ status: 'delivered' }),
    }),
    op('dunning/services/communication-service.ts::CommunicationOrchestrationService.retryFailedCommunications', {
      arrange: async ctx => {
        await newCommunication(ctx, { status: 'failed' });
        return args(50);
      },
      call: (ctx, limit) => ctx.communications.retryFailedCommunications(limit),
      valid: isReport,
    }),

    // ------------------------------------------------------------ CustomerSegmentationService
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService', {
      arrange: ctx => args(ctx.db, coreTables, segmentTables),
      call: (_ctx, db, core, tables) => new CustomerSegmentationService(db, core, tables),
      valid: result => expect(result).toBeInstanceOf(CustomerSegmentationService),
      keep: {
        'args[0]': 'the database handle, a dependency',
        'args[1]': 'the table definitions, a dependency',
        'args[2]': 'the table definitions, a dependency',
      },
    }),
    op('dunning/services/segmentation-service.ts::createCustomerSegmentationService', {
      arrange: ctx => args(ctx.db, coreTables, segmentTables),
      call: (_ctx, db, core, tables) => createCustomerSegmentationService(db, core, tables),
      valid: result => expect(result).toBeInstanceOf(CustomerSegmentationService),
      keep: {
        'args[0]': 'the database handle, a dependency',
        'args[1]': 'the table definitions, a dependency',
        'args[2]': 'the table definitions, a dependency',
      },
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.createSegment', {
      arrange: () => args(segmentInput(), adminId),
      call: (ctx, input, createdBy) => ctx.segments.createSegment(input, createdBy),
      valid: result => expect(result).toMatchObject({ type: 'custom', isActive: true }),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.updateSegment', {
      arrange: async ctx => args(await newSegmentId(ctx), { description: 'Updated' }),
      call: (ctx, id, input) => ctx.segments.updateSegment(id, input),
      valid: result => expect(result).toMatchObject({ description: 'Updated' }),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.getSegment', {
      arrange: async ctx => args(await newSegmentId(ctx)),
      call: (ctx, id) => ctx.segments.getSegment(id),
      valid: result => expect(result).toMatchObject({ type: 'custom' }),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.listSegments', {
      arrange: async ctx => {
        await newSegment(ctx);
        return args({
          limit: 20,
          offset: 0,
          type: 'custom' as const,
          sortBy: 'createdAt' as const,
          sortOrder: 'desc' as const,
        });
      },
      call: (ctx, query) => ctx.segments.listSegments(query),
      valid: result => expect(Array.isArray(result) && result.length > 0).toBe(true),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.deleteSegment', {
      arrange: async ctx => args(await newSegmentId(ctx)),
      call: (ctx, id) => ctx.segments.deleteSegment(id),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.updateSegmentCustomerCount', {
      arrange: async ctx => args(await newSegmentId(ctx)),
      call: (ctx, id) => ctx.segments.updateSegmentCustomerCount(id),
      valid: result => expect(result).toBeDefined(),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.getCustomersInSegment', {
      arrange: async ctx => args(await newSegmentId(ctx), 100),
      call: (ctx, id, limit) => ctx.segments.getCustomersInSegment(id, limit),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.getCustomersMatchingCriteria', {
      arrange: () => args({ totalSpent: { min: money('10', 'USD').toJSON() } }, 100),
      call: (ctx, criteria, limit) => ctx.segments.getCustomersMatchingCriteria(criteria, limit),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.calculateCustomerRiskScore', {
      arrange: () => args(customerId),
      call: (ctx, id) => ctx.segments.calculateCustomerRiskScore(id),
      valid: result => expect(result).toMatchObject({ overall: expect.any(Number) }),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.updateCustomerRiskProfile', {
      arrange: () => args(customerId),
      call: (ctx, id) => ctx.segments.updateCustomerRiskProfile(id),
      valid: result => expect(result).toMatchObject({ customerId }),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.getCustomerSegments', {
      arrange: async ctx => {
        await newSegment(ctx);
        return args(customerId);
      },
      call: (ctx, id) => ctx.segments.getCustomerSegments(id),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.bulkUpdateRiskProfiles', {
      arrange: () => args(100),
      call: (ctx, limit) => ctx.segments.bulkUpdateRiskProfiles(limit),
      valid: isReport,
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.processAutoUpdateSegments', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.segments.processAutoUpdateSegments(),
      valid: isReport,
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.getCustomerRiskProfile', {
      arrange: async ctx => {
        orThrow(await ctx.segments.updateCustomerRiskProfile(customerId));
        return args(customerId);
      },
      call: (ctx, id) => ctx.segments.getCustomerRiskProfile(id),
      valid: result => expect(result).toMatchObject({ customerId }),
    }),
    op('dunning/services/segmentation-service.ts::CustomerSegmentationService.getCustomersByRiskCategory', {
      arrange: async ctx => {
        const profile = orThrow(await ctx.segments.updateCustomerRiskProfile(customerId));
        return args(profile.riskScore.category, 100);
      },
      call: (ctx, category, limit) => ctx.segments.getCustomersByRiskCategory(category, limit),
      valid: result => expect(Array.isArray(result) && result.length > 0).toBe(true),
    }),

    // ------------------------------------------------------------ DunningIntegrationService
    op('dunning/services/integration-service.ts::DunningIntegrationService.create', {
      arrange: ctx => args(ctx.db, coreTables, dunning, { systemUserId: 'usr_system' }),
      call: (_ctx, db, core, tables, config) => DunningIntegrationService.create(db, core, tables, config),
      valid: result => expect(result).toBeInstanceOf(DunningIntegrationService),
      keep: {
        'args[0]': 'the database handle, a dependency',
        'args[1]': 'the table definitions, a dependency',
        'args[2]': 'the table definitions, a dependency',
      },
    }),
    op('dunning/services/integration-service.ts::createDunningIntegrationService', {
      arrange: ctx => args(ctx.db, coreTables, dunning, { systemUserId: 'usr_system' }),
      call: (_ctx, db, core, tables, config) => createDunningIntegrationService(db, core, tables, config),
      valid: result => expect(result).toBeInstanceOf(DunningIntegrationService),
      keep: {
        'args[0]': 'the database handle, a dependency',
        'args[1]': 'the table definitions, a dependency',
        'args[2]': 'the table definitions, a dependency',
      },
    }),
    op('dunning/services/integration-service.ts::DunningIntegrationService.handlePaymentFailure', {
      arrange: async ctx => {
        const payment = await seedPayment(typed.core.writes(runnerOn(ctx.db)), null);
        return args({
          paymentId: payment.id,
          customerId,
          failureReason: 'card_declined',
          amount: money('25', 'USD'),
          failureCount: 1,
          metadata: { source: 'hostile-input' },
        });
      },
      call: (ctx, event) => ctx.integration.handlePaymentFailure(event),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('dunning/services/integration-service.ts::DunningIntegrationService.handleSubscriptionStatusChange', {
      arrange: async ctx => {
        const subscription = await seedSubscription(typed.core.writes(runnerOn(ctx.db)), 'past_due');
        return args({
          subscriptionId: subscription.id,
          customerId,
          oldStatus: 'active',
          newStatus: 'past_due',
          metadata: { source: 'hostile-input' },
        });
      },
      call: (ctx, event) => ctx.integration.handleSubscriptionStatusChange(event),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('dunning/services/integration-service.ts::DunningIntegrationService.handleTrialEnding', {
      arrange: async ctx => {
        const subscription = await seedSubscription(typed.core.writes(runnerOn(ctx.db)), 'trialing');
        return args({
          subscriptionId: subscription.id,
          customerId,
          trialEndDate: now(),
          daysUntilEnd: 3,
          metadata: { source: 'hostile-input' },
        });
      },
      call: (ctx, event) => ctx.integration.handleTrialEnding(event),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('dunning/services/integration-service.ts::DunningIntegrationService.handlePaymentSuccess', {
      arrange: async ctx => {
        const payment = await seedPayment(typed.core.writes(runnerOn(ctx.db)), null);
        return args({
          paymentId: payment.id,
          customerId,
          amount: money('25', 'USD'),
          metadata: { source: 'hostile-input' },
        });
      },
      call: (ctx, event) => ctx.integration.handlePaymentSuccess(event),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('dunning/services/integration-service.ts::DunningIntegrationService.processScheduledExecutions', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.integration.processScheduledExecutions(),
      valid: isReport,
    }),
    op('dunning/services/integration-service.ts::DunningIntegrationService.processPendingCommunications', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.integration.processPendingCommunications(),
      valid: isReport,
    }),
    op('dunning/services/integration-service.ts::DunningIntegrationService.retryFailedExecutions', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.integration.retryFailedExecutions(),
      valid: isReport,
    }),
    op('dunning/services/integration-service.ts::DunningIntegrationService.updateRiskProfiles', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.integration.updateRiskProfiles(),
      valid: isReport,
    }),
    op('dunning/services/integration-service.ts::DunningIntegrationService.processAutoUpdateSegments', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.integration.processAutoUpdateSegments(),
      valid: isReport,
    }),
    op('dunning/services/integration-service.ts::DunningIntegrationService.healthCheck', {
      arrange: noArgs,
      call: (ctx: Ctx, ..._rest: unknown[]) => ctx.integration.healthCheck(),
      valid: result => expect(result).toMatchObject({ status: 'healthy', providers: { in_app: true } }),
    }),
    op('dunning/services/integration-service.ts::DunningIntegrationService.getIntegrationMetrics', {
      arrange: () => args(30),
      call: (ctx, days) => ctx.integration.getIntegrationMetrics(days),
      valid: result => expect(result).toMatchObject({ successRate: expect.any(Number) }),
    }),
  ],
});
