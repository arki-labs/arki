/**
 * Payments on the journal, and the `writes(run)` functions of the core journal
 *
 * Flow: service → writes(run) → command rules → journal event → `payments`
 *       row, in one transaction.
 *
 * These tests pin three things. A payment moves only along its allowed path
 * and a rejected request writes nothing. Money is stored as exact minor units,
 * and payments recorded before minor units (`PaymentInitiated`, a float) still
 * replay to the row the column migration wrote. And the
 * plain functions the services call run the right command and never leak the
 * journal's `version` column.
 */
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import type { FailureOf } from '@arki/failure';
import type { CommandConflict, CommandFailure, CommandInvalid, CommandRunner } from '@arki/journal';
import { instant } from '@arki/date';
import { InvalidInput, isFailure, orThrow } from '@arki/failure';
import { CommandNotFound } from '@arki/journal';

import type { AppDb, AppTx } from '../test-support.js';
import type { CoreWrites } from './journal.js';
import type { PaymentId } from './types.js';
import {
  core,
  countEvents,
  customerId,
  eventTypesOf,
  meta,
  openDb,
  plain,
  planId,
  schema,
  typed,
  userId,
} from '../test-support.js';
import { createCoreJournal } from './journal.js';
import { createPaymentId, createSubscriptionId, paymentIdFactory, subscriptionIdFactory } from './primitives.js';

const { payments } = core;
const { journal } = plain;
const { commands, entities } = plain.core;

let db: AppDb;
let client: PGlite;
let next = 0;

/** The app's command runner, as a service gets it: here it runs on the test database. */
const run: Parameters<typeof plain.core.writes>[0] = (command, input) => journal.run(db, command, input, meta);

/** Commands take `Money` JSON: the amount as exact text, with its currency. */
function intent(amount = '19.99', currency = 'USD') {
  next += 1;

  return { userId, customerId, providerPaymentId: `pi_${next}`, amount: { amount, currency } };
}

async function seed(): Promise<PaymentId> {
  const paymentId = createPaymentId();
  await orThrow(journal.run(db, commands.initiatePayment, { paymentId, ...intent() }, meta));

  return paymentId;
}

async function rowOf(paymentId: PaymentId) {
  const [row] = await db.select().from(payments).where(eq(payments.id, paymentId));

  return row;
}

/** The code of a refusal: a rule of a command said no. */
type RefusalCode = (CommandNotFound | CommandConflict | CommandInvalid)['code'];

/** The command must return the failure with this code and message, and must leave the journal and the row alone. */
async function expectRejected(
  attempt: () => Promise<unknown>,
  code: RefusalCode,
  message: string,
  paymentId?: PaymentId,
) {
  const eventsBefore = await countEvents(db);
  const rowBefore = paymentId ? await rowOf(paymentId) : undefined;

  const refused = await attempt();

  expect(isFailure(refused)).toBe(true);
  expect(refused).toMatchObject({ code, message });
  expect(await countEvents(db)).toBe(eventsBefore);
  if (paymentId) {
    expect(await rowOf(paymentId)).toEqual(rowBefore);
  }
}

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

describe('initiatePayment', () => {
  it('stores a pending payment and one event, as the checkout does today', async () => {
    const paymentId = createPaymentId();
    const input = { ...intent(), description: 'Pro plan', metadata: { taxAmount: 3.8, paymentIntentId: 'pi_x' } };

    const result = await orThrow(journal.run(db, commands.initiatePayment, { paymentId, ...input }, meta));

    expect(result.events.map(event => event.type)).toEqual(['PaymentInitiatedV2']);
    expect(await rowOf(paymentId)).toMatchObject({
      id: paymentId,
      subscriptionId: null,
      userId,
      customerId,
      providerPaymentId: input.providerPaymentId,
      amountMinor: 1999,
      currency: 'USD',
      status: 'pending',
      paymentMethod: 'card',
      description: 'Pro plan',
      failureReason: null,
      receiptUrl: null,
      refunded: false,
      refundedAmountMinor: 0,
      metadata: { taxAmount: 3.8, paymentIntentId: 'pi_x' },
      version: 1,
    });
  });

  it('makes an id when the caller has none', async () => {
    const result = await orThrow(journal.run(db, commands.initiatePayment, intent(), meta));

    expect(result.row?.id).toMatch(/^pay/);
  });

  it('rejects a second initiate of the same id, so a retried request cannot reset a payment', async () => {
    const paymentId = await seed();

    await expectRejected(
      () => journal.run(db, commands.initiatePayment, { paymentId, ...intent() }, meta),
      'journal.conflict',
      `Payment ${paymentId} already exists with status pending`,
      paymentId,
    );
  });
});

