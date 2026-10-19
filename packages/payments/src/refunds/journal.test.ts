/**
 * Refunds on the journal
 *
 * Flow: RefundService → writes(run) → command rules → journal event →
 *       `refunds` row, in one transaction.
 *
 * A refund moves money back, so its path is strict: requested → approved or
 * rejected → processing → completed or failed. These tests pin that a step out
 * of order is rejected and writes nothing, that amounts are stored as exact
 * minor units of the refund's currency (and refunds recorded before that still
 * replay), and that the provider's refund id arrives with completion (the live
 * service has it only then).
 *
 * This file runs on the typed journal, `initJournal.tx<AppTx>().db<AppDb>()`,
 * the form an app uses.
 */
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import type { Instant } from '@arki/date';
import type { FailureOf, SchemaFailure } from '@arki/failure';
import type { CommandConflict, CommandInvalid, CommandRunner } from '@arki/journal';
import { fromDate } from '@arki/date';
import { InvalidInput, isFailure, orThrow } from '@arki/failure';
import { CommandNotFound } from '@arki/journal';

import type { PaymentId } from '../core/types.js';
import type { AppDb, AppTx } from '../test-support.js';
import type { RefundWrites } from './journal.js';
import type { RefundId } from './primitives.js';
import { createPaymentId } from '../core/primitives.js';
import {
  adminId,
  countEvents,
  customerId,
  eventTypesOf,
  meta,
  openDb,
  plain,
  refundsTables,
  rejectionOf,
  schema,
  typed,
  userId,
} from '../test-support.js';
import { createRefundsJournal } from './journal.js';
import { createRefundId, refundIdFactory } from './primitives.js';

const { refunds } = refundsTables;
const { journal } = typed;
const { commands, entities } = typed.refunds;

let db: AppDb;
let client: PGlite;
let paymentId: PaymentId;

/** The app's command runner, as the service gets it: here it runs on the test database. */
const run: Parameters<typeof typed.refunds.writes>[0] = (command, input) => journal.run(db, command, input, meta);

/** The time the journal recorded for an event, as the `Instant` a reducer stores. */
const recordedAtOf = (event: { recordedAt: Date } | undefined): Instant | undefined =>
  event ? fromDate(event.recordedAt) : undefined;

/** Amounts go in as `Money` JSON: exact text with a currency. */
const usd = (amount: string) => ({ amount, currency: 'USD' });
const kwd = (amount: string) => ({ amount, currency: 'KWD' });

function request(
  overrides: {
    originalAmount?: { amount: string; currency: string };
    refundAmount?: { amount: string; currency: string };
  } = {},
) {
  return {
    paymentId,
    originalAmount: usd('100'),
    refundAmount: usd('25.50'),
    reason: 'customer_request' as const,
    requestedBy: userId,
    ...overrides,
  };
}

/** A refund moved along its path up to the given status. */
async function seed(status: 'pending' | 'approved' | 'processing' | 'completed' | 'rejected'): Promise<RefundId> {
  const refundId = createRefundId();
  await orThrow(journal.run(db, commands.requestRefund, { refundId, ...request() }, meta));

  if (status === 'rejected') {
    await orThrow(
      journal.run(db, commands.rejectRefund, { refundId, rejectedBy: adminId, rejectionReason: 'no' }, meta),
    );
  }
  if (status === 'approved' || status === 'processing' || status === 'completed') {
    await orThrow(journal.run(db, commands.approveRefund, { refundId, approvedBy: adminId }, meta));
  }
  if (status === 'processing' || status === 'completed') {
    await orThrow(journal.run(db, commands.processRefund, { refundId }, meta));
  }
  if (status === 'completed') {
    await orThrow(journal.run(db, commands.completeRefund, { refundId, providerRefundId: 're_seed' }, meta));
  }

  return refundId;
}

async function rowOf(refundId: RefundId) {
  const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId));

  return row;
}

/** The code of a refusal: a rule of a command said no. */
type RefusalCode = (CommandNotFound | CommandConflict | CommandInvalid)['code'];

