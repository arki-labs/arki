/**
 * Payments on the journal, and the `writes(run)` functions of the core journal
 *
 * Flow: service → writes(run) → command rules → journal event → `payments`
 *       row, in one transaction.
 *
 * These tests pin three things. A payment moves only along its allowed path
 * and a rejected request writes nothing. Money in a `real` column comes back
 * the way the reducer said it would, so replay and the table agree. And the
 * plain functions the services call run the right command and never leak the
 * journal's `version` column.
 */
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import type { CommandErrorCode, CommandRunner } from '@arki/journal';
import { CommandError } from '@arki/journal';

import type { AppDb, AppTx } from '../test-support';
import type { CoreWrites } from './journal';
import type { PaymentId } from './types';
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
  schema,
  typed,
  userId,
} from '../test-support';
import { createCoreJournal } from './journal';
import { storedReal } from './journal/support';
import { createPaymentId, createSubscriptionId, paymentIdFactory, subscriptionIdFactory } from './primitives';

const { payments } = core;
const { journal } = plain;
const { commands, entities } = plain.core;

let db: AppDb;
let client: PGlite;
let next = 0;

/** The app's command runner, as a service gets it: here it runs on the test database. */
const run: Parameters<typeof plain.core.writes>[0] = (command, input) => journal.run(db, command, input, meta);

function intent(amount = 19.99) {
  next += 1;

  return { userId, customerId, providerPaymentId: `pi_${next}`, amount };
}

async function seed(): Promise<PaymentId> {
  const paymentId = createPaymentId();
  await journal.run(db, commands.initiatePayment, { paymentId, ...intent() }, meta);

  return paymentId;
}

async function rowOf(paymentId: PaymentId) {
  const [row] = await db.select().from(payments).where(eq(payments.id, paymentId));

  return row;
}

/** The command must be rejected with this code and message, and must leave the journal and the row alone. */
async function expectRejected(
  attempt: () => Promise<unknown>,
  code: CommandErrorCode,
  message: string,
  paymentId?: PaymentId,
) {
  const eventsBefore = await countEvents(db);
  const rowBefore = paymentId ? await rowOf(paymentId) : undefined;

  const error = await rejectionOf(attempt());

  expect(error).toBeInstanceOf(CommandError);
  expect(error).toMatchObject({ code, message });
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

    const result = await journal.run(db, commands.initiatePayment, { paymentId, ...input }, meta);

    expect(result.events.map(event => event.type)).toEqual(['PaymentInitiated']);
    expect(await rowOf(paymentId)).toMatchObject({
      id: paymentId,
      subscriptionId: null,
      userId,
      customerId,
      providerPaymentId: input.providerPaymentId,
      amount: 19.99,
      currency: 'USD',
      status: 'pending',
      paymentMethod: 'card',
      description: 'Pro plan',
      failureReason: null,
      receiptUrl: null,
      refunded: false,
      refundedAmount: 0,
      metadata: { taxAmount: 3.8, paymentIntentId: 'pi_x' },
      version: 1,
    });
  });

  it('makes an id when the caller has none', async () => {
    const result = await journal.run(db, commands.initiatePayment, intent(), meta);

    expect(result.row?.id).toMatch(/^pay/);
  });

  it('rejects a second initiate of the same id, so a retried request cannot reset a payment', async () => {
    const paymentId = await seed();

    await expectRejected(
      () => journal.run(db, commands.initiatePayment, { paymentId, ...intent() }, meta),
      'CONFLICT',
      `Payment ${paymentId} already exists with status pending`,
      paymentId,
    );
  });
});