describe('money in minor-unit columns', () => {
  it('stores 19.99 USD as 1999 and the event keeps the exact text, so replay lands on the same row', async () => {
    const paymentId = createPaymentId();

    const result = await orThrow(journal.run(db, commands.initiatePayment, { paymentId, ...intent('19.99') }, meta));

    expect(result.events[0]?.data).toMatchObject({ amount: { amount: '19.99', currency: 'USD' } });
    expect(await rowOf(paymentId)).toMatchObject({ amountMinor: 1999, currency: 'USD' });
    expect(await journal.verify(db, entities.payment, paymentId)).toEqual({ ok: true });
  });

  it('keeps 1234567.89 to the cent: a 4-byte float column kept only 1234567.9', async () => {
    const paymentId = createPaymentId();

    await orThrow(journal.run(db, commands.initiatePayment, { paymentId, ...intent('1234567.89') }, meta));

    expect(await rowOf(paymentId)).toMatchObject({ amountMinor: 123_456_789 });
    expect(await journal.verify(db, entities.payment, paymentId)).toEqual({ ok: true });
  });
});

/** Records a payment the way the code before minor units did: a `PaymentInitiated` event with a float amount. */
async function recordOld(amount: number, currency: string): Promise<PaymentId> {
  const paymentId = createPaymentId();
  next += 1;
  const old = plain.core.events.PaymentInitiated({
    subscriptionId: null,
    userId,
    customerId,
    providerPaymentId: `pi_old_${next}`,
    amount,
    currency,
    paymentMethod: 'card',
    description: null,
    metadata: null,
  });
  await journal.write(db, entities.payment, paymentId, { meta, events: () => [old] });

  return paymentId;
}

/**
 * Payments recorded before minor units have a `PaymentInitiated` event whose
 * amount is a float of major units. Replay and repair run today's reducers on
 * them, so the old event must still decode and land on the row the column
 * migration wrote: the `real` value, rounded half-even to the currency.
 */
describe('a payment recorded before minor units (`PaymentInitiated`)', () => {
  it.each([
    [19.99, 'USD', 1999],
    [1000, 'JPY', 1000],
    [1.234, 'BHD', 1234],
    // The `real` column held 1234567.9, and the migration converted that
    [1_234_567.89, 'USD', 123_456_790],
    // Lower case from older rows still reads
    [5, 'eur', 500],
  ])('%d %s reduces to %d minor units and replays to the stored row', async (amount, currency, minor) => {
    const paymentId = await recordOld(amount, currency);

    expect(await rowOf(paymentId)).toMatchObject({ amountMinor: minor, currency, refundedAmountMinor: 0 });
    expect(await eventTypesOf(db, 'payment', paymentId)).toEqual(['PaymentInitiated']);
    expect(await journal.verify(db, entities.payment, paymentId)).toEqual({ ok: true });
  });

  it('keeps moving along its path after the change: an old payment can still complete', async () => {
    const paymentId = await recordOld(19.99, 'USD');

    await orThrow(journal.run(db, commands.completePayment, { paymentId, receiptUrl: null }, meta));

    expect(await rowOf(paymentId)).toMatchObject({ amountMinor: 1999, status: 'succeeded' });
    expect(await journal.verify(db, entities.payment, paymentId)).toEqual({ ok: true });
  });
});

describe('money with its currency', () => {
  it('stores a JPY payment in yen: 1000 JPY is 1000, not 10 or 100000', async () => {
    const paymentId = createPaymentId();

    const result = await orThrow(
      journal.run(db, commands.initiatePayment, { paymentId, ...intent('1000', 'JPY') }, meta),
    );

    expect(result.events[0]?.data).toMatchObject({ amount: { amount: '1000', currency: 'JPY' } });
    expect(await rowOf(paymentId)).toMatchObject({ amountMinor: 1000, currency: 'JPY' });
  });

  it('rejects a negative amount and writes nothing: a payment never moves money backwards', async () => {
    const paymentId = createPaymentId();

    const refused = await journal.run(db, commands.initiatePayment, { paymentId, ...intent('-1') }, meta);

    expect(InvalidInput.is(refused)).toBe(true);
    expect(refused).toMatchObject({
      data: { issues: [{ message: 'Amount must not be negative', path: ['amount'] }] },
    });
    expect(await rowOf(paymentId)).toBeUndefined();
  });
});

