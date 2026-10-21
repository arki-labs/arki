// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * The refund workflow, `payments.refund`
 *
 * Flow: approval → `RefundApproved` → run `refund:<refundId>` → begin → payBack (Stripe) → settled (webhook signal)
 *       → record → notify.
 *
 * A refund moves money back once, and the money it holds stays held until Stripe says where it ended. These tests
 * run the real workflow on the real tables with a fake Stripe account, and use the harness to crash the process,
 * move time, and stand in for the operator.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';
import { CommandConflict, initJournal } from '@arki/journal';
import { workflowHarness } from '@arki/journal/testing';
import { money } from '@arki/money';

import type { NotificationService } from '../core/notifications/service.js';
import type { AppDb, AppTx } from '../test-support.js';
import type { RefundStripe } from './workflow.js';
import { createCoreJournal } from '../core/journal.js';
import { IdempotencyConflict, PaymentProviderError } from '../core/providers/provider-error.js';
import { coreReads, refundReads, refundRow, seedPayment } from '../service-test-support.js';
import {
  adminId,
  core,
  journalTablesInSchema,
  meta,
  metaSchema,
  pushedSchema,
  refundsTables,
  seedFixture,
  userId,
} from '../test-support.js';
import { RefundInvalidState } from './failures.js';
import { createRefundsJournal } from './journal.js';
import { RefundService } from './service.js';
import { createRefundWorkflow } from './workflow.js';

type StripeRefund = { refundId: string; providerRefundId: string; status: string | null; failureReason: string | null };

/** A Stripe account for one test: its refunds by idempotency key, and how it answers a create (default: `succeeded`). */
function stripeAccount(created?: { status: string; failureReason: string | null }) {
  const byKey = new Map<string, StripeRefund>();
  /** The amount of every create, as Stripe received it. */
  const amounts: string[] = [];
  const account = {
    byKey,
    amounts,
    /** Runs after Stripe stored a create and before it answers: a test drops the answer or kills the process here. */
    afterCreate: (): Promise<void> => Promise.resolve(),
    /** Set: a create is refused as a reused key with other parameters. */
    conflict: false,
    /** Stripe moves every refund on, as it does between the create and the webhook. */
    settle(status: string, failureReason: string | null = null) {
      for (const refund of byKey.values()) {
        refund.status = status;
        refund.failureReason = failureReason;
      }
    },
    api: {
      findRefund: (_paymentId, refundId) =>
        Promise.resolve([...byKey.values()].find(refund => refund.refundId === refundId) ?? null),
      refundPayment: async (_paymentId, params) => {
        if (account.conflict) return IdempotencyConflict();
        // Stripe's idempotency: a known key answers with the first refund, a new key makes another one
        const known = byKey.get(params.idempotencyKey);
        if (known) return { ...known };
        amounts.push(params.amount?.toString() ?? 'all');
        const refund = {
          refundId: params.refundId,
          providerRefundId: `re_${byKey.size + 1}`,
          status: created?.status ?? 'succeeded',
          failureReason: created?.failureReason ?? null,
        };
        byKey.set(params.idempotencyKey, refund);
        // The answer is what Stripe said at the create, whatever happens to the refund afterwards
        const answer = { ...refund };
        await account.afterCreate();
        return answer;
      },
    } satisfies RefundStripe,
  };
  return account;
}

let stripe = stripeAccount();

/** Set: runs once, then the next checkpoint dies, as a process killed after the step body and before its commit. */
let beforeNextCheckpoint: (() => void) | undefined;

/** Every mail the workflow sent, as `<to>:<refundId>[:<status>]`. */
let mails: string[] = [];
const notifications: NotificationService = {
  sendRefundStatusUpdate: (refund, status) => {
    mails.push(`customer:${refund.id}:${status}`);
    return Promise.resolve();
  },
  sendRefundFailureAlert: refund => {
    mails.push(`support:${refund.id}`);
    return Promise.resolve();
  },
};

