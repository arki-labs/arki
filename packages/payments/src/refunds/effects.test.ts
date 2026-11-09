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
import { CommandNotFound, initJournal } from '@arki/journal';
import { money } from '@arki/money';

import type { NotificationService } from '../core/notifications/service.js';
import { NotificationFailed } from '../core/failures.js';
import type { AppDb, AppTx } from '../test-support.js';
import { createCoreJournal } from '../core/journal.js';
import { coreReads, refundReads, seedPayment } from '../service-test-support.js';
import { adminId, core, journalTablesInSchema, meta, metaSchema, openDb, refundsTables, userId } from '../test-support.js';
import { createRefundEffects } from './effects.js';
import { createRefundsJournal } from './journal.js';
import { RefundService } from './service.js';

/** The refunds the approvers were mailed about, in order. */
const approverMails: string[] = [];
/** The refunds whose customer was told of the rejection, in order. */
const rejectionMails: string[] = [];
/** `down`: every send returns `payments.notification_failed`; `refused`: every send returns another failure. */
let mailFault: 'down' | 'refused' | null = null;
/** What a send returns while `mailFault` is set. */
const fault = (notification: 'refund_approval_request' | 'refund_status_update') =>
  mailFault === 'down'
    ? NotificationFailed({ channel: 'email', notification })
    : CommandNotFound({ detail: 'The mailer has no approver list' });
const notifications: NotificationService = {
  sendRefundApprovalRequest: refund => {
    if (mailFault !== null) return Promise.resolve(fault('refund_approval_request'));
    approverMails.push(refund.id);
    return Promise.resolve();
  },
  sendRefundStatusUpdate: (refund, status) => {
    if (mailFault !== null) return Promise.resolve(fault('refund_status_update'));
    rejectionMails.push(`${refund.id}:${status}`);
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

  // A mail that did not go out used to be logged and acked: no retry, no lastError, and the approvers never knew.
  // A transport outage sends nothing, so the job tries again later instead of dying at once.
  it('a mail that returned payments.notification_failed is retried with backoff, never acked or dropped', async () => {
    mailFault = 'down';
    try {
      const waiting = await requested(30);
      await drainAll();

      const { jobs: dead } = await journal.jobs(db, { status: 'dead', effect: 'refund-approval-request' });
      expect(dead).toEqual([]);
      const { jobs: waitingJobs } = await journal.jobs(db, { effect: 'refund-approval-request' });
      const retrying = waitingJobs.filter(job => JSON.stringify(job.lastError).includes('payments.notification_failed'));
      expect(retrying).toHaveLength(1);
      expect(retrying[0]).toMatchObject({ attempts: 1, deadAt: null });
      expect(approverMails).not.toContain(waiting.id);
    } finally {
      mailFault = null;
    }
  });

  it('any other failure the mailer returns makes the job dead at once, with it as lastError', async () => {
    mailFault = 'refused';
    try {
      await requested(31);
      await drainAll();

      const { jobs } = await journal.jobs(db, { status: 'dead', effect: 'refund-approval-request' });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ attempts: 1 });
      expect(JSON.stringify(jobs[0]?.lastError)).toContain('journal.not_found');
    } finally {
      mailFault = null;
    }
  });

  // The customer's rejection mail used to be sent by RefundService, its failure logged and dropped
  it('tells the customer of a rejection after the commit, and retries a mail the transport could not send', async () => {
    const rejected = await requested(25);
    await orThrow(service().rejectRefund({ refundId: rejected.id, rejectedBy: adminId, reason: 'outside policy' }));
    expect(rejectionMails).toEqual([]);
    await drainAll();
    expect(rejectionMails).toEqual([`${rejected.id}:rejected`]);

    mailFault = 'down';
    try {
      const unlucky = await requested(25);
      await orThrow(service().rejectRefund({ refundId: unlucky.id, rejectedBy: adminId, reason: 'outside policy' }));
      await drainAll();

      const { jobs: dead } = await journal.jobs(db, { status: 'dead', effect: 'refund-rejection-notice' });
      expect(dead).toEqual([]);
      const { jobs } = await journal.jobs(db, { effect: 'refund-rejection-notice' });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ attempts: 1, deadAt: null });
      expect(JSON.stringify(jobs[0]?.lastError)).toContain('payments.notification_failed');
    } finally {
      mailFault = null;
    }
  });
});