describe('money in a `real` column', () => {
  it.each([0, 0.1, 19.99, 99_999.99, 999_999.99, 1_234_567.89, 16_777_217])(
    'storedReal(%d) is the number Postgres gives back, so the reducer and the table agree',
    async amount => {
      const [row] = await db
        .insert(payments)
        .values({ userId, customerId, providerPaymentId: `pi_real_${amount}`, amount })
        .returning({ amount: payments.amount });

      expect(storedReal(amount)).toBe(row?.amount);
    },
  );

  it('round-trips 19.99 exactly, and the payment replays to the stored row', async () => {
    const paymentId = createPaymentId();

    await journal.run(db, commands.initiatePayment, { paymentId, ...intent(19.99) }, meta);

    const row = await rowOf(paymentId);
    expect(row?.amount).toBe(19.99);
    expect(await journal.verify(db, entities.payment, paymentId)).toEqual({ ok: true });
  });

  it('accepts 1234567.89: the column keeps 1234567.9 (a 4-byte float), the event keeps the amount as given', async () => {
    const paymentId = createPaymentId();

    const result = await journal.run(db, commands.initiatePayment, { paymentId, ...intent(1_234_567.89) }, meta);

    expect(result.events[0]?.data).toMatchObject({ amount: 1_234_567.89 });
    const row = await rowOf(paymentId);
    expect(row?.amount).toBe(1_234_567.9);
    expect(await journal.verify(db, entities.payment, paymentId)).toEqual({ ok: true });
  });
});