/** The app as it boots: one `initJournal`, the payments and refunds definitions, and one compose. Again after a crash. */
function setup() {
  const j = initJournal.tx<AppTx>().db<AppDb>().create({ tables: journalTablesInSchema, meta: metaSchema });
  const payments = createCoreJournal(j, core);
  const refunds = createRefundsJournal(j, { refunds: refundsTables.refunds, payments: core.payments });
  const refund = createRefundWorkflow(j, refunds);
  const journal = j.compose({
    workflows: [refund],
    workflowMeta: { actorId: 'system:workflow' },
    services: { stripe: () => stripe.api, notifications },
  });
  journal.hooks.command.around(async (ctx, next) => {
    if (ctx.name === 'workflow.checkpoint' && beforeNextCheckpoint !== undefined) {
      const dying = beforeNextCheckpoint;
      beforeNextCheckpoint = undefined;
      dying();
      throw new Error('the process died before the checkpoint');
    }
    await next();
  });
  return { tables: journalTablesInSchema, journal, payments, refunds, refund };
}

let h: Awaited<ReturnType<typeof harness>>;
const harness = () => workflowHarness({ setup, schema: pushedSchema });

beforeEach(async () => {
  stripe = stripeAccount();
  mails = [];
  beforeNextCheckpoint = undefined;
  h = await harness();
  await seedFixture(h.db);
});

afterEach(async () => {
  await h.close();
});

/** The request's command runner, on the harness database and the newest runtime. */
const run: Parameters<ReturnType<typeof setup>['refunds']['writes']>[0] = (command, input) =>
  h.journal.run(h.db, command, input, meta);

/** A collected payment of 25 and an approved refund of 10 of it. The approval queued the run's start. */
async function approvedRefund(currency = 'USD', paid = '25', amount = '10') {
  const payment = await seedPayment(h.payments.writes(run), null, paid, currency);
  await orThrow(h.payments.writes(run).completePayment({ paymentId: payment.id }));
  const refund = await orThrow(
    h.refunds.writes(run).requestRefund({
      paymentId: payment.id,
      originalAmount: { amount: paid, currency },
      refundAmount: { amount, currency },
      reason: 'customer_request',
      requestedBy: userId,
    }),
  );
  await orThrow(h.refunds.writes(run).approveRefund({ refundId: refund.id, approvedBy: adminId }));
  return { payment, refundId: refund.id, runId: `refund:${refund.id}` };
}

async function readRun(runId: string) {
  const read = orThrow(await h.refund.read(h.db, runId));
  if (read === undefined) throw new Error(`no run ${runId}`);
  return read;
}

/** The run's row: its state, where it waits, its output. */
async function runRow(runId: string) {
  const read = await readRun(runId);
  return read.run;
}

const noop = (): void => {
  // Replaced by the promise's resolver before a point is returned.
};

/** A point a step reports reaching, which the test awaits. */
function signalPoint() {
  let reach = noop;
  const reached = new Promise<void>(resolve => {
    reach = resolve;
  });
  return { reached, reach: () => reach() };
}

/** The process dies here: nothing after this line of the step ever runs. */
const dieHere = () =>
  new Promise<never>(() => {
    // Never settles.
  });

describe('paying the refund back', () => {
  it('a crash after Stripe answered re-runs payBack with the same key and refunds once', async () => {
    const { refundId, runId } = await approvedRefund();
    const answered = signalPoint();
    stripe.afterCreate = async () => {
      stripe.afterCreate = () => Promise.resolve();
      answered.reach();
      await dieHere();
    };
    // This drain never returns: the process dies inside payBack, after Stripe stored the refund.
    // eslint-disable-next-line failure/must-use -- the drain never settles, so it has no result to handle
    void h.drain();
    await answered.reached;

    h.crash();
    // The dead worker's lease must run out before the new one takes the job
    await h.tick('2m');
    orThrow(await h.drain());

    expect(stripe.byKey.size).toBe(1);
    expect(await refundRow(h.db, refundId)).toMatchObject({ status: 'completed', providerRefundId: 're_1' });
    expect(await runRow(runId)).toMatchObject({
      state: 'completed',
      output: { providerRefundId: 're_1', outcome: 'completed' },
    });
  });

  it('an error after the create leaves the row processing so its amount still counts', async () => {
    const { payment, refundId } = await approvedRefund();
    stripe.afterCreate = () => {
      stripe.afterCreate = () => Promise.resolve();
      return Promise.reject(new PaymentProviderError('unavailable', 'socket hang up'));
    };

    orThrow(await h.drain());

    expect(await refundRow(h.db, refundId)).toMatchObject({ status: 'processing' });
    // 10 of 25 is on its way: 20 more would refund more than was paid
    const refused = await h.refunds.writes(run).requestRefund({
      paymentId: payment.id,
      originalAmount: { amount: '25', currency: 'USD' },
      refundAmount: { amount: '20', currency: 'USD' },
      reason: 'customer_request',
      requestedBy: userId,
    });
    expect(CommandConflict.is(refused)).toBe(true);

    // The retry finds the refund Stripe already made, and makes no second one
    await h.tick('1m');
    orThrow(await h.drain());
    expect(stripe.byKey.size).toBe(1);
    expect(await refundRow(h.db, refundId)).toMatchObject({ status: 'completed', providerRefundId: 're_1' });
  });

  it('a Stripe fault that would repeat stops payBack at once for an operator, instead of retrying for minutes', async () => {
    const { refundId, runId } = await approvedRefund();
    stripe.afterCreate = () => Promise.reject(new PaymentProviderError('invalid_request', 'amount must be positive'));

    orThrow(await h.drain());

    expect(await runRow(runId)).toMatchObject({ state: 'running', stuck: true });
    expect(await refundRow(h.db, refundId)).toMatchObject({ status: 'processing' });
  });

  it('a JPY refund reaches Stripe as 1500 JPY, never divided by 100', async () => {
    await approvedRefund('JPY', '5000', '1500');

    orThrow(await h.drain());

    expect(stripe.amounts).toEqual(['1500 JPY']);
  });
});

