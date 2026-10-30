// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
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
import { adminId, core, countEvents, eventTypesOf, openDb, planId, rejectionOf, typed } from '../../test-support.js';
import { PlanInactive, SubscriptionAlreadyActive, SubscriptionInvalidState } from '../failures.js';
import { createPlanId, createSubscriptionId } from '../primitives.js';
import { CardDeclined, IdempotencyConflict, ReferenceNotFound } from '../providers/provider-error.js';
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

/** The call must return this failure, must not reach the provider, and must leave the journal and the row alone. */
async function expectRefused(attempt: () => Promise<unknown>, refusal: object, subscriptionId: SubscriptionId) {
  const eventsBefore = await countEvents(db);
  const rowBefore = await subscriptionRow(db, subscriptionId);
  const callsBefore = providerCalls;

  const result = await attempt();

  expect(result).toMatchObject(refusal);
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

    await orThrow(manager.cancelSubscription(id, { immediately: true }));

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'canceled', canceledAt });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual(['SubscriptionCreated', 'SubscriptionCanceled']);
  });

  it('a subscription that is already canceled is refused before the provider is asked, and nothing is written', async () => {
    const { id } = await seedSubscription(writes, 'canceled');
    const manager = managerWith(current => ({ ...current, status: 'canceled' }));

    await expectRefused(
      () => manager.cancelSubscription(id),
      { code: 'payments.subscription_invalid_state', data: { status: 'canceled', action: 'cancel' } },
      id,
    );
  });
});

describe('updateSubscription', () => {
  it('stores the plan the provider moved the subscription to, and records one event', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const premium = orThrow(createPlanId());
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
    const premium = orThrow(createPlanId());
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
      await orThrow(
        managerWith(current => ({ ...current, cancelAtPeriodEnd })).setCancelAtPeriodEnd(id, cancelAtPeriodEnd),
      );

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
      { code: 'payments.subscription_invalid_state', data: { status: 'canceled', action: 'set_cancel_at_period_end' } },
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
      { code: 'payments.subscription_invalid_state', data: { status: 'active', action: 'reactivate' } },
      id,
    );
  });
});

describe('pauseSubscription and resumeSubscription', () => {
  it('a pause and a resume each store the provider status and record one event', async () => {
    const { id } = await seedSubscription(writes, 'active');

    await orThrow(managerWith(current => ({ ...current, status: 'paused' })).pauseSubscription(id));

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'paused' });

    await orThrow(managerWith(current => ({ ...current, status: 'active' })).resumeSubscription(id));

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
    await orThrow(manager.pauseSubscription(id));

    await expectRefused(
      () => manager.pauseSubscription(id),
      { code: 'payments.subscription_invalid_state', data: { status: 'paused', action: 'pause' } },
      id,
    );
  });

  it('only a paused subscription can be resumed: an active one is refused, nothing written', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const manager = managerWith(current => ({ ...current, status: 'active' }));

    await expectRefused(
      () => manager.resumeSubscription(id),
      { code: 'payments.subscription_invalid_state', data: { status: 'active', action: 'resume' } },
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
    await orThrow(manager.syncSubscriptionWithProvider(id));

    expect(await countEvents(db)).toBe(eventsBefore);
  });
});