describe('completePayment, failPayment and cancelPayment', () => {
  it('completes a pending payment and keeps the receipt', async () => {
    const paymentId = await seed();

    const result = await journal.run(
      db,
      commands.completePayment,
      { paymentId, receiptUrl: 'https://pay.example/r/1' },
      meta,
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
    await journal.run(db, commands.completePayment, { paymentId }, meta);

    await expectRejected(
      () => journal.run(db, commands.completePayment, { paymentId }, meta),
      'CONFLICT',
      'Cannot complete payment with status succeeded',
      paymentId,
    );
  });

  it('fails a pending payment and keeps the reason', async () => {
    const paymentId = await seed();

    const result = await journal.run(db, commands.failPayment, { paymentId, failureReason: 'card_declined' }, meta);

    expect(result.events.map(event => event.type)).toEqual(['PaymentFailed']);
    expect(await rowOf(paymentId)).toMatchObject({ status: 'failed', failureReason: 'card_declined', version: 2 });
  });

  it('rejects failing a payment that already succeeded: the money was taken', async () => {
    const paymentId = await seed();
    await journal.run(db, commands.completePayment, { paymentId }, meta);

    await expectRejected(
      () => journal.run(db, commands.failPayment, { paymentId, failureReason: 'late' }, meta),
      'CONFLICT',
      'Cannot fail payment with status succeeded',
      paymentId,
    );
  });

  it('cancels a pending payment', async () => {
    const paymentId = await seed();

    const result = await journal.run(db, commands.cancelPayment, { paymentId }, meta);

    expect(result.events.map(event => event.type)).toEqual(['PaymentCanceled']);
    expect(await rowOf(paymentId)).toMatchObject({ status: 'canceled', version: 2 });
  });

  it('rejects canceling a payment that is already settled', async () => {
    const paymentId = await seed();
    await journal.run(db, commands.failPayment, { paymentId, failureReason: 'card_declined' }, meta);

    await expectRejected(
      () => journal.run(db, commands.cancelPayment, { paymentId }, meta),
      'CONFLICT',
      'Cannot cancel payment with status failed',
      paymentId,
    );
  });

  it.each(['completePayment', 'failPayment', 'cancelPayment'] as const)(
    '%s rejects a payment that is not there',
    async name => {
      const paymentId = createPaymentId();
      const attempts = {
        completePayment: () => journal.run(db, commands.completePayment, { paymentId }, meta),
        failPayment: () => journal.run(db, commands.failPayment, { paymentId, failureReason: 'x' }, meta),
        cancelPayment: () => journal.run(db, commands.cancelPayment, { paymentId }, meta),
      };

      await expectRejected(attempts[name], 'NOT_FOUND', `Payment ${paymentId} not found`);
    },
  );
});

describe('writes(run): what the services call', () => {
  it('runs the payment commands and hands back rows without the journal `version`', async () => {
    const writes = plain.core.writes(run);
    const completed = createPaymentId();
    const failed = createPaymentId();
    const canceled = createPaymentId();

    const initiated = await writes.initiatePayment({ paymentId: completed, ...intent() });
    await writes.initiatePayment({ paymentId: failed, ...intent() });
    await writes.initiatePayment({ paymentId: canceled, ...intent() });

    expect(initiated).toMatchObject({ id: completed, status: 'pending' });
    expect(initiated).not.toHaveProperty('version');
    expect(await writes.completePayment({ paymentId: completed })).toMatchObject({ status: 'succeeded' });
    expect(await writes.failPayment({ paymentId: failed, failureReason: 'card_declined' })).toMatchObject({
      status: 'failed',
      failureReason: 'card_declined',
    });
    expect(await writes.cancelPayment({ paymentId: canceled })).toMatchObject({ status: 'canceled' });
    expect(await eventTypesOf(db, 'payment', completed)).toEqual(['PaymentInitiated', 'PaymentCompleted']);
    expect(await eventTypesOf(db, 'payment', failed)).toEqual(['PaymentInitiated', 'PaymentFailed']);
    expect(await eventTypesOf(db, 'payment', canceled)).toEqual(['PaymentInitiated', 'PaymentCanceled']);
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
      currentPeriodStart: new Date('2026-01-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-02-01T00:00:00.000Z'),
    };

    const created = await writes.createSubscription({ subscriptionId, ...delivery });
    expect(created).toMatchObject({ id: subscriptionId, status: 'active' });
    expect(created).not.toHaveProperty('version');

    expect(await writes.syncSubscription({ ...delivery, status: 'unpaid' })).toMatchObject({
      id: subscriptionId,
      status: 'unpaid',
    });
    expect(await writes.markSubscriptionPastDue({ subscriptionId })).toMatchObject({ status: 'past_due' });
    expect(await writes.pauseSubscription({ subscriptionId })).toMatchObject({ status: 'paused' });
    expect(await writes.resumeSubscription({ subscriptionId, status: 'past_due' })).toMatchObject({
      status: 'past_due',
    });
    expect(await writes.activateSubscription({ subscriptionId })).toMatchObject({ status: 'active' });
    expect(
      await writes.cancelSubscription({ subscriptionId, canceledAt: new Date('2026-01-20T00:00:00.000Z') }),
    ).toMatchObject({ status: 'canceled' });
    expect(await writes.reactivateSubscription({ subscriptionId })).toMatchObject({
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

  it('lets a rejected rule reach the service as a `CommandError`, so the app can map it to an API answer', async () => {
    const writes = plain.core.writes(run);
    const paymentId = createPaymentId();

    const error = await rejectionOf(writes.completePayment({ paymentId }));

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: `Payment ${paymentId} not found` });
  });
});

describe('types', () => {
  it('takes the journal definitions of an app (its own transaction and database types) and the untyped form', () => {
    // Both journals are built in `test-support.ts`; `tsc` checks that the factory accepts each `j`.
    expectTypeOf(typed.core.writes).parameter(0).toEqualTypeOf<CommandRunner<{ actorId: string }, AppTx>>();
    expectTypeOf(plain.core.writes).parameter(0).toEqualTypeOf<CommandRunner<{ actorId: string }>>();
    expectTypeOf(typed.core.writes).returns.toEqualTypeOf<CoreWrites>();
  });

  it('keeps `version` out of the rows the services get', () => {
    expectTypeOf<Awaited<ReturnType<CoreWrites['createSubscription']>>>().not.toHaveProperty('version');
    expectTypeOf<Awaited<ReturnType<CoreWrites['initiatePayment']>>>().not.toHaveProperty('version');
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
