// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
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

import type { CommandConflict, CommandInvalid, CommandNotFound } from '@arki/journal';
import { instant } from '@arki/date';
import { isFailure, orThrow } from '@arki/failure';

import type { AppDb } from '../test-support.js';
import type { SyncSubscriptionInput } from './journal.js';
import type { SubscriptionId, SubscriptionStatus } from './types.js';
import { core, countEvents, customerId, eventTypesOf, meta, openDb, plain, planId, userId } from '../test-support.js';
import { createCustomerId, createPlanId, createSubscriptionId } from './primitives.js';

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
  const subscriptionId = orThrow(createSubscriptionId());
  await orThrow(
    journal.run(db, commands.createSubscription, { subscriptionId, ...delivery({ status, ...overrides }) }, meta),
  );

  return subscriptionId;
}

async function rowOf(subscriptionId: SubscriptionId) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));

  return row;
}

async function rowsOfProvider(providerSubscriptionId: string) {
  return db.select().from(subscriptions).where(eq(subscriptions.providerSubscriptionId, providerSubscriptionId));
}

/** The code of a refusal: a rule of a command said no. */
type RefusalCode = (CommandNotFound | CommandConflict | CommandInvalid)['code'];

/** The command must return the failure with this code and message, and must leave the journal and the row alone. */
async function expectRejected(
  attempt: () => Promise<unknown>,
  code: RefusalCode,
  message: string,
  subscriptionId?: SubscriptionId,
) {
  const eventsBefore = await countEvents(db);
  const rowBefore = subscriptionId ? await rowOf(subscriptionId) : undefined;

  const refused = await attempt();

  expect(isFailure(refused)).toBe(true);
  expect(refused).toMatchObject({ code, message });
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
    const subscriptionId = orThrow(createSubscriptionId());
    const input = delivery({ status: 'active', metadata: { taxAmount: 1.9, taxInclusive: false } });

    const result = await orThrow(journal.run(db, commands.createSubscription, { subscriptionId, ...input }, meta));

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

    const result = await orThrow(journal.run(db, commands.createSubscription, input, meta));

    expect(result.row?.id).toMatch(/^sub/);
    expect(await rowsOfProvider(input.providerSubscriptionId)).toHaveLength(1);
  });

  it('rejects a second create of the same id, so one subscription is never stored twice', async () => {
    const subscriptionId = await seed('active');

    await expectRejected(
      () => journal.run(db, commands.createSubscription, { subscriptionId, ...delivery() }, meta),
      'journal.conflict',
      `Subscription ${subscriptionId} already exists`,
      subscriptionId,
    );
  });
});

describe('cancelSubscription', () => {
  it('keeps the provider status and `cancelAtPeriodEnd` for a cancel at the end of the period (the old rule forced `canceled`)', async () => {
    const subscriptionId = await seed('active');
    const canceledAt = instant('2026-01-10T12:00:00.000Z');

    const result = await orThrow(
      journal.run(
        db,
        commands.cancelSubscription,
        { subscriptionId, status: 'active', canceledAt, cancelAtPeriodEnd: true },
        meta,
      ),
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

    await orThrow(journal.run(db, commands.cancelSubscription, { subscriptionId, canceledAt }, meta));

    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'canceled', canceledAt, cancelAtPeriodEnd: false });
  });

  it('rejects a subscription that is not there', async () => {
    const subscriptionId = orThrow(createSubscriptionId());

    await expectRejected(
      () => journal.run(db, commands.cancelSubscription, { subscriptionId }, meta),
      'journal.not_found',
      `Subscription ${subscriptionId} not found`,
    );
  });

  it('rejects a second cancel, so `canceledAt` is not moved by a repeat', async () => {
    const subscriptionId = await seed('canceled', { canceledAt: periodStart });

    await expectRejected(
      () => journal.run(db, commands.cancelSubscription, { subscriptionId, canceledAt: periodEnd }, meta),
      'journal.conflict',
      `Subscription ${subscriptionId} is already canceled`,
      subscriptionId,
    );
  });
});

