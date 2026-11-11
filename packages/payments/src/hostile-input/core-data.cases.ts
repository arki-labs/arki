import type { PGlite } from '@electric-sql/pglite';
import { pgSchema } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';

import { instant } from '@arki/date';
import { orThrow } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { money } from '@arki/money';

import type { CoreWrites } from '../core/journal.js';
import type { NewWebhookEvent } from '../core/types.js';
import type { UserId } from '../core/user-id.js';
import type { AppDb, AppTx } from '../test-support.js';
import { createCoreDerivedSchemas } from '../core/derived-schemas.js';
import { createCoreJournal } from '../core/journal.js';
import { createPaymentJournal } from '../core/journal/payment.js';
import { createSubscriptionJournal } from '../core/journal/subscription.js';
import {
  eventVarcharSchema,
  lockReferences,
  sameJson,
  storedReal,
  toInstant,
  toIso,
  toNullableInstant,
  writtenRow,
} from '../core/journal/support.js';
import { fromMinorColumn, fromStoredNumber, paymentAmount, planPrice, toMinorColumn } from '../core/money.js';
import {
  createCustomerId,
  createPaymentId,
  createPlanId,
  createSubscriptionId,
  createWebhookId,
} from '../core/primitives.js';
import { createPaymentRepository, PaymentRepository } from '../core/repository.js';
import { createCoreTables } from '../core/tables.js';
import { claimWebhookEvent, reclaimWebhookEvent } from '../core/webhook-claims.js';
import { createDunningTables } from '../dunning/tables.js';
import { createPaymentRepositories } from '../repositories.js';
import { runnerOn, seedPayment, seedSubscription } from '../service-test-support.js';
import { createTaxTables } from '../tax/tables.js';
import {
  core,
  customerId,
  journalTablesInSchema,
  metaSchema,
  openDb,
  planId,
  refundsTables,
  schema,
  typed,
  userId,
  users,
} from '../test-support.js';
import { area, args, op } from './engine.js';

type Ctx = { db: AppDb; client: PGlite; repo: PaymentRepository; writes: CoreWrites };

const noArgs = (): [] => [];

let sequence = 0;
function nextNumber(): number {
  sequence += 1;
  return sequence;
}

/** Journal definitions nobody registered events on yet (a second `createPaymentJournal` on one set would clash). */
function freshJournalDefinitions() {
  return initJournal.tx<AppTx>().db<AppDb>().create({ tables: journalTablesInSchema, meta: metaSchema });
}

const earlier = () => instant('2020-01-01T00:00:00.000Z');
const later = () => instant('2100-01-01T00:00:00.000Z');

async function newUser(ctx: Ctx): Promise<UserId> {
  const id: UserId = `usr_hostile${nextNumber()}`;
  await ctx.db.insert(users).values({ id });
  return id;
}

async function newPlan(ctx: Ctx) {
  return orThrow(await ctx.repo.createPlan({ name: `Plan ${nextNumber()}`, priceMinor: 1500 }));
}

async function newCustomer(ctx: Ctx) {
  const owner = await newUser(ctx);
  return orThrow(
    await ctx.repo.createCustomer({
      userId: owner,
      providerCustomerId: `cus_hostile${nextNumber()}`,
      email: `hostile${nextNumber()}@example.com`,
    }),
  );
}

function webhookInput(): NewWebhookEvent {
  return {
    provider: 'stripe',
    eventType: 'subscription.created',
    providerEventId: `evt_hostile${nextNumber()}`,
    data: { object: 'subscription' },
    sourceIp: '203.0.113.7',
  };
}

async function newPlanId(ctx: Ctx) {
  const plan = await newPlan(ctx);
  return plan.id;
}

async function newCustomerId(ctx: Ctx) {
  const customer = await newCustomer(ctx);
  return customer.id;
}

async function newWebhook(ctx: Ctx) {
  return orThrow(await ctx.repo.createWebhookEvent(webhookInput()));
}

async function newSubscription(ctx: Ctx, status: Parameters<typeof seedSubscription>[1] = 'active') {
  return seedSubscription(ctx.writes, status);
}

async function newPayment(ctx: Ctx, subscriptionId: Parameters<typeof seedPayment>[1] = null) {
  return seedPayment(ctx.writes, subscriptionId);
}

/** A payment that succeeded, so it can be refunded. */
async function newSucceededPayment(ctx: Ctx) {
  const payment = await newPayment(ctx);
  return orThrow(await ctx.writes.completePayment({ paymentId: payment.id }));
}

async function newWebhookId(ctx: Ctx) {
  const event = await newWebhook(ctx);
  return event.id;
}

async function newWebhookProviderEventId(ctx: Ctx) {
  const event = await newWebhook(ctx);
  return event.providerEventId;
}

async function newSubscriptionId(ctx: Ctx, status: Parameters<typeof seedSubscription>[1] = 'active') {
  const subscription = await seedSubscription(ctx.writes, status);
  return subscription.id;
}

