// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * The refund effects, `createRefundEffects`
 *
 * Flow: `requestRefund` → `RefundRequestedV2` → a job written in the request's transaction → the worker (here
 * `drain`) runs `refund-approval-request` → the approvers' mail.
 *
 * The effect runs on the real tables and the real journal, with a mailer that records what it was asked to send.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { money } from '@arki/money';

import type { NotificationService } from '../core/notifications/service.js';
import type { AppDb, AppTx } from '../test-support.js';
import { createCoreJournal } from '../core/journal.js';
import { coreReads, refundReads, seedPayment } from '../service-test-support.js';
import { adminId, core, journalTablesInSchema, meta, metaSchema, openDb, refundsTables, userId } from '../test-support.js';
import { createRefundEffects } from './effects.js';
import { createRefundsJournal } from './journal.js';
import { RefundService } from './service.js';

/** The refunds the approvers were mailed about, in order. */
const approverMails: string[] = [];
const notifications: NotificationService = {
  sendRefundApprovalRequest: refund => {
    approverMails.push(refund.id);
    return Promise.resolve();
  },
};

/** The app as it boots: the payments and refunds definitions, and one compose that lists the refund effects. */
const j = initJournal.tx<AppTx>().db<AppDb>().create({ tables: journalTablesInSchema, meta: metaSchema });
const payments = createCoreJournal(j, core);
const refunds = createRefundsJournal(j, { refunds: refundsTables.refunds, payments: core.payments });
const journal = j.compose({ effects: [...createRefundEffects(j, refunds)], services: { notifications } });

let db: AppDb;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

/** The request's command runner, on the test database. */
const run: Parameters<typeof refunds.writes>[0] = (command, input) => journal.run(db, command, input, meta);

/** Refunds up to 10.00 USD are approved at once; larger ones wait for a person. */
const service = () =>
  new RefundService(refundReads(db), refunds.writes(run), coreReads(db), {
    systemUserId: adminId,
    autoApproveLimits: { USD: '10.00' },
  });

/** A collected payment of 50 USD. */
async function paidPayment() {
  const payment = await seedPayment(payments.writes(run), null, '50');
  await orThrow(payments.writes(run).completePayment({ paymentId: payment.id }));
  return payment;
}

/** A refund request of `amount` USD on a payment of its own. */
async function requested(amount: number) {
  const payment = await paidPayment();
  return orThrow(
    service().requestRefund({
      paymentId: payment.id,
      amount: money(amount, 'USD'),
      reason: 'customer_request',
      requestedBy: userId,
    }),
  );
}

/** What the worker does: runs every due job until none is left. */
async function drainAll() {
  let processed: number;
  do {
    processed = orThrow(await journal.drain(db));
  } while (processed > 0);
}

describe('createRefundEffects', () => {
  it('the approver mail is sent once after commit, only while the refund is still pending', async () => {
    // Approvers act on refunds that wait for them: one mail each, never one for a refund that rolled back or was
    // decided before they could act
    const waiting = await requested(20);
    expect(waiting.status).toBe('pending');
    // The request answers before the mail: the worker sends it after the commit
    expect(approverMails).toEqual([]);
    await drainAll();
    expect(approverMails).toEqual([waiting.id]);
    await drainAll();
    expect(approverMails).toEqual([waiting.id]);

    // Auto-approved in the same request: never pending when the job runs
    const small = await requested(5);
    expect(small.status).toBe('approved');
    // Decided by a person before the job ran
    const decided = await requested(20);
    await orThrow(service().approveRefund({ refundId: decided.id, approvedBy: adminId }));
    // Rolled back: no event, no job
    const lost = await paidPayment();
    await expect(
      db.transaction(async tx => {
        orThrow(
          await journal.run(
            tx,
            refunds.commands.requestRefund,
            {
              paymentId: lost.id,
              originalAmount: { amount: '50', currency: 'USD' },
              refundAmount: { amount: '20', currency: 'USD' },
              reason: 'customer_request',
              customerNote: null,
              internalNotes: null,
              requestedBy: userId,
              metadata: null,
            },
            meta,
          ),
        );
        throw new Error('the request rolls back');
      }),
    ).rejects.toThrow('the request rolls back');

    await drainAll();
    expect(approverMails).toEqual([waiting.id]);
  });
});
