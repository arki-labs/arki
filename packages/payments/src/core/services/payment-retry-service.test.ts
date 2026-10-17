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

import type { AppDb } from '../../test-support.js';
import type { CoreWrites } from '../journal.js';
import type { PaymentStatus, SubscriptionStatus } from '../types.js';
import type { RetryStrategy } from './payment-retry-service.js';
import { coreReads, runnerOn, seedPayment, seedSubscription, subscriptionRow } from '../../service-test-support.js';
import { countEvents, eventTypesOf, openDb, typed } from '../../test-support.js';
import { CardDeclined } from '../providers/provider-error.js';
import { PaymentRetryService } from './payment-retry-service.js';

type Provider = ConstructorParameters<typeof PaymentRetryService>[0];

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

/** Runs the one scheduled retry of a failed payment on a subscription in `status`. */
async function retryOn(status: SubscriptionStatus, retryStatus: PaymentStatus) {
  const subscription = await seedSubscription(writes, 'active');
  if (status === 'past_due') {
    await writes.markSubscriptionPastDue({ subscriptionId: subscription.id });
  }
  const payment = await seedPayment(writes, subscription.id);
  const service = new PaymentRetryService(providerWhereRetryEnds(retryStatus), reads, writes, [oneRetryNow]);

  await service.scheduleRetries(payment.id, 'card_declined');
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
    const service = new PaymentRetryService(declining, reads, writes, [strategy]);
    await service.scheduleRetries(payment.id, 'card_declined');
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