describe('reactivateSubscription', () => {
  it('clears the cancellation and stores the provider status', async () => {
    const subscriptionId = await seed('canceled', { canceledAt: periodStart, cancelAtPeriodEnd: true });

    const result = await orThrow(
      journal.run(db, commands.reactivateSubscription, { subscriptionId, status: 'trialing' }, meta),
    );

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionReactivated']);
    expect(await rowOf(subscriptionId)).toMatchObject({
      status: 'trialing',
      canceledAt: null,
      cancelAtPeriodEnd: false,
    });
  });

  it('also accepts a past due subscription, as the live service does (the old rule accepted only `canceled`)', async () => {
    const subscriptionId = await seed('past_due');

    await orThrow(journal.run(db, commands.reactivateSubscription, { subscriptionId }, meta));

    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'active' });
  });

  it('rejects an active subscription: there is nothing to reactivate', async () => {
    const subscriptionId = await seed('active');

    await expectRejected(
      () => journal.run(db, commands.reactivateSubscription, { subscriptionId }, meta),
      'journal.conflict',
      'Only canceled or past due subscriptions can be reactivated',
      subscriptionId,
    );
  });

  it('rejects a subscription that is not there', async () => {
    const subscriptionId = orThrow(createSubscriptionId());

    await expectRejected(
      () => journal.run(db, commands.reactivateSubscription, { subscriptionId }, meta),
      'journal.not_found',
      `Subscription ${subscriptionId} not found`,
    );
  });
});

describe('pauseSubscription and resumeSubscription', () => {
  it('pauses an active subscription and records it as its own event', async () => {
    const subscriptionId = await seed('active');

    const result = await orThrow(journal.run(db, commands.pauseSubscription, { subscriptionId }, meta));

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionPaused']);
    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'paused', version: 2 });
  });

  it('pauses a past due subscription, because dunning pauses after a failed payment', async () => {
    const subscriptionId = await seed('past_due');

    await orThrow(journal.run(db, commands.pauseSubscription, { subscriptionId }, meta));

    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'paused' });
  });

  it('rejects pausing a canceled subscription', async () => {
    const subscriptionId = await seed('canceled');

    await expectRejected(
      () => journal.run(db, commands.pauseSubscription, { subscriptionId }, meta),
      'journal.conflict',
      'Only active or past due subscriptions can be paused',
      subscriptionId,
    );
  });

  it('rejects pausing a subscription that is not there', async () => {
    const subscriptionId = orThrow(createSubscriptionId());

    await expectRejected(
      () => journal.run(db, commands.pauseSubscription, { subscriptionId }, meta),
      'journal.not_found',
      `Subscription ${subscriptionId} not found`,
    );
  });

  it('resumes a paused subscription with the status the provider reports', async () => {
    const subscriptionId = await seed('paused');

    const result = await orThrow(
      journal.run(db, commands.resumeSubscription, { subscriptionId, status: 'active' }, meta),
    );

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionResumed']);
    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'active' });
  });

  it('rejects resuming a subscription that is not paused', async () => {
    const subscriptionId = await seed('active');

    await expectRejected(
      () => journal.run(db, commands.resumeSubscription, { subscriptionId }, meta),
      'journal.conflict',
      'Only paused subscriptions can be resumed',
      subscriptionId,
    );
  });

  it('rejects resuming a subscription that is not there', async () => {
    const subscriptionId = orThrow(createSubscriptionId());

    await expectRejected(
      () => journal.run(db, commands.resumeSubscription, { subscriptionId }, meta),
      'journal.not_found',
      `Subscription ${subscriptionId} not found`,
    );
  });
});

