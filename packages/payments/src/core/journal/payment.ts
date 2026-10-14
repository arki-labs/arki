/**
 * Payment on the journal: its events, the entity and the commands
 *
 * One `payments` row is the current state of a payment, keyed by its id.
 * A payment starts `pending`, may wait in `requires_action` for the customer,
 * and ends `succeeded`, `failed` or `canceled`. A `failed` payment can still
 * succeed (the customer retried with the provider); a `succeeded` one never
 * fails.
 *
 * The command takes the amount as `Money` JSON (`{ amount: '19.99',
 * currency: 'USD' }`), and `PaymentInitiatedV2` keeps it in that form, exact.
 * The row holds it as whole minor units (`amount_minor`) beside `currency`.
 *
 * `PaymentInitiated` is the event written while `amount` was a `real` column:
 * a JS number of major units. No command writes it any more; it stays declared
 * so stored payments still replay. Its reducer rebuilds what the column
 * migration wrote: the `real` value (see `storedReal`), rounded half-even to
 * the currency's minor units.
 */

import type { Instant } from '@arki/date';
import type { JournalDefinitions, RootDb, TransactionSource } from '@arki/journal';
import { userIdSchema } from '../user-id.js';
import { z } from '@arki/contracts';
import { fromDate } from '@arki/date';
import { CommandError } from '@arki/journal';
import { Money } from '@arki/money';

import type { CoreTables } from '../tables.js';
import { fromStoredNumber, moneyJsonSchema, nonNegativeMoneySchema, toMinorColumn } from '../money.js';
import {
  createPaymentId,
  customerIdSchema,
  paymentIdSchema,
  paymentMethodTypeValues,
  subscriptionIdSchema,
} from '../primitives.js';
import { storedReal } from './support.js';

type PaymentRow = CoreTables['payments']['$inferSelect'];

const paymentMethodSchema = z.enum(paymentMethodTypeValues);
const metadataSchema = z.record(z.string(), z.unknown());

export const initiatePaymentInputSchema = z.object({
  /** Left out: the command makes a new id */
  paymentId: paymentIdSchema.optional(),
  subscriptionId: subscriptionIdSchema.nullable().optional(),
  userId: userIdSchema,
  customerId: customerIdSchema,
  providerPaymentId: z.string().min(1).max(255),
  amount: nonNegativeMoneySchema,
  paymentMethod: paymentMethodSchema.default('card'),
  description: z.string().nullable().optional(),
  metadata: metadataSchema.nullable().optional(),
});

export const completePaymentInputSchema = z.object({
  paymentId: paymentIdSchema,
  receiptUrl: z.string().nullable().optional(),
});

export const failPaymentInputSchema = z.object({ paymentId: paymentIdSchema, failureReason: z.string() });

export const cancelPaymentInputSchema = z.object({ paymentId: paymentIdSchema });

export const markPaymentRequiresActionInputSchema = z.object({ paymentId: paymentIdSchema });

/** `refundedAmount` is the total refunded so far, not this refund alone: a resent report writes nothing. */
export const recordPaymentRefundInputSchema = z.object({
  paymentId: paymentIdSchema,
  refundedAmount: nonNegativeMoneySchema,
});

export const recordPaymentDisputeInputSchema = z.object({
  paymentId: paymentIdSchema,
  disputeId: z.string().min(1).max(255),
  status: z.string().min(1).max(64),
  reason: z.string().nullable().optional(),
});

export type InitiatePaymentInput = z.input<typeof initiatePaymentInputSchema>;
export type CompletePaymentInput = z.input<typeof completePaymentInputSchema>;
export type FailPaymentInput = z.input<typeof failPaymentInputSchema>;
export type CancelPaymentInput = z.input<typeof cancelPaymentInputSchema>;
export type MarkPaymentRequiresActionInput = z.input<typeof markPaymentRequiresActionInputSchema>;
export type RecordPaymentRefundInput = z.input<typeof recordPaymentRefundInputSchema>;
export type RecordPaymentDisputeInput = z.input<typeof recordPaymentDisputeInputSchema>;

function requirePayment(row: PaymentRow | null, paymentId: string): PaymentRow {
  if (!row) {
    throw new CommandError('NOT_FOUND', `Payment ${paymentId} not found`);
  }

  return row;
}

/** A payment the provider has not settled yet: it may still succeed, fail or need the customer. */
function isOpen(status: PaymentRow['status']): boolean {
  return status === 'pending' || status === 'processing' || status === 'requires_action';
}

