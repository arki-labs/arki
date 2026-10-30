// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * WebhookHandler: every event runs, and runs once at a time
 *
 * Payment providers resend a webhook until it is answered with success, and
 * two copies can arrive at the same time. Each run of an event changes what a
 * customer is charged or can use, so:
 * - a copy must never run an event that is running or done;
 * - a failed or crashed event must run again on the next resend, or it is lost;
 * - an event that keeps failing must stop the resends after `maxRetries`.
 *
 * The claim and the takeover run the shipped SQL from `webhook-claims.ts` on
 * PGlite, against the real `webhook_events` table and its unique index. The
 * other store methods are plain updates mirrored here, as
 * `service-test-support.ts` does for the repository reads. The validator is a
 * stub: signature checks are covered in `webhook-security.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { add, fromUnix, now, sub } from '@arki/date';
import { InvalidInput, isFailure, orThrow } from '@arki/failure';
import { UnknownCurrency } from '@arki/money';
import { CommandConflict, initJournal } from '@arki/journal';

import type { AppDb, AppTx } from '../../test-support.js';
import type { WebhookEvent, WebhookEventType, WebhookValidationResult } from '../types.js';
import type { WebhookEventStore, WebhookRefunds, WebhookValidator, WebhookWrites } from './webhook-handler.js';
import type { WebhookValidationOptions } from './webhook-security.js';
import { createRefundsJournal } from '../../refunds/journal.js';
import { createRefundWorkflow } from '../../refunds/workflow.js';
import { refundRow, runnerOn, seedPayment, seedSubscription } from '../../service-test-support.js';
import {
  adminId,
  core,
  countEvents,
  eventTypesOf,
  journalTablesInSchema,
  meta,
  metaSchema,
  openDb,
  refundsTables,
  typed,
  userId,
} from '../../test-support.js';
import { createWebhookId } from '../primitives.js';
import { claimWebhookEvent, reclaimWebhookEvent } from '../webhook-claims.js';
import {
  isWebhookFailure,
  WebhookClaimConflict,
  WebhookHandler,
  WebhookInProgress,
  WebhookPayloadInvalid,
  WebhookRejected,
  WebhookRetriesExhausted,
  WebhookTargetNotFound,
} from './webhook-handler.js';

const { payments, subscriptions, webhookEvents } = core;

let db: AppDb;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

// `retryFailedWebhooks` reads every unprocessed row, so each test starts empty.
beforeEach(async () => {
  await db.delete(webhookEvents).where(isNotNull(webhookEvents.id));
});

/** The one row a query returned. */
function only(rows: WebhookEvent[], what: string): WebhookEvent {
  const [row] = rows;
  if (!row) {
    throw new Error(`webhook event not found (${what})`);
  }
  return row;
}

/** The event store on the test database. */
function storeOn(database: AppDb): WebhookEventStore {
  return {
    claimWebhookEvent: (data) => claimWebhookEvent(database, webhookEvents, data),
    reclaimWebhookEvent: (id, seen, cutoff) => reclaimWebhookEvent(database, webhookEvents, id, seen, cutoff),
    async markWebhookEventAsProcessed(id) {
      const rows = await database
        .update(webhookEvents)
        .set({ processed: true, processedAt: now(), updatedAt: now() })
        .where(eq(webhookEvents.id, id))
        .returning();
      return only(rows, 'mark processed');
    },
    async findUnprocessedWebhookEvents(limit = 100) {
      return database
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.processed, false))
        .orderBy(asc(webhookEvents.createdAt))
        .limit(limit);
    },
    async updateWebhookEvent(id, data) {
      const rows = await database
        .update(webhookEvents)
        .set({ ...data, updatedAt: now() })
        .where(eq(webhookEvents.id, id))
        .returning();
      return only(rows, 'update');
    },
    async findSubscriptionByProviderSubscriptionId(id) {
      const [row] = await database.select().from(subscriptions).where(eq(subscriptions.providerSubscriptionId, id));
      return row ?? null;
    },
    async findPaymentByProviderPaymentId(id) {
      const [row] = await database.select().from(payments).where(eq(payments.providerPaymentId, id));
      return row ?? null;
    },
  };
}

/** The journal writes on the test database: the real commands, as the app's `paymentsJournal.writes(run)`. */
function writesOn(database: AppDb) {
  return typed.core.writes(runnerOn(database));
}

/** A validator that returns `result` and records the options it was called with. */
function validatorReturning(result: WebhookValidationResult) {
  const calls: WebhookValidationOptions[] = [];
  const validator: WebhookValidator = {
    validateWebhook(_provider, _payload, _signature, _timestamp, _sourceIp, _secret, options = {}) {
      calls.push(options);
      return Promise.resolve(result);
    },
  };
  return { validator, calls };
}

const valid: WebhookValidationResult = {
  isValid: true,
  provider: 'stripe',
  eventType: 'subscription.created',
  data: { object: 'subscription' },
};

/**
 * A handler with the library defaults on the test database, counting how
 * often the event runs. `body` is what each run does after it is counted.
 */
function countingHandler(
  options: { result?: WebhookValidationResult; skipIpValidation?: boolean; maxRetries?: number } = {},
  body: (run: number) => Promise<void> = () => Promise.resolve(),
) {
  const { validator, calls } = validatorReturning(options.result ?? valid);
  const handler = new WebhookHandler(storeOn(db), validator, writesOn(db), {
    ...(options.skipIpValidation === undefined ? {} : { skipIpValidation: options.skipIpValidation }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
  const counter = { runs: 0 };
  handler.registerEventHandler('subscription.created', async () => {
    counter.runs += 1;
    await body(counter.runs);
  });
  return { handler, counter, calls };
}

/** A body whose first run fails, and later runs succeed. */
function failingOnce(run: number): Promise<void> {
  return run === 1 ? Promise.reject(new Error('downstream unavailable')) : Promise.resolve();
}

/** What `processWebhook` answered: a result the route sends as 2xx, or a failure. A fault rejects. */
async function deliver(handler: WebhookHandler, eventId: string) {
  const result = await handler.processWebhook(
    'stripe',
    JSON.stringify({ id: eventId, type: 'customer.subscription.created' }),
    't=0,v1=stub',
    '0',
    '203.0.113.7',
    'whsec_test',
  );
  assert(!RandomSourceUnavailable.is(result), 'webhook scenarios require working entropy');
  return result;
}

type Delivered = Awaited<ReturnType<typeof deliver>>;

async function rowFor(eventId: string): Promise<WebhookEvent> {
  return only(
    await db.select().from(webhookEvents).where(eq(webhookEvents.providerEventId, eventId)),
    eventId,
  );
}

/** Store a row as an earlier attempt left it. */
async function seedRow(eventId: string, row: { lastAttemptAt: WebhookEvent['lastAttemptAt']; errorMessage?: string }) {
  const { event } = orThrow(await claimWebhookEvent(db, webhookEvents, {
    id: orThrow(createWebhookId()),
    provider: 'stripe',
    eventType: 'subscription.created',
    providerEventId: eventId,
    data: {},
    processed: false,
    attempts: 1,
    sourceIp: '203.0.113.7',
    ...row,
  }));
  return event;
}

const ran = { status: 'processed' };
/** Not run by this copy, and retryable: the route answers non-2xx, so the provider resends. */
const busy = { code: 'payments.webhook_in_progress', data: { retryable: true } };
const done = { status: 'duplicate' };

/** This delivery ran the event now. */
function ranNow(result: Delivered): boolean {
  return !isFailure(result) && result.status === 'processed';
}

/** A copy that lost a race either waits for a resend or sees the winner's result. */
function isBusyOrDone(result: Delivered): boolean {
  return WebhookInProgress.is(result) || (!isFailure(result) && result.status === 'duplicate');
}

describe('WebhookHandler: one run at a time', () => {
  it('runs a new event once when copies arrive at the same time', async () => {
    const { handler, counter } = countingHandler();

    const results = await Promise.all([
      deliver(handler, 'evt_concurrent'),
      deliver(handler, 'evt_concurrent'),
      deliver(handler, 'evt_concurrent'),
    ]);

    expect(counter.runs).toBe(1);
    const winners = results.filter((r) => ranNow(r));
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r !== winners[0]).every((r) => isBusyOrDone(r))).toBe(true);
    expect(await rowFor('evt_concurrent')).toMatchObject({ processed: true, attempts: 1 });
  });

  it('asks a copy that arrives mid-run to be resent, and does not run it', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Only the first run is held open, so a wrong second run fails the test
    // instead of hanging it.
    const { handler, counter } = countingHandler({}, async (run) => {
      if (run === 1) {
        entered.resolve();
        await release.promise;
      }
    });

    const first = deliver(handler, 'evt_in_flight');
    await entered.promise;

    // Not a success: if the running attempt then crashed, a 2xx here would
    // stop the resends and lose the event.
    expect(await deliver(handler, 'evt_in_flight')).toMatchObject(busy);
    expect(counter.runs).toBe(1);

    release.resolve();
    expect(await first).toMatchObject(ran);
    expect(counter.runs).toBe(1);
    expect(await rowFor('evt_in_flight')).toMatchObject({ processed: true, attempts: 1 });
  });

  it('does not run a copy that leaves a fresh attempt alone (stored row, inside the lease)', async () => {
    const { handler, counter } = countingHandler();
    await seedRow('evt_fresh', { lastAttemptAt: now() });

    expect(await deliver(handler, 'evt_fresh')).toMatchObject(busy);
    expect(counter.runs).toBe(0);
    expect(await rowFor('evt_fresh')).toMatchObject({ processed: false, attempts: 1 });
  });

  it('does not run an event again after it succeeded', async () => {
    const { handler, counter } = countingHandler();

    const first = await deliver(handler, 'evt_after_success');
    const resend = await deliver(handler, 'evt_after_success');

    assert(!isFailure(first));
    expect(first).toMatchObject(ran);
    expect(resend).toMatchObject({ ...done, webhookId: first.webhookId });
    expect(counter.runs).toBe(1);
  });
});

describe('WebhookHandler: no lost events', () => {
  it('rethrows a fault after recording it, and the resend runs the event again', async () => {
    const { handler, counter } = countingHandler({}, failingOnce);

    // A throw reaches the route as a non-2xx answer, so the provider resends.
    await expect(deliver(handler, 'evt_fail_then_resend')).rejects.toThrow('downstream unavailable');
    expect(await rowFor('evt_fail_then_resend')).toMatchObject({
      processed: false,
      errorMessage: 'downstream unavailable',
    });

    expect(await deliver(handler, 'evt_fail_then_resend')).toMatchObject(ran);
    expect(counter.runs).toBe(2);
    expect(await rowFor('evt_fail_then_resend')).toMatchObject({ processed: true, attempts: 2, errorMessage: null });
  });

  it('takes over an attempt that crashed (no error, older than the lease)', async () => {
    const { handler, counter } = countingHandler();
    await seedRow('evt_crashed', { lastAttemptAt: sub(now(), { minutes: 10 }) });

    expect(await deliver(handler, 'evt_crashed')).toMatchObject(ran);
    expect(counter.runs).toBe(1);
    expect(await rowFor('evt_crashed')).toMatchObject({ processed: true, attempts: 2 });
  });

  it('lets only one of two copies take over a failed event', async () => {
    const { handler, counter } = countingHandler({}, failingOnce);
    await expect(deliver(handler, 'evt_fail_then_two')).rejects.toThrow('downstream unavailable');

    const results = await Promise.all([deliver(handler, 'evt_fail_then_two'), deliver(handler, 'evt_fail_then_two')]);

    expect(counter.runs).toBe(2);
    expect(results.filter((r) => ranNow(r))).toHaveLength(1);
    expect(results.filter((r) => isBusyOrDone(r))).toHaveLength(1);
    expect(await rowFor('evt_fail_then_two')).toMatchObject({ processed: true, attempts: 2 });
  });

  it('the takeover query is won by exactly one of two callers that read the same row', async () => {
    const failed = await seedRow('evt_race', { lastAttemptAt: now(), errorMessage: 'boom' });
    // A cutoff in the future (a server clock running ahead) would let every
    // attempt be taken over; only the `attempts` check stops the second.
    const cutoff = add(now(), { minutes: 5 });

    const won = await Promise.all([
      reclaimWebhookEvent(db, webhookEvents, failed.id, failed.attempts, cutoff),
      reclaimWebhookEvent(db, webhookEvents, failed.id, failed.attempts, cutoff),
    ]);

    expect(won.toSorted()).toEqual([false, true]);
    expect(await rowFor('evt_race')).toMatchObject({ attempts: 2, errorMessage: null });
  });

  it('stops the resends once maxRetries attempts have failed', async () => {
    const { handler, counter } = countingHandler({ maxRetries: 3 }, () => Promise.reject(new Error('always')));

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(deliver(handler, 'evt_capped')).rejects.toThrow('always');
    }
    const given = await deliver(handler, 'evt_capped');
    // Not retryable: the route answers 2xx with the code, and the provider stops resending.
    expect(WebhookRetriesExhausted.is(given)).toBe(true);
    expect(given).toMatchObject({ code: 'payments.webhook_retries_exhausted', data: { attempts: 3, retryable: false } });
    expect(counter.runs).toBe(3);
  });
});

describe('WebhookHandler.retryFailedWebhooks', () => {
  it('re-runs a failed event, but never one still running', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { handler, counter } = countingHandler({}, async (run) => {
      if (run === 1) {
        throw new Error('downstream unavailable');
      }
      if (run === 2) {
        entered.resolve();
        await release.promise;
      }
    });

    await expect(deliver(handler, 'evt_retry_job')).rejects.toThrow('downstream unavailable');
    expect(counter.runs).toBe(1);

    const retrying = handler.retryFailedWebhooks();
    await entered.promise;
    // The job's own attempt is now running: a second pass must not start it again.
    await handler.retryFailedWebhooks();
    expect(counter.runs).toBe(2);

    release.resolve();
    await retrying;
    expect(counter.runs).toBe(2);
    expect(await rowFor('evt_retry_job')).toMatchObject({ processed: true, attempts: 2 });
  });
});

describe('WebhookHandler before the claim', () => {
  it('acknowledges an event type it does not handle and stores nothing', async () => {
    const { handler, counter } = countingHandler({ result: { isValid: true, provider: 'stripe', data: {} } });

    const result = await deliver(handler, 'evt_unhandled');

    expect(result).toEqual({ status: 'ignored' });
    expect(counter.runs).toBe(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it('rejects an event that fails validation, without asking for a resend, and stores nothing', async () => {
    const { handler, counter } = countingHandler({
      result: { isValid: false, provider: 'stripe', error: 'Invalid webhook signature' },
    });

    const result = await deliver(handler, 'evt_invalid');

    expect(WebhookRejected.is(result)).toBe(true);
    expect(result).toMatchObject({
      code: 'payments.webhook_rejected',
      data: { reason: 'Invalid webhook signature', retryable: false },
    });
    expect(counter.runs).toBe(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it('passes skipIpValidation to the validator, off unless asked for', async () => {
    const skipping = countingHandler({ skipIpValidation: true });
    const checking = countingHandler();

    expect(await deliver(skipping.handler, 'evt_skip_ip')).toMatchObject(ran);
    expect(await deliver(checking.handler, 'evt_check_ip')).toMatchObject(ran);

    expect(skipping.calls).toEqual([{ skipIpValidation: true }]);
    expect(checking.calls).toEqual([{ skipIpValidation: false }]);
  });
});

/** A handler whose validator returns a Stripe event of `type` carrying `object`, on the test database. */
function stateHandler(
  eventType: WebhookEventType,
  object: Record<string, unknown>,
  store = storeOn(db),
  refunds?: WebhookRefunds,
) {
  const { validator } = validatorReturning({
    isValid: true,
    provider: 'stripe',
    eventType,
    data: { id: 'evt_x', type: 'x', data: { object } },
  });
  const writes: WebhookWrites = writesOn(db);
  return new WebhookHandler(store, validator, writes, {}, refunds);
}

/** A Stripe Subscription object, as `customer.subscription.*` events carry it. */
function stripeSubscription(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    object: 'subscription',
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    trial_start: null,
    trial_end: null,
    items: { data: [{ current_period_start: 1_760_000_000, current_period_end: 1_762_592_000 }] },
    ...fields,
  };
}

/** A Stripe PaymentIntent object, as `payment_intent.*` events carry it. */
function stripeIntent(id: string, fields: Record<string, unknown> = {}) {
  return { id, object: 'payment_intent', last_payment_error: null, ...fields };
}

/** A Stripe Charge object, as `charge.refunded` events carry it. */
function stripeCharge(paymentIntent: string | null, fields: Record<string, unknown> = {}) {
  return { id: 'ch_test', object: 'charge', payment_intent: paymentIntent, amount_refunded: 0, currency: 'usd', ...fields };
}

async function subscriptionRowOf(providerSubscriptionId: string) {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.providerSubscriptionId, providerSubscriptionId));
  return row;
}

async function paymentRowOf(providerPaymentId: string) {
  const [row] = await db.select().from(payments).where(eq(payments.providerPaymentId, providerPaymentId));
  return row;
}

describe('WebhookHandler: webhooks change subscriptions and payments', () => {
  let nextEvent = 0;

  /** A new Stripe event id, so each delivery is a new event unless a test is about redelivery. */
  function freshEventId(): string {
    nextEvent += 1;
    return `evt_state_${nextEvent}`;
  }

  it('subscription.updated brings the status and the billing period in line with Stripe', async () => {
    const seeded = await seedSubscription(writesOn(db), 'active');
    const object = stripeSubscription(seeded.providerSubscriptionId, { status: 'past_due' });
    const handler = stateHandler('subscription.updated', object);

    expect(await deliver(handler, freshEventId())).toMatchObject(ran);

    const row = await subscriptionRowOf(seeded.providerSubscriptionId);
    expect(row).toMatchObject({ status: 'past_due', userId: seeded.userId, planId: seeded.planId });
    expect(row?.currentPeriodStart.equals(fromUnix(1_760_000_000))).toBe(true);
    expect(row?.currentPeriodEnd.equals(fromUnix(1_762_592_000))).toBe(true);
    const subscriptionEvents = await eventTypesOf(db, 'subscription', seeded.id);
    expect(subscriptionEvents.at(-1)).toBe('SubscriptionSynced');

    // The same state again, under a new event id: nothing changed, so nothing is written.
    const eventsBefore = await countEvents(db);
    expect(await deliver(handler, freshEventId())).toMatchObject(ran);
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('subscription.canceled marks the subscription canceled, with the time Stripe canceled it', async () => {
    const seeded = await seedSubscription(writesOn(db), 'active');
    const object = stripeSubscription(seeded.providerSubscriptionId, {
      status: 'canceled',
      canceled_at: 1_760_500_000,
    });

    expect(await deliver(stateHandler('subscription.canceled', object), freshEventId())).toMatchObject(ran);

    const row = await subscriptionRowOf(seeded.providerSubscriptionId);
    expect(row?.status).toBe('canceled');
    expect(row?.canceledAt?.equals(fromUnix(1_760_500_000))).toBe(true);
    const subscriptionEvents = await eventTypesOf(db, 'subscription', seeded.id);
    expect(subscriptionEvents.at(-1)).toBe('SubscriptionSynced');
  });

  it('subscription.created for a subscription the app does not know fails and is retried: no owner is invented', async () => {
    const eventId = freshEventId();
    const eventsBefore = await countEvents(db);

    const result = await deliver(stateHandler('subscription.created', stripeSubscription('psub_unknown')), eventId);

    // Retryable on purpose: Stripe can send the event before the app's own insert of the row commits.
    expect(WebhookTargetNotFound.is(result)).toBe(true);
    expect(result).toMatchObject({
      code: 'payments.webhook_target_not_found',
      data: { kind: 'subscription', providerId: 'psub_unknown', retryable: true },
    });
    const stored = await rowFor(eventId);
    expect(stored.processed).toBe(false);
    expect(stored.errorMessage).toBe(
      'payments.webhook_target_not_found: No local subscription for provider subscription psub_unknown',
    );
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await subscriptionRowOf('psub_unknown')).toBeUndefined();
  });

  it('payment.succeeded completes a pending payment', async () => {
    const seeded = await seedPayment(writesOn(db), null);

    const result = await deliver(
      stateHandler('payment.succeeded', stripeIntent(seeded.providerPaymentId)),
      freshEventId(),
    );

    expect(result).toMatchObject(ran);
    expect(await paymentRowOf(seeded.providerPaymentId)).toMatchObject({ status: 'succeeded' });
    expect(await eventTypesOf(db, 'payment', seeded.id)).toEqual(['PaymentInitiatedV2', 'PaymentCompleted']);
  });

  it('payment.failed fails a pending payment and keeps the reason Stripe gave', async () => {
    const seeded = await seedPayment(writesOn(db), null);
    const object = stripeIntent(seeded.providerPaymentId, {
      last_payment_error: { message: 'Your card was declined.', code: 'card_declined' },
    });

    expect(await deliver(stateHandler('payment.failed', object), freshEventId())).toMatchObject(ran);

    expect(await paymentRowOf(seeded.providerPaymentId)).toMatchObject({
      status: 'failed',
      failureReason: 'Your card was declined.',
    });
    expect(await eventTypesOf(db, 'payment', seeded.id)).toEqual(['PaymentInitiatedV2', 'PaymentFailed']);
  });

  it('payment.refunded records the total Stripe refunded on a collected payment', async () => {
    const seeded = await seedPayment(writesOn(db), null, '25');
    await orThrow(writesOn(db).completePayment({ paymentId: seeded.id }));
    const charge = stripeCharge(seeded.providerPaymentId, { amount_refunded: 1000, currency: 'usd' });

    expect(await deliver(stateHandler('payment.refunded', charge), freshEventId())).toMatchObject(ran);
    // Stripe sends the whole total again on a resend: nothing changes
    expect(await deliver(stateHandler('payment.refunded', charge), freshEventId())).toMatchObject(ran);

    expect(await paymentRowOf(seeded.providerPaymentId)).toMatchObject({ refunded: true, refundedAmountMinor: 1000 });
    expect(await eventTypesOf(db, 'payment', seeded.id)).toEqual([
      'PaymentInitiatedV2',
      'PaymentCompleted',
      'PaymentRefundRecorded',
    ]);
  });

  it('payment.refunded before the payment is collected fails and is retried, so the refund is not lost', async () => {
    const seeded = await seedPayment(writesOn(db), null);
    const eventId = freshEventId();

    const result = await deliver(
      stateHandler('payment.refunded', stripeCharge(seeded.providerPaymentId, { amount_refunded: 500 })),
      eventId,
    );

    // The journal's refused write is returned (AGENTS.md law 9), not thrown: the route answers it non-2xx.
    expect(CommandConflict.is(result)).toBe(true);
    expect(isWebhookFailure(result)).toBe(false);
    expect(await rowFor(eventId)).toMatchObject({ processed: false, errorMessage: 'journal.conflict: Cannot refund payment with status pending' });
    expect(await paymentRowOf(seeded.providerPaymentId)).toMatchObject({ refunded: false, refundedAmountMinor: 0 });
  });

  it('payment.refunded with an amount in a currency money refuses answers that failure, records no refund and is not processed', async () => {
    const seeded = await seedPayment(writesOn(db), null, '25');
    await orThrow(writesOn(db).completePayment({ paymentId: seeded.id }));
    const charge = stripeCharge(seeded.providerPaymentId, { amount_refunded: 1000, currency: 'zzz' });

    const result = await deliver(stateHandler('payment.refunded', charge), freshEventId());

    expect(UnknownCurrency.is(result)).toBe(true);
    expect(await paymentRowOf(seeded.providerPaymentId)).toMatchObject({ refunded: false, refundedAmountMinor: 0 });
    expect(await eventTypesOf(db, 'payment', seeded.id)).toEqual(['PaymentInitiatedV2', 'PaymentCompleted']);
    const stored = await db.select().from(webhookEvents).where(isNotNull(webhookEvents.errorMessage));
    expect(stored.some(row => !row.processed && row.errorMessage?.startsWith('money.unknown_currency'))).toBe(true);
  });

  it('payment.refunded for a charge without a payment intent is acknowledged and records nothing', async () => {
    const eventsBefore = await countEvents(db);

    const result = await deliver(
      stateHandler('payment.refunded', stripeCharge(null, { amount_refunded: 500 })),
      freshEventId(),
    );

    expect(result).toMatchObject(ran);
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  /**
   * The app's journal with the refund workflow composed: the run a refund webhook signals. Its own
   * `initJournal` on the same tables, because a journal composes workflows once. No step runs here.
   */
  const refundRuntime = (() => {
    const j = initJournal.tx<AppTx>().db<AppDb>().create({ tables: journalTablesInSchema, meta: metaSchema });
    const refund = createRefundWorkflow(
      j,
      createRefundsJournal(j, { refunds: refundsTables.refunds, payments: core.payments }),
    );
    const journal = j.compose({
      workflows: [refund],
      workflowMeta: { actorId: 'system:workflow' },
      services: {
        stripe: () => {
          throw new Error('the webhook tests run no workflow step');
        },
        notifications: {},
      },
    });
    return { journal, refund };
  })();

  /** What each signal the handler sent was answered with, in order. */
  let signalled: string[] = [];

  /** The app's `signal`: the workflow's settled signal on the test database. `dropAnswer`: the first call throws after it was delivered. */
  function refundsOn(dropAnswer = false): WebhookRefunds {
    return {
      signal: async input => {
        const outcome = await refundRuntime.journal.run(
          db,
          refundRuntime.refund.signal('stripe.refund.settled'),
          input,
          meta,
        );
        if (!isFailure(outcome)) signalled.push(outcome.status);
        if (dropAnswer && signalled.length === 1) throw new Error('connection lost after the signal was stored');
        return outcome;
      },
    };
  }

  /** A collected payment of 25 and an approved refund of 10 of it; with `run`, its workflow run has started. */
  async function approvedRefund({ run }: { run: boolean }) {
    const payment = await seedPayment(writesOn(db), null, '25');
    await orThrow(writesOn(db).completePayment({ paymentId: payment.id }));
    const refundWrites = typed.refunds.writes(runnerOn(db));
    const refund = await orThrow(
      refundWrites.requestRefund({
        paymentId: payment.id,
        originalAmount: { amount: '25', currency: 'USD' },
        refundAmount: { amount: '10', currency: 'USD' },
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );
    await orThrow(refundWrites.approveRefund({ refundId: refund.id, approvedBy: adminId }));
    if (run) {
      orThrow(
        await refundRuntime.journal.run(
          db,
          refundRuntime.refund.start,
          { id: `refund:${refund.id}`, input: { refundId: refund.id } },
          meta,
        ),
      );
    }
    return { payment, refund };
  }

  function chargeWithRefund(providerPaymentId: string, refund: Record<string, unknown>) {
    return stripeCharge(providerPaymentId, {
      amount_refunded: 1000,
      currency: 'usd',
      refunds: { data: [{ status: 'succeeded', ...refund }] },
    });
  }

  describe('refund webhooks signal the refund workflow', () => {
    beforeEach(() => {
      signalled = [];
    });

    it('a settled refund the service made is signalled to its run, and the handler writes no refund itself', async () => {
      const { payment, refund } = await approvedRefund({ run: true });
      const charge = chargeWithRefund(payment.providerPaymentId, {
        id: 're_settled',
        metadata: { refundId: refund.id },
      });

      expect(
        await deliver(stateHandler('payment.refunded', charge, storeOn(db), refundsOn()), freshEventId()),
      ).toMatchObject(ran);

      // `kept`: the run has not reached its wait yet, and takes the signal when it does
      expect(signalled).toEqual(['kept']);
      expect(await refundRow(db, refund.id)).toMatchObject({ status: 'approved', providerRefundId: null });
    });

    it('a resent charge.refunded is a duplicate signal', async () => {
      const { payment, refund } = await approvedRefund({ run: true });
      const charge = chargeWithRefund(payment.providerPaymentId, {
        id: 're_resent',
        metadata: { refundId: refund.id },
      });
      const refunds = refundsOn(true);
      const eventId = freshEventId();

      // The signal was stored, then the answer was lost: Stripe resends the same event
      await expect(deliver(stateHandler('payment.refunded', charge, storeOn(db), refunds), eventId)).rejects.toThrow(
        'connection lost after the signal was stored',
      );
      expect(await deliver(stateHandler('payment.refunded', charge, storeOn(db), refunds), eventId)).toMatchObject(ran);

      // The run holds one signal: the resend changed nothing
      expect(signalled).toEqual(['kept', 'duplicate']);
    });

    it('a refund made outside the service answers 2xx and signals nothing', async () => {
      const { payment } = await approvedRefund({ run: true });
      const charge = chargeWithRefund(payment.providerPaymentId, { id: 're_dashboard', metadata: {} });

      expect(
        await deliver(stateHandler('payment.refunded', charge, storeOn(db), refundsOn()), freshEventId()),
      ).toMatchObject(ran);

      expect(signalled).toEqual([]);
    });

    it('a refund whose run does not exist answers 2xx, so Stripe stops resending', async () => {
      const { payment, refund } = await approvedRefund({ run: false });
      const charge = chargeWithRefund(payment.providerPaymentId, {
        id: 're_no_run',
        metadata: { refundId: refund.id },
      });

      expect(
        await deliver(stateHandler('payment.refunded', charge, storeOn(db), refundsOn()), freshEventId()),
      ).toMatchObject(ran);

      expect(signalled).toEqual(['no-run']);
    });

    it('refund.updated alone signals the run, for Stripe API versions that list no refunds on the charge', async () => {
      const { refund } = await approvedRefund({ run: true });
      const object = { id: 're_alone', object: 'refund', status: 'failed', metadata: { refundId: refund.id } };

      expect(
        await deliver(stateHandler('refund.updated', object, storeOn(db), refundsOn()), freshEventId()),
      ).toMatchObject(ran);

      expect(signalled).toEqual(['kept']);
    });

    it('a refund Stripe has not settled yet signals nothing: a later event settles it', async () => {
      const { refund } = await approvedRefund({ run: true });

      for (const status of ['pending', 'requires_action']) {
        const object = { id: `re_${status}`, object: 'refund', status, metadata: { refundId: refund.id } };
        expect(
          await deliver(stateHandler('refund.updated', object, storeOn(db), refundsOn()), freshEventId()),
        ).toMatchObject(ran);
      }

      expect(signalled).toEqual([]);
    });
  });

  it('payment.dispute_created records the dispute on the payment', async () => {
    const seeded = await seedPayment(writesOn(db), null);
    await orThrow(writesOn(db).completePayment({ paymentId: seeded.id }));
    const dispute = {
      id: 'dp_webhook_1',
      object: 'dispute',
      payment_intent: seeded.providerPaymentId,
      status: 'needs_response',
      reason: 'fraudulent',
    };

    expect(await deliver(stateHandler('payment.dispute_created', dispute), freshEventId())).toMatchObject(ran);

    expect(await paymentRowOf(seeded.providerPaymentId)).toMatchObject({
      disputeId: 'dp_webhook_1',
      disputeStatus: 'needs_response',
    });
    expect(await eventTypesOf(db, 'payment', seeded.id)).toContain('PaymentDisputeRecorded');
  });

  it('payment.requires_action marks a pending payment as waiting for the customer', async () => {
    const seeded = await seedPayment(writesOn(db), null);

    expect(await deliver(stateHandler('payment.requires_action', stripeIntent(seeded.providerPaymentId)), freshEventId())).toMatchObject(ran);

    expect(await paymentRowOf(seeded.providerPaymentId)).toMatchObject({ status: 'requires_action' });
    const paymentEvents = await eventTypesOf(db, 'payment', seeded.id);
    expect(paymentEvents.at(-1)).toBe('PaymentRequiresAction');
  });

  it('payment.succeeded after payment.requires_action completes it (3-D Secure passed)', async () => {
    const seeded = await seedPayment(writesOn(db), null);
    const object = stripeIntent(seeded.providerPaymentId);

    expect(await deliver(stateHandler('payment.requires_action', object), freshEventId())).toMatchObject(ran);
    expect(await deliver(stateHandler('payment.succeeded', object), freshEventId())).toMatchObject(ran);

    expect(await paymentRowOf(seeded.providerPaymentId)).toMatchObject({ status: 'succeeded' });
    expect(await eventTypesOf(db, 'payment', seeded.id)).toEqual([
      'PaymentInitiatedV2',
      'PaymentRequiresAction',
      'PaymentCompleted',
    ]);
  });

  it('payment.succeeded after payment.failed completes it: the customer retried and the money was collected', async () => {
    const seeded = await seedPayment(writesOn(db), null);
    const object = stripeIntent(seeded.providerPaymentId);

    expect(await deliver(stateHandler('payment.failed', object), freshEventId())).toMatchObject(ran);
    expect(await deliver(stateHandler('payment.succeeded', object), freshEventId())).toMatchObject(ran);

    expect(await paymentRowOf(seeded.providerPaymentId)).toMatchObject({ status: 'succeeded' });
    expect(await eventTypesOf(db, 'payment', seeded.id)).toEqual([
      'PaymentInitiatedV2',
      'PaymentFailed',
      'PaymentCompleted',
    ]);
  });

  it('payment.failed for a payment that already succeeded changes nothing: the money was taken', async () => {
    const seeded = await seedPayment(writesOn(db), null);
    await orThrow(writesOn(db).completePayment({ paymentId: seeded.id }));
    const eventsBefore = await countEvents(db);
    const eventId = freshEventId();

    const result = await deliver(stateHandler('payment.failed', stripeIntent(seeded.providerPaymentId)), eventId);

    expect(result).toMatchObject(ran);
    expect(await paymentRowOf(seeded.providerPaymentId)).toMatchObject({ status: 'succeeded' });
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await rowFor(eventId)).toMatchObject({ processed: true });
  });

  it('a payment event without an id fails as an invalid payload and writes nothing', async () => {
    const eventId = freshEventId();
    const eventsBefore = await countEvents(db);

    const result = await deliver(stateHandler('payment.succeeded', { object: 'payment_intent' }), eventId);

    // Final: a resend carries the same body, so the route answers 2xx and Stripe stops.
    assert(WebhookPayloadInvalid.is(result));
    expect(result.data.retryable).toBe(false);
    expect(InvalidInput.is(result.cause)).toBe(true);
    const stored = await rowFor(eventId);
    expect(stored.processed).toBe(false);
    expect(stored.errorMessage).toMatch(/^payments\.webhook_payload_invalid: Invalid webhook payload:/);
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('invoice.paid still only acknowledges: the event is processed and nothing is written', async () => {
    const eventId = freshEventId();
    const eventsBefore = await countEvents(db);

    expect(await deliver(stateHandler('invoice.paid', { id: 'in_1', object: 'invoice' }), eventId)).toMatchObject(ran);

    expect(await rowFor(eventId)).toMatchObject({ processed: true });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('a resend of a processed payment event does not run again (the claim)', async () => {
    const seeded = await seedPayment(writesOn(db), null);
    const handler = stateHandler('payment.succeeded', stripeIntent(seeded.providerPaymentId));
    expect(await deliver(handler, 'evt_dup')).toMatchObject(ran);
    const eventsBefore = await countEvents(db);

    expect(await deliver(handler, 'evt_dup')).toMatchObject(done);

    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await eventTypesOf(db, 'payment', seeded.id)).toEqual(['PaymentInitiatedV2', 'PaymentCompleted']);
  });

  it('a rerun after a crash between the write and "processed" writes nothing twice (the status guard)', async () => {
    const seeded = await seedPayment(writesOn(db), null);
    const real = storeOn(db);
    let marks = 0;
    const crashingOnce: WebhookEventStore = {
      ...real,
      markWebhookEventAsProcessed(id) {
        marks += 1;
        return marks === 1 ? Promise.reject(new Error('connection lost')) : real.markWebhookEventAsProcessed(id);
      },
    };
    const handler = stateHandler('payment.succeeded', stripeIntent(seeded.providerPaymentId), crashingOnce);

    await expect(deliver(handler, 'evt_crash')).rejects.toThrow('connection lost');
    expect(await paymentRowOf(seeded.providerPaymentId)).toMatchObject({ status: 'succeeded' });
    const eventsBefore = await countEvents(db);

    expect(await deliver(handler, 'evt_crash')).toMatchObject(ran);

    expect(await rowFor('evt_crash')).toMatchObject({ attempts: 2, processed: true });
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await eventTypesOf(db, 'payment', seeded.id)).toEqual(['PaymentInitiatedV2', 'PaymentCompleted']);
  });

  it('payment.succeeded for a payment the app does not know is retryable: the insert may not have committed yet', async () => {
    const eventId = freshEventId();

    const result = await deliver(stateHandler('payment.succeeded', stripeIntent('pi_not_yet_here')), eventId);

    expect(result).toMatchObject({
      code: 'payments.webhook_target_not_found',
      data: { kind: 'payment', providerId: 'pi_not_yet_here', retryable: true },
    });
    expect(await rowFor(eventId)).toMatchObject({
      processed: false,
      errorMessage: 'payments.webhook_target_not_found: No local payment for provider payment pi_not_yet_here',
    });
  });

  it.each([
    ['payment.dispute_created', { id: 'dp_unknown', object: 'dispute', payment_intent: 'pi_dispute_unknown', status: 'needs_response' }],
    ['payment.refunded', stripeCharge('pi_dispute_unknown', { amount_refunded: 100 })],
  ] as const)('%s for a payment the app does not know returns the retryable not-found failure', async (type, object) => {
    const result = await deliver(stateHandler(type, object), freshEventId());

    expect(result).toMatchObject({
      code: 'payments.webhook_target_not_found',
      data: { kind: 'payment', providerId: 'pi_dispute_unknown', retryable: true },
    });
  });

  it.each([
    ['subscription.updated', stripeSubscription('psub_no_items', { items: { data: [] } })],
    ['subscription.updated', stripeSubscription('psub_far', { canceled_at: 9_000_000_000_000 })],
    ['payment.refunded', { id: 'ch_bad', object: 'charge', amount_refunded: -1, currency: 'usd' }],
    ['refund.updated', { object: 'refund' }],
    ['payment.dispute_created', { id: 'dp_bad', object: 'dispute' }],
  ] as const)('%s with a body its schema refuses is a final payload failure, never a throw', async (type, object) => {
    const eventId = freshEventId();
    const eventsBefore = await countEvents(db);

    const result = await deliver(stateHandler(type, object), eventId);

    assert(WebhookPayloadInvalid.is(result));
    expect(result.data.retryable).toBe(false);
    expect(InvalidInput.is(result.cause)).toBe(true);
    expect(await rowFor(eventId)).toMatchObject({ processed: false });
    expect(await countEvents(db)).toBe(eventsBefore);
  });
});

describe('WebhookHandler: the event envelope', () => {
  it.each([
    ['not JSON', 'not json'],
    ['no id', JSON.stringify({ type: 'customer.subscription.created' })],
    ['an empty type', JSON.stringify({ id: 'evt_empty_type', type: '' })],
  ])('a body with %s is a final payload failure and stores nothing', async (_what, body) => {
    const { handler, counter } = countingHandler();

    const result = await handler.processWebhook('stripe', body, 't=0,v1=stub', '0', '203.0.113.7', 'whsec_test');

    expect(result).toMatchObject({ code: 'payments.webhook_payload_invalid', data: { retryable: false } });
    expect(counter.runs).toBe(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });
});

describe('claimWebhookEvent', () => {
  it('returns the retryable claim conflict when the insert conflicts but no row holds the event id', async () => {
    const held = await seedRow('evt_holder', { lastAttemptAt: now() });

    // The same webhook id (primary key) for another provider event: the insert does nothing, and the
    // lookup by provider event id finds no row.
    const claim = await claimWebhookEvent(db, webhookEvents, {
      id: held.id,
      provider: 'stripe',
      eventType: 'subscription.created',
      providerEventId: 'evt_collides',
      data: {},
      processed: false,
      attempts: 1,
      sourceIp: '203.0.113.7',
    });

    expect(WebhookClaimConflict.is(claim)).toBe(true);
    expect(claim).toMatchObject({
      code: 'payments.webhook_claim_conflict',
      data: { providerEventId: 'evt_collides', retryable: true },
    });
  });
});

describe('webhook ID failure', () => {
  it('returns the canonical refusal before claiming or processing a provider event', async () => {
    const { handler, counter } = countingHandler();
    vi.stubGlobal('crypto', {});
    try {
      const result = await handler.processWebhook(
        'stripe', JSON.stringify({ id: 'evt_no_entropy', type: 'customer.subscription.created' }),
        't=0,v1=stub', '0', '203.0.113.7', 'whsec_test',
      );
      expect(RandomSourceUnavailable.is(result)).toBe(true);
      expect(counter.runs).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await db.select().from(webhookEvents).where(eq(webhookEvents.providerEventId, 'evt_no_entropy'))).toEqual([]);
  });
});