async function newSubscriptionProviderId(ctx: Ctx) {
  const subscription = await seedSubscription(ctx.writes, 'active');
  return subscription.providerSubscriptionId;
}

async function newPaymentId(ctx: Ctx) {
  const payment = await seedPayment(ctx.writes, null);
  return payment.id;
}

async function newPaymentProviderId(ctx: Ctx) {
  const payment = await seedPayment(ctx.writes, null);
  return payment.providerPaymentId;
}

async function newSucceededPaymentId(ctx: Ctx) {
  const payment = await newSucceededPayment(ctx);
  return payment.id;
}

function subscriptionInput() {
  return {
    userId,
    planId,
    customerId,
    providerSubscriptionId: `psub_hostile${nextNumber()}`,
    status: 'active' as const,
    currentPeriodStart: instant('2026-01-01T00:00:00.000Z'),
    currentPeriodEnd: instant('2026-02-01T00:00:00.000Z'),
    trialStart: instant('2025-12-25T00:00:00.000Z'),
    trialEnd: instant('2026-01-01T00:00:00.000Z'),
    canceledAt: null,
    cancelAtPeriodEnd: false,
    metadata: { source: 'hostile' },
  };
}

const unusedDunningTables = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});
const unusedTaxTables = createTaxTables({ schema });