/** The command must return the failure with this code and message, and must leave the journal and the row alone. */
async function expectRejected(
  attempt: () => Promise<unknown>,
  code: RefusalCode,
  message: string,
  refundId?: RefundId,
) {
  const eventsBefore = await countEvents(db);
  const rowBefore = refundId ? await rowOf(refundId) : undefined;

  const refused = await attempt();

  expect(isFailure(refused)).toBe(true);
  expect(refused).toMatchObject({ code, message });
  expect(await countEvents(db)).toBe(eventsBefore);
  if (refundId) {
    expect(await rowOf(refundId)).toEqual(rowBefore);
  }
}

/** A payment of 100 USD. At most one refund of a payment is pending at a time, so each test gets its own. */
let paymentCounter = 0;
async function freshPayment(): Promise<PaymentId> {
  paymentCounter += 1;
  const id = createPaymentId();
  await orThrow(
    journal.run(
      db,
      typed.core.commands.initiatePayment,
      { paymentId: id, userId, customerId, providerPaymentId: `pi_refunds_${paymentCounter}`, amount: usd('100') },
      meta,
    ),
  );

  return id;
}

beforeAll(async () => {
  ({ db, client } = await openDb());
});

beforeEach(async () => {
  paymentId = await freshPayment();
});

afterAll(async () => {
  await client.close();
});

describe('requestRefund', () => {
  it('stores a pending refund with amounts in minor units of its currency', async () => {
    const refundId = createRefundId();

    const result = await orThrow(
      journal.run(
        db,
        commands.requestRefund,
        { refundId, ...request(), customerNote: 'Changed my mind', metadata: '{}' },
        meta,
      ),
    );

    expect(result.events.map(event => event.type)).toEqual(['RefundRequestedV2']);
    const row = await rowOf(refundId);
    expect(row).toMatchObject({
      id: refundId,
      paymentId,
      originalAmountMinor: 10_000,
      refundAmountMinor: 2550,
      currency: 'USD',
      reason: 'customer_request',
      status: 'pending',
      providerRefundId: null,
      providerResponse: null,
      requestedBy: userId,
      approvedBy: null,
      rejectedBy: null,
      customerNote: 'Changed my mind',
      internalNotes: null,
      metadata: '{}',
      version: 1,
    });
    expect(row?.requestedAt).toEqual(recordedAtOf(result.events[0]));
  });

  it('makes an id when the caller has none', async () => {
    const result = await orThrow(journal.run(db, commands.requestRefund, request(), meta));

    expect(result.row?.id).toMatch(/^rfnd/);
  });

  it('rejects a second request with the same id', async () => {
    const refundId = await seed('pending');

    await expectRejected(
      () => journal.run(db, commands.requestRefund, { refundId, ...request() }, meta),
      'journal.conflict',
      `Refund ${refundId} already exists`,
      refundId,
    );
  });

  it('rejects a refund larger than the payment, so no more money goes back than came in', async () => {
    await expectRejected(
      () =>
        journal.run(
          db,
          commands.requestRefund,
          request({ originalAmount: usd('100'), refundAmount: usd('100.01') }),
          meta,
        ),
      'journal.invalid',
      'Refund amount (100.01 USD) cannot exceed original amount (100.00 USD)',
    );
  });

  it('rejects a refund of zero or less', async () => {
    await expectRejected(
      () => journal.run(db, commands.requestRefund, request({ refundAmount: usd('0') }), meta),
      'journal.invalid',
      'Refund amount must be positive',
    );
  });

  it('rejects a refund in another currency than the original: 25 EUR is not a part of 100 USD', async () => {
    await expectRejected(
      () => journal.run(db, commands.requestRefund, request({ refundAmount: { amount: '25', currency: 'EUR' } }), meta),
      'journal.invalid',
      'Refund currency (EUR) differs from the original currency (USD)',
    );
  });

  it('stores a JPY refund in yen, never multiplied or divided by 100', async () => {
    const refundId = createRefundId();

    await orThrow(
      journal.run(
        db,
        commands.requestRefund,
        {
          refundId,
          ...request({
            originalAmount: { amount: '5000', currency: 'JPY' },
            refundAmount: { amount: '1500', currency: 'JPY' },
          }),
        },
        meta,
      ),
    );

    expect(await rowOf(refundId)).toMatchObject({
      originalAmountMinor: 5000,
      refundAmountMinor: 1500,
      currency: 'JPY',
    });
  });

  it('stores a KWD refund to the fils: three decimals, which a two-decimal column used to cut', async () => {
    const refundId = createRefundId();

    await orThrow(
      journal.run(
        db,
        commands.requestRefund,
        { refundId, ...request({ originalAmount: kwd('10.000'), refundAmount: kwd('1.234') }) },
        meta,
      ),
    );

    expect(await rowOf(refundId)).toMatchObject({ originalAmountMinor: 10_000, refundAmountMinor: 1234 });
    expect(await journal.verify(db, entities.refund, refundId)).toEqual({ ok: true });
  });
});