describe('completePayment, failPayment and cancelPayment', () => {
  it('completes a pending payment and keeps the receipt', async () => {
    const paymentId = await seed();

    const result = await orThrow(
      journal.run(db, commands.completePayment, { paymentId, receiptUrl: 'https://pay.example/r/1' }, meta),
    );

    expect(result.events.map(event => event.type)).toEqual(['PaymentCompleted']);
    expect(await rowOf(paymentId)).toMatchObject({
      status: 'succeeded',
      receiptUrl: 'https://pay.example/r/1',
      version: 2,
    });
  });

  it('rejects completing a payment twice, so a repeated webhook cannot rewrite a finished payment', async () => {
    const paymentId = await seed();
    await orThrow(journal.run(db, commands.completePayment, { paymentId }, meta));

    await expectRejected(
      () => journal.run(db, commands.completePayment, { paymentId }, meta),
      'journal.conflict',
      'Cannot complete payment with status succeeded',
      paymentId,
    );
  });

  it('fails a pending payment and keeps the reason', async () => {
    const paymentId = await seed();

    const result = await orThrow(
      journal.run(db, commands.failPayment, { paymentId, failureReason: 'card_declined' }, meta),
    );

    expect(result.events.map(event => event.type)).toEqual(['PaymentFailed']);
    expect(await rowOf(paymentId)).toMatchObject({ status: 'failed', failureReason: 'card_declined', version: 2 });
  });

  it('rejects failing a payment that already succeeded: the money was taken', async () => {
    const paymentId = await seed();
    await orThrow(journal.run(db, commands.completePayment, { paymentId }, meta));

    await expectRejected(
      () => journal.run(db, commands.failPayment, { paymentId, failureReason: 'late' }, meta),
      'journal.conflict',
      'Cannot fail payment with status succeeded',
      paymentId,
    );
  });

  it('cancels a pending payment', async () => {
    const paymentId = await seed();

    const result = await orThrow(journal.run(db, commands.cancelPayment, { paymentId }, meta));

    expect(result.events.map(event => event.type)).toEqual(['PaymentCanceled']);
    expect(await rowOf(paymentId)).toMatchObject({ status: 'canceled', version: 2 });
  });

  it('rejects canceling a payment that is already settled', async () => {
    const paymentId = await seed();
    await orThrow(journal.run(db, commands.failPayment, { paymentId, failureReason: 'card_declined' }, meta));

    await expectRejected(
      () => journal.run(db, commands.cancelPayment, { paymentId }, meta),
      'journal.conflict',
      'Cannot cancel payment with status failed',
      paymentId,
    );
  });

  it('completes a failed payment: the customer retried with the provider and the money was collected', async () => {
    const paymentId = await seed();
    await orThrow(journal.run(db, commands.failPayment, { paymentId, failureReason: 'card_declined' }, meta));

    const result = await orThrow(journal.run(db, commands.completePayment, { paymentId }, meta));

    expect(result.events.map(event => event.type)).toEqual(['PaymentCompleted']);
    expect(await rowOf(paymentId)).toMatchObject({ status: 'succeeded', version: 3 });
    expect(await eventTypesOf(db, 'payment', paymentId)).toEqual([
      'PaymentInitiatedV2',
      'PaymentFailed',
      'PaymentCompleted',
    ]);
  });

  it('marks a pending payment as waiting for the customer', async () => {
    const paymentId = await seed();

    const result = await orThrow(journal.run(db, commands.markPaymentRequiresAction, { paymentId }, meta));

    expect(result.events.map(event => event.type)).toEqual(['PaymentRequiresAction']);
    expect(await rowOf(paymentId)).toMatchObject({ status: 'requires_action', version: 2 });
  });

  it('a repeated requires-action writes nothing, so a resent webhook is safe', async () => {
    const paymentId = await seed();
    await orThrow(journal.run(db, commands.markPaymentRequiresAction, { paymentId }, meta));
    const eventsBefore = await countEvents(db);

    const result = await orThrow(journal.run(db, commands.markPaymentRequiresAction, { paymentId }, meta));

    expect(result.events).toEqual([]);
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await rowOf(paymentId)).toMatchObject({ status: 'requires_action', version: 2 });
  });

  it('completes a payment after the customer acted (3-D Secure passed)', async () => {
    const paymentId = await seed();
    await orThrow(journal.run(db, commands.markPaymentRequiresAction, { paymentId }, meta));

    await orThrow(journal.run(db, commands.completePayment, { paymentId }, meta));

    expect(await eventTypesOf(db, 'payment', paymentId)).toEqual([
      'PaymentInitiatedV2',
      'PaymentRequiresAction',
      'PaymentCompleted',
    ]);
    expect(await rowOf(paymentId)).toMatchObject({ status: 'succeeded' });
  });

  it('fails a payment after the customer action failed', async () => {
    const paymentId = await seed();
    await orThrow(journal.run(db, commands.markPaymentRequiresAction, { paymentId }, meta));

    await orThrow(journal.run(db, commands.failPayment, { paymentId, failureReason: 'authentication_failed' }, meta));

    expect(await rowOf(paymentId)).toMatchObject({ status: 'failed', failureReason: 'authentication_failed' });
  });

  it('rejects requires-action on a settled payment', async () => {
    const paymentId = await seed();
    await orThrow(journal.run(db, commands.completePayment, { paymentId }, meta));

    await expectRejected(
      () => journal.run(db, commands.markPaymentRequiresAction, { paymentId }, meta),
      'journal.conflict',
      'Cannot mark payment with status succeeded as requiring action',
      paymentId,
    );
  });

  it.each(['completePayment', 'failPayment', 'cancelPayment', 'markPaymentRequiresAction'] as const)(
    '%s rejects a payment that is not there',
    async name => {
      const paymentId = createPaymentId();
      const attempts = {
        completePayment: () => journal.run(db, commands.completePayment, { paymentId }, meta),
        failPayment: () => journal.run(db, commands.failPayment, { paymentId, failureReason: 'x' }, meta),
        cancelPayment: () => journal.run(db, commands.cancelPayment, { paymentId }, meta),
        markPaymentRequiresAction: () => journal.run(db, commands.markPaymentRequiresAction, { paymentId }, meta),
      };

      await expectRejected(attempts[name], 'journal.not_found', `Payment ${paymentId} not found`);
    },
  );
});

