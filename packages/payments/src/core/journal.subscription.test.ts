/**
 * Subscriptions on the journal
 *
 * Flow: service → writes(run) → command rules → journal event → `subscriptions`
 *       row, in one transaction.
 *
 * These tests pin what the move to the journal must keep true: the row holds
 * what the payment provider reported (the package never invents a status), a
 * rejected request writes nothing, and a webhook delivered twice is one event.
 */
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CommandErrorCode } from '@arki/journal';
import { instant } from '@arki/date';
import { CommandError } from '@arki/journal';

import type { AppDb } from '../test-support.js';
import type { SyncSubscriptionInput } from './journal.js';
import type { SubscriptionId, SubscriptionStatus } from './types.js';
import {
  core,
  countEvents,
  customerId,
  eventTypesOf,
  meta,
  openDb,
  plain,
  planId,
  rejectionOf,
  userId,
} from '../test-support.js';
import { createSubscriptionId } from './primitives.js';

const { subscriptions } = core;
const { journal } = plain;
const { commands, entities } = plain.core;

let db: AppDb;
let client: PGlite;
let next = 0;

const periodStart = instant('2026-01-01T00:00:00.000Z');
const periodEnd = instant('2026-02-01T00:00:00.000Z');

/** What a provider reports for a new subscription. Each call names a new provider subscription. */
function delivery(overrides: Partial<SyncSubscriptionInput> = {}): SyncSubscriptionInput {
  next += 1;

  return {
    userId,
    planId,
    customerId,
    providerSubscriptionId: `psub_${next}`,
    status: 'active',
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    ...overrides,
  };
}

/** A stored subscription in the given provider status. */
async function seed(
  status: SubscriptionStatus,
  overrides: Partial<SyncSubscriptionInput> = {},
): Promise<SubscriptionId> {
  const subscriptionId = createSubscriptionId();
  await journal.run(db, commands.createSubscription, { subscriptionId, ...delivery({ status, ...overrides }) }, meta);

  return subscriptionId;
}

async function rowOf(subscriptionId: SubscriptionId) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));

  return row;
}

async function rowsOfProvider(providerSubscriptionId: string) {
  return db.select().from(subscriptions).where(eq(subscriptions.providerSubscriptionId, providerSubscriptionId));
}

/** The command must be rejected with this code and message, and must leave the journal and the row alone. */
async function expectRejected(
  attempt: () => Promise<unknown>,
  code: CommandErrorCode,
  message: string,
  subscriptionId?: SubscriptionId,
) {
  const eventsBefore = await countEvents(db);
  const rowBefore = subscriptionId ? await rowOf(subscriptionId) : undefined;

  const error = await rejectionOf(attempt());

  expect(error).toBeInstanceOf(CommandError);
  expect(error).toMatchObject({ code, message });
  expect(await countEvents(db)).toBe(eventsBefore);
  if (subscriptionId) {
    expect(await rowOf(subscriptionId)).toEqual(rowBefore);
  }
}

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

describe('createSubscription', () => {
  it('stores the status the provider reported, because the provider owns it (the old rule forced `incomplete`)', async () => {
    const subscriptionId = createSubscriptionId();
    const input = delivery({ status: 'active', metadata: { taxAmount: 1.9, taxInclusive: false } });

    const result = await journal.run(db, commands.createSubscription, { subscriptionId, ...input }, meta);

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionCreated']);
    expect(await rowOf(subscriptionId)).toMatchObject({
      id: subscriptionId,
      userId,
      planId,
      customerId,
      providerSubscriptionId: input.providerSubscriptionId,
      status: 'active',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      trialStart: null,
      trialEnd: null,
      canceledAt: null,
      cancelAtPeriodEnd: false,
      metadata: { taxAmount: 1.9, taxInclusive: false },
      version: 1,
    });
    expect(await eventTypesOf(db, 'subscription', subscriptionId)).toEqual(['SubscriptionCreated']);
  });

  it('keeps the trial dates and the `trialing` status of a subscription that starts with a trial', async () => {
    const trialEnd = instant('2026-01-15T00:00:00.000Z');
    const subscriptionId = await seed('trialing', { trialStart: periodStart, trialEnd });

    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'trialing', trialStart: periodStart, trialEnd });
  });

  it('makes an id when the caller has none, so the router need not build one', async () => {
    const input = delivery();

    const result = await journal.run(db, commands.createSubscription, input, meta);

    expect(result.row?.id).toMatch(/^sub/);
    expect(await rowsOfProvider(input.providerSubscriptionId)).toHaveLength(1);
  });

  it('rejects a second create of the same id, so one subscription is never stored twice', async () => {
    const subscriptionId = await seed('active');

    await expectRejected(
      () => journal.run(db, commands.createSubscription, { subscriptionId, ...delivery() }, meta),
      'CONFLICT',
      `Subscription ${subscriptionId} already exists`,
      subscriptionId,
    );
  });
});

