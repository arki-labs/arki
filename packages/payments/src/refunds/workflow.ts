/**
 * A refund paid back by a durable workflow
 *
 * `createRefundWorkflow(j, refundsJournal)` defines `payments.refund` v1 on the app's journal. Approving a refund
 * (`RefundApproved`, by a person or by the auto-approval rule) starts one run, id `refund:<refundId>`, from a job
 * written in the approval's transaction. The run then pays the money back through Stripe and survives restarts:
 *
 * 1. `begin`: reads the refund. `approved` becomes `processing`; `processing` goes on (a re-run); anything else stops.
 * 2. `payBack`: looks the Stripe refund up by our refund id, and creates it only when Stripe has none, with the step's
 *    key as the idempotency key. A refund Stripe already `succeeded` completes the row.
 * 3. `settled`: waits up to 3 days for the `stripe.refund.settled` signal the webhook sends. It is skipped when
 *    `payBack` already saw where the refund ends.
 * 4. `record`: completes or fails the row from what Stripe says. A refund still on its way throws, so the step's
 *    backoff asks Stripe again later. A refund Stripe fails after the row is `completed` stays completed: the run
 *    ends `completed` with `lateFailure`, the error is logged, and support is alerted.
 * 5. `notify`: tells the customer the refund is completed, or support that it failed. The mailer takes no key, so a
 *    crash after the send and before the checkpoint sends the mail a second time.
 *
 * Stripe's answers a caller must handle (`ReferenceNotFound`, `IdempotencyConflict`) are returned, so the step dies at
 * once: the run waits, stuck, for an operator (`journal.workflows.retryStep` or `resolveStep`). A throw is retried
 * with the same key, except a `PaymentProviderError` Stripe will refuse again (`retryable` false), which kills the
 * step at once.
 */

import { eq } from 'drizzle-orm';

import type { JournalDefinitions, RootDb, TransactionSource } from '@arki/journal';
import type { StandardSchemaV1 } from '@arki/schema';
import { z } from '@arki/contracts';
import { isFailure } from '@arki/failure';
import { backoff, need } from '@arki/journal';
import { getLogger } from '@arki/log';

import type { NotificationService } from '../core/notifications/service.js';
import type { StripeProvider } from '../core/providers/stripe-provider.js';
import type { createRefundsJournal } from './journal.js';
import type { RefundId } from './primitives.js';
import { fromMinorColumn } from '../core/money.js';
import { paymentIdSchema } from '../core/primitives.js';
import { PaymentProviderError } from '../core/providers/provider-error.js';
import { RefundInvalidState, RefundNotFound } from './failures.js';
import { refundIdSchema, refundReasonValues } from './primitives.js';

/** Logs ids and statuses only. */
const logger = getLogger('arki:payments');

/** The Stripe calls the workflow makes. A `StripeProvider` fits. */
export type RefundStripe = Pick<StripeProvider, 'refundPayment' | 'findRefund'>;

/** The workflow's type. `RefundWorkflow['signal']` is what a webhook calls. */
export type RefundWorkflow = ReturnType<typeof createRefundWorkflow>;

/** Where a Stripe refund ends. `pending` and `requires_action` are still on their way. */
export const REFUND_SETTLED_STATUSES = ['succeeded', 'failed', 'canceled'] as const;

/** The id of a refund's run: the approval starts it, the webhook signals it. */
export const refundRunId = (refundId: RefundId) => `refund:${refundId}`;

/** What the webhook tells the run: the Stripe refund and where it ended. */
const settledSchema = z.object({ providerRefundId: z.string().min(1), status: z.enum(REFUND_SETTLED_STATUSES) });

const settledStatuses: ReadonlySet<string | null> = new Set(REFUND_SETTLED_STATUSES);

function isSettled(status: string | null): status is (typeof REFUND_SETTLED_STATUSES)[number] {
  return settledStatuses.has(status);
}

/** Thrown by `record` while Stripe still has the refund on its way, so the step's backoff asks again later. */
class RefundNotSettled extends Error {}

/**
 * Retry a throw, except a Stripe fault the same call meets again (a bad request, a wrong key). A returned failure
 * is never retried: `while` sees it too, and it is final.
 */
