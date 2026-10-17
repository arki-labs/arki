/**
 * SubscriptionManager on the journal
 *
 * Flow: SubscriptionManager → provider call → writes(run) → command → journal
 *       event → `subscriptions` row, in one transaction.
 *
 * The manager asks the provider first and then stores what the provider
 * reported. These tests pin that every such change leaves an event next to the
 * row (so the history of a subscription is complete), and that a call the
 * manager refuses, or a sync that brings nothing new, writes no event.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant } from '@arki/date';
import { orThrow } from '@arki/failure';
import { Money } from '@arki/money';

import type { AppDb } from '../../test-support.js';
import type { CoreWrites } from '../journal.js';
import type { Subscription, SubscriptionId } from '../types.js';
import { coreReads, runnerOn, seedSubscription, subscriptionRow, unexpectedCall } from '../../service-test-support.js';
import { core, countEvents, eventTypesOf, openDb, planId, rejectionOf, typed } from '../../test-support.js';
import { createPlanId } from '../primitives.js';
import { CardDeclined } from '../providers/provider-error.js';
import { SubscriptionManager } from './subscription-manager.js';

type Provider = ConstructorParameters<typeof SubscriptionManager>[0];

let db: AppDb;
let client: PGlite;
let reads: ReturnType<typeof coreReads>;
let writes: CoreWrites;
let providerCalls = 0;

/** A provider that answers every subscription call with `report(what we hold)`. */
function providerReporting(report: (current: Subscription) => Subscription): Provider {
  const answer = async (subscriptionId: SubscriptionId) => {
    const current = await reads.findSubscriptionById(subscriptionId);

    if (!current) {
      throw new Error(`the provider does not know ${subscriptionId}`);
    }

    providerCalls += 1;

    return report(current);
  };

  return {
    createSubscription: unexpectedCall('createSubscription'),
    updateSubscription: answer,
    previewSubscriptionChange: () =>
      Promise.resolve({
        planId,
        proration: {
          immediateTotal: Money.zero('USD').toJSON(),
          nextInvoiceTotal: Money.zero('USD').toJSON(),
          creditApplied: Money.zero('USD').toJSON(),
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

function managerWith(report: (current: Subscription) => Subscription) {
  return new SubscriptionManager(providerReporting(report), reads, writes);
}

/** The call must fail with this message, must not reach the provider, and must leave the journal and the row alone. */
async function expectRefused(attempt: () => Promise<unknown>, message: string, subscriptionId: SubscriptionId) {
  const eventsBefore = await countEvents(db);
  const rowBefore = await subscriptionRow(db, subscriptionId);
  const callsBefore = providerCalls;

  const error = await rejectionOf(attempt());

  expect(error).toMatchObject({ message });
  expect(providerCalls).toBe(callsBefore);
  expect(await countEvents(db)).toBe(eventsBefore);
  expect(await subscriptionRow(db, subscriptionId)).toEqual(rowBefore);
}

beforeAll(async () => {
  ({ db, client } = await openDb());
  reads = coreReads(db);
  writes = typed.core.writes(runnerOn(db));
});

afterAll(async () => {
  await client.close();
});

describe('cancelSubscription', () => {
  it('a cancel at the end of the period stores what the provider reports: still active, flagged to end', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const canceledAt = instant('2026-01-20T10:00:00.000Z');
    const manager = managerWith(current => ({ ...current, status: 'active', canceledAt, cancelAtPeriodEnd: true }));

    const result = await manager.cancelSubscription(id);

    expect(result).toMatchObject({ id, status: 'active', cancelAtPeriodEnd: true });
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active', canceledAt, cancelAtPeriodEnd: true });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual(['SubscriptionCreated', 'SubscriptionCanceled']);
  });

  it('an immediate cancel ends the subscription now and records the event', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const canceledAt = instant('2026-01-21T10:00:00.000Z');
    const manager = managerWith(current => ({ ...current, status: 'canceled', canceledAt }));

    await manager.cancelSubscription(id, { immediately: true });

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'canceled', canceledAt });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual(['SubscriptionCreated', 'SubscriptionCanceled']);
  });

  it('a subscription that is already canceled is refused before the provider is asked, and nothing is written', async () => {
    const { id } = await seedSubscription(writes, 'canceled');
    const manager = managerWith(current => ({ ...current, status: 'canceled' }));

    await expectRefused(
      () => manager.cancelSubscription(id),
      'Failed to cancel subscription: Subscription is already canceled',
      id,
    );
  });
});

describe('updateSubscription', () => {
  it('stores the plan the provider moved the subscription to, and records one event', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const premium = createPlanId();
    await db.insert(core.plans).values({ id: premium, name: 'Premium', priceMinor: 2000 });
    const manager = managerWith(current => ({ ...current, planId: premium }));

    const result = await orThrow(manager.updateSubscription(id, premium));

    expect(result.subscription).toMatchObject({ id, planId: premium });
    expect(await subscriptionRow(db, id)).toMatchObject({ planId: premium });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual(['SubscriptionCreated', 'SubscriptionPlanChanged']);
  });

  /** The provider did not move the plan, so the row must not either: the caller gets the decline to show. */
  it('a plan change the card declines is returned as CardDeclined, and the row keeps its plan', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const premium = createPlanId();
    await db.insert(core.plans).values({ id: premium, name: 'Premium', priceMinor: 2000 });
    const rowBefore = await subscriptionRow(db, id);
    const eventsBefore = await countEvents(db);
    const manager = new SubscriptionManager(
      {
        ...providerReporting(current => current),
        updateSubscription: () => Promise.resolve(CardDeclined({ providerCode: 'card_declined' })),
      },
      reads,
      writes,
    );

    const result = await manager.updateSubscription(id, premium);

    expect(CardDeclined.is(result)).toBe(true);
    expect(await subscriptionRow(db, id)).toEqual(rowBefore);
    expect(await countEvents(db)).toBe(eventsBefore);
  });
});

