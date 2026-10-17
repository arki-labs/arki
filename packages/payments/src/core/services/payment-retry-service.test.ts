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

/** A decline is now returned, not thrown. The attempt must end exactly as it did when the provider threw. */
describe('a retry the card declines', () => {
  it('fails the attempt with the decline, and leaves the subscription and the journal alone', async () => {
    const subscription = await seedSubscription(writes, 'active');
    const payment = await seedPayment(writes, subscription.id);
    const declining: Provider = {
      confirmPayment: () => Promise.resolve(CardDeclined({ providerCode: 'card_declined' })),
    };
    const service = new PaymentRetryService(declining, reads, writes, [oneRetryNow]);
    await service.scheduleRetries(payment.id, 'card_declined');
    const eventsBefore = await countEvents(db);

    await service.processRetries();

    expect(service.getRetryAttempts(payment.id)).toMatchObject([
      { status: 'failed', failureReason: 'The card was declined (card_declined)' },
    ]);
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await subscriptionRow(db, subscription.id)).toMatchObject({ status: 'active' });
  });
});
