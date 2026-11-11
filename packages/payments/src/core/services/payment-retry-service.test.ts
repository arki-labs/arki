/**
 * PaymentRetryService on the journal
 *
 * Flow: PaymentRetryService → writes(run) → command → journal event →
 *       `subscriptions` row, in one transaction.
 *
 * A failed payment is tried again on a schedule. The schedule stays in memory,
 * as before. What the tests pin is the outcome for the customer: a retry that
 * succeeds brings a past due subscription back, the last failed retry makes it
 * past due, and both leave an event. When the status would not change, nothing
 * is written.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { add, now, sub } from '@arki/date';
import { orThrow } from '@arki/failure';

import type { AppDb } from '../../test-support.js';
import type { CoreWrites } from '../journal.js';
import type { PaymentStatus, SubscriptionStatus } from '../types.js';
import type { RetryStrategy } from './payment-retry-service.js';
import { coreReads, runnerOn, seedPayment, seedSubscription, subscriptionRow } from '../../service-test-support.js';
import { countEvents, eventTypesOf, openDb, typed } from '../../test-support.js';
import { PaymentWithoutSubscription } from '../failures.js';
import { MAX_BATCH_ITEMS } from '../pg-values.js';
import { createPaymentId } from '../primitives.js';
import { CardDeclined, ReferenceNotFound } from '../providers/provider-error.js';
import { StripeProvider } from '../providers/stripe-provider.js';
import { PaymentRetryService } from './payment-retry-service.js';

type Provider = Parameters<typeof PaymentRetryService.create>[0];

/** One retry, due at once. */
const oneRetryNow: RetryStrategy = {
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

let db: AppDb;
let client: PGlite;
let reads: ReturnType<typeof coreReads>;
let writes: CoreWrites;

function providerWhereRetryEnds(retryStatus: PaymentStatus): Provider {
  return {
    async confirmPayment(paymentId) {
      const payment = await reads.findPaymentById(paymentId);

      if (!payment) {
        throw new Error(`the provider does not know ${paymentId}`);
      }

      return { ...payment, status: retryStatus };
    },
  };
}

/** A service built from strategies that are valid. */
function build(...args: Parameters<typeof PaymentRetryService.create>) {
  return orThrow(PaymentRetryService.create(...args));
}

/** Runs the one scheduled retry of a failed payment on a subscription in `status`. */
async function retryOn(status: SubscriptionStatus, retryStatus: PaymentStatus) {
  const subscription = await seedSubscription(writes, 'active');
  if (status === 'past_due') {
    await orThrow(writes.markSubscriptionPastDue({ subscriptionId: subscription.id }));
  }
  const payment = await seedPayment(writes, subscription.id);
  const service = build(providerWhereRetryEnds(retryStatus), reads, writes, [oneRetryNow]);

  await orThrow(service.scheduleRetries(payment.id, 'card_declined'));
  const eventsBefore = await countEvents(db);
  await service.processRetries();

  return {
    id: subscription.id,
    attempts: service.getRetryAttempts(payment.id),
    eventsWritten: (await countEvents(db)) - eventsBefore,
  };
}

beforeAll(async () => {
  ({ db, client } = await openDb());
  reads = coreReads(db);
  writes = typed.core.writes(runnerOn(db));
});

afterAll(async () => {
  await client.close();
});

describe('a retry that succeeds', () => {
  it('brings a past due subscription back to active and records the event', async () => {
    const { id, attempts } = await retryOn('past_due', 'succeeded');

    expect(attempts.map(attempt => attempt.status)).toEqual(['succeeded']);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionPastDue',
      'SubscriptionActivated',
    ]);
  });

  it('writes nothing when the subscription was still active', async () => {
    const { id, eventsWritten } = await retryOn('active', 'succeeded');

    expect(eventsWritten).toBe(0);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active' });
  });
});

describe('the last retry fails', () => {
  it('makes an active subscription past due and records the event', async () => {
    const { id, attempts } = await retryOn('active', 'failed');

    expect(attempts.map(attempt => attempt.status)).toEqual(['failed']);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual(['SubscriptionCreated', 'SubscriptionPastDue']);
  });

  it('writes nothing when the subscription was already past due', async () => {
    const { id, eventsWritten } = await retryOn('past_due', 'failed');

    expect(eventsWritten).toBe(0);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
  });
});