describe('setCancelAtPeriodEnd', () => {
  it('sets and clears the flag with the provider, keeps the status, and records one event each time', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const flagged = async (cancelAtPeriodEnd: boolean) => {
      await managerWith(current => ({ ...current, cancelAtPeriodEnd })).setCancelAtPeriodEnd(id, cancelAtPeriodEnd);

      return subscriptionRow(db, id);
    };

    expect(await flagged(true)).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect(await flagged(false)).toMatchObject({ status: 'active', cancelAtPeriodEnd: false });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionCancelAtPeriodEndSet',
      'SubscriptionCancelAtPeriodEndSet',
    ]);
  });

  it('a canceled subscription is refused before the provider is asked, and nothing is written', async () => {
    const { id } = await seedSubscription(writes, 'canceled');
    const manager = managerWith(current => ({ ...current, cancelAtPeriodEnd: true }));

    await expectRefused(
      () => manager.setCancelAtPeriodEnd(id, true),
      'Failed to set cancel at period end: Subscription is already canceled',
      id,
    );
  });
});

describe('reactivateSubscription', () => {
  it('a canceled subscription comes back: the cancellation is cleared and the event is recorded', async () => {
    const { id } = await seedSubscription(writes, 'canceled');
    const manager = managerWith(current => ({ ...current, status: 'active' }));

    const result = await manager.reactivateSubscription(id);

    expect(result).toMatchObject({ id, status: 'active' });
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active', canceledAt: null, cancelAtPeriodEnd: false });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual(['SubscriptionCreated', 'SubscriptionReactivated']);
  });

  it('an active subscription has nothing to reactivate: refused, nothing written', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const manager = managerWith(current => ({ ...current, status: 'active' }));

    await expectRefused(
      () => manager.reactivateSubscription(id),
      'Failed to reactivate subscription: Only canceled or past due subscriptions can be reactivated',
      id,
    );
  });
});

describe('pauseSubscription and resumeSubscription', () => {
  it('a pause and a resume each store the provider status and record one event', async () => {
    const { id } = await seedSubscription(writes, 'active');

    await managerWith(current => ({ ...current, status: 'paused' })).pauseSubscription(id);

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'paused' });

    await managerWith(current => ({ ...current, status: 'active' })).resumeSubscription(id);

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionPaused',
      'SubscriptionResumed',
    ]);
  });

  it('only an active subscription can be paused: a paused one is refused, nothing written', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const manager = managerWith(current => ({ ...current, status: 'paused' }));
    await manager.pauseSubscription(id);

    await expectRefused(
      () => manager.pauseSubscription(id),
      'Failed to pause subscription: Only active subscriptions can be paused',
      id,
    );
  });

  it('only a paused subscription can be resumed: an active one is refused, nothing written', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const manager = managerWith(current => ({ ...current, status: 'active' }));

    await expectRefused(
      () => manager.resumeSubscription(id),
      'Failed to resume subscription: Only paused subscriptions can be resumed',
      id,
    );
  });
});

describe('syncSubscriptionWithProvider', () => {
  it('stores the provider snapshot once: a second sync with the same answer writes no event', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const currentPeriodEnd = instant('2026-03-01T00:00:00.000Z');
    const manager = managerWith(current => ({ ...current, status: 'past_due', currentPeriodEnd }));

    const synced = await manager.syncSubscriptionWithProvider(id);

    expect(synced).toMatchObject({ id, status: 'past_due', currentPeriodEnd });
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due', currentPeriodEnd });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual(['SubscriptionCreated', 'SubscriptionSynced']);

    const eventsBefore = await countEvents(db);
    await manager.syncSubscriptionWithProvider(id);

    expect(await countEvents(db)).toBe(eventsBefore);
  });
});