describe('writes(run): what the services call', () => {
  it('runs the payment commands and hands back rows without the journal `version`', async () => {
    const writes = plain.core.writes(run);
    const completed = createPaymentId();
    const failed = createPaymentId();
    const canceled = createPaymentId();

    const initiated = await orThrow(writes.initiatePayment({ paymentId: completed, ...intent() }));
    await orThrow(writes.initiatePayment({ paymentId: failed, ...intent() }));
    await orThrow(writes.initiatePayment({ paymentId: canceled, ...intent() }));

    expect(initiated).toMatchObject({ id: completed, status: 'pending' });
    expect(initiated).not.toHaveProperty('version');
    expect(await orThrow(writes.completePayment({ paymentId: completed }))).toMatchObject({ status: 'succeeded' });
    expect(await orThrow(writes.failPayment({ paymentId: failed, failureReason: 'card_declined' }))).toMatchObject({
      status: 'failed',
      failureReason: 'card_declined',
    });
    expect(await orThrow(writes.cancelPayment({ paymentId: canceled }))).toMatchObject({ status: 'canceled' });
    expect(await eventTypesOf(db, 'payment', completed)).toEqual(['PaymentInitiatedV2', 'PaymentCompleted']);
    expect(await eventTypesOf(db, 'payment', failed)).toEqual(['PaymentInitiatedV2', 'PaymentFailed']);
    expect(await eventTypesOf(db, 'payment', canceled)).toEqual(['PaymentInitiatedV2', 'PaymentCanceled']);
  });

  it('runs markPaymentRequiresAction and hands back the row without the journal `version`', async () => {
    const writes = plain.core.writes(run);
    const paymentId = createPaymentId();
    await orThrow(writes.initiatePayment({ paymentId, ...intent() }));

    const waiting = await orThrow(writes.markPaymentRequiresAction({ paymentId }));

    expect(waiting).toMatchObject({ id: paymentId, status: 'requires_action' });
    expect(waiting).not.toHaveProperty('version');
    expect(await eventTypesOf(db, 'payment', paymentId)).toEqual(['PaymentInitiatedV2', 'PaymentRequiresAction']);
  });

  it('runs the subscription commands, one event per call, in the order the services call them', async () => {
    const writes = plain.core.writes(run);
    const subscriptionId = createSubscriptionId();
    const delivery = {
      userId,
      planId,
      customerId,
      providerSubscriptionId: 'psub_writes',
      status: 'active' as const,
      currentPeriodStart: instant('2026-01-01T00:00:00.000Z'),
      currentPeriodEnd: instant('2026-02-01T00:00:00.000Z'),
    };

    const created = await orThrow(writes.createSubscription({ subscriptionId, ...delivery }));
    expect(created).toMatchObject({ id: subscriptionId, status: 'active' });
    expect(created).not.toHaveProperty('version');

    expect(await writes.syncSubscription({ ...delivery, status: 'unpaid' })).toMatchObject({
      id: subscriptionId,
      status: 'unpaid',
    });
    expect(await orThrow(writes.markSubscriptionPastDue({ subscriptionId }))).toMatchObject({ status: 'past_due' });
    expect(await orThrow(writes.pauseSubscription({ subscriptionId }))).toMatchObject({ status: 'paused' });
    expect(await orThrow(writes.resumeSubscription({ subscriptionId, status: 'past_due' }))).toMatchObject({
      status: 'past_due',
    });
    expect(await orThrow(writes.activateSubscription({ subscriptionId }))).toMatchObject({ status: 'active' });
    expect(
      await orThrow(writes.cancelSubscription({ subscriptionId, canceledAt: instant('2026-01-20T00:00:00.000Z') })),
    ).toMatchObject({ status: 'canceled' });
    expect(await orThrow(writes.reactivateSubscription({ subscriptionId }))).toMatchObject({
      status: 'active',
      canceledAt: null,
    });

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
  });

  it('returns a refused rule to the service as a failure, so the app can map it to an API answer', async () => {
    const writes = plain.core.writes(run);
    const paymentId = createPaymentId();

    const refused = await writes.completePayment({ paymentId });

    expect(CommandNotFound.is(refused)).toBe(true);
    expect(refused).toMatchObject({
      code: 'journal.not_found',
      status: 404,
      message: `Payment ${paymentId} not found`,
    });
  });
});