describe('cancelSubscription', () => {
  it('keeps the provider status and `cancelAtPeriodEnd` for a cancel at the end of the period (the old rule forced `canceled`)', async () => {
    const subscriptionId = await seed('active');
    const canceledAt = instant('2026-01-10T12:00:00.000Z');

    const result = await journal.run(
      db,
      commands.cancelSubscription,
      { subscriptionId, status: 'active', canceledAt, cancelAtPeriodEnd: true },
      meta,
    );

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionCanceled']);
    expect(await rowOf(subscriptionId)).toMatchObject({
      status: 'active',
      canceledAt,
      cancelAtPeriodEnd: true,
      version: 2,
    });
  });

  it('cancels at once with status `canceled` when the provider says so (the dunning cancel)', async () => {
    const subscriptionId = await seed('past_due');
    const canceledAt = instant('2026-01-11T00:00:00.000Z');

    await journal.run(db, commands.cancelSubscription, { subscriptionId, canceledAt }, meta);

    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'canceled', canceledAt, cancelAtPeriodEnd: false });
  });

  it('rejects a subscription that is not there', async () => {
    const subscriptionId = createSubscriptionId();

    await expectRejected(
      () => journal.run(db, commands.cancelSubscription, { subscriptionId }, meta),
      'NOT_FOUND',
      `Subscription ${subscriptionId} not found`,
    );
  });

  it('rejects a second cancel, so `canceledAt` is not moved by a repeat', async () => {
    const subscriptionId = await seed('canceled', { canceledAt: periodStart });

    await expectRejected(
      () => journal.run(db, commands.cancelSubscription, { subscriptionId, canceledAt: periodEnd }, meta),
      'CONFLICT',
      `Subscription ${subscriptionId} is already canceled`,
      subscriptionId,
    );
  });
});

describe('reactivateSubscription', () => {
  it('clears the cancellation and stores the provider status', async () => {
    const subscriptionId = await seed('canceled', { canceledAt: periodStart, cancelAtPeriodEnd: true });

    const result = await journal.run(db, commands.reactivateSubscription, { subscriptionId, status: 'trialing' }, meta);

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionReactivated']);
    expect(await rowOf(subscriptionId)).toMatchObject({
      status: 'trialing',
      canceledAt: null,
      cancelAtPeriodEnd: false,
    });
  });

  it('also accepts a past due subscription, as the live service does (the old rule accepted only `canceled`)', async () => {
    const subscriptionId = await seed('past_due');

    await journal.run(db, commands.reactivateSubscription, { subscriptionId }, meta);

    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'active' });
  });

  it('rejects an active subscription: there is nothing to reactivate', async () => {
    const subscriptionId = await seed('active');

    await expectRejected(
      () => journal.run(db, commands.reactivateSubscription, { subscriptionId }, meta),
      'CONFLICT',
      'Only canceled or past due subscriptions can be reactivated',
      subscriptionId,
    );
  });

  it('rejects a subscription that is not there', async () => {
    const subscriptionId = createSubscriptionId();

    await expectRejected(
      () => journal.run(db, commands.reactivateSubscription, { subscriptionId }, meta),
      'NOT_FOUND',
      `Subscription ${subscriptionId} not found`,
    );
  });
});

describe('pauseSubscription and resumeSubscription', () => {
  it('pauses an active subscription and records it as its own event', async () => {
    const subscriptionId = await seed('active');

    const result = await journal.run(db, commands.pauseSubscription, { subscriptionId }, meta);

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionPaused']);
    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'paused', version: 2 });
  });

  it('pauses a past due subscription, because dunning pauses after a failed payment', async () => {
    const subscriptionId = await seed('past_due');

    await journal.run(db, commands.pauseSubscription, { subscriptionId }, meta);

    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'paused' });
  });

  it('rejects pausing a canceled subscription', async () => {
    const subscriptionId = await seed('canceled');

    await expectRejected(
      () => journal.run(db, commands.pauseSubscription, { subscriptionId }, meta),
      'CONFLICT',
      'Only active or past due subscriptions can be paused',
      subscriptionId,
    );
  });

  it('rejects pausing a subscription that is not there', async () => {
    const subscriptionId = createSubscriptionId();

    await expectRejected(
      () => journal.run(db, commands.pauseSubscription, { subscriptionId }, meta),
      'NOT_FOUND',
      `Subscription ${subscriptionId} not found`,
    );
  });

  it('resumes a paused subscription with the status the provider reports', async () => {
    const subscriptionId = await seed('paused');

    const result = await journal.run(db, commands.resumeSubscription, { subscriptionId, status: 'active' }, meta);

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionResumed']);
    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'active' });
  });

  it('rejects resuming a subscription that is not paused', async () => {
    const subscriptionId = await seed('active');

    await expectRejected(
      () => journal.run(db, commands.resumeSubscription, { subscriptionId }, meta),
      'CONFLICT',
      'Only paused subscriptions can be resumed',
      subscriptionId,
    );
  });

  it('rejects resuming a subscription that is not there', async () => {
    const subscriptionId = createSubscriptionId();

    await expectRejected(
      () => journal.run(db, commands.resumeSubscription, { subscriptionId }, meta),
      'NOT_FOUND',
      `Subscription ${subscriptionId} not found`,
    );
  });
});

