import type { PGlite } from '@electric-sql/pglite';
import { expect } from 'vitest';

import { add, instant, now, sub } from '@arki/date';
import { isFailure, orThrow } from '@arki/failure';
import { KV } from '@arki/kv';
import { money } from '@arki/money';

import type { CoreWrites } from '../core/journal.js';
import type { DunningRule, DunningSenders } from '../core/services/dunning-service.js';
import type { RetryStrategy } from '../core/services/payment-retry-service.js';
import type { PlanId, Subscription, SubscriptionId } from '../core/types.js';
import type { UserId } from '../core/user-id.js';
import type { AppDb } from '../test-support.js';
import { createPaymentMonitoringService, PaymentMonitoringService } from '../core/monitoring/payment-monitor.js';
import { createCustomerId, createPlanId } from '../core/primitives.js';
import { createFakeStripeHttp, stripeProviderOf } from '../core/providers/stripe-test-support.js';
import { PaymentRepository } from '../core/repository.js';
import { createDunningService, DunningService } from '../core/services/dunning-service.js';
import { createPaymentRetryService, PaymentRetryService } from '../core/services/payment-retry-service.js';
import { createProrationService, ProrationService } from '../core/services/proration-service.js';
import { createSubscriptionManager, SubscriptionManager } from '../core/services/subscription-manager.js';
import { coreReads, runnerOn, seedPayment } from '../service-test-support.js';
import { core, openDb, planId, typed, users } from '../test-support.js';
import { area, args, op } from './engine.js';

type Ctx = {
  db: AppDb;
  client: PGlite;
  reads: ReturnType<typeof coreReads>;
  writes: CoreWrites;
  repository: PaymentRepository;
  kv: KV;
};

const KEEP_DEPENDENCY = 'a dependency, not input';

// ---------------------------------------------------------------- shared stand-ins