/**
 * A decline is returned, not thrown, and it is the most common way a retry fails. On the last
 * attempt it must still end dunning like any other failed retry: otherwise the subscription stays
 * in limbo, neither recovered nor marked past due.
 */
describe('a retry the card declines', () => {
  const declining: Provider = {
    confirmPayment: () => Promise.resolve(CardDeclined({ providerCode: 'card_declined' })),
  };

  /** Two retries: the first is due now, the second an hour later, so only the first runs. */
  const twoRetries: RetryStrategy = { ...oneRetryNow, name: 'two_retries', maxAttempts: 2, delayMinutes: [0, 60] };

  async function declinedRetryWith(strategy: RetryStrategy) {
    const subscription = await seedSubscription(writes, 'active');
    const payment = await seedPayment(writes, subscription.id);
    const service = build(declining, reads, writes, [strategy]);
    await orThrow(service.scheduleRetries(payment.id, 'card_declined'));
    const eventsBefore = await countEvents(db);

    await service.processRetries();

    return {
      id: subscription.id,
      attempts: service.getRetryAttempts(payment.id),
      eventsWritten: (await countEvents(db)) - eventsBefore,
    };
  }

  it('on the last attempt ends dunning: the subscription is past due, with the event', async () => {
    const { id, attempts } = await declinedRetryWith(oneRetryNow);

    expect(attempts).toMatchObject([{ status: 'failed', failureReason: 'The card was declined (card_declined)' }]);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual(['SubscriptionCreated', 'SubscriptionPastDue']);
  });

  it('before the last attempt only fails that attempt: the next one stays scheduled and nothing is written', async () => {
    const { id, attempts, eventsWritten } = await declinedRetryWith(twoRetries);

    expect(attempts.map(attempt => attempt.status)).toEqual(['failed', 'pending']);
    expect(eventsWritten).toBe(0);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active' });
  });
});

/**
 * `processRetries` returns what each due attempt did, so the caller can act on a failure instead of
 * reading log lines: a provider built wrong, a declined card or a crash each come back as a value.
 */
