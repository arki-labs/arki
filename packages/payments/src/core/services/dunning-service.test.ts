/**
 * DunningService on the journal
 *
 * Flow: DunningService → writes(run) → command → journal event →
 *       `subscriptions` row, in one transaction.
 *
 * Dunning is what happens after a payment fails: mark the subscription past
 * due, retry, pause, and in the end cancel. Each step changes what the customer
 * can use, so each step must leave an event. The schedule of steps stays in
 * memory, as before; only the table writes moved. A canceled subscription is
 * never brought back by a recovery: the command refuses it.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppDb } from '../../test-support';
import type { CoreWrites } from '../journal';
import type { Payment, PaymentStatus } from '../types';
import type { DunningRule } from './dunning-service';
import {
  coreReads,
  runnerOn,
  seedPayment,
  seedSubscription,
  subscriptionRow,
  unexpectedCall,
} from '../../service-test-support';
import { countEvents, eventTypesOf, openDb, rejectionOf, typed } from '../../test-support';
import { createPaymentId } from '../primitives';
import { PaymentsCommandError } from '../journal';
import { DunningService } from './dunning-service';

type Provider = ConstructorParameters<typeof DunningService>[0];

let db: AppDb;
let client: PGlite;
let reads: ReturnType<typeof coreReads>;
let writes: CoreWrites;

/** One rule that runs at once when a payment fails. */
function ruleDoing(type: DunningRule['action']['type']): DunningRule {
  return {
    id: `test_${type}`,
    name: `Test ${type}`,
    enabled: true,
    trigger: { event: 'payment_failed', delayDays: 0 },
    action: { type, config: {} },
  };
}

/** A provider where a retried payment ends in `retryStatus`, and pause and cancel go through. */
function providerWhereRetryEnds(retryStatus: PaymentStatus): Provider {
  const subscriptionAnswer = async (subscriptionId: Parameters<Provider['pauseSubscription']>[0]) => {
    const current = await reads.findSubscriptionById(subscriptionId);

    if (!current) {
      throw new Error(`the provider does not know ${subscriptionId}`);
    }

    return current;
  };

  return {
    async confirmPayment(paymentId): Promise<Payment> {
      const payment = await reads.findPaymentById(paymentId);

      if (!payment) {
        throw new Error(`the provider does not know ${paymentId}`);
      }

      return { ...payment, status: retryStatus };
    },
    pauseSubscription: subscriptionAnswer,
    cancelSubscription: subscriptionAnswer,
  };
}

function dunningWith(rule: DunningRule, retryStatus: PaymentStatus = 'succeeded') {
  return new DunningService(providerWhereRetryEnds(retryStatus), reads, writes, { rules: [rule] });
}

/** A subscription whose payment just failed, with dunning started. */
async function failedPaymentOn(service: DunningService) {
  const subscription = await seedSubscription(writes, 'active');
  const payment = await seedPayment(writes, subscription.id);
  await service.handlePaymentFailure(payment.id, subscription.id, 'card_declined');

  return subscription.id;
}

beforeAll(async () => {
  ({ db, client } = await openDb());
  reads = coreReads(db);
  writes = typed.core.writes(runnerOn(db));
});

afterAll(async () => {
  await client.close();
});

describe('handlePaymentFailure', () => {
  it('marks the subscription past due, records the event and schedules the steps', async () => {
    const service = dunningWith(ruleDoing('email'));

    const id = await failedPaymentOn(service);

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual(['SubscriptionCreated', 'SubscriptionPastDue']);
    expect(service.getPendingEventsForSubscription(id)).toHaveLength(1);
  });

  it('a second failed payment on a subscription that is already past due writes no second event', async () => {
    const service = dunningWith(ruleDoing('email'));
    const id = await failedPaymentOn(service);
    const secondPayment = await seedPayment(writes, id);
    const eventsBefore = await eventTypesOf(db, 'subscription', id);

    await service.handlePaymentFailure(secondPayment.id, id, 'card_declined');

    expect(await eventTypesOf(db, 'subscription', id)).toEqual(eventsBefore);
  });

  it('an unknown payment starts nothing: it throws and writes no event', async () => {
    const service = dunningWith(ruleDoing('email'));
    const { id } = await seedSubscription(writes, 'active');
    const eventsBefore = await countEvents(db);

    const error = await rejectionOf(service.handlePaymentFailure(createPaymentId(), id));

    expect(error).toMatchObject({ message: 'Payment or subscription not found' });
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active' });
  });
});