export const coreDataArea = area<Ctx>({
  area: 'core-data',
  async open() {
    const { db, client } = await openDb();
    return { db, client, repo: new PaymentRepository(db, core), writes: typed.core.writes(runnerOn(db)) };
  },
  close: ctx => ctx.client.close(),
  cases: [
    // ------------------------------------------------------------ money
    op('core/money.ts::toMinorColumn', {
      arrange: () => args(money('12.34', 'USD')),
      call: (_ctx, amount) => toMinorColumn(amount),
      valid: result => expect(result).toBe(1234),
    }),
    op('core/money.ts::fromMinorColumn', {
      arrange: () => args(1234, 'usd'),
      call: (_ctx, units, currency) => fromMinorColumn(units, currency),
      valid: result => expect(String(result)).toContain('12.34'),
    }),
    op('core/money.ts::fromStoredNumber', {
      arrange: () => args(12.34, 'USD'),
      call: (_ctx, value, currency) => fromStoredNumber(value, currency),
      valid: result => expect(String(result)).toContain('12.34'),
    }),
    op('core/money.ts::planPrice', {
      arrange: () => args({ priceMinor: 1000, currency: 'USD' }),
      call: (_ctx, plan) => planPrice(plan),
      valid: result => expect(String(result)).toContain('10'),
    }),
    op('core/money.ts::paymentAmount', {
      arrange: () => args({ amountMinor: 2500, currency: 'EUR' }),
      call: (_ctx, payment) => paymentAmount(payment),
      valid: result => expect(String(result)).toContain('25'),
    }),

    // ------------------------------------------------------------ primitives
    op('core/primitives.ts::createPlanId', { arrange: noArgs, call: () => createPlanId() }),
    op('core/primitives.ts::createSubscriptionId', { arrange: noArgs, call: () => createSubscriptionId() }),
    op('core/primitives.ts::createPaymentId', { arrange: noArgs, call: () => createPaymentId() }),
    op('core/primitives.ts::createCustomerId', { arrange: noArgs, call: () => createCustomerId() }),
    op('core/primitives.ts::createWebhookId', { arrange: noArgs, call: () => createWebhookId() }),

    // ------------------------------------------------------------ tables and derived schemas
    op('core/tables.ts::createCoreTables', {
      arrange: () => args({ schema: pgSchema(`pay_hostile${nextNumber()}`), userIdRef: () => users.id }),
      call: (_ctx, deps) => createCoreTables(deps),
      valid: result => expect(result).toHaveProperty('webhookEvents'),
    }),
    op('core/derived-schemas.ts::createCoreDerivedSchemas', {
      arrange: () =>
        args({
          plans: core.plans,
          customers: core.customers,
          subscriptions: core.subscriptions,
          payments: core.payments,
          webhookEvents: core.webhookEvents,
        }),
      call: (_ctx, tables) => createCoreDerivedSchemas(tables),
      valid: result => expect(result).toHaveProperty('planInsertSchema'),
      keep: { 'args[0]': 'the app tables the schemas are derived from, a dependency' },
    }),

    // ------------------------------------------------------------ journal support
    op('core/journal/support.ts::eventVarcharSchema', {
      arrange: () => args(255),
      call: (_ctx, max) => eventVarcharSchema(max),
      valid: result => expect(result).toHaveProperty('safeParse'),
    }),
    op('core/journal/support.ts::toIso', {
      arrange: () => args(instant('2026-01-01T00:00:00.000Z')),
      call: (_ctx, value) => toIso(value),
      valid: result => expect(result).toBe('2026-01-01T00:00:00Z'),
    }),
    op('core/journal/support.ts::toInstant', {
      arrange: () => args('2026-01-01T00:00:00.000Z'),
      call: (_ctx, iso) => toInstant(iso),
      valid: result => expect(String(result)).toContain('2026-01-01'),
    }),
    op('core/journal/support.ts::toNullableInstant', {
      arrange: () => args('2026-01-01T00:00:00.000Z'),
      call: (_ctx, iso) => toNullableInstant(iso),
      valid: result => expect(String(result)).toContain('2026-01-01'),
    }),
    op('core/journal/support.ts::storedReal', {
      arrange: () => args(19.99),
      call: (_ctx, value) => storedReal(value),
      valid: result => expect(result).toBe(19.99),
    }),
    op('core/journal/support.ts::sameJson', {
      arrange: () => args({ a: 1, b: ['x', { c: true }] }, { b: ['x', { c: true }], a: 1 }),
      call: (_ctx, left, right) => sameJson(left, right),
      valid: result => expect(result).toBe(true),
    }),
    op('core/journal/support.ts::writtenRow', {
      arrange: () => args({ version: 3, id: 'sub_x' }, 'createSubscription'),
      call: (_ctx, row, what) => writtenRow(Promise.resolve({ row }), what),
      valid: result => expect(result).toEqual({ id: 'sub_x' }),
    }),
    op('core/journal/support.ts::lockReferences', {
      arrange: ctx =>
        args(ctx.db, core.payments, [
          { column: core.payments.customerId, value: customerId, missing: () => 'missing' },
        ]),
      call: (_ctx, db, table, references) => lockReferences(db, table, references),
      valid: result => expect(result).toBeUndefined(),
      keep: { 'args[0]': 'the database, a dependency', 'args[1]': 'the table, a dependency' },
    }),

    // ------------------------------------------------------------ webhook claims (free functions)
    op('core/webhook-claims.ts::claimWebhookEvent', {
      arrange: ctx => args(ctx.db, core.webhookEvents, webhookInput()),
      call: (_ctx, db, table, data) => claimWebhookEvent(db, table, data),
      valid: result => expect(result).toMatchObject({ created: true }),
      keep: { 'args[0]': 'the database, a dependency', 'args[1]': 'the table, a dependency' },
    }),
    op('core/webhook-claims.ts::reclaimWebhookEvent', {
      arrange: async ctx => {
        const event = await newWebhook(ctx);
        orThrow(await ctx.repo.incrementWebhookEventAttempts(event.id, 'first try failed'));
        return args(ctx.db, core.webhookEvents, event.id, 1, later());
      },
      call: (_ctx, db, table, id, seenAttempts, leaseCutoff) =>
        reclaimWebhookEvent(db, table, id, seenAttempts, leaseCutoff),
      valid: result => expect(result).toBe(true),
      keep: { 'args[0]': 'the database, a dependency', 'args[1]': 'the table, a dependency' },
    }),

    // ------------------------------------------------------------ repository factories
    op('repositories.ts::createPaymentRepositories', {
      arrange: ctx =>
        args(ctx.db, {
          core: core,
          dunning: unusedDunningTables,
          refunds: { refunds: refundsTables.refunds },
          tax: unusedTaxTables,
        }),
      call: (_ctx, db, tables) => createPaymentRepositories(db, tables),
      valid: result => expect(result).toHaveProperty('core'),
      keep: { 'args[0]': 'the database, a dependency', 'args[1]': 'the tables, a dependency' },
    }),
    op('core/repository.ts::createPaymentRepository', {
      arrange: ctx => args(ctx.db, { tables: core }),
      call: (_ctx, db, deps) => createPaymentRepository(db, deps),
      valid: result => expect(result).toBeInstanceOf(PaymentRepository),
      keep: { 'args[0]': 'the database, a dependency', 'args[1]': 'the tables, a dependency' },
    }),
    op('core/repository.ts::PaymentRepository', {
      arrange: ctx => args(ctx.db, core),
      call: (_ctx, db, tables) => new PaymentRepository(db, tables),
      valid: result => expect(result).toBeInstanceOf(PaymentRepository),
      keep: { 'args[0]': 'the database, a dependency', 'args[1]': 'the tables, a dependency' },
    }),

    // ------------------------------------------------------------ repository: plans
    op('core/repository.ts::PaymentRepository.createPlan', {
      arrange: () =>
        args({
          name: `Hostile plan ${nextNumber()}`,
          description: 'A plan for the gate',
          tier: 'pro' as const,
          priceMinor: 1999,
          currency: 'USD',
          interval: 'monthly' as const,
          intervalCount: 1,
          features: ['one', 'two'],
          isActive: true,
          trialPeriodDays: 14,
          metadata: { source: 'hostile' },
        }),
      call: (ctx, data) => ctx.repo.createPlan(data),
      valid: result => expect(result).toMatchObject({ tier: 'pro', priceMinor: 1999, trialPeriodDays: 14 }),
    }),
    op('core/repository.ts::PaymentRepository.findPlanById', {
      arrange: () => args(planId),
      call: (ctx, id) => ctx.repo.findPlanById(id),
      valid: result => expect(result).toMatchObject({ id: planId, name: 'Pro' }),
    }),
    op('core/repository.ts::PaymentRepository.getPlan', {
      arrange: () => args(planId),
      call: (ctx, id) => ctx.repo.getPlan(id),
      valid: result => expect(result).toMatchObject({ id: planId, name: 'Pro' }),
    }),
    op('core/repository.ts::PaymentRepository.findPlansByTier', {
      arrange: () => args('basic' as const),
      call: (ctx, tier) => ctx.repo.findPlansByTier(tier),
      valid: result => expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ id: planId })])),
    }),
    op('core/repository.ts::PaymentRepository.findPlans', {
      arrange: () =>
        args({ tier: 'basic' as const, interval: 'monthly' as const, isActive: true, limit: 50, offset: 0 }),
      call: (ctx, query) => ctx.repo.findPlans(query),
      valid: result => expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ id: planId })])),
    }),
    op('core/repository.ts::PaymentRepository.findActivePlans', {
      arrange: noArgs,
      call: (ctx, _none?: undefined) => ctx.repo.findActivePlans(),
      valid: result => expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ id: planId })])),
    }),
    op('core/repository.ts::PaymentRepository.updatePlan', {
      arrange: async ctx => args(await newPlanId(ctx), { name: 'Renamed plan', priceMinor: 2500, trialPeriodDays: 7 }),
      call: (ctx, id, data) => ctx.repo.updatePlan(id, data),
      valid: result => expect(result).toMatchObject({ name: 'Renamed plan', priceMinor: 2500 }),
    }),
    op('core/repository.ts::PaymentRepository.deactivatePlan', {
      arrange: async ctx => args(await newPlanId(ctx)),
      call: (ctx, id) => ctx.repo.deactivatePlan(id),
      valid: result => expect(result).toMatchObject({ isActive: false }),
    }),

    // ------------------------------------------------------------ repository: customers
    op('core/repository.ts::PaymentRepository.createCustomer', {
      arrange: async ctx =>
        args({
          userId: await newUser(ctx),
          providerCustomerId: `cus_hostile${nextNumber()}`,
          provider: 'stripe' as const,
          email: `new${nextNumber()}@example.com`,
          name: 'New Buyer',
          defaultPaymentMethodId: 'pm_hostile',
          metadata: { source: 'hostile' },
        }),
      call: (ctx, data) => ctx.repo.createCustomer(data),
      valid: result => expect(result).toMatchObject({ name: 'New Buyer', provider: 'stripe' }),
    }),
    op('core/repository.ts::PaymentRepository.findCustomerById', {
      arrange: () => args(customerId),
      call: (ctx, id) => ctx.repo.findCustomerById(id),
      valid: result => expect(result).toMatchObject({ id: customerId, email: 'buyer@example.com' }),
    }),
    op('core/repository.ts::PaymentRepository.findCustomerByUserId', {
      arrange: () => args(userId),
      call: (ctx, owner) => ctx.repo.findCustomerByUserId(owner),
      valid: result => expect(result).toMatchObject({ id: customerId }),
    }),
    op('core/repository.ts::PaymentRepository.findCustomerByProviderCustomerId', {
      arrange: () => args('cus_test', 'stripe' as const),
      call: (ctx, providerCustomerId, provider) =>
        ctx.repo.findCustomerByProviderCustomerId(providerCustomerId, provider),
      valid: result => expect(result).toMatchObject({ id: customerId }),
    }),
    op('core/repository.ts::PaymentRepository.updateCustomer', {
      arrange: async ctx =>
        args(await newCustomerId(ctx), {
          email: `changed${nextNumber()}@example.com`,
          name: 'Changed Name',
          providerCustomerId: `cus_changed${nextNumber()}`,
          defaultPaymentMethodId: 'pm_changed',
          metadata: { changed: true },
        }),
      call: (ctx, id, data) => ctx.repo.updateCustomer(id, data),
      valid: result => expect(result).toMatchObject({ name: 'Changed Name', defaultPaymentMethodId: 'pm_changed' }),
    }),
    op('core/repository.ts::PaymentRepository.deleteCustomer', {
      arrange: async ctx => args(await newCustomerId(ctx)),
      call: (ctx, id) => ctx.repo.deleteCustomer(id),
      valid: result => expect(result).toBeUndefined(),
    }),

    // ------------------------------------------------------------ repository: subscriptions
    op('core/repository.ts::PaymentRepository.findSubscriptionById', {
      arrange: async ctx => args(await newSubscriptionId(ctx)),
      call: (ctx, id) => ctx.repo.findSubscriptionById(id),
      valid: result => expect(result).toMatchObject({ planId, plan: { id: planId } }),
    }),
    op('core/repository.ts::PaymentRepository.getSubscription', {
      arrange: async ctx => args(await newSubscriptionId(ctx)),
      call: (ctx, id) => ctx.repo.getSubscription(id),
      valid: result => expect(result).toMatchObject({ planId }),
    }),
    op('core/repository.ts::PaymentRepository.findSubscriptionsByUserId', {
      arrange: async ctx => {
        await newSubscription(ctx);
        return args(userId);
      },
      call: (ctx, owner) => ctx.repo.findSubscriptionsByUserId(owner),
      valid: result => expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ userId })])),
    }),
    op('core/repository.ts::PaymentRepository.findSubscriptions', {
      arrange: async ctx => {
        await newSubscription(ctx);
        return args({ status: 'active' as const, planId, userId, limit: 50, offset: 0 });
      },
      call: (ctx, query) => ctx.repo.findSubscriptions(query),
      valid: result => expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ planId })])),
    }),
    op('core/repository.ts::PaymentRepository.findActiveSubscriptionByUserId', {
      arrange: async ctx => {
        await newSubscription(ctx);
        return args(userId);
      },
      call: (ctx, owner) => ctx.repo.findActiveSubscriptionByUserId(owner),
      valid: result => expect(result).toMatchObject({ status: 'active', plan: { id: planId } }),
    }),
    op('core/repository.ts::PaymentRepository.findSubscriptionByProviderSubscriptionId', {
      arrange: async ctx => args(await newSubscriptionProviderId(ctx)),
      call: (ctx, providerSubscriptionId) => ctx.repo.findSubscriptionByProviderSubscriptionId(providerSubscriptionId),
      valid: result =>
        expect(result).toMatchObject({ providerSubscriptionId: expect.stringMatching(/^psub_service_/) }),
    }),
    op('core/repository.ts::PaymentRepository.findSubscriptionsByStatus', {
      arrange: async ctx => {
        await newSubscription(ctx);
        return args('active' as const);
      },
      call: (ctx, status) => ctx.repo.findSubscriptionsByStatus(status),
      valid: result => expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'active' })])),
    }),
    op('core/repository.ts::PaymentRepository.findSubscriptionsEndingInRange', {
      arrange: async ctx => {
        await newSubscription(ctx);
        return args(instant('2026-01-15T00:00:00.000Z'), instant('2026-03-01T00:00:00.000Z'), 'active' as const);
      },
      call: (ctx, start, end, status) => ctx.repo.findSubscriptionsEndingInRange(start, end, status),
      valid: result => expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'active' })])),
    }),

    // ------------------------------------------------------------ repository: payments
    op('core/repository.ts::PaymentRepository.findPaymentById', {
      arrange: async ctx => args(await newPaymentId(ctx)),
      call: (ctx, id) => ctx.repo.findPaymentById(id),
      valid: result => expect(result).toMatchObject({ status: 'pending', amountMinor: 2500 }),
    }),
    op('core/repository.ts::PaymentRepository.findPaymentsByUserId', {
      arrange: async ctx => {
        await newPayment(ctx);
        return args(userId, 10);
      },
      call: (ctx, owner, limit) => ctx.repo.findPaymentsByUserId(owner, limit),
      valid: result => expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ userId })])),
    }),
    op('core/repository.ts::PaymentRepository.findPayments', {
      arrange: async ctx => {
        const subscription = await newSubscription(ctx);
        await newPayment(ctx, subscription.id);
        return args({
          status: 'pending' as const,
          subscriptionId: subscription.id,
          customerId,
          userId,
          startDate: earlier(),
          endDate: later(),
          limit: 50,
          offset: 0,
        });
      },
      call: (ctx, query) => ctx.repo.findPayments(query),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('core/repository.ts::PaymentRepository.findPaymentsBySubscriptionId', {
      arrange: async ctx => {
        const subscription = await newSubscription(ctx);
        await newPayment(ctx, subscription.id);
        return args(subscription.id);
      },
      call: (ctx, subscriptionId) => ctx.repo.findPaymentsBySubscriptionId(subscriptionId),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('core/repository.ts::PaymentRepository.findPaymentByProviderPaymentId', {
      arrange: async ctx => args(await newPaymentProviderId(ctx)),
      call: (ctx, providerPaymentId) => ctx.repo.findPaymentByProviderPaymentId(providerPaymentId),
      valid: result => expect(result).toMatchObject({ providerPaymentId: expect.stringMatching(/^pi_service_/) }),
    }),
    op('core/repository.ts::PaymentRepository.findPaymentsByStatus', {
      arrange: async ctx => {
        await newPayment(ctx);
        return args('pending' as const);
      },
      call: (ctx, status) => ctx.repo.findPaymentsByStatus(status),
      valid: result => expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'pending' })])),
    }),

    // ------------------------------------------------------------ repository: webhook events
    op('core/repository.ts::PaymentRepository.createWebhookEvent', {
      arrange: () => args(webhookInput()),
      call: (ctx, data) => ctx.repo.createWebhookEvent(data),
      valid: result => expect(result).toMatchObject({ eventType: 'subscription.created', processed: false }),
    }),
    op('core/repository.ts::PaymentRepository.claimWebhookEvent', {
      arrange: () => args(webhookInput()),
      call: (ctx, data) => ctx.repo.claimWebhookEvent(data),
      valid: result => expect(result).toMatchObject({ created: true }),
    }),
    op('core/repository.ts::PaymentRepository.reclaimWebhookEvent', {
      arrange: async ctx => {
        const event = await newWebhook(ctx);
        orThrow(await ctx.repo.incrementWebhookEventAttempts(event.id, 'first try failed'));
        return args(event.id, 1, later());
      },
      call: (ctx, id, seenAttempts, leaseCutoff) => ctx.repo.reclaimWebhookEvent(id, seenAttempts, leaseCutoff),
      valid: result => expect(result).toBe(true),
    }),
    op('core/repository.ts::PaymentRepository.findWebhookEventById', {
      arrange: async ctx => args(await newWebhookId(ctx)),
      call: (ctx, id) => ctx.repo.findWebhookEventById(id),
      valid: result => expect(result).toMatchObject({ eventType: 'subscription.created' }),
    }),
    op('core/repository.ts::PaymentRepository.findWebhookEventByProviderEventId', {
      arrange: async ctx => args(await newWebhookProviderEventId(ctx), 'stripe' as const),
      call: (ctx, providerEventId, provider) => ctx.repo.findWebhookEventByProviderEventId(providerEventId, provider),
      valid: result => expect(result).toMatchObject({ providerEventId: expect.stringMatching(/^evt_hostile/) }),
    }),
    op('core/repository.ts::PaymentRepository.findUnprocessedWebhookEvents', {
      arrange: async ctx => {
        await newWebhook(ctx);
        return args(10, 5);
      },
      call: (ctx, limit, belowAttempts) => ctx.repo.findUnprocessedWebhookEvents(limit, belowAttempts),
      valid: result => expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ processed: false })])),
    }),
    op('core/repository.ts::PaymentRepository.findWebhookEventsCreatedBetween', {
      arrange: async ctx => {
        await newWebhook(ctx);
        return args(earlier(), later(), 10);
      },
      call: (ctx, start, end, limit) => ctx.repo.findWebhookEventsCreatedBetween(start, end, limit),
      valid: result => expect(Array.isArray(result) && result.length > 0).toBe(true),
    }),
    op('core/repository.ts::PaymentRepository.findWebhookEventsByType', {
      arrange: async ctx => {
        await newWebhook(ctx);
        return args('subscription.created' as const);
      },
      call: (ctx, eventType) => ctx.repo.findWebhookEventsByType(eventType),
      valid: result => expect(Array.isArray(result) && result.length > 0).toBe(true),
    }),
    op('core/repository.ts::PaymentRepository.updateWebhookEvent', {
      arrange: async ctx =>
        args(await newWebhookId(ctx), {
          providerEventId: `evt_changed${nextNumber()}`,
          data: { object: 'changed' },
          attempts: 2,
          errorMessage: 'boom',
          sourceIp: '198.51.100.9',
          processed: false,
        }),
      call: (ctx, id, data) => ctx.repo.updateWebhookEvent(id, data),
      valid: result => expect(result).toMatchObject({ attempts: 2, errorMessage: 'boom' }),
    }),
    op('core/repository.ts::PaymentRepository.markWebhookEventAsProcessed', {
      arrange: async ctx => args(await newWebhookId(ctx)),
      call: (ctx, id) => ctx.repo.markWebhookEventAsProcessed(id),
      valid: result => expect(result).toMatchObject({ processed: true }),
    }),
    op('core/repository.ts::PaymentRepository.incrementWebhookEventAttempts', {
      arrange: async ctx => args(await newWebhookId(ctx), 'handler crashed'),
      call: (ctx, id, errorMessage) => ctx.repo.incrementWebhookEventAttempts(id, errorMessage),
      valid: result => expect(result).toMatchObject({ attempts: 1, errorMessage: 'handler crashed' }),
    }),

    // ------------------------------------------------------------ repository: analytics
    op('core/repository.ts::PaymentRepository.getSubscriptionStats', {
      arrange: async ctx => {
        await newSubscription(ctx);
        return args(earlier(), later());
      },
      call: (ctx, start, end) => ctx.repo.getSubscriptionStats(start, end),
      valid: result =>
        expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ plan: expect.anything() })])),
    }),
    op('core/repository.ts::PaymentRepository.getPaymentStats', {
      arrange: async ctx => {
        await newPayment(ctx);
        return args(earlier(), later());
      },
      call: (ctx, start, end) => ctx.repo.getPaymentStats(start, end),
      valid: result => expect(Array.isArray(result) && result.length > 0).toBe(true),
    }),
    op('core/repository.ts::PaymentRepository.getCustomerCount', {
      arrange: noArgs,
      call: (ctx, _none?: undefined) => ctx.repo.getCustomerCount(),
      valid: result => expect(result).toBeGreaterThan(0),
    }),
    op('core/repository.ts::PaymentRepository.getActiveSubscriptionCount', {
      arrange: async ctx => {
        await newSubscription(ctx);
        return args();
      },
      call: (ctx, _none?: undefined) => ctx.repo.getActiveSubscriptionCount(),
      valid: result => expect(result).toBeGreaterThan(0),
    }),
    op('core/repository.ts::PaymentRepository.countPaymentsCreatedBetween', {
      arrange: async ctx => {
        await newPayment(ctx);
        return args(earlier(), later());
      },
      call: (ctx, start, end) => ctx.repo.countPaymentsCreatedBetween(start, end),
      valid: result => expect(result).toBeGreaterThan(0),
    }),

    // ------------------------------------------------------------ journal factories
    op('core/journal.ts::createCoreJournal', {
      arrange: () => args(freshJournalDefinitions(), { payments: core.payments, subscriptions: core.subscriptions }),
      call: (_ctx, definitions, tables) => createCoreJournal(definitions, tables),
      valid: result => expect(result).toHaveProperty('commands.initiatePayment'),
      surface: true,
      keep: { 'args[0]': 'the journal definitions, a dependency', 'args[1]': 'the app tables, a dependency' },
    }),
    op('core/journal/payment.ts::createPaymentJournal', {
      arrange: () => args(freshJournalDefinitions(), core.payments),
      call: (_ctx, definitions, table) => createPaymentJournal(definitions, table),
      valid: result => expect(result).toHaveProperty('commands.initiatePayment'),
      surface: true,
      keep: { 'args[0]': 'the journal definitions, a dependency' },
    }),
    op('core/journal/subscription.ts::createSubscriptionJournal', {
      arrange: () => args(freshJournalDefinitions(), core.subscriptions),
      call: (_ctx, definitions, table) => createSubscriptionJournal(definitions, table),
      valid: result => expect(result).toHaveProperty('commands.createSubscription'),
      surface: true,
      keep: { 'args[0]': 'the journal definitions, a dependency' },
    }),
    op('core/journal.ts::createCoreJournal().writes', {
      arrange: ctx => args(runnerOn(ctx.db)),
      call: (_ctx, runner) => typed.core.writes(runner),
      valid: result => expect(result).toHaveProperty('createSubscription'),
      surface: true,
    }),

    // ------------------------------------------------------------ write commands: payments
    op('core/journal.ts::createCoreJournal().writes().initiatePayment', {
      arrange: async ctx => {
        const subscription = await newSubscription(ctx);
        return args({
          paymentId: orThrow(createPaymentId()),
          subscriptionId: subscription.id,
          userId,
          customerId,
          providerPaymentId: `pi_hostile${nextNumber()}`,
          amount: { amount: '25', currency: 'USD' },
          paymentMethod: 'card' as const,
          description: 'A hostile payment',
          metadata: { source: 'hostile' },
        });
      },
      call: (ctx, input) => ctx.writes.initiatePayment(input),
      valid: result => expect(result).toMatchObject({ status: 'pending', amountMinor: 2500, currency: 'USD' }),
    }),
    op('core/journal.ts::createCoreJournal().writes().completePayment', {
      arrange: async ctx => args({ paymentId: await newPaymentId(ctx), receiptUrl: 'https://example.com/receipt' }),
      call: (ctx, input) => ctx.writes.completePayment(input),
      valid: result => expect(result).toMatchObject({ status: 'succeeded', receiptUrl: 'https://example.com/receipt' }),
    }),
    op('core/journal.ts::createCoreJournal().writes().failPayment', {
      arrange: async ctx => args({ paymentId: await newPaymentId(ctx), failureReason: 'card declined' }),
      call: (ctx, input) => ctx.writes.failPayment(input),
      valid: result => expect(result).toMatchObject({ status: 'failed', failureReason: 'card declined' }),
    }),
    op('core/journal.ts::createCoreJournal().writes().cancelPayment', {
      arrange: async ctx => args({ paymentId: await newPaymentId(ctx) }),
      call: (ctx, input) => ctx.writes.cancelPayment(input),
      valid: result => expect(result).toMatchObject({ status: 'canceled' }),
    }),
    op('core/journal.ts::createCoreJournal().writes().markPaymentRequiresAction', {
      arrange: async ctx => args({ paymentId: await newPaymentId(ctx) }),
      call: (ctx, input) => ctx.writes.markPaymentRequiresAction(input),
      valid: result => expect(result).toMatchObject({ status: 'requires_action' }),
    }),
    op('core/journal.ts::createCoreJournal().writes().recordPaymentRefund', {
      arrange: async ctx =>
        args({ paymentId: await newSucceededPaymentId(ctx), refundedAmount: { amount: '10', currency: 'USD' } }),
      call: (ctx, input) => ctx.writes.recordPaymentRefund(input),
      valid: result => expect(result).toMatchObject({ refundedAmountMinor: 1000 }),
    }),
    op('core/journal.ts::createCoreJournal().writes().recordPaymentDispute', {
      arrange: async ctx =>
        args({
          paymentId: await newSucceededPaymentId(ctx),
          disputeId: `dp_hostile${nextNumber()}`,
          status: 'needs_response',
          reason: 'fraudulent',
        }),
      call: (ctx, input) => ctx.writes.recordPaymentDispute(input),
      valid: result => expect(result).toMatchObject({ disputeStatus: 'needs_response' }),
    }),

    // ------------------------------------------------------------ write commands: subscriptions
    op('core/journal.ts::createCoreJournal().writes().createSubscription', {
      arrange: () => args({ ...subscriptionInput(), subscriptionId: orThrow(createSubscriptionId()) }),
      call: (ctx, input) => ctx.writes.createSubscription(input),
      valid: result => expect(result).toMatchObject({ status: 'active', planId, cancelAtPeriodEnd: false }),
    }),
    op('core/journal.ts::createCoreJournal().writes().syncSubscription', {
      arrange: () => args(subscriptionInput()),
      call: (ctx, input) => ctx.writes.syncSubscription(input),
      valid: result => expect(result).toMatchObject({ status: 'active', planId }),
    }),
    op('core/journal.ts::createCoreJournal().writes().cancelSubscription', {
      arrange: async ctx =>
        args({
          subscriptionId: await newSubscriptionId(ctx),
          status: 'canceled' as const,
          canceledAt: instant('2026-01-15T00:00:00.000Z'),
          cancelAtPeriodEnd: false,
        }),
      call: (ctx, input) => ctx.writes.cancelSubscription(input),
      valid: result => expect(result).toMatchObject({ status: 'canceled' }),
    }),
    op('core/journal.ts::createCoreJournal().writes().reactivateSubscription', {
      arrange: async ctx =>
        args({ subscriptionId: await newSubscriptionId(ctx, 'canceled'), status: 'active' as const }),
      call: (ctx, input) => ctx.writes.reactivateSubscription(input),
      valid: result => expect(result).toMatchObject({ status: 'active' }),
    }),
    op('core/journal.ts::createCoreJournal().writes().pauseSubscription', {
      arrange: async ctx => args({ subscriptionId: await newSubscriptionId(ctx), status: 'paused' as const }),
      call: (ctx, input) => ctx.writes.pauseSubscription(input),
      valid: result => expect(result).toMatchObject({ status: 'paused' }),
    }),
    op('core/journal.ts::createCoreJournal().writes().resumeSubscription', {
      arrange: async ctx => args({ subscriptionId: await newSubscriptionId(ctx, 'paused'), status: 'active' as const }),
      call: (ctx, input) => ctx.writes.resumeSubscription(input),
      valid: result => expect(result).toMatchObject({ status: 'active' }),
    }),
    op('core/journal.ts::createCoreJournal().writes().changeSubscriptionPlan', {
      arrange: async ctx => args({ subscriptionId: await newSubscriptionId(ctx), planId: await newPlanId(ctx) }),
      call: (ctx, input) => ctx.writes.changeSubscriptionPlan(input),
      valid: result => expect(result).not.toMatchObject({ planId }),
    }),
    op('core/journal.ts::createCoreJournal().writes().setSubscriptionCancelAtPeriodEnd', {
      arrange: async ctx => args({ subscriptionId: await newSubscriptionId(ctx), cancelAtPeriodEnd: true }),
      call: (ctx, input) => ctx.writes.setSubscriptionCancelAtPeriodEnd(input),
      valid: result => expect(result).toMatchObject({ cancelAtPeriodEnd: true, status: 'active' }),
    }),
    op('core/journal.ts::createCoreJournal().writes().markSubscriptionPastDue', {
      arrange: async ctx => args({ subscriptionId: await newSubscriptionId(ctx) }),
      call: (ctx, input) => ctx.writes.markSubscriptionPastDue(input),
      valid: result => expect(result).toMatchObject({ status: 'past_due' }),
    }),
    op('core/journal.ts::createCoreJournal().writes().activateSubscription', {
      arrange: async ctx => args({ subscriptionId: await newSubscriptionId(ctx, 'incomplete') }),
      call: (ctx, input) => ctx.writes.activateSubscription(input),
      valid: result => expect(result).toMatchObject({ status: 'active' }),
    }),
  ],
});