describe('settling', () => {
  it('a refund Stripe settles at once does not wait for the webhook', async () => {
    const { refundId, runId } = await approvedRefund();

    orThrow(await h.drain());

    const read = await readRun(runId);
    expect(read.run.state).toBe('completed');
    expect(read.run.results.settled).toBeNull();
    expect(mails).toEqual([`customer:${refundId}:completed`]);
  });

  it('a signal that never comes is settled by a Stripe lookup after 3d', async () => {
    stripe = stripeAccount({ status: 'pending', failureReason: null });
    const { refundId, runId } = await approvedRefund();
    orThrow(await h.drain());
    expect(await runRow(runId)).toMatchObject({ state: 'parked', waitingFor: 'stripe.refund.settled' });

    // Stripe paid it back, and its webhook was lost
    stripe.settle('succeeded');
    await h.tick('3d');
    orThrow(await h.drain());

    expect(await refundRow(h.db, refundId)).toMatchObject({ status: 'completed', providerRefundId: 're_1' });
    expect(await runRow(runId)).toMatchObject({ output: { providerRefundId: 're_1', outcome: 'completed' } });
    expect(mails).toEqual([`customer:${refundId}:completed`]);
  });

  it('a failed Stripe refund ends the row failed and frees the amount', async () => {
    stripe = stripeAccount({ status: 'failed', failureReason: 'insufficient_funds' });
    const { payment, refundId, runId } = await approvedRefund();

    orThrow(await h.drain());

    expect(await refundRow(h.db, refundId)).toMatchObject({
      status: 'failed',
      providerResponse: JSON.stringify({ error: 'Stripe refund re_1 failed: insufficient_funds' }),
    });
    expect(await runRow(runId)).toMatchObject({ output: { providerRefundId: 're_1', outcome: 'failed' } });
    expect(mails).toEqual([`support:${refundId}`]);
    // Nothing went back, so the whole payment can be refunded again
    const again = await h.refunds.writes(run).requestRefund({
      paymentId: payment.id,
      originalAmount: { amount: '25', currency: 'USD' },
      refundAmount: { amount: '25', currency: 'USD' },
      reason: 'customer_request',
      requestedBy: userId,
    });
    expect(again).toMatchObject({ status: 'pending' });
  });

  it('a refund Stripe fails after we recorded it completed stays completed, flags lateFailure and alerts support', async () => {
    const { refundId, runId } = await approvedRefund();
    // Stripe answers `succeeded`, and payBack completes the row. The process dies before payBack's checkpoint, and
    // before payBack runs again Stripe fails the refund.
    stripe.afterCreate = () => {
      stripe.afterCreate = () => Promise.resolve();
      beforeNextCheckpoint = () => stripe.settle('failed', 'expired_or_canceled_card');
      return Promise.resolve();
    };

    orThrow(await h.drain());
    // The lost checkpoint is a defect on the job: an operator resumes the step, as after any interrupted checkpoint
    orThrow(await h.journal.workflows.retryStep(h.db, { runId, path: 'payBack', phase: 'do' }, { actor: 'usr_ops' }));
    orThrow(await h.drain());

    expect(await refundRow(h.db, refundId)).toMatchObject({ status: 'completed', providerRefundId: 're_1' });
    expect(await runRow(runId)).toMatchObject({
      state: 'completed',
      output: { providerRefundId: 're_1', outcome: 'completed', lateFailure: 'expired_or_canceled_card' },
    });
    expect(mails).toEqual([`support:${refundId}`]);
  });

  it('a dead payBack resolved with the Stripe id completes the refund', async () => {
    stripe.conflict = true;
    const { refundId, runId } = await approvedRefund();
    orThrow(await h.drain());
    expect(await runRow(runId)).toMatchObject({ state: 'running', stuck: true });
    expect(await refundRow(h.db, refundId)).toMatchObject({ status: 'processing' });

    // The operator found the refund in the Stripe dashboard
    orThrow(
      await h.journal.workflows.resolveStep(
        h.db,
        { runId, path: 'payBack', result: { providerRefundId: 're_dashboard', status: 'succeeded' } },
        { actor: 'usr_ops', reason: 'found in the Stripe dashboard' },
      ),
    );
    orThrow(await h.drain());

    expect(await refundRow(h.db, refundId)).toMatchObject({ status: 'completed', providerRefundId: 're_dashboard' });
    expect(await runRow(runId)).toMatchObject({ state: 'completed' });
  });
});