/**
 * Refunds recorded before minor units have a `RefundRequested` event with
 * float amounts, reduced then to a `decimal(10,2)` column. Replay runs today's
 * reducers, so the old event must still decode and land on what the column
 * migration wrote: the two-decimal value, in minor units of the currency.
 */
describe('a refund recorded before minor units (`RefundRequested`)', () => {
  it.each([
    [100, 25.5, 'USD', 10_000, 2550],
    [5000, 1500, 'JPY', 5000, 1500],
    // The column kept two decimals, so 1.234 KWD had become 1.23
    [10, 1.234, 'KWD', 10_000, 1230],
  ])('%d / %d %s replays to %d / %d minor units', async (original, refunded, currency, originalMinor, refundMinor) => {
    const refundId = createRefundId();
    const old = typed.refunds.events.RefundRequested({
      paymentId,
      originalAmount: original,
      refundAmount: refunded,
      currency,
      reason: 'customer_request',
      customerNote: null,
      internalNotes: null,
      requestedBy: userId,
      metadata: null,
    });

    // The typed journal writes inside the app's own transaction
    await db.transaction(tx => journal.write(tx, entities.refund, refundId, { meta, events: () => [old] }));

    expect(await rowOf(refundId)).toMatchObject({
      originalAmountMinor: originalMinor,
      refundAmountMinor: refundMinor,
      currency,
      status: 'pending',
    });
    expect(await journal.verify(db, entities.refund, refundId)).toEqual({ ok: true });
  });
});

describe('what a payment can refund, checked inside the command', () => {
  it('refuses a request over what earlier approved refunds left, and writes nothing', async () => {
    const earlier = createRefundId();
    await orThrow(
      journal.run(db, commands.requestRefund, { refundId: earlier, ...request({ refundAmount: usd('80') }) }, meta),
    );
    await orThrow(journal.run(db, commands.approveRefund, { refundId: earlier, approvedBy: adminId }, meta));

    await expectRejected(
      () => journal.run(db, commands.requestRefund, { ...request({ refundAmount: usd('30') }) }, meta),
      'journal.conflict',
      'Refund of 30.00 USD exceeds what is left of the payment',
    );
  });

  it('lets a request through that fits what is left', async () => {
    const earlier = createRefundId();
    await orThrow(
      journal.run(db, commands.requestRefund, { refundId: earlier, ...request({ refundAmount: usd('80') }) }, meta),
    );
    await orThrow(journal.run(db, commands.approveRefund, { refundId: earlier, approvedBy: adminId }, meta));

    const result = await orThrow(
      journal.run(db, commands.requestRefund, { ...request({ refundAmount: usd('20') }) }, meta),
    );

    expect(result.events.map(event => event.type)).toEqual(['RefundRequestedV2']);
  });

  it('refuses a refund of a payment that does not exist', async () => {
    const refused = await journal.run(db, commands.requestRefund, { ...request(), paymentId: createPaymentId() }, meta);

    expect(CommandNotFound.is(refused)).toBe(true);
  });

  it('the database allows one pending refund per payment', async () => {
    await orThrow(journal.run(db, commands.requestRefund, { ...request({ refundAmount: usd('10') }) }, meta));

    const error = await rejectionOf(
      journal.run(db, commands.requestRefund, { ...request({ refundAmount: usd('10') }) }, meta),
    );

    expect(error).toMatchObject({ cause: { constraint: 'refunds_one_pending_per_payment_idx' } });
  });
});