describe('markSubscriptionPastDue and activateSubscription (dunning and payment retry)', () => {
  it('marks a subscription past due when a payment fails', async () => {
    const subscriptionId = await seed('active');

    const result = await journal.run(db, commands.markSubscriptionPastDue, { subscriptionId }, meta);

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionPastDue']);
    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'past_due', version: 2 });
  });

  it('writes no event when the subscription is already past due, because dunning and retry both report it', async () => {
    const subscriptionId = await seed('past_due');
    const before = await countEvents(db);

    const result = await journal.run(db, commands.markSubscriptionPastDue, { subscriptionId }, meta);

    expect(result.events).toEqual([]);
    expect(await countEvents(db)).toBe(before);
    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'past_due', version: 1 });
  });

  it('rejects marking a subscription that is not there', async () => {
    const subscriptionId = createSubscriptionId();

    await expectRejected(
      () => journal.run(db, commands.markSubscriptionPastDue, { subscriptionId }, meta),
      'NOT_FOUND',
      `Subscription ${subscriptionId} not found`,
    );
  });

  it('activates a past due subscription when the retried payment goes through', async () => {
    const subscriptionId = await seed('past_due');

    const result = await journal.run(db, commands.activateSubscription, { subscriptionId }, meta);

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionActivated']);
    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'active', version: 2 });
  });

  it('writes no event when the subscription is already active (the old rule threw), so a repeated recovery is safe', async () => {
    const subscriptionId = await seed('active');
    const before = await countEvents(db);

    const result = await journal.run(db, commands.activateSubscription, { subscriptionId }, meta);

    expect(result.events).toEqual([]);
    expect(await countEvents(db)).toBe(before);
  });

  it('rejects activating a canceled subscription: a late payment must not bring it back', async () => {
    const subscriptionId = await seed('canceled');

    await expectRejected(
      () => journal.run(db, commands.activateSubscription, { subscriptionId }, meta),
      'CONFLICT',
      `Cannot activate canceled subscription ${subscriptionId}`,
      subscriptionId,
    );
  });

  it('rejects activating a subscription that is not there', async () => {
    const subscriptionId = createSubscriptionId();

    await expectRejected(
      () => journal.run(db, commands.activateSubscription, { subscriptionId }, meta),
      'NOT_FOUND',
      `Subscription ${subscriptionId} not found`,
    );
  });
});