describe('markSubscriptionPastDue and activateSubscription (dunning and payment retry)', () => {
  it('marks a subscription past due when a payment fails', async () => {
    const subscriptionId = await seed('active');

    const result = await orThrow(journal.run(db, commands.markSubscriptionPastDue, { subscriptionId }, meta));

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionPastDue']);
    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'past_due', version: 2 });
  });

  it('writes no event when the subscription is already past due, because dunning and retry both report it', async () => {
    const subscriptionId = await seed('past_due');
    const before = await countEvents(db);

    const result = await orThrow(journal.run(db, commands.markSubscriptionPastDue, { subscriptionId }, meta));

    expect(result.events).toEqual([]);
    expect(await countEvents(db)).toBe(before);
    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'past_due', version: 1 });
  });

  it('rejects marking a subscription that is not there', async () => {
    const subscriptionId = orThrow(createSubscriptionId());

    await expectRejected(
      () => journal.run(db, commands.markSubscriptionPastDue, { subscriptionId }, meta),
      'journal.not_found',
      `Subscription ${subscriptionId} not found`,
    );
  });

  it('rejects marking a canceled subscription past due: it has no payment left to chase', async () => {
    const subscriptionId = await seed('canceled');

    await expectRejected(
      () => journal.run(db, commands.markSubscriptionPastDue, { subscriptionId }, meta),
      'journal.conflict',
      `Subscription ${subscriptionId} is canceled, so it cannot be past due`,
      subscriptionId,
    );
  });

  it('activates a past due subscription when the retried payment goes through', async () => {
    const subscriptionId = await seed('past_due');

    const result = await orThrow(journal.run(db, commands.activateSubscription, { subscriptionId }, meta));

    expect(result.events.map(event => event.type)).toEqual(['SubscriptionActivated']);
    expect(await rowOf(subscriptionId)).toMatchObject({ status: 'active', version: 2 });
  });

  it('writes no event when the subscription is already active (the old rule threw), so a repeated recovery is safe', async () => {
    const subscriptionId = await seed('active');
    const before = await countEvents(db);

    const result = await orThrow(journal.run(db, commands.activateSubscription, { subscriptionId }, meta));

    expect(result.events).toEqual([]);
    expect(await countEvents(db)).toBe(before);
  });

  it('rejects activating a canceled subscription: a late payment must not bring it back', async () => {
    const subscriptionId = await seed('canceled');

    await expectRejected(
      () => journal.run(db, commands.activateSubscription, { subscriptionId }, meta),
      'journal.conflict',
      `Cannot activate canceled subscription ${subscriptionId}`,
      subscriptionId,
    );
  });

  it('rejects activating a subscription that is not there', async () => {
    const subscriptionId = orThrow(createSubscriptionId());

    await expectRejected(
      () => journal.run(db, commands.activateSubscription, { subscriptionId }, meta),
      'journal.not_found',
      `Subscription ${subscriptionId} not found`,
    );
  });
});