describe('starting the run', () => {
  it('approving starts exactly one run even when approval is retried', async () => {
    const service = new RefundService(refundReads(h.db), h.refunds.writes(run), coreReads(h.db), {
      systemUserId: adminId,
      autoApproveLimits: {},
    });
    const payment = await seedPayment(h.payments.writes(run), null, '25');
    await orThrow(h.payments.writes(run).completePayment({ paymentId: payment.id }));
    const pending = await orThrow(
      service.requestRefund({
        paymentId: payment.id,
        amount: money(10, 'USD'),
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );

    const approved = await orThrow(service.approveRefund({ refundId: pending.id, approvedBy: adminId }));
    const retried = await service.approveRefund({ refundId: pending.id, approvedBy: adminId });
    orThrow(await h.drain());
    // A start job tried again after the run started gives the same run
    const restarted = orThrow(
      await h.journal.run(h.db, h.refund.start, { id: `refund:${pending.id}`, input: { refundId: pending.id } }, meta),
    );

    // The service answers before the money moves: the UI says "on its way"
    expect(approved.status).toBe('approved');
    expect(RefundInvalidState.is(retried)).toBe(true);
    expect(restarted).toEqual({ runId: `refund:${pending.id}` });
    const { runs } = await h.journal.workflows.runs(h.db, { name: 'payments.refund' });
    expect(runs.map(summary => summary.id)).toEqual([`refund:${pending.id}`]);
    expect(stripe.byKey.size).toBe(1);
  });

  it('an auto-approved refund starts its run too', async () => {
    const service = new RefundService(refundReads(h.db), h.refunds.writes(run), coreReads(h.db), {
      systemUserId: adminId,
    });
    const payment = await seedPayment(h.payments.writes(run), null, '25');
    await orThrow(h.payments.writes(run).completePayment({ paymentId: payment.id }));

    const refund = await orThrow(
      service.requestRefund({
        paymentId: payment.id,
        amount: money(5, 'USD'),
        reason: 'customer_request',
        requestedBy: userId,
      }),
    );
    orThrow(await h.drain());

    expect(refund.status).toBe('approved');
    expect(await refundRow(h.db, refund.id)).toMatchObject({ status: 'completed', providerRefundId: 're_1' });
  });
});

describe('reading a run', () => {
  it('refund.read types the output and the payBack result, so an operator screen needs no casts', async () => {
    const { runId } = await approvedRefund();
    orThrow(await h.drain());

    const read = await readRun(runId);

    expectTypeOf(read.run.output).toEqualTypeOf<{
      providerRefundId: string;
      outcome: 'completed' | 'failed';
      lateFailure?: string | undefined;
    } | null>();
    expectTypeOf(read.run.results.payBack).toEqualTypeOf<
      { providerRefundId: string; status: string | null } | undefined
    >();
    expect(read.run.results.payBack).toEqual({ providerRefundId: 're_1', status: 'succeeded' });
    expect(isFailure(read)).toBe(false);
  });
});