const worthRetrying = (reason: unknown) =>
  !isFailure(reason) && !(reason instanceof PaymentProviderError && !reason.retryable);

/** `payBack`: the journal's default schedule (8 tries, 1 s doubling to 5 min), without the faults Stripe repeats. */
const payBackRetry = backoff.exponential({ base: 1000, max: 300_000, jitter: 0.25 }).upTo(7).while(worthRetrying);

/**
 * `record`: asks Stripe again from 1 min, doubling to every 6 h, about 8 days in all, while the refund is still
 * pending (`RefundNotSettled`) or another throw may clear. A refund still pending after that waits, stuck, for an
 * operator.
 */
const recordRetry = backoff
  .exponential({ base: 60_000, max: 6 * 3_600_000, jitter: 0.25 })
  .upTo(40)
  .while(worthRetrying);

export function createRefundWorkflow<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(j: JournalDefinitions<Meta, Tx, AppDb>, refundsJournal: ReturnType<typeof createRefundsJournal<Meta, Tx, AppDb>>) {
  const { commands } = refundsJournal;
  const { refund } = refundsJournal.entities;
  const refunds = refund.table;

  async function readRefund(db: AppDb, refundId: RefundId) {
    const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
    return row ?? RefundNotFound({ refundId });
  }

  return (
    j
      .workflow('payments.refund', {
        version: 1,
        // No transform: `def.read` checks the stored input with this same schema
        input: z.object({ refundId: refundIdSchema }),
        output: z.object({
          providerRefundId: z.string(),
          outcome: z.enum(['completed', 'failed']),
          /** Set when Stripe failed the refund after the row was `completed`: Stripe's reason, or `unknown`. */
          lateFailure: z.string().optional(),
        }),
        needs: {
          /** The provider is built on the database the step runs on. */
          stripe: need<(db: AppDb) => RefundStripe>(),
          /** Every method is optional: `{}` sends nothing. */
          notifications: need<NotificationService>(),
        },
        onDeadStep: 'wait',
        startOn: {
          entity: refund,
          event: refundsJournal.events.RefundApproved,
          id: e => refundRunId(e.entityId),
          input: e => ({ refundId: e.entityId }),
        },
      })
      // Look up, then act: after a crash between `processRefund` and the checkpoint the row is already `processing`
      .step(
        'begin',
        async ({ input, db, run }) => {
          const row = await readRefund(db, input.refundId);
          if (isFailure(row)) return row;

          if (row.status === 'approved') {
            const processing = await run(commands.processRefund, { refundId: input.refundId });
            if (isFailure(processing)) return processing;
          } else if (row.status !== 'processing') {
            return RefundInvalidState({ refundId: input.refundId, status: row.status });
          }

          return {
            paymentId: row.paymentId,
            amountMinor: row.refundAmountMinor,
            currency: row.currency ?? 'USD',
            reason: row.reason,
          };
        },
        {
          output: z.object({
            paymentId: paymentIdSchema,
            amountMinor: z.int(),
            currency: z.string(),
            reason: z.enum(refundReasonValues),
          }),
        },
      )
      .step(
        'payBack',
        async ({ input, results, key, db, run, stripe }) => {
          const provider = stripe(db);
          const { paymentId, amountMinor, currency, reason } = results.begin;

          // Stripe forgets an idempotency key after 24 hours, and a dead step can be retried later than that
          const found = await provider.findRefund(paymentId, input.refundId);
          if (isFailure(found)) return found;

          const answer =
            found ??
            (await provider.refundPayment(paymentId, {
              refundId: input.refundId,
              // The same on every try of this step: Stripe answers a repeat with the first refund
              idempotencyKey: key,
              amount: fromMinorColumn(amountMinor, currency),
              reason,
              metadata: { internalReason: reason },
            }));
          if (isFailure(answer)) return answer;

          if (answer.status === 'succeeded') {
            const completed = await run(commands.completeRefund, {
              refundId: input.refundId,
              providerRefundId: answer.providerRefundId,
              providerResponse: JSON.stringify(answer),
            });
            if (isFailure(completed)) return completed;
          }

          // `failed` and `canceled` are data here: `record` fails the row
          return { providerRefundId: answer.providerRefundId, status: answer.status };
        },
        {
          // An operator who finds the refund at Stripe gives this by hand (`resolveStep`)
          output: z.object({ providerRefundId: z.string().min(1), status: z.string().nullable() }),
          retry: payBackRetry,
        },
      )
      .waitFor('settled', {
        signal: 'stripe.refund.settled',
        schema: settledSchema,
        timeout: '3d',
        // No signal in 3 days: `record` asks Stripe
        onTimeout: 'continue',
        // Stripe already said where the refund ends: no webhook needed
        when: ({ results }) => !isSettled(results.payBack.status),
      })
      .step(
        'record',
        async ({ input, results, db, run, stripe }) => {
          const { payBack } = results;
          let settled =
            results.settled ??
            (isSettled(payBack.status) ? { providerRefundId: payBack.providerRefundId, status: payBack.status } : null);
          let failureReason: string | null = null;

          // No signal came, or Stripe failed the refund: ask Stripe where it stands, and why
          if (settled === null || settled.status !== 'succeeded') {
            const found = await stripe(db).findRefund(results.begin.paymentId, input.refundId);
            if (isFailure(found)) return found;
            if (found !== null && isSettled(found.status)) {
              settled = { providerRefundId: found.providerRefundId, status: found.status };
              failureReason = found.failureReason;
            }
          }

          if (settled === null) {
            // Thrown, not returned: the step's backoff asks Stripe again
            throw new RefundNotSettled(
              `Stripe refund ${payBack.providerRefundId} of refund ${input.refundId} is still ${payBack.status ?? 'without a status'}`,
            );
          }

          if (settled.status === 'succeeded') {
            // Idempotent: `payBack` may have completed the row already
            const completed = await run(commands.completeRefund, {
              refundId: input.refundId,
              providerRefundId: settled.providerRefundId,
              providerResponse: JSON.stringify(settled),
            });
            if (isFailure(completed)) return completed;

            return {
              providerRefundId: settled.providerRefundId,
              outcome: 'completed' as const,
              errorMessage: null,
              lateFailure: null,
            };
          }

          const why = failureReason === null ? '' : `: ${failureReason}`;
          const errorMessage = `Stripe refund ${settled.providerRefundId} ${settled.status}${why}`;
          const row = await readRefund(db, input.refundId);
          if (isFailure(row)) return row;

          if (row.status === 'completed') {
            // Stripe failed a refund it had reported succeeded. The row stays completed, and so does the run;
            // support is alerted in `notify`
            logger.error('Refund {refundId} is completed, but Stripe now reports {providerRefundId} as {status}', {
              refundId: input.refundId,
              providerRefundId: settled.providerRefundId,
              status: settled.status,
            });
            return {
              providerRefundId: settled.providerRefundId,
              outcome: 'completed' as const,
              errorMessage,
              lateFailure: failureReason ?? 'unknown',
            };
          }

          // A re-run after `failRefund` committed finds the row `failed` already
          if (row.status === 'processing') {
            const failed = await run(commands.failRefund, { refundId: input.refundId, errorMessage });
            if (isFailure(failed)) return failed;
          }

          return {
            providerRefundId: settled.providerRefundId,
            outcome: 'failed' as const,
            errorMessage,
            lateFailure: null,
          };
        },
        { retry: recordRetry },
      )
      .step('notify', async ({ input, results, db, notifications }) => {
        const row = await readRefund(db, input.refundId);
        if (isFailure(row)) return row;

        // A late failure alerts support only: the customer was never told the refund completed
        if (results.record.errorMessage === null) {
          await notifications.sendRefundStatusUpdate?.(row, 'completed');
        } else {
          await notifications.sendRefundFailureAlert?.(row, new Error(results.record.errorMessage));
        }

        return null;
      })
      .finish(({ results }) => {
        const { providerRefundId, outcome, lateFailure } = results.record;
        return lateFailure === null ? { providerRefundId, outcome } : { providerRefundId, outcome, lateFailure };
      })
  );
}