describe('syncSubscription (webhooks and provider sync)', () => {
  it('creates the subscription on the first delivery', async () => {
    const input = delivery({ status: 'trialing', trialStart: periodStart, trialEnd: periodEnd, metadata: { a: '1' } });

    const result = await orThrow(journal.run(db, commands.syncSubscription, input, meta));

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
    const first = await orThrow(journal.run(db, commands.syncSubscription, input, meta));
    const before = await countEvents(db);

    // The same facts again, with the metadata keys in another order
    const second = await orThrow(
      journal.run(db, commands.syncSubscription, { ...input, metadata: { seats: 2, plan: 'pro' } }, meta),
    );

    expect(second.events).toEqual([]);
    expect(await countEvents(db)).toBe(before);
    expect(second.row).toEqual(first.row);
    expect(await rowsOfProvider(input.providerSubscriptionId)).toHaveLength(1);
  });

  it('writes one `SubscriptionSynced` with the whole provider snapshot when a delivery changes something', async () => {
    const input = delivery({ metadata: { plan: 'pro' } });
    const first = await orThrow(journal.run(db, commands.syncSubscription, input, meta));
    const subscriptionId = first.row?.id ?? orThrow(createSubscriptionId());
    const renewedUntil = instant('2026-03-01T00:00:00.000Z');

    // A renewal that goes past due. The delivery does not mention the metadata, so the row keeps it.
    const second = await orThrow(
      journal.run(
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
      ),
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
    await orThrow(journal.run(db, commands.syncSubscription, input, meta));
    const firstCanceledAt = instant('2026-01-20T10:00:00.000Z');
    const canceled = await orThrow(
      journal.run(db, commands.syncSubscription, { ...input, status: 'canceled', canceledAt: firstCanceledAt }, meta),
    );
    expect(canceled.events.map(event => event.type)).toEqual(['SubscriptionSynced']);
    const before = await countEvents(db);

    const repeated = await orThrow(
      journal.run(
        db,
        commands.syncSubscription,
        { ...input, status: 'canceled', canceledAt: instant('2026-01-20T10:05:00.000Z') },
        meta,
      ),
    );

    expect(repeated.events).toEqual([]);
    expect(await countEvents(db)).toBe(before);
    expect(repeated.row).toMatchObject({ status: 'canceled', canceledAt: firstCanceledAt, version: 2 });
  });

  it('finds a subscription made by `createSubscription` by its provider id, so checkout and webhook share one row', async () => {
    const input = delivery({ status: 'incomplete' });
    const subscriptionId = orThrow(createSubscriptionId());
    await orThrow(journal.run(db, commands.createSubscription, { subscriptionId, ...input }, meta));

    const synced = await orThrow(journal.run(db, commands.syncSubscription, { ...input, status: 'active' }, meta));

    expect(synced.row?.id).toBe(subscriptionId);
    expect(await rowsOfProvider(input.providerSubscriptionId)).toHaveLength(1);
    expect(await eventTypesOf(db, 'subscription', subscriptionId)).toEqual([
      'SubscriptionCreated',
      'SubscriptionSynced',
    ]);
  });
});

describe('what the caller sends that the tables cannot hold is a typed failure, never a raw Postgres error', () => {
  const missingPlan = () => orThrow(createPlanId());
  const missingCustomer = () => orThrow(createCustomerId());

  it.each([
    ['createSubscription', commands.createSubscription],
    ['syncSubscription', commands.syncSubscription],
  ] as const)(
    '%s returns reference_not_found for a plan, customer or user with no row, and writes nothing',
    async (_name, command) => {
      const before = await countEvents(db);
      const plan = missingPlan();
      const customer = missingCustomer();

      expect(await journal.run(db, command, delivery({ planId: plan }), meta)).toMatchObject({
        code: 'payments.reference_not_found',
        data: { kind: 'plan', id: plan, missing: 'row' },
      });
      expect(await journal.run(db, command, delivery({ customerId: customer }), meta)).toMatchObject({
        code: 'payments.reference_not_found',
        data: { kind: 'customer', id: customer },
      });
      expect(await journal.run(db, command, delivery({ userId: 'usr_nobody' }), meta)).toMatchObject({
        code: 'payments.reference_not_found',
        data: { kind: 'user', id: 'usr_nobody' },
      });
      expect(await countEvents(db)).toBe(before);
    },
  );

  it('createSubscription returns journal.conflict for a provider subscription id that is already stored', async () => {
    const stored = delivery();
    await orThrow(journal.run(db, commands.createSubscription, stored, meta));
    const before = await countEvents(db);

    const second = await journal.run(
      db,
      commands.createSubscription,
      { ...stored, subscriptionId: orThrow(createSubscriptionId()) },
      meta,
    );

    expect(second).toMatchObject({ code: 'journal.conflict' });
    expect(await rowsOfProvider(stored.providerSubscriptionId)).toHaveLength(1);
    expect(await countEvents(db)).toBe(before);
  });

  it('changeSubscriptionPlan returns reference_not_found for a plan with no row', async () => {
    const subscriptionId = await seed('active');
    const plan = missingPlan();

    expect(
      await journal.run(db, commands.changeSubscriptionPlan, { subscriptionId, planId: plan }, meta),
    ).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'plan', id: plan },
    });
    expect(await rowOf(subscriptionId)).toMatchObject({ planId });
  });

  it.each([
    ['U+0000 in metadata', { metadata: { store: 'APP\u0000STORE' } }],
    ['U+0000 in a metadata key', { metadata: { 'st\u0000ore': 'APP_STORE' } }],
    ['U+0000 in the provider subscription id', { providerSubscriptionId: 'sub_\u0000' }],
    ['a provider subscription id past 255 characters', { providerSubscriptionId: 's'.repeat(256) }],
    ['a period end before year 1', { currentPeriodEnd: instant('-000100-01-01T00:00:00Z') }],
    ['a trial end after year 9999', { trialEnd: instant('+010000-01-01T00:00:00Z') }],
  ] as const)('syncSubscription refuses %s as schema.invalid_input', async (_what, overrides) => {
    const before = await countEvents(db);

    expect(await journal.run(db, commands.syncSubscription, delivery(overrides), meta)).toMatchObject({
      code: 'schema.invalid_input',
    });
    expect(await countEvents(db)).toBe(before);
  });
});