export function createPaymentJournal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  j: JournalDefinitions<Meta, Tx, AppDb>,
  payments: CoreTables['payments'],
) {
  const paymentStart = {
    subscriptionId: subscriptionIdSchema.nullable(),
    userId: userIdSchema,
    customerId: customerIdSchema,
    providerPaymentId: z.string(),
    paymentMethod: paymentMethodSchema,
    description: z.string().nullable(),
    metadata: metadataSchema.nullable(),
  };
  /** Before minor units: a payment was started, its amount a JS number of major units. Replay only. */
  const PaymentInitiated = j.event(
    'PaymentInitiated',
    z.object({ ...paymentStart, amount: z.number(), currency: z.string() }),
  );
  /** A payment was started with the provider. It is `pending`. The amount is exact `Money` JSON. */
  const PaymentInitiatedV2 = j.event('PaymentInitiatedV2', z.object({ ...paymentStart, amount: moneyJsonSchema }));
  const PaymentCompleted = j.event('PaymentCompleted', z.object({ receiptUrl: z.string().nullable() }));
  const PaymentFailed = j.event('PaymentFailed', z.object({ failureReason: z.string() }));
  const PaymentCanceled = j.event('PaymentCanceled', z.object({}));
  /** The provider needs the customer to act (for example 3-D Secure) before the payment can finish. */
  const PaymentRequiresAction = j.event('PaymentRequiresAction', z.object({}));
  /** The provider refunded part or all of the payment. `refundedAmount` is the exact total refunded so far, as `Money` JSON. */
  const PaymentRefundRecorded = j.event('PaymentRefundRecorded', z.object({ refundedAmount: moneyJsonSchema }));
  /** The customer's bank opened a dispute on the payment, or the dispute changed status. */
  const PaymentDisputeRecorded = j.event(
    'PaymentDisputeRecorded',
    z.object({ disputeId: z.string(), status: z.string(), reason: z.string().nullable() }),
  );

  type StartData = z.output<typeof PaymentInitiatedV2.schema>;
  const started = (data: Omit<StartData, 'amount'>, amountMinor: number, currency: string, at: Instant) =>
    ({
      subscriptionId: data.subscriptionId,
      userId: data.userId,
      customerId: data.customerId,
      providerPaymentId: data.providerPaymentId,
      amountMinor,
      currency,
      status: 'pending' as const,
      paymentMethod: data.paymentMethod,
      description: data.description,
      failureReason: null,
      receiptUrl: null,
      refunded: false,
      refundedAmountMinor: 0,
      disputeId: null,
      disputeStatus: null,
      metadata: data.metadata,
      createdAt: at,
      updatedAt: at,
    });

  const payment = j
    .entity('payment', payments)
    .create(PaymentInitiated, e =>
      started(
        e.data,
        toMinorColumn(fromStoredNumber(storedReal(e.data.amount), e.data.currency)),
        e.data.currency,
        fromDate(e.recordedAt),
      ),
    )
    .create(PaymentInitiatedV2, e =>
      started(e.data, toMinorColumn(Money.fromJSON(e.data.amount)), e.data.amount.currency, fromDate(e.recordedAt)),
    )
    .on(PaymentCompleted, (_row, e) => ({
      status: 'succeeded',
      receiptUrl: e.data.receiptUrl,
      updatedAt: fromDate(e.recordedAt),
    }))
    .on(PaymentFailed, (_row, e) => ({
      status: 'failed',
      failureReason: e.data.failureReason,
      updatedAt: fromDate(e.recordedAt),
    }))
    .on(PaymentCanceled, (_row, e) => ({ status: 'canceled', updatedAt: fromDate(e.recordedAt) }))
    .on(PaymentRequiresAction, (_row, e) => ({ status: 'requires_action', updatedAt: fromDate(e.recordedAt) }))
    .on(PaymentRefundRecorded, (_row, e) => {
      const refundedAmount = Money.fromJSON(e.data.refundedAmount);

      return {
        refunded: !refundedAmount.isZero(),
        refundedAmountMinor: toMinorColumn(refundedAmount),
        updatedAt: fromDate(e.recordedAt),
      };
    })
    .on(PaymentDisputeRecorded, (_row, e) => ({
      disputeId: e.data.disputeId,
      disputeStatus: e.data.status,
      updatedAt: fromDate(e.recordedAt),
    }));

  const initiatePayment = j.command('initiatePayment', initiatePaymentInputSchema, (input, { write }) => {
    const paymentId = input.paymentId ?? createPaymentId();

    return write(payment, paymentId, row => {
      if (row) {
        throw new CommandError('CONFLICT', `Payment ${paymentId} already exists with status ${row.status}`);
      }

      return [
        PaymentInitiatedV2({
          subscriptionId: input.subscriptionId ?? null,
          userId: input.userId,
          customerId: input.customerId,
          providerPaymentId: input.providerPaymentId,
          amount: input.amount.toJSON(),
          paymentMethod: input.paymentMethod,
          description: input.description ?? null,
          metadata: input.metadata ?? null,
        }),
      ];
    });
  });

  /**
   * The money was collected. An open payment completes, and so does a `failed`
   * one: the customer retried on the same provider payment and it succeeded.
   */
  const completePayment = j.command('completePayment', completePaymentInputSchema, (input, { write }) =>
    write(payment, input.paymentId, row => {
      const current = requirePayment(row, input.paymentId);

      if (!isOpen(current.status) && current.status !== 'failed') {
        throw new CommandError('CONFLICT', `Cannot complete payment with status ${current.status}`);
      }

      return [PaymentCompleted({ receiptUrl: input.receiptUrl ?? null })];
    }),
  );

  /** Only an open payment fails. A `succeeded` payment never moves back to `failed`. */
  const failPayment = j.command('failPayment', failPaymentInputSchema, (input, { write }) =>
    write(payment, input.paymentId, row => {
      const current = requirePayment(row, input.paymentId);

      if (!isOpen(current.status)) {
        throw new CommandError('CONFLICT', `Cannot fail payment with status ${current.status}`);
      }

      return [PaymentFailed({ failureReason: input.failureReason })];
    }),
  );

  const cancelPayment = j.command('cancelPayment', cancelPaymentInputSchema, (input, { write }) =>
    write(payment, input.paymentId, row => {
      const current = requirePayment(row, input.paymentId);

      if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'canceled') {
        throw new CommandError('CONFLICT', `Cannot cancel payment with status ${current.status}`);
      }

      return [PaymentCanceled({})];
    }),
  );

  /** The customer must act before the payment can finish. Repeating it on a payment that already waits writes nothing. */
  const markPaymentRequiresAction = j.command(
    'markPaymentRequiresAction',
    markPaymentRequiresActionInputSchema,
    (input, { write }) =>
      write(payment, input.paymentId, row => {
        const current = requirePayment(row, input.paymentId);

        if (current.status === 'requires_action') {
          return [];
        }

        if (!isOpen(current.status)) {
          throw new CommandError('CONFLICT', `Cannot mark payment with status ${current.status} as requiring action`);
        }

        return [PaymentRequiresAction({})];
      }),
  );

  /**
   * The provider refunded part or all of a payment that was collected. The command takes the
   * running total, so a webhook delivered twice, or after a later one, never lowers or doubles it.
   */
  const recordPaymentRefund = j.command('recordPaymentRefund', recordPaymentRefundInputSchema, (input, { write }) =>
    write(payment, input.paymentId, row => {
      const current = requirePayment(row, input.paymentId);

      if (current.status !== 'succeeded') {
        throw new CommandError('CONFLICT', `Cannot refund payment with status ${current.status}`);
      }
      if (input.refundedAmount.currency.code !== current.currency.toUpperCase()) {
        throw new CommandError(
          'BAD_REQUEST',
          `Refund is in ${input.refundedAmount.currency.code}, payment is in ${current.currency}`,
        );
      }

      const refundedMinor = toMinorColumn(input.refundedAmount);
      if (refundedMinor > current.amountMinor) {
        throw new CommandError('BAD_REQUEST', `Refund of ${refundedMinor} exceeds the payment of ${current.amountMinor}`);
      }
      // Not higher than what is recorded: a resent or out-of-order report
      if (refundedMinor <= current.refundedAmountMinor) {
        return [];
      }

      return [PaymentRefundRecorded({ refundedAmount: input.refundedAmount.toJSON() })];
    }),
  );

  /** A dispute opened, or changed status. The same dispute and status again writes nothing. */
  const recordPaymentDispute = j.command(
    'recordPaymentDispute',
    recordPaymentDisputeInputSchema,
    (input, { write }) =>
      write(payment, input.paymentId, row => {
        const current = requirePayment(row, input.paymentId);

        if (current.disputeId === input.disputeId && current.disputeStatus === input.status) {
          return [];
        }

        return [
          PaymentDisputeRecorded({
            disputeId: input.disputeId,
            status: input.status,
            reason: input.reason ?? null,
          }),
        ];
      }),
  );

  return {
    payment,
    events: {
      PaymentRefundRecorded,
      PaymentDisputeRecorded,
      PaymentInitiated,
      PaymentInitiatedV2,
      PaymentCompleted,
      PaymentFailed,
      PaymentCanceled,
      PaymentRequiresAction,
    },
    commands: {
      initiatePayment,
      completePayment,
      failPayment,
      cancelPayment,
      markPaymentRequiresAction,
      recordPaymentRefund,
      recordPaymentDispute,
    },
  };
}