describe('processDunningEvents', () => {
  it('a retry that succeeds makes the subscription active again and clears the remaining steps', async () => {
    const service = dunningWith(ruleDoing('retry_payment'), 'succeeded');
    const id = await failedPaymentOn(service);

    await service.processDunningEvents();

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionPastDue',
      'SubscriptionActivated',
    ]);
    expect(service.getPendingEventsForSubscription(id)).toHaveLength(0);
  });

  it('a retry that fails again changes nothing: the subscription stays past due and no event is written', async () => {
    const service = dunningWith(ruleDoing('retry_payment'), 'failed');
    const id = await failedPaymentOn(service);
    const eventsBefore = await countEvents(db);

    await service.processDunningEvents();

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('the pause step pauses the subscription and records the event', async () => {
    const service = dunningWith(ruleDoing('pause_subscription'));
    const id = await failedPaymentOn(service);

    await service.processDunningEvents();

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'paused' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionPastDue',
      'SubscriptionPaused',
    ]);
  });

  it('the cancel step ends the subscription with a cancellation time and records the event', async () => {
    const service = dunningWith(ruleDoing('cancel_subscription'));
    const id = await failedPaymentOn(service);

    await service.processDunningEvents();

    const row = await subscriptionRow(db, id);
    expect(row).toMatchObject({ status: 'canceled' });
    expect(row?.canceledAt).toBeInstanceOf(Date);
    expect(await eventTypesOf(db, 'subscription', id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionPastDue',
      'SubscriptionCanceled',
    ]);
  });
});

describe('handleSubscriptionRecovery', () => {
  it('a past due subscription whose payment went through is active again, with the event', async () => {
    const service = dunningWith(ruleDoing('email'));
    const id = await failedPaymentOn(service);

    await service.handleSubscriptionRecovery(id);

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionPastDue',
      'SubscriptionActivated',
    ]);
    // The scheduled steps are gone. What is left is the in-memory note that the subscription recovered.
    expect(service.getPendingEventsForSubscription(id).map(event => event.eventType)).toEqual([
      'subscription_recovered',
    ]);
  });

  it('a subscription that is already active writes no event', async () => {
    const service = dunningWith(ruleDoing('email'));
    const { id } = await seedSubscription(writes, 'active');
    const eventsBefore = await countEvents(db);

    await service.handleSubscriptionRecovery(id);

    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('a canceled subscription is not brought back by a late payment: the command refuses and the row stays canceled', async () => {
    const service = dunningWith(ruleDoing('email'));
    const { id } = await seedSubscription(writes, 'canceled');
    const eventsBefore = await countEvents(db);

    const error = await rejectionOf(service.handleSubscriptionRecovery(id));

    expect(error).toBeInstanceOf(PaymentsCommandError);
    expect(error).toMatchObject({ code: 'CONFLICT', message: `Cannot activate canceled subscription ${id}` });
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'canceled' });
  });
});

describe('what dunning does not own', () => {
  it('the provider is only asked for what the configured step needs', async () => {
    const provider: Provider = {
      confirmPayment: unexpectedCall('confirmPayment'),
      pauseSubscription: unexpectedCall('pauseSubscription'),
      cancelSubscription: unexpectedCall('cancelSubscription'),
    };
    const service = new DunningService(provider, reads, writes, { rules: [ruleDoing('email')] });
    const id = await failedPaymentOn(service);
    const eventsBefore = await countEvents(db);

    await service.processDunningEvents();

    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
  });
});