describe('approveRefund and rejectRefund', () => {
  it('approves a pending refund and records who approved it and when', async () => {
    const refundId = await seed('pending');

    const result = await orThrow(journal.run(db, commands.approveRefund, { refundId, approvedBy: adminId }, meta));

    expect(result.events.map(event => event.type)).toEqual(['RefundApproved']);
    const row = await rowOf(refundId);
    expect(row).toMatchObject({ status: 'approved', approvedBy: adminId, version: 2 });
    expect(row?.approvedAt).toEqual(recordedAtOf(result.events[0]));
  });

  it("keeps the approver's notes on the row", async () => {
    const refundId = await seed('pending');

    await orThrow(
      journal.run(db, commands.approveRefund, { refundId, approvedBy: adminId, notes: 'seen the receipt' }, meta),
    );

    expect(await rowOf(refundId)).toMatchObject({ status: 'approved', approvalNotes: 'seen the receipt' });
  });

  it('refuses a rejection with a blank reason and writes nothing', async () => {
    const refundId = await seed('pending');
    const eventsBefore = await countEvents(db);

    const refused = await journal.run(
      db, commands.rejectRefund, { refundId, rejectedBy: adminId, rejectionReason: '  ' }, meta,
    );

    expect(InvalidInput.is(refused)).toBe(true);
    expect(refused).toMatchObject({ data: { issues: [{ path: ['rejectionReason'] }] } });
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await rowOf(refundId)).toMatchObject({ status: 'pending' });
  });

  it('rejects approving a refund twice, so the provider is not asked to refund twice', async () => {
    const refundId = await seed('approved');

    await expectRejected(
      () => journal.run(db, commands.approveRefund, { refundId, approvedBy: adminId }, meta),
      'journal.conflict',
      'Cannot approve refund with status approved',
      refundId,
    );
  });

  it('rejects a pending refund and records who rejected it and why', async () => {
    const refundId = await seed('pending');

    const result = await orThrow(
      journal.run(
        db,
        commands.rejectRefund,
        { refundId, rejectedBy: adminId, rejectionReason: 'Outside the refund window' },
        meta,
      ),
    );

    expect(result.events.map(event => event.type)).toEqual(['RefundRejected']);
    expect(await rowOf(refundId)).toMatchObject({
      status: 'rejected',
      rejectedBy: adminId,
      rejectionReason: 'Outside the refund window',
      version: 2,
    });
  });

  it('rejects rejecting a refund that was already approved', async () => {
    const refundId = await seed('approved');

    await expectRejected(
      () => journal.run(db, commands.rejectRefund, { refundId, rejectedBy: adminId, rejectionReason: 'late' }, meta),
      'journal.conflict',
      'Cannot reject refund with status approved',
      refundId,
    );
  });
});