describe('types', () => {
  it('exposes owned command failures so callers cannot treat a refused sync as a stored subscription', () => {
    expectTypeOf<FailureOf<CoreWrites['syncSubscription']>>().toEqualTypeOf<CommandFailure>();
    expectTypeOf<FailureOf<CoreWrites['initiatePayment']>>().extract<CommandFailure>().toEqualTypeOf<CommandFailure>();
  });


  it('takes the journal definitions of an app (its own transaction and database types) and the untyped form', () => {
    // Both journals are built in `test-support.ts`; `tsc` checks that the factory accepts each `j`.
    expectTypeOf(typed.core.writes).parameter(0).toEqualTypeOf<CommandRunner<{ actorId: string }, AppTx>>();
    expectTypeOf(plain.core.writes).parameter(0).toEqualTypeOf<CommandRunner<{ actorId: string }>>();
    expectTypeOf(typed.core.writes).returns.toEqualTypeOf<CoreWrites>();
  });

  it('keeps `version` out of the rows the services get', () => {
    expectTypeOf<Awaited<ReturnType<CoreWrites['createSubscription']>>>().not.toHaveProperty('version');
    expectTypeOf<Awaited<ReturnType<CoreWrites['initiatePayment']>>>().not.toHaveProperty('version');
    expectTypeOf<Awaited<ReturnType<CoreWrites['markPaymentRequiresAction']>>>().not.toHaveProperty('version');
  });
});

/** Tables shaped like the ones an app had before the journal: no `version` column. */
const legacySubscriptions = schema.table('legacy_subscriptions', { id: subscriptionIdFactory.primaryColumn() });
const legacyPayments = schema.table('legacy_payments', { id: paymentIdFactory.primaryColumn() });

/** Never called: `tsc` checks it. An app that forgot the schema change must fail to compile, not fail at run time. */
function rejectsTablesWithoutVersion() {
  createCoreJournal(plain.j, {
    payments: core.payments,
    // @ts-expect-error -- a table without the `version` column cannot hold a journal entity
    subscriptions: legacySubscriptions,
  });
  createCoreJournal(plain.j, {
    // @ts-expect-error -- a table without the `version` column cannot hold a journal entity
    payments: legacyPayments,
    subscriptions: core.subscriptions,
  });
}
void rejectsTablesWithoutVersion;