/** A refusal the provider returns is final: the manager hands it back unchanged and writes no row and no event. */
describe('a failure the provider returns is handed back, and nothing is written', () => {
  const missing = (id: SubscriptionId) => ReferenceNotFound({ kind: 'subscription', id, missing: 'row' });

  const calls = {
    cancelSubscription: (manager: SubscriptionManager, id: SubscriptionId) => manager.cancelSubscription(id),
    setCancelAtPeriodEnd: (manager: SubscriptionManager, id: SubscriptionId) =>
      manager.setCancelAtPeriodEnd(id, true),
  };

  it.each(Object.entries(calls))('%s returns the provider ReferenceNotFound', async (_name, call) => {
    const { id } = await seedSubscription(writes, 'active');
    const rowBefore = await subscriptionRow(db, id);
    const eventsBefore = await countEvents(db);
    const manager = new SubscriptionManager(
      {
        ...providerReporting(current => current),
        cancelSubscription: () => Promise.resolve(missing(id)),
        updateSubscription: () => Promise.resolve(missing(id)),
      },
      reads,
      writes,
    );

    const result = await call(manager, id);

    expect(ReferenceNotFound.is(result)).toBe(true);
    expect(await subscriptionRow(db, id)).toEqual(rowBefore);
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it.each([
    ['reactivateSubscription', 'canceled'],
    ['pauseSubscription', 'active'],
    ['resumeSubscription', 'paused'],
  ] as const)('%s returns the provider failure', async (name, status) => {
    const { id } = await seedSubscription(writes, status);
    const rowBefore = await subscriptionRow(db, id);
    const eventsBefore = await countEvents(db);
    const manager = new SubscriptionManager(
      { ...providerReporting(current => current), [name]: () => Promise.resolve(missing(id)) },
      reads,
      writes,
    );

    const result = await manager[name](id);

    expect(ReferenceNotFound.is(result)).toBe(true);
    expect(await subscriptionRow(db, id)).toEqual(rowBefore);
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('cancelSubscription returns a reused idempotency key as IdempotencyConflict', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const manager = new SubscriptionManager(
      { ...providerReporting(current => current), cancelSubscription: () => Promise.resolve(IdempotencyConflict()) },
      reads,
      writes,
    );

    expect(IdempotencyConflict.is(await manager.cancelSubscription(id))).toBe(true);
  });

  it('createSubscription returns the provider CardDeclined unchanged when the user has no active subscription', async () => {
    const { userId } = await seedSubscription(writes, 'canceled');
    const manager = new SubscriptionManager(
      {
        ...providerReporting(current => current),
        createSubscription: () => Promise.resolve(CardDeclined({ providerCode: 'card_declined' })),
      },
      { ...reads, findActiveSubscriptionByUserId: () => Promise.resolve(null) },
      writes,
    );

    expect(CardDeclined.is(await manager.createSubscription(userId, planId))).toBe(true);
  });

  it('previewSubscriptionChange returns the provider ReferenceNotFound unchanged', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const premium = orThrow(createPlanId());
    await db.insert(core.plans).values({ id: premium, name: 'Premium preview', priceMinor: 2000 });
    const manager = new SubscriptionManager(
      {
        ...providerReporting(current => current),
        previewSubscriptionChange: () => Promise.resolve(missing(id)),
      },
      reads,
      writes,
    );

    expect(ReferenceNotFound.is(await manager.previewSubscriptionChange(id, premium))).toBe(true);
  });
});

/** A refusal the manager decides itself is returned with its code before the provider is asked. */
describe('the manager returns its own refusals as failures', () => {
  it('updateSubscription refuses a subscription that is not active, and a plan that is not offered', async () => {
    const paused = await seedSubscription(writes, 'paused');
    const manager = managerWith(current => current);

    await expectRefused(
      () => manager.updateSubscription(paused.id, planId),
      {
        code: 'payments.subscription_invalid_state',
        data: { subscriptionId: paused.id, status: 'paused', action: 'update' },
      },
      paused.id,
    );

    const active = await seedSubscription(writes, 'active');
    const retired = orThrow(createPlanId());
    await db.insert(core.plans).values({ id: retired, name: 'Retired', priceMinor: 500, isActive: false });

    await expectRefused(
      () => manager.updateSubscription(active.id, retired),
      { code: 'payments.plan_inactive', data: { planId: retired } },
      active.id,
    );
    expect(PlanInactive.is(await manager.previewSubscriptionChange(active.id, retired))).toBe(true);
  });

  it('an unknown subscription is ReferenceNotFound for every change, and nothing reaches the provider', async () => {
    const unknown = orThrow(createSubscriptionId());
    const manager = managerWith(current => current);
    const callsBefore = providerCalls;

    for (const result of [
      await manager.updateSubscription(unknown, planId),
      await manager.setCancelAtPeriodEnd(unknown, true),
      await manager.cancelSubscription(unknown),
      await manager.reactivateSubscription(unknown),
      await manager.pauseSubscription(unknown),
      await manager.resumeSubscription(unknown),
      await manager.previewSubscriptionChange(unknown, planId),
      await manager.syncSubscriptionWithProvider(unknown),
    ]) {
      expect(result).toMatchObject({
        code: 'payments.reference_not_found',
        data: { kind: 'subscription', id: unknown, missing: 'row' },
      });
    }
    expect(providerCalls).toBe(callsBefore);
  });

  it('syncSubscriptionWithProvider returns ReferenceNotFound with missing provider_id when the provider has no such subscription', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const eventsBefore = await countEvents(db);
    const manager = new SubscriptionManager(
      { ...providerReporting(current => current), getSubscription: () => Promise.resolve(null) },
      reads,
      writes,
    );

    expect(await manager.syncSubscriptionWithProvider(id)).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'subscription', id, missing: 'provider_id' },
    });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('createSubscription refuses a user with no customer, an unknown or retired plan, and a second active subscription', async () => {
    const manager = managerWith(current => current);
    const retired = orThrow(createPlanId());
    await db.insert(core.plans).values({ id: retired, name: 'Retired too', priceMinor: 500, isActive: false });
    const { userId, id: activeId } = await seedSubscription(writes, 'active');

    expect(await manager.createSubscription(adminId, planId)).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'customer', id: adminId, missing: 'row' },
    });
    expect(await manager.createSubscription(userId, orThrow(createPlanId()))).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'plan', missing: 'row' },
    });
    expect(PlanInactive.is(await manager.createSubscription(userId, retired))).toBe(true);

    const second = await new SubscriptionManager(
      providerReporting(current => current),
      {
        ...reads,
        findActiveSubscriptionByUserId: id =>
          reads.findSubscriptionById(activeId).then(row => (row?.userId === id ? row : null)),
      },
      writes,
    ).createSubscription(userId, planId);

    expect(SubscriptionAlreadyActive.is(second)).toBe(true);
    expect(second).toMatchObject({ data: { userId, subscriptionId: activeId } });
  });

  it('a provider that throws is not rewrapped: the caller gets the same error', async () => {
    const { id } = await seedSubscription(writes, 'active');
    const outage = new Error('provider is down');
    const manager = new SubscriptionManager(
      { ...providerReporting(current => current), cancelSubscription: () => Promise.reject(outage) },
      reads,
      writes,
    );

    expect(await rejectionOf(manager.cancelSubscription(id))).toBe(outage);

    const canceled = await seedSubscription(writes, 'canceled');
    expect(SubscriptionInvalidState.is(await manager.pauseSubscription(canceled.id))).toBe(true);
  });
});