describe('processRefund, completeRefund and failRefund', () => {
  it('starts processing an approved refund without a provider refund id (the provider has not answered yet)', async () => {
    const refundId = await seed('approved');

    const result = await orThrow(journal.run(db, commands.processRefund, { refundId }, meta));

    expect(result.events.map(event => event.type)).toEqual(['RefundProcessed']);
    const row = await rowOf(refundId);
    expect(row).toMatchObject({ status: 'processing', providerRefundId: null, version: 3 });
    expect(row?.processedAt).toEqual(recordedAtOf(result.events[0]));
  });

  it('rejects processing a refund nobody approved', async () => {
    const refundId = await seed('pending');

    await expectRejected(
      () => journal.run(db, commands.processRefund, { refundId }, meta),
      'journal.conflict',
      'Cannot process refund with status pending. Must be approved first.',
      refundId,
    );
  });

  it('completes a processing refund and stores the provider refund id that arrives with completion', async () => {
    const refundId = await seed('processing');

    const result = await orThrow(
      journal.run(
        db,
        commands.completeRefund,
        { refundId, providerRefundId: 're_123', providerResponse: '{"id":"re_123"}' },
        meta,
      ),
    );

    expect(result.events.map(event => event.type)).toEqual(['RefundCompleted']);
    const row = await rowOf(refundId);
    expect(row).toMatchObject({
      status: 'completed',
      providerRefundId: 're_123',
      providerResponse: '{"id":"re_123"}',
      version: 4,
    });
    expect(row?.completedAt).toEqual(recordedAtOf(result.events[0]));
  });

  it('completing a refund with the Stripe id it already has changes nothing', async () => {
    const refundId = await seed('completed');
    const eventsBefore = await eventTypesOf(db, 'refund', refundId);

    const result = await orThrow(
      journal.run(db, commands.completeRefund, { refundId, providerRefundId: 're_seed' }, meta),
    );

    expect(result.events).toEqual([]);
    expect(await eventTypesOf(db, 'refund', refundId)).toEqual(eventsBefore);
  });

  it('rejects completing a completed refund with another Stripe id', async () => {
    const refundId = await seed('completed');

    await expectRejected(
      () => journal.run(db, commands.completeRefund, { refundId, providerRefundId: 're_other' }, meta),
      'journal.conflict',
      'Cannot complete refund with status completed. Must be processing first.',
      refundId,
    );
  });

  it('rejects completing a refund that is not being processed', async () => {
    const refundId = await seed('approved');

    await expectRejected(
      () => journal.run(db, commands.completeRefund, { refundId, providerRefundId: 're_1' }, meta),
      'journal.conflict',
      'Cannot complete refund with status approved. Must be processing first.',
      refundId,
    );
  });

  it('fails a processing refund and keeps the error as the JSON the service stored before the journal', async () => {
    const refundId = await seed('processing');

    const result = await orThrow(
      journal.run(db, commands.failRefund, { refundId, errorMessage: 'charge_disputed' }, meta),
    );

    expect(result.events.map(event => event.type)).toEqual(['RefundFailed']);
    expect(await rowOf(refundId)).toMatchObject({
      status: 'failed',
      providerResponse: '{"error":"charge_disputed"}',
      version: 4,
    });
  });

  it('rejects failing a refund that already completed: the money went back', async () => {
    const refundId = await seed('completed');

    await expectRejected(
      () => journal.run(db, commands.failRefund, { refundId, errorMessage: 'late' }, meta),
      'journal.conflict',
      'Cannot fail refund with status completed. Must be processing first.',
      refundId,
    );
  });

  it.each(['approveRefund', 'rejectRefund', 'processRefund', 'completeRefund', 'failRefund'] as const)(
    '%s rejects a refund that is not there',
    async name => {
      const refundId = createRefundId();
      const attempts = {
        approveRefund: () => journal.run(db, commands.approveRefund, { refundId, approvedBy: adminId }, meta),
        rejectRefund: () =>
          journal.run(db, commands.rejectRefund, { refundId, rejectedBy: adminId, rejectionReason: 'x' }, meta),
        processRefund: () => journal.run(db, commands.processRefund, { refundId }, meta),
        completeRefund: () => journal.run(db, commands.completeRefund, { refundId, providerRefundId: 're_1' }, meta),
        failRefund: () => journal.run(db, commands.failRefund, { refundId, errorMessage: 'x' }, meta),
      };

      await expectRejected(attempts[name], 'journal.not_found', `Refund ${refundId} not found`);
    },
  );
});