describe('processRetries reports each due attempt', () => {
  /** A failed payment on an active subscription, with its retries scheduled by `strategy` on `provider`. */
  async function scheduledOn(provider: Provider, strategy: RetryStrategy = oneRetryNow) {
    const subscription = await seedSubscription(writes, 'active');
    const payment = await seedPayment(writes, subscription.id);
    const service = build(provider, reads, writes, [strategy]);
    const attempts = await orThrow(service.scheduleRetries(payment.id, 'card_declined'));
    return { service, subscription, payment, attemptIds: attempts.map(attempt => attempt.id) };
  }

  it('a recovered payment is succeeded, and its other due attempt is cancelled, in run order', async () => {
    const twoDueNow: RetryStrategy = { ...oneRetryNow, name: 'two_due_now', maxAttempts: 2, delayMinutes: [0, 0] };
    const { service, attemptIds } = await scheduledOn(providerWhereRetryEnds('succeeded'), twoDueNow);

    expect(await service.processRetries()).toEqual([
      { attemptId: attemptIds[0], status: 'succeeded' },
      { attemptId: attemptIds[1], status: 'cancelled' },
    ]);
  });

  it('a declined card is failed with payments.card_declined', async () => {
    const declining: Provider = {
      confirmPayment: () => Promise.resolve(CardDeclined({ providerCode: 'card_declined' })),
    };
    const { service, attemptIds } = await scheduledOn(declining);

    expect(await service.processRetries()).toEqual([
      {
        attemptId: attemptIds[0],
        status: 'failed',
        failure: expect.objectContaining({ code: 'payments.card_declined', data: { providerCode: 'card_declined' } }),
      },
    ]);
  });

  it('a payment the provider answers as failed is failed with that answer', async () => {
    const { service, payment, attemptIds } = await scheduledOn(providerWhereRetryEnds('failed'));

    expect(await service.processRetries()).toEqual([
      {
        attemptId: attemptIds[0],
        status: 'failed',
        payment: expect.objectContaining({ id: payment.id, status: 'failed' }),
      },
    ]);
  });

  it('a StripeProvider built without references is refused with payments.configuration_invalid', async () => {
    const stripe = orThrow(
      StripeProvider.create({ apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' }),
    );
    const { service, payment, attemptIds } = await scheduledOn(stripe);

    expect(await service.processRetries()).toEqual([
      {
        attemptId: attemptIds[0],
        status: 'refused',
        failure: expect.objectContaining({
          code: 'payments.configuration_invalid',
          data: expect.objectContaining({ setting: 'references' }),
        }),
      },
    ]);
    expect(service.getRetryAttempts(payment.id)).toMatchObject([{ status: 'failed' }]);
  });

  it('an attempt that throws is thrown with its error, and the next attempt still runs', async () => {
    const providerDown = new Error('provider down');
    const subscription = await seedSubscription(writes, 'active');
    const broken = await seedPayment(writes, subscription.id);
    const recovered = await seedPayment(writes, subscription.id);
    const recovering = providerWhereRetryEnds('succeeded');
    const provider: Provider = {
      async confirmPayment(paymentId) {
        if (paymentId === broken.id) throw providerDown;
        return recovering.confirmPayment(paymentId);
      },
    };
    const service = build(provider, reads, writes, [oneRetryNow]);
    const [first] = await orThrow(service.scheduleRetries(broken.id, 'card_declined'));
    const [second] = await orThrow(service.scheduleRetries(recovered.id, 'card_declined'));

    expect(await service.processRetries()).toEqual([
      { attemptId: first?.id, status: 'thrown', error: providerDown },
      { attemptId: second?.id, status: 'succeeded' },
    ]);
    expect(service.getRetryAttempts(broken.id)).toMatchObject([{ status: 'failed', failureReason: 'provider down' }]);
  });

  it('an attempt whose subscription is no longer active or past due is cancelled', async () => {
    const { service, subscription, attemptIds } = await scheduledOn(providerWhereRetryEnds('succeeded'));
    await orThrow(writes.cancelSubscription({ subscriptionId: subscription.id }));

    expect(await service.processRetries()).toEqual([{ attemptId: attemptIds[0], status: 'cancelled' }]);
  });
});

/** A retry schedule is refused, with nothing scheduled, when there is nothing to retry or no subscription to keep. */
describe('scheduleRetries refusals', () => {
  it('returns ReferenceNotFound for an unknown payment', async () => {
    const service = build(providerWhereRetryEnds('succeeded'), reads, writes, [oneRetryNow]);
    const paymentId = orThrow(createPaymentId());

    const result = await service.scheduleRetries(paymentId, 'card_declined');

    expect(ReferenceNotFound.is(result)).toBe(true);
    expect(result).toMatchObject({ code: 'payments.reference_not_found', data: { kind: 'payment', id: paymentId } });
    expect(service.getRetryAttempts(paymentId)).toEqual([]);
  });

  it('returns PaymentWithoutSubscription for a one-off payment', async () => {
    const service = build(providerWhereRetryEnds('succeeded'), reads, writes, [oneRetryNow]);
    const payment = await seedPayment(writes, null);

    const result = await service.scheduleRetries(payment.id, 'card_declined');

    expect(PaymentWithoutSubscription.is(result)).toBe(true);
    expect(result).toMatchObject({ code: 'payments.payment_without_subscription', data: { paymentId: payment.id } });
    expect(service.getRetryAttempts(payment.id)).toEqual([]);
  });

  it('picks the strategy by the stored subscription status: a paused subscription gets no retries', async () => {
    const service = build(providerWhereRetryEnds('succeeded'), reads, writes, [oneRetryNow]);
    const subscription = await seedSubscription(writes, 'paused');
    const payment = await seedPayment(writes, subscription.id);

    expect(await service.scheduleRetries(payment.id, 'card_declined')).toEqual([]);
  });
});

describe('getRetryAnalytics', () => {
  it('counts only the attempts created inside the window, comparing instants without throwing', async () => {
    const service = build(providerWhereRetryEnds('failed'), reads, writes, [oneRetryNow]);
    const subscription = await seedSubscription(writes, 'active');
    const payment = await seedPayment(writes, subscription.id);
    await orThrow(service.scheduleRetries(payment.id, 'card_declined'));
    const created = service.getRetryAttempts(payment.id)[0]?.createdAt;
    if (!created) throw new Error('no attempt was scheduled');

    const inside = await service.getRetryAnalytics(created, created);
    const after = await service.getRetryAnalytics(add(created, { minutes: 1 }));

    expect(inside.totalRetryAttempts).toBe(1);
    expect(after.totalRetryAttempts).toBe(0);
  });

  it('sums the stored amount of each payment a retry recovered', async () => {
    const service = build(providerWhereRetryEnds('succeeded'), reads, writes, [oneRetryNow]);
    const subscription = await seedSubscription(writes, 'active');
    const payment = await seedPayment(writes, subscription.id, '19.99', 'USD');
    await orThrow(service.scheduleRetries(payment.id, 'card_declined'));
    await service.processRetries();

    const analytics = await service.getRetryAnalytics(sub(now(), { hours: 1 }));

    expect(analytics.successfulRetries).toBe(1);
    expect(analytics.revenueRecovered.get('USD').toString()).toBe('1999/100 USD');
    expect(analytics.revenueRecovered.currencies().map(currency => currency.code)).toEqual(['USD']);
  });
});

describe('retry strategies belong to one service', () => {
  it('adding or changing a strategy on one service leaves the defaults of the next one alone', () => {
    const first = build(providerWhereRetryEnds('succeeded'), reads, writes);
    const defaults = structuredClone(first.getRetryStrategies());
    const [standard] = defaults;
    if (!standard) throw new Error('the package ships default strategies');

    expect(first.addRetryStrategy({ ...oneRetryNow, name: 'only_this_instance' })).toBeUndefined();
    expect(first.updateRetryStrategy(standard.name, { maxAttempts: 9 })).toBeUndefined();

    const second = build(providerWhereRetryEnds('succeeded'), reads, writes);
    expect(second.getRetryStrategies()).toEqual(defaults);
  });
});

describe('a strategy the schedule cannot follow fails where it is set', () => {
  const unusable: [string, Partial<RetryStrategy>][] = [
    ['a fractional attempt count', { maxAttempts: 1.5 }],
    ['an attempt count past 10, which an exponential backoff would carry past the last date', { maxAttempts: 11 }],
    ['a delay that is not a number', { delayMinutes: [Number.NaN] }],
    ['a delay past a year', { delayMinutes: [525_601] }],
  ];

  it.each(unusable)('%s is payments.configuration_invalid, and changes nothing', (_what, change) => {
    const service = build(providerWhereRetryEnds('succeeded'), reads, writes);
    const before = structuredClone(service.getRetryStrategies());
    const [first] = before;
    if (!first) throw new Error('the package ships default strategies');

    expect(
      PaymentRetryService.create(providerWhereRetryEnds('succeeded'), reads, writes, [{ ...oneRetryNow, ...change }]),
    ).toMatchObject({ code: 'payments.configuration_invalid' });
    expect(service.addRetryStrategy({ ...oneRetryNow, ...change })).toMatchObject({
      code: 'payments.configuration_invalid',
    });
    expect(service.updateRetryStrategy(first.name, change)).toMatchObject({ code: 'payments.configuration_invalid' });
    expect(service.getRetryStrategies()).toEqual(before);
  });

  it('updateRetryStrategy for a name no strategy has is payments.retry_strategy_not_found, and changes nothing', () => {
    const service = build(providerWhereRetryEnds('succeeded'), reads, writes);
    const before = structuredClone(service.getRetryStrategies());

    const refused = service.updateRetryStrategy('no-such-strategy', { maxAttempts: 2 });

    expect(refused).toMatchObject({ code: 'payments.retry_strategy_not_found', data: { name: 'no-such-strategy' } });
    expect(service.getRetryStrategies()).toEqual(before);
  });

  it('more than MAX_BATCH_ITEMS strategies, or delays in one, are payments.configuration_invalid', () => {
    const many = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, index) => ({ ...oneRetryNow, name: `s${index}` }));
    const manyDelays = { ...oneRetryNow, delayMinutes: Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => 1) };

    expect(PaymentRetryService.create(providerWhereRetryEnds('succeeded'), reads, writes, many)).toMatchObject({
      code: 'payments.configuration_invalid',
    });
    expect(PaymentRetryService.create(providerWhereRetryEnds('succeeded'), reads, writes, [manyDelays])).toMatchObject({
      code: 'payments.configuration_invalid',
    });
  });
});