describe('syncSubscription (webhooks and provider sync)', () => {
  it('creates the subscription on the first delivery', async () => {
    const input = delivery({ status: 'trialing', trialStart: periodStart, trialEnd: periodEnd, metadata: { a: '1' } });

    const result = await journal.run(db, commands.syncSubscription, input, meta);

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionCreated']);
    const rows = await rowsOfProvider(input.providerSubscriptionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'trialing',
      trialStart: periodStart,
      trialEnd: periodEnd,
      metadata: { a: '1' },
      version: 1,
    });
  });

  it('writes no event for an identical second delivery, because providers deliver webhooks more than once', async () => {
    const input = delivery({ metadata: { plan: 'pro', seats: 2 }, trialStart: null, canceledAt: null });
    const first = await journal.run(db, commands.syncSubscription, input, meta);
    const before = await countEvents(db);

    // The same facts again, with the metadata keys in another order
    const second = await journal.run(
      db,
      commands.syncSubscription,
      { ...input, metadata: { seats: 2, plan: 'pro' } },
      meta,
    );

    expect(second.events).toEqual([]);
    expect(await countEvents(db)).toBe(before);
    expect(second.row).toEqual(first.row);
    expect(await rowsOfProvider(input.providerSubscriptionId)).toHaveLength(1);
  });

  it('writes one `SubscriptionSynced` with the whole provider snapshot when a delivery changes something', async () => {
    const input = delivery({ metadata: { plan: 'pro' } });
    const first = await journal.run(db, commands.syncSubscription, input, meta);
    const subscriptionId = first.row?.id ?? createSubscriptionId();
    const renewedUntil = instant('2026-03-01T00:00:00.000Z');

    // A renewal that goes past due. The delivery does not mention the metadata, so the row keeps it.
    const second = await journal.run(
      db,
      commands.syncSubscription,
      {
        ...input,
        status: 'past_due',
        currentPeriodStart: periodEnd,
        currentPeriodEnd: renewedUntil,
        metadata: undefined,
      },
      meta,
    );

    expect(second.events.map(event => event.type)).toEqual(['SubscriptionSynced']);
    expect(second.events[0]?.data).toMatchObject({ status: 'past_due', metadata: { plan: 'pro' } });
    expect(await rowOf(subscriptionId)).toMatchObject({
      status: 'past_due',
      currentPeriodStart: periodEnd,
      currentPeriodEnd: renewedUntil,
      metadata: { plan: 'pro' },
      version: 2,
    });
    expect(await eventTypesOf(db, 'subscription', subscriptionId)).toEqual([
      'SubscriptionCreated',
      'SubscriptionSynced',
    ]);
  });

  it('writes no event when a provider repeats a cancellation with a new "now" (RevenueCat stamps every delivery)', async () => {
    const input = delivery();
    await journal.run(db, commands.syncSubscription, input, meta);
    const firstCanceledAt = instant('2026-01-20T10:00:00.000Z');
    const canceled = await journal.run(
      db,
      commands.syncSubscription,
      { ...input, status: 'canceled', canceledAt: firstCanceledAt },
      meta,
    );
    expect(canceled.events.map(event => event.type)).toEqual(['SubscriptionSynced']);
    const before = await countEvents(db);

    const repeated = await journal.run(
      db,
      commands.syncSubscription,
      { ...input, status: 'canceled', canceledAt: instant('2026-01-20T10:05:00.000Z') },
      meta,
    );

    expect(repeated.events).toEqual([]);
    expect(await countEvents(db)).toBe(before);
    expect(repeated.row).toMatchObject({ status: 'canceled', canceledAt: firstCanceledAt, version: 2 });
  });

  it('finds a subscription made by `createSubscription` by its provider id, so checkout and webhook share one row', async () => {
    const input = delivery({ status: 'incomplete' });
    const subscriptionId = createSubscriptionId();
    await journal.run(db, commands.createSubscription, { subscriptionId, ...input }, meta);

    const synced = await journal.run(db, commands.syncSubscription, { ...input, status: 'active' }, meta);

    expect(synced.row?.id).toBe(subscriptionId);
    expect(await rowsOfProvider(input.providerSubscriptionId)).toHaveLength(1);
    expect(await eventTypesOf(db, 'subscription', subscriptionId)).toEqual([
      'SubscriptionCreated',
      'SubscriptionSynced',
    ]);
  });
});

describe('a whole subscription life', () => {
  it('replays from its events to the stored row, so the journal can rebuild or repair the table', async () => {
    const input = delivery({ status: 'trialing', trialStart: periodStart, trialEnd: periodEnd, metadata: { a: 1 } });
    const subscriptionId = createSubscriptionId();
    await journal.run(db, commands.createSubscription, { subscriptionId, ...input }, meta);
    await journal.run(db, commands.syncSubscription, { ...input, status: 'active' }, meta);
    await journal.run(db, commands.markSubscriptionPastDue, { subscriptionId }, meta);
    await journal.run(db, commands.pauseSubscription, { subscriptionId }, meta);
    await journal.run(db, commands.resumeSubscription, { subscriptionId, status: 'past_due' }, meta);
    await journal.run(db, commands.activateSubscription, { subscriptionId }, meta);
    await journal.run(db, commands.cancelSubscription, { subscriptionId, canceledAt: periodEnd }, meta);
    await journal.run(db, commands.reactivateSubscription, { subscriptionId }, meta);

    expect(await eventTypesOf(db, 'subscription', subscriptionId)).toEqual([
      'SubscriptionCreated',
      'SubscriptionSynced',
      'SubscriptionPastDue',
      'SubscriptionPaused',
      'SubscriptionResumed',
      'SubscriptionActivated',
      'SubscriptionCanceled',
      'SubscriptionReactivated',
    ]);
    expect(await journal.verify(db, entities.subscription, subscriptionId)).toEqual({ ok: true });
    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'active', canceledAt: null, version: 8 });
  });
});