describe('a lone surrogate, which the jsonb event data refuses (22P02), is a typed failure and writes nothing', () => {
  const lone = 'a\uD800';

  it('syncSubscription and createSubscription refuse one in the provider subscription id or the stream id as schema.invalid_input', async () => {
    const before = await countEvents(db);

    expect(
      await journal.run(db, commands.syncSubscription, delivery({ providerSubscriptionId: `sub_${lone}` }), meta),
    ).toMatchObject({
      code: 'schema.invalid_input',
    });
    expect(
      await journal.run(db, commands.syncSubscription, delivery({ metadata: { store: lone } }), meta),
    ).toMatchObject({
      code: 'schema.invalid_input',
    });
    for (const refused of [
      journal.run(db, commands.createSubscription, { subscriptionId: `sub_${lone}`, ...delivery() }, meta),
      journal.run(db, commands.cancelSubscription, { subscriptionId: `sub_${lone}` }, meta),
      journal.run(db, commands.activateSubscription, { subscriptionId: `sub_${lone}` }, meta),
    ]) {
      expect(await refused).toMatchObject({ code: 'schema.invalid_input' });
    }
    expect(await countEvents(db)).toBe(before);
  });

  it('answers a plan id holding one as reference_not_found, as no row holds it', async () => {
    const before = await countEvents(db);

    expect(await journal.run(db, commands.syncSubscription, delivery({ planId: `plan_${lone}` }), meta)).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'plan' },
    });
    expect(await countEvents(db)).toBe(before);
  });
});

describe('a whole subscription life', () => {
  it('replays from its events to the stored row, so the journal can rebuild or repair the table', async () => {
    const input = delivery({ status: 'trialing', trialStart: periodStart, trialEnd: periodEnd, metadata: { a: 1 } });
    const subscriptionId = orThrow(createSubscriptionId());
    await orThrow(journal.run(db, commands.createSubscription, { subscriptionId, ...input }, meta));
    await orThrow(journal.run(db, commands.syncSubscription, { ...input, status: 'active' }, meta));
    await orThrow(journal.run(db, commands.markSubscriptionPastDue, { subscriptionId }, meta));
    await orThrow(journal.run(db, commands.pauseSubscription, { subscriptionId }, meta));
    await orThrow(journal.run(db, commands.resumeSubscription, { subscriptionId, status: 'past_due' }, meta));
    await orThrow(journal.run(db, commands.activateSubscription, { subscriptionId }, meta));
    await orThrow(journal.run(db, commands.cancelSubscription, { subscriptionId, canceledAt: periodEnd }, meta));
    await orThrow(journal.run(db, commands.reactivateSubscription, { subscriptionId }, meta));

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

describe('a subscription id no row can hold', () => {
  it('is schema.invalid_input for every command that reads a subscription stream, and writes nothing', async () => {
    const subscriptionId = 'sub_a\u0000b' as const;
    const before = await countEvents(db);

    for (const refused of [
      journal.run(db, commands.createSubscription, { subscriptionId, ...delivery() }, meta),
      journal.run(db, commands.cancelSubscription, { subscriptionId }, meta),
      journal.run(db, commands.reactivateSubscription, { subscriptionId }, meta),
      journal.run(db, commands.pauseSubscription, { subscriptionId }, meta),
      journal.run(db, commands.resumeSubscription, { subscriptionId }, meta),
      journal.run(db, commands.changeSubscriptionPlan, { subscriptionId, planId }, meta),
      journal.run(db, commands.setSubscriptionCancelAtPeriodEnd, { subscriptionId, cancelAtPeriodEnd: true }, meta),
      journal.run(db, commands.markSubscriptionPastDue, { subscriptionId }, meta),
      journal.run(db, commands.activateSubscription, { subscriptionId }, meta),
    ]) {
      expect(await refused).toMatchObject({ code: 'schema.invalid_input' });
    }
    expect(await countEvents(db)).toBe(before);
  });
});