/** A real Stripe provider on the fake HTTP layer, for the factories that type their provider as `BasePaymentProvider`. */
function stripeProvider() {
  const http = createFakeStripeHttp(() => ({ body: {} }));

  return stripeProviderOf(
    { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
    {
      references: {
        findCustomerById: () => Promise.resolve(null),
        findPlanById: () => Promise.resolve(null),
        findSubscriptionById: () => Promise.resolve(null),
        findPaymentById: () => Promise.resolve(null),
      },
      httpClient: http.client,
      maxNetworkRetries: 0,
    },
  );
}

/** A second plan, 20.00 USD, so a plan change has somewhere to go. */
async function newPlan(ctx: Ctx, price = 2000): Promise<PlanId> {
  const id = orThrow(createPlanId());
  await ctx.db.insert(core.plans).values({ id, name: `Plan ${id}`, priceMinor: price });

  return id;
}

let nextOwner = 0;

/** A user with a customer and no subscription, so nothing else in the area touches their subscriptions. */
async function freshOwner(ctx: Ctx) {
  nextOwner += 1;
  const owner: UserId = `usr_fuzz_${nextOwner}`;
  const customerId = orThrow(createCustomerId());
  await ctx.db.insert(users).values({ id: owner });
  await ctx.db.insert(core.customers).values({
    id: customerId,
    userId: owner,
    providerCustomerId: `cus_fuzz_${nextOwner}`,
    email: `fuzz${nextOwner}@example.com`,
  });

  return { userId: owner, customerId };
}

const januaryPeriod = { start: instant('2026-01-01T00:00:00.000Z'), end: instant('2026-02-01T00:00:00.000Z') };

/** A subscription of a fresh owner. */
async function freshSubscription(
  ctx: Ctx,
  status: 'active' | 'paused' | 'canceled' | 'past_due' = 'active',
  period = januaryPeriod,
) {
  const owner = await freshOwner(ctx);
  nextOwner += 1;

  return orThrow(
    ctx.writes.createSubscription({
      userId: owner.userId,
      planId,
      customerId: owner.customerId,
      providerSubscriptionId: `psub_fuzz_${nextOwner}`,
      status,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      canceledAt: status === 'canceled' ? instant('2026-01-15T00:00:00.000Z') : null,
    }),
  );
}

// ---------------------------------------------------------------- dunning

function emailRule(delayDays = 0): DunningRule {
  return {
    id: 'fuzz_email',
    name: 'Fuzz email',
    enabled: true,
    trigger: { event: 'payment_failed', delayDays },
    action: { type: 'email', config: { template: 'payment_failed_template' } },
  };
}

/** What a sender returns when it delivered: no failure. */
const delivered: undefined = Reflect.get({}, 'failure');

const senders: DunningSenders = {
  sendEmail: () => Promise.resolve(delivered),
  sendWebhook: () => Promise.resolve(delivered),
};

function dunningProvider(ctx: Ctx): Parameters<typeof DunningService.create>[0] {
  const subscriptionAnswer = async (subscriptionId: SubscriptionId) => {
    const current = await ctx.reads.findSubscriptionById(subscriptionId);

    if (!current) {
      throw new Error(`the provider does not know ${subscriptionId}`);
    }

    return current;
  };

  return {
    async confirmPayment(paymentId) {
      const payment = await ctx.reads.findPaymentById(paymentId);

      if (!payment) {
        throw new Error(`the provider does not know ${paymentId}`);
      }

      return { ...payment, status: 'succeeded' };
    },
    pauseSubscription: subscriptionAnswer,
    cancelSubscription: subscriptionAnswer,
  };
}

function dunningService(ctx: Ctx) {
  return orThrow(
    DunningService.create(dunningProvider(ctx), ctx.repository, ctx.writes, { rules: [emailRule()] }, senders),
  );
}

/** A subscription and a payment of a fresh owner, and a service that has not seen the failure yet. */
async function dunningScene(ctx: Ctx) {
  const subscription = await freshSubscription(ctx);
  const payment = await seedPayment(ctx.writes, subscription.id);

  return { service: dunningService(ctx), subscription, payment };
}

/** The same scene after the failure was handled: the subscription is past due and one step is scheduled. */
async function dunningAfterFailure(ctx: Ctx) {
  const scene = await dunningScene(ctx);
  await orThrow(scene.service.handlePaymentFailure(scene.payment.id, scene.subscription.id, 'card_declined'));

  return scene;
}

// ---------------------------------------------------------------- payment retry

function oneRetryNow(): RetryStrategy {
  return {
    name: 'one_retry_now',
    maxAttempts: 1,
    backoffStrategy: 'custom',
    delayMinutes: [0],
    conditions: {
      paymentMethods: ['card'],
      failureReasons: ['card_declined'],
      subscriptionStatuses: ['active', 'past_due'],
    },
  };
}

function retryService(ctx: Ctx) {
  return orThrow(
    PaymentRetryService.create(
      {
        async confirmPayment(paymentId) {
          const payment = await ctx.reads.findPaymentById(paymentId);

          if (!payment) {
            throw new Error(`the provider does not know ${paymentId}`);
          }

          return { ...payment, status: 'succeeded' };
        },
      },
      ctx.repository,
      ctx.writes,
      [oneRetryNow()],
    ),
  );
}

async function retryScene(ctx: Ctx) {
  const subscription = await freshSubscription(ctx);
  const payment = await seedPayment(ctx.writes, subscription.id);

  return { service: retryService(ctx), subscription, payment };
}

async function retryScheduled(ctx: Ctx) {
  const scene = await retryScene(ctx);
  await orThrow(scene.service.scheduleRetries(scene.payment.id, 'card_declined'));

  return scene;
}

// ---------------------------------------------------------------- proration

const effectiveDate = instant('2026-01-11T00:00:00.000Z');

async function prorationScene(ctx: Ctx, period?: Parameters<typeof freshSubscription>[2]) {
  const subscription = await freshSubscription(ctx, 'active', period);

  return { service: new ProrationService(ctx.repository), subscription, newPlanId: await newPlan(ctx) };
}

// ---------------------------------------------------------------- subscription manager

type Provider = ConstructorParameters<typeof SubscriptionManager>[0];

/** A provider that answers every subscription call with `report(what we hold)`. */
function providerReporting(ctx: Ctx, report: (current: Subscription) => Subscription): Provider {
  const answer = async (subscriptionId: SubscriptionId) => {
    const current = await ctx.reads.findSubscriptionById(subscriptionId);

    if (!current) {
      throw new Error(`the provider does not know ${subscriptionId}`);
    }

    return report(current);
  };

  return {
    // Stores the subscription through the journal, as the provider's webhook would, for the customer asked.
    async createSubscription(input) {
      const customer = await ctx.reads.findCustomerById(input.customerId);

      if (!customer) {
        throw new Error(`the provider does not know ${input.customerId}`);
      }

      nextOwner += 1;

      return orThrow(
        ctx.writes.createSubscription({
          userId: customer.userId,
          planId: input.planId,
          customerId: input.customerId,
          providerSubscriptionId: `psub_fuzz_created_${nextOwner}`,
          status: 'active',
          currentPeriodStart: instant('2026-01-01T00:00:00.000Z'),
          currentPeriodEnd: instant('2026-02-01T00:00:00.000Z'),
        }),
      );
    },
    updateSubscription: answer,
    previewSubscriptionChange: () =>
      Promise.resolve({
        planId,
        proration: {
          immediateTotal: money('0', 'USD').toJSON(),
          nextInvoiceTotal: money('0', 'USD').toJSON(),
          creditApplied: money('0', 'USD').toJSON(),
        },
        nextBillingDate: instant('2026-02-01T00:00:00.000Z'),
      }),
    cancelSubscription: answer,
    reactivateSubscription: answer,
    pauseSubscription: answer,
    resumeSubscription: answer,
    getSubscription: answer,
  };
}

function manager(ctx: Ctx, report: (current: Subscription) => Subscription = current => current) {
  return new SubscriptionManager(providerReporting(ctx, report), ctx.repository, ctx.writes);
}

// ---------------------------------------------------------------- monitor

function monitor(ctx: Ctx) {
  return new PaymentMonitoringService(ctx.kv, ctx.repository);
}

/** The KV points at a port nothing listens on, so a write fails the way a Redis outage does: the record methods return that failure. */
function expectKvOutage(result: unknown) {
  expect(isFailure(result)).toBe(true);
  expect(result).toMatchObject({ code: 'kv.unavailable' });
}

const periodStart = instant('2026-01-01T00:00:00.000Z');
const periodEnd = instant('2026-12-31T00:00:00.000Z');

export const coreServicesArea = area<Ctx>({
  area: 'core-services',
  async open() {
    const { db, client } = await openDb();

    return {
      db,
      client,
      reads: coreReads(db),
      writes: typed.core.writes(runnerOn(db)),
      repository: new PaymentRepository(db, core),
      kv: new KV('redis://127.0.0.1:1', undefined, 'rl', { commandTimeoutMs: 20 }),
    };
  },
  async close(ctx) {
    // The KV points at a port nothing listens on, so its close may time out: that is its only allowed failure
    const closed = await ctx.kv.close();
    if (isFailure(closed)) expect(closed).toMatchObject({ code: 'kv.close_failed' });
    await ctx.client.close();
  },
  cases: [
    // ------------------------------------------------------------ dunning
    op('core/services/dunning-service.ts::DunningService.create', {
      arrange: ctx => args(dunningProvider(ctx), ctx.reads, ctx.writes, { rules: [emailRule()] }, senders),
      call: (_ctx, provider, reads, writes, config, sendersArg) =>
        DunningService.create(provider, reads, writes, config, sendersArg),
      valid: result => {
        expect(result).toBeInstanceOf(DunningService);
        expect(result).toMatchObject({ config: { rules: [{ id: 'fuzz_email' }] } });
      },
      keep: {
        'args[0]': KEEP_DEPENDENCY,
        'args[1]': KEEP_DEPENDENCY,
        'args[2]': KEEP_DEPENDENCY,
        'args[4]': KEEP_DEPENDENCY,
      },
    }),
    op('core/services/dunning-service.ts::createDunningService', {
      arrange: ctx => args(stripeProvider(), ctx.repository, ctx.writes, { rules: [emailRule()] }, senders),
      call: (_ctx, provider, repository, writes, config, sendersArg) =>
        createDunningService(provider, repository, writes, config, sendersArg),
      valid: result => {
        expect(result).toBeInstanceOf(DunningService);
        expect(result).toMatchObject({ config: { rules: [{ id: 'fuzz_email' }] } });
      },
      keep: {
        'args[0]': KEEP_DEPENDENCY,
        'args[1]': KEEP_DEPENDENCY,
        'args[2]': KEEP_DEPENDENCY,
        'args[4]': KEEP_DEPENDENCY,
      },
    }),
    op('core/services/dunning-service.ts::DunningService.handlePaymentFailure', {
      arrange: async ctx => {
        const { service, subscription, payment } = await dunningScene(ctx);

        return args(service, payment.id, subscription.id, 'card_declined');
      },
      call: async (_ctx, service, paymentId, subscriptionId, reason) => {
        const result = await service.handlePaymentFailure(paymentId, subscriptionId, reason);

        return result ?? { scheduled: service.getPendingEventsForSubscription(subscriptionId).length };
      },
      valid: result => expect(result).toEqual({ scheduled: 1 }),
    }),
    op('core/services/dunning-service.ts::DunningService.processDunningEvents', {
      arrange: async ctx => {
        const { service } = await dunningAfterFailure(ctx);

        return args(service);
      },
      call: (_ctx, service) => service.processDunningEvents(),
      valid: result => expect(result).toMatchObject([{ status: 'done' }]),
    }),
    op('core/services/dunning-service.ts::DunningService.handleSubscriptionRecovery', {
      arrange: async ctx => {
        const { service, subscription } = await dunningAfterFailure(ctx);

        return args(service, subscription.id);
      },
      call: async (ctx, service, subscriptionId) => {
        const result = await service.handleSubscriptionRecovery(subscriptionId);

        if (isFailure(result)) return result;
        const stored = await ctx.reads.findSubscriptionById(subscriptionId);

        return stored?.status;
      },
      valid: result => expect(result).toBe('active'),
    }),
    op('core/services/dunning-service.ts::DunningService.getDunningStats', {
      arrange: async ctx => {
        const { service } = await dunningAfterFailure(ctx);

        return args(service, periodStart, periodEnd);
      },
      call: (_ctx, service, startDate, endDate) => service.getDunningStats(startDate, endDate),
      valid: result =>
        expect(result).toMatchObject({
          totalFailedPayments: expect.any(Number),
          recoveredPayments: 0,
          subscriptionsInDunning: expect.any(Number),
        }),
    }),
    op('core/services/dunning-service.ts::DunningService.getPendingEventsForSubscription', {
      arrange: async ctx => {
        const { service, subscription } = await dunningAfterFailure(ctx);

        return args(service, subscription.id);
      },
      call: (_ctx, service, subscriptionId) => service.getPendingEventsForSubscription(subscriptionId),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('core/services/dunning-service.ts::DunningService.updateConfiguration', {
      arrange: ctx => args(dunningService(ctx), { rules: [emailRule(2)] }),
      call: (_ctx, service, config) => {
        const updated = service.updateConfiguration(config);
        if (isFailure(updated)) return updated;

        return service.getConfiguration().rules[0]?.trigger.delayDays;
      },
      valid: result => expect(result).toBe(2),
    }),
    op('core/services/dunning-service.ts::DunningService.getConfiguration', {
      arrange: ctx => args(dunningService(ctx)),
      call: (_ctx, service) => service.getConfiguration(),
      valid: result => expect(result).toMatchObject({ rules: [{ id: 'fuzz_email' }] }),
    }),

    // ------------------------------------------------------------ payment retry
    op('core/services/payment-retry-service.ts::PaymentRetryService.create', {
      arrange: ctx =>
        args({ confirmPayment: () => Promise.reject(new Error('not called')) }, ctx.reads, ctx.writes, [oneRetryNow()]),
      call: (_ctx, provider, reads, writes, strategies) =>
        PaymentRetryService.create(provider, reads, writes, strategies),
      valid: result => {
        expect(result).toBeInstanceOf(PaymentRetryService);
        expect(result).toMatchObject({ strategies: [{ name: 'one_retry_now' }] });
      },
      keep: { 'args[0]': KEEP_DEPENDENCY, 'args[1]': KEEP_DEPENDENCY, 'args[2]': KEEP_DEPENDENCY },
    }),
    op('core/services/payment-retry-service.ts::createPaymentRetryService', {
      arrange: ctx => args(stripeProvider(), ctx.repository, ctx.writes, [oneRetryNow()]),
      call: (_ctx, provider, repository, writes, strategies) =>
        createPaymentRetryService(provider, repository, writes, strategies),
      valid: result => {
        expect(result).toBeInstanceOf(PaymentRetryService);
        expect(result).toMatchObject({ strategies: [{ name: 'one_retry_now' }] });
      },
      keep: { 'args[0]': KEEP_DEPENDENCY, 'args[1]': KEEP_DEPENDENCY, 'args[2]': KEEP_DEPENDENCY },
    }),
    op('core/services/payment-retry-service.ts::PaymentRetryService.scheduleRetries', {
      arrange: async ctx => {
        const { service, payment } = await retryScene(ctx);

        return args(service, payment.id, 'card_declined');
      },
      call: (_ctx, service, paymentId, reason) => service.scheduleRetries(paymentId, reason),
      valid: result =>
        expect(result).toMatchObject([{ attemptNumber: 1, status: 'pending', strategyUsed: 'one_retry_now' }]),
    }),
    op('core/services/payment-retry-service.ts::PaymentRetryService.processRetries', {
      arrange: async ctx => {
        const { service } = await retryScheduled(ctx);

        return args(service);
      },
      call: (_ctx, service) => service.processRetries(),
      valid: result => expect(result).toMatchObject([{ status: 'succeeded' }]),
    }),
    op('core/services/payment-retry-service.ts::PaymentRetryService.cancelRetries', {
      arrange: async ctx => {
        const { service, payment } = await retryScheduled(ctx);

        return args(service, payment.id, 'no_such_attempt');
      },
      call: async (_ctx, service, paymentId, excludeId) => {
        await service.cancelRetries(paymentId, excludeId);

        return service.getRetryAttempts(paymentId);
      },
      valid: result => expect(result).toEqual([]),
    }),
    op('core/services/payment-retry-service.ts::PaymentRetryService.getRetryAnalytics', {
      arrange: async ctx => {
        const { service } = await retryScheduled(ctx);

        return args(service, periodStart, periodEnd);
      },
      call: (_ctx, service, startDate, endDate) => service.getRetryAnalytics(startDate, endDate),
      valid: result =>
        expect(result).toMatchObject({ totalRetryAttempts: expect.any(Number), revenueRecovered: expect.anything() }),
    }),
    op('core/services/payment-retry-service.ts::PaymentRetryService.getRetryAttempts', {
      arrange: async ctx => {
        const { service, payment } = await retryScheduled(ctx);

        return args(service, payment.id);
      },
      call: (_ctx, service, paymentId) => service.getRetryAttempts(paymentId),
      valid: result => expect(result).toMatchObject([{ attemptNumber: 1 }]),
    }),
    op('core/services/payment-retry-service.ts::PaymentRetryService.getRetryStrategies', {
      arrange: ctx => args(retryService(ctx)),
      call: (_ctx, service) => service.getRetryStrategies(),
      valid: result => expect(result).toMatchObject([{ name: 'one_retry_now' }]),
    }),
    op('core/services/payment-retry-service.ts::PaymentRetryService.addRetryStrategy', {
      arrange: ctx =>
        args(retryService(ctx), { ...oneRetryNow(), name: 'another_retry', maxAttempts: 2, delayMinutes: [0, 5] }),
      call: (_ctx, service, strategy) => {
        const added = service.addRetryStrategy(strategy);
        if (isFailure(added)) return added;

        return service.getRetryStrategies().map(stored => stored.name);
      },
      valid: result => expect(result).toEqual(['one_retry_now', 'another_retry']),
    }),
    op('core/services/payment-retry-service.ts::PaymentRetryService.updateRetryStrategy', {
      arrange: ctx => args(retryService(ctx), 'one_retry_now', { maxAttempts: 2, delayMinutes: [0, 5] }),
      call: (_ctx, service, name, updates) => {
        const updated = service.updateRetryStrategy(name, updates);
        if (isFailure(updated)) return updated;

        return service.getRetryStrategies()[0]?.maxAttempts;
      },
      valid: result => expect(result).toBe(2),
    }),

    // ------------------------------------------------------------ proration
    op('core/services/proration-service.ts::ProrationService', {
      arrange: ctx => args(ctx.reads),
      call: (_ctx, reads) => new ProrationService(reads),
      valid: result => expect(result).toBeInstanceOf(ProrationService),
      keep: { 'args[0]': KEEP_DEPENDENCY },
    }),
    op('core/services/proration-service.ts::createProrationService', {
      arrange: ctx => args(ctx.reads),
      call: (_ctx, reads) => createProrationService(reads),
      valid: result => expect(result).toBeInstanceOf(ProrationService),
      keep: { 'args[0]': KEEP_DEPENDENCY },
    }),
    op('core/services/proration-service.ts::ProrationService.calculateProration', {
      arrange: async ctx => {
        const { service, subscription, newPlanId } = await prorationScene(ctx);

        return args(service, subscription.id, newPlanId, {
          prorationBehavior: 'create_prorations' as const,
          effectiveDate,
        });
      },
      call: (_ctx, service, subscriptionId, newPlanId, options) =>
        service.calculateProration(subscriptionId, newPlanId, options),
      valid: result => expect(result).toMatchObject({ remainingTime: { days: 21 } }),
    }),
    op('core/services/proration-service.ts::ProrationService.previewSubscriptionChange', {
      arrange: async ctx => {
        const { service, subscription, newPlanId } = await prorationScene(ctx);

        return args(service, subscription.id, newPlanId, {
          prorationBehavior: 'create_prorations' as const,
          effectiveDate,
        });
      },
      call: (_ctx, service, subscriptionId, newPlanId, options) =>
        service.previewSubscriptionChange(subscriptionId, newPlanId, options),
      valid: result => expect(result).toHaveProperty('proration.immediateTotal'),
    }),
    op('core/services/proration-service.ts::ProrationService.previewMultiplePlanChanges', {
      arrange: async ctx => {
        const { service, subscription, newPlanId } = await prorationScene(ctx);

        return args(service, subscription.id, [newPlanId, await newPlan(ctx, 500)], {
          prorationBehavior: 'create_prorations' as const,
          effectiveDate,
        });
      },
      call: (_ctx, service, subscriptionId, planIds, options) =>
        service.previewMultiplePlanChanges(subscriptionId, planIds, options),
      valid: result => {
        expect(result).toMatchObject({ refused: [] });
        const previews: unknown = Reflect.get(new Object(result), 'previews');
        expect(Object.keys(new Object(previews))).toHaveLength(2);
      },
    }),
    op('core/services/proration-service.ts::ProrationService.getOptimalChangeTimings', {
      arrange: async ctx => {
        // The method asks for a change effective now, so the stored period must contain now.
        const current = now();
        const { service, subscription, newPlanId } = await prorationScene(ctx, {
          start: sub(current, { hours: 240 }),
          end: add(current, { hours: 480 }),
        });

        return args(service, subscription.id, newPlanId);
      },
      call: (_ctx, service, subscriptionId, newPlanId) => service.getOptimalChangeTimings(subscriptionId, newPlanId),
      valid: result =>
        expect(result).toMatchObject({
          recommendations: { bestOption: expect.stringMatching(/immediate|next_cycle/) },
        }),
    }),
    op('core/services/proration-service.ts::ProrationService.generateProrationSummary', {
      arrange: async ctx => {
        const { service, subscription, newPlanId } = await prorationScene(ctx);

        return args(service, subscription.id, newPlanId, {
          prorationBehavior: 'create_prorations' as const,
          effectiveDate,
        });
      },
      call: (_ctx, service, subscriptionId, newPlanId, options) =>
        service.generateProrationSummary(subscriptionId, newPlanId, options),
      valid: result => expect(result).toMatchObject({ title: 'Plan Upgrade', effectiveDate: '2026-01-11' }),
    }),

    // ------------------------------------------------------------ subscription manager
    op('core/services/subscription-manager.ts::SubscriptionManager', {
      arrange: ctx =>
        args(
          providerReporting(ctx, current => current),
          ctx.reads,
          ctx.writes,
        ),
      call: (_ctx, provider, reads, writes) => new SubscriptionManager(provider, reads, writes),
      valid: result => expect(result).toBeInstanceOf(SubscriptionManager),
      keep: { 'args[0]': KEEP_DEPENDENCY, 'args[1]': KEEP_DEPENDENCY, 'args[2]': KEEP_DEPENDENCY },
    }),
    op('core/services/subscription-manager.ts::createSubscriptionManager', {
      arrange: ctx => args(stripeProvider(), ctx.repository, ctx.writes),
      call: (_ctx, provider, repository, writes) => createSubscriptionManager(provider, repository, writes),
      valid: result => expect(result).toBeInstanceOf(SubscriptionManager),
      keep: { 'args[0]': KEEP_DEPENDENCY, 'args[1]': KEEP_DEPENDENCY, 'args[2]': KEEP_DEPENDENCY },
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.createSubscription', {
      arrange: async ctx => {
        const owner = await freshOwner(ctx);

        return args(manager(ctx), owner.userId, planId, { trialPeriodDays: 7, metadata: { source: 'fuzz' } });
      },
      call: (_ctx, subscriptions, owner, plan, options) => subscriptions.createSubscription(owner, plan, options),
      valid: result => expect(result).toMatchObject({ status: 'active', planId }),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.updateSubscription', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx);
        const target = await newPlan(ctx);

        return args(
          manager(ctx, current => ({ ...current, planId: target })),
          subscription.id,
          target,
          {
            prorationBehavior: 'none' as const,
          },
        );
      },
      call: (_ctx, subscriptions, subscriptionId, target, options) =>
        subscriptions.updateSubscription(subscriptionId, target, options),
      valid: result => expect(result).toHaveProperty('subscription.planId'),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.setCancelAtPeriodEnd', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx);

        return args(
          manager(ctx, current => ({ ...current, cancelAtPeriodEnd: true })),
          subscription.id,
          true,
        );
      },
      call: (_ctx, subscriptions, subscriptionId, flag) => subscriptions.setCancelAtPeriodEnd(subscriptionId, flag),
      valid: result => expect(result).toMatchObject({ cancelAtPeriodEnd: true }),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.cancelSubscription', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx);

        return args(
          manager(ctx, current => ({
            ...current,
            status: 'canceled',
            canceledAt: instant('2026-01-21T10:00:00.000Z'),
          })),
          subscription.id,
          { immediately: true, reason: 'too_expensive' },
        );
      },
      call: (_ctx, subscriptions, subscriptionId, options) => subscriptions.cancelSubscription(subscriptionId, options),
      valid: result => expect(result).toMatchObject({ status: 'canceled' }),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.reactivateSubscription', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx, 'canceled');

        return args(
          manager(ctx, current => ({ ...current, status: 'active', canceledAt: null })),
          subscription.id,
        );
      },
      call: (_ctx, subscriptions, subscriptionId) => subscriptions.reactivateSubscription(subscriptionId),
      valid: result => expect(result).toMatchObject({ status: 'active' }),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.pauseSubscription', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx);

        return args(
          manager(ctx, current => ({ ...current, status: 'paused' })),
          subscription.id,
        );
      },
      call: (_ctx, subscriptions, subscriptionId) => subscriptions.pauseSubscription(subscriptionId),
      valid: result => expect(result).toMatchObject({ status: 'paused' }),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.resumeSubscription', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx, 'paused');

        return args(
          manager(ctx, current => ({ ...current, status: 'active' })),
          subscription.id,
        );
      },
      call: (_ctx, subscriptions, subscriptionId) => subscriptions.resumeSubscription(subscriptionId),
      valid: result => expect(result).toMatchObject({ status: 'active' }),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.getSubscription', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx);

        return args(manager(ctx), subscription.id);
      },
      call: (_ctx, subscriptions, subscriptionId) => subscriptions.getSubscription(subscriptionId),
      valid: result => expect(result).toMatchObject({ status: 'active', planId }),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.getUserSubscriptions', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx);

        return args(manager(ctx), subscription.userId);
      },
      call: (_ctx, subscriptions, owner) => subscriptions.getUserSubscriptions(owner),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.getActiveSubscription', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx);

        return args(manager(ctx), subscription.userId);
      },
      call: (_ctx, subscriptions, owner) => subscriptions.getActiveSubscription(owner),
      valid: result => expect(result).toMatchObject({ status: 'active' }),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.previewSubscriptionChange', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx);

        return args(manager(ctx), subscription.id, await newPlan(ctx), { prorationBehavior: 'none' as const });
      },
      call: (_ctx, subscriptions, subscriptionId, target, options) =>
        subscriptions.previewSubscriptionChange(subscriptionId, target, options),
      valid: result => expect(result).toHaveProperty('proration.immediateTotal'),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.handleTrialEndingSoon', {
      arrange: ctx => args(manager(ctx), 3),
      call: (_ctx, subscriptions, days) => subscriptions.handleTrialEndingSoon(days),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.handlePastDueSubscriptions', {
      arrange: async ctx => {
        const past = await freshSubscription(ctx, 'past_due');

        return args(manager(ctx), past.id);
      },
      call: async (_ctx, subscriptions, pastDueId) => {
        const pastDue = await subscriptions.handlePastDueSubscriptions();

        return pastDue.some(found => found.id === pastDueId);
      },
      valid: result => expect(result).toBe(true),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.getSubscriptionAnalytics', {
      arrange: ctx => args(manager(ctx), periodStart, periodEnd),
      call: (_ctx, subscriptions, startDate, endDate) => subscriptions.getSubscriptionAnalytics(startDate, endDate),
      valid: result =>
        expect(result).toMatchObject({
          totalSubscriptions: expect.any(Number),
          subscriptionsByStatus: expect.anything(),
        }),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.syncSubscriptionWithProvider', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx);

        return args(
          manager(ctx, current => ({ ...current, status: 'past_due' })),
          subscription.id,
        );
      },
      call: (_ctx, subscriptions, subscriptionId) => subscriptions.syncSubscriptionWithProvider(subscriptionId),
      valid: result => expect(result).toMatchObject({ status: 'past_due' }),
    }),
    op('core/services/subscription-manager.ts::SubscriptionManager.validateSubscriptionAccess', {
      arrange: async ctx => {
        const subscription = await freshSubscription(ctx);

        return args(manager(ctx), subscription.userId, ['basic']);
      },
      call: (_ctx, subscriptions, owner, tiers) => subscriptions.validateSubscriptionAccess(owner, tiers),
      valid: result => expect(result).toMatchObject({ hasAccess: true }),
    }),

    // ------------------------------------------------------------ monitor
    op('core/monitoring/payment-monitor.ts::PaymentMonitoringService', {
      arrange: ctx => args(ctx.kv, ctx.repository),
      call: (_ctx, kv, reads) => new PaymentMonitoringService(kv, reads),
      valid: result => expect(result).toBeInstanceOf(PaymentMonitoringService),
    }),
    op('core/monitoring/payment-monitor.ts::createPaymentMonitoringService', {
      arrange: ctx => args(ctx.kv, ctx.repository),
      call: (_ctx, kv, reads) => createPaymentMonitoringService(kv, reads),
      valid: result => expect(result).toBeInstanceOf(PaymentMonitoringService),
    }),
    op('core/monitoring/payment-monitor.ts::PaymentMonitoringService.recordPaymentAttempt', {
      arrange: ctx =>
        args(monitor(ctx), {
          success: true,
          status: 'succeeded',
          processingTime: 120,
          amount: money('25', 'USD'),
          provider: 'stripe',
          errorCode: 'none',
        }),
      call: (_ctx, service, result) => service.recordPaymentAttempt(result),
      valid: expectKvOutage,
    }),
    op('core/monitoring/payment-monitor.ts::PaymentMonitoringService.recordWebhookProcessing', {
      arrange: ctx => args(monitor(ctx), 150, true),
      call: (_ctx, service, duration, success) => service.recordWebhookProcessing(duration, success),
      valid: expectKvOutage,
    }),
    op('core/monitoring/payment-monitor.ts::PaymentMonitoringService.recordSubscriptionEvent', {
      arrange: ctx => args(monitor(ctx), 'created' as const),
      call: (_ctx, service, event) => service.recordSubscriptionEvent(event),
      valid: expectKvOutage,
    }),
    op('core/monitoring/payment-monitor.ts::PaymentMonitoringService.recordRefund', {
      arrange: ctx => args(monitor(ctx), money('10', 'USD'), 'requested_by_customer'),
      call: (_ctx, service, amount, reason) => service.recordRefund(amount, reason),
      valid: expectKvOutage,
    }),
    op('core/monitoring/payment-monitor.ts::PaymentMonitoringService.detectAnomalies', {
      arrange: ctx => args(monitor(ctx)),
      call: (_ctx, service) => service.detectAnomalies(),
      valid: result => expect(Array.isArray(result)).toBe(true),
    }),
    op('core/monitoring/payment-monitor.ts::PaymentMonitoringService.getSystemHealth', {
      arrange: ctx => args(monitor(ctx)),
      call: (_ctx, service) => service.getSystemHealth(),
      valid: result => expect(result).toMatchObject({ payments: { activeSubscriptions: expect.any(Number) } }),
    }),
  ],
});