describe('writes(run): what RefundService calls', () => {
  it('runs a whole refund, one event per step, and the row replays from its events', async () => {
    const writes = typed.refunds.writes(run);
    const refundId = createRefundId();

    const requested = await orThrow(writes.requestRefund({ refundId, ...request() }));
    expect(requested).toMatchObject({ id: refundId, status: 'pending', refundAmountMinor: 2550 });
    expect(requested).not.toHaveProperty('version');

    expect(await orThrow(writes.approveRefund({ refundId, approvedBy: adminId }))).toMatchObject({
      status: 'approved',
    });
    expect(await orThrow(writes.processRefund({ refundId }))).toMatchObject({ status: 'processing' });
    expect(await orThrow(writes.completeRefund({ refundId, providerRefundId: 're_life' }))).toMatchObject({
      status: 'completed',
      providerRefundId: 're_life',
    });

    expect(await eventTypesOf(db, 'refund', refundId)).toEqual([
      'RefundRequestedV2',
      'RefundApproved',
      'RefundProcessed',
      'RefundCompleted',
    ]);
    expect(await journal.verify(db, entities.refund, refundId)).toEqual({ ok: true });
  });

  it('runs the reject and the fail commands too', async () => {
    const writes = typed.refunds.writes(run);
    // The processing one first: a payment has one pending refund at a time
    const failed = await seed('processing');
    const rejected = await seed('pending');

    expect(
      await orThrow(writes.rejectRefund({ refundId: rejected, rejectedBy: adminId, rejectionReason: 'no' })),
    ).toMatchObject({ status: 'rejected' });
    expect(await orThrow(writes.failRefund({ refundId: failed, errorMessage: 'boom' }))).toMatchObject({
      status: 'failed',
    });
    expect(await eventTypesOf(db, 'refund', rejected)).toEqual(['RefundRequestedV2', 'RefundRejected']);
    expect(await eventTypesOf(db, 'refund', failed)).toEqual([
      'RefundRequestedV2',
      'RefundApproved',
      'RefundProcessed',
      'RefundFailed',
    ]);
    expect(await journal.verify(db, entities.refund, failed)).toEqual({ ok: true });
  });

  it('returns a refused rule to the service as a failure, so the app can map it to an API answer', async () => {
    const writes = typed.refunds.writes(run);
    const refundId = await seed('pending');

    const refused = await writes.processRefund({ refundId });

    expect(refused).toMatchObject({ code: 'journal.conflict', status: 409 });
  });
});

describe('types', () => {
  it('exposes schema failures instead of promising a refund for invalid journal input', () => {
    expectTypeOf<FailureOf<RefundWrites['requestRefund']>>().extract<SchemaFailure>().toEqualTypeOf<SchemaFailure>();
  });


  it('takes the journal definitions of an app (its own transaction and database types) and the untyped form', () => {
    // Both journals are built in `test-support.ts`; `tsc` checks that the factory accepts each `j`.
    expectTypeOf(typed.refunds.writes).parameter(0).toEqualTypeOf<CommandRunner<{ actorId: string }, AppTx>>();
    expectTypeOf(plain.refunds.writes).parameter(0).toEqualTypeOf<CommandRunner<{ actorId: string }>>();
    expectTypeOf(typed.refunds.writes).returns.toEqualTypeOf<RefundWrites>();
  });

  it('keeps `version` out of the rows the service gets', () => {
    expectTypeOf<Awaited<ReturnType<RefundWrites['requestRefund']>>>().not.toHaveProperty('version');
  });
});

/** A table shaped like the one an app had before the journal: no `version` column. */
const legacyRefunds = schema.table('legacy_refunds', { id: refundIdFactory.primaryColumn() });

/** Never called: `tsc` checks it. An app that forgot the schema change must fail to compile, not fail at run time. */
function rejectsATableWithoutVersion() {
  // @ts-expect-error -- a table without the `version` column cannot hold a journal entity
  createRefundsJournal(plain.j, { refunds: legacyRefunds, payments: core.payments });
}
void rejectsATableWithoutVersion;
