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
import type { EventDef, JournalDefinitions, RootDb, TransactionSource } from '@arki/journal';
import type { StandardSchemaV1 } from '@arki/schema';
import { userIdSchema } from '../user-id.js';
import { z } from '@arki/contracts';
import { fromDate } from '@arki/date';
import { isFailure, orThrow } from '@arki/failure';
import { CommandConflict, CommandInvalid, CommandNotFound } from '@arki/journal';
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

const paymentStart = {
  subscriptionId: subscriptionIdSchema.nullable(),
  userId: userIdSchema,
  customerId: customerIdSchema,
  providerPaymentId: z.string(),
  paymentMethod: paymentMethodSchema,
  description: z.string().nullable(),
  metadata: metadataSchema.nullable(),
};
const paymentInitiatedSchema = z.object({ ...paymentStart, amount: z.number(), currency: z.string() });
const paymentInitiatedV2Schema = z.object({ ...paymentStart, amount: moneyJsonSchema });
const paymentCompletedSchema = z.object({ receiptUrl: z.string().nullable() });
const paymentFailedSchema = z.object({ failureReason: z.string() });
const paymentCanceledSchema = z.object({});
const paymentRequiresActionSchema = z.object({});
const paymentRefundRecordedSchema = z.object({ refundedAmount: moneyJsonSchema });
const paymentDisputeRecordedSchema = z.object({
  disputeId: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
});

// The events have names (interfaces over `EventDef`), so the journal's types say `PaymentCompletedEvent`
// instead of the event's whole schema type, in declaration files and editor hovers alike.
/** Before minor units: a payment was started, its amount a JS number of major units. Replay only. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface PaymentInitiatedEvent extends EventDef<'PaymentInitiated', typeof paymentInitiatedSchema> {}
/** A payment was started with the provider. It is `pending`. The amount is exact `Money` JSON. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface PaymentInitiatedV2Event extends EventDef<'PaymentInitiatedV2', typeof paymentInitiatedV2Schema> {}
/** The provider collected the money. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface PaymentCompletedEvent extends EventDef<'PaymentCompleted', typeof paymentCompletedSchema> {}
/** The provider could not collect the money. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface PaymentFailedEvent extends EventDef<'PaymentFailed', typeof paymentFailedSchema> {}
/** The payment was canceled before it finished. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface PaymentCanceledEvent extends EventDef<'PaymentCanceled', typeof paymentCanceledSchema> {}
/** The provider needs the customer to act (for example 3-D Secure) before the payment can finish. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface PaymentRequiresActionEvent extends EventDef<
  'PaymentRequiresAction',
  typeof paymentRequiresActionSchema
> {}
/** The provider refunded part or all of the payment. `refundedAmount` is the exact total refunded so far, as `Money` JSON. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface PaymentRefundRecordedEvent extends EventDef<
  'PaymentRefundRecorded',
  typeof paymentRefundRecordedSchema
> {}
/** The customer's bank opened a dispute on the payment, or the dispute changed status. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface PaymentDisputeRecordedEvent extends EventDef<
  'PaymentDisputeRecorded',
  typeof paymentDisputeRecordedSchema
> {}

function requirePayment(row: PaymentRow | null, paymentId: string): PaymentRow | CommandNotFound {
  if (!row) {
    return CommandNotFound({ detail: `Payment ${paymentId} not found` });
  }

  return row;
}

/** A payment the provider has not settled yet: it may still succeed, fail or need the customer. */
function isOpen(status: PaymentRow['status']): boolean {
  return status === 'pending' || status === 'processing' || status === 'requires_action';
}

export function createPaymentJournal<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(j: JournalDefinitions<Meta, Tx, AppDb>, payments: CoreTables['payments']) {
  const PaymentInitiated: PaymentInitiatedEvent = j.event('PaymentInitiated', paymentInitiatedSchema);
  const PaymentInitiatedV2: PaymentInitiatedV2Event = j.event('PaymentInitiatedV2', paymentInitiatedV2Schema);
  const PaymentCompleted: PaymentCompletedEvent = j.event('PaymentCompleted', paymentCompletedSchema);
  const PaymentFailed: PaymentFailedEvent = j.event('PaymentFailed', paymentFailedSchema);
  const PaymentCanceled: PaymentCanceledEvent = j.event('PaymentCanceled', paymentCanceledSchema);
  const PaymentRequiresAction: PaymentRequiresActionEvent = j.event(
    'PaymentRequiresAction',
    paymentRequiresActionSchema,
  );
  const PaymentRefundRecorded: PaymentRefundRecordedEvent = j.event(
    'PaymentRefundRecorded',
    paymentRefundRecordedSchema,
  );
  const PaymentDisputeRecorded: PaymentDisputeRecordedEvent = j.event(
    'PaymentDisputeRecorded',
    paymentDisputeRecordedSchema,
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
    // The two `orThrow` reads below fold events this journal wrote itself, from `Money#toJSON()` after the
    // command's schema accepted the amount. A fold cannot return a failure; a refusal here is a corrupt
    // event log (a bug), so it throws.
    .create(PaymentInitiatedV2, e =>
      started(e.data, toMinorColumn(orThrow(Money.fromJSON(e.data.amount))), e.data.amount.currency, fromDate(e.recordedAt)),
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
      const refundedAmount = orThrow(Money.fromJSON(e.data.refundedAmount));

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

  const initiatePayment = j.command(
    'initiatePayment',
    initiatePaymentInputSchema,
    { writes: [PaymentInitiatedV2] },
    (input, { write }) => {
      const paymentId = input.paymentId ?? createPaymentId();
      if (isFailure(paymentId)) return paymentId;

      return write(payment, paymentId, row => {
        if (row) {
          return CommandConflict({ detail: `Payment ${paymentId} already exists with status ${row.status}` });
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
    },
  );

  /**
   * The money was collected. An open payment completes, and so does a `failed`
   * one: the customer retried on the same provider payment and it succeeded.
   */
  const completePayment = j.command(
    'completePayment',
    completePaymentInputSchema,
    { writes: [PaymentCompleted] },
    (input, { write }) =>
      write(payment, input.paymentId, row => {
        const current = requirePayment(row, input.paymentId);
        if (isFailure(current)) return current;

        if (!isOpen(current.status) && current.status !== 'failed') {
          return CommandConflict({ detail: `Cannot complete payment with status ${current.status}` });
        }

        return [PaymentCompleted({ receiptUrl: input.receiptUrl ?? null })];
      }),
  );

  /** Only an open payment fails. A `succeeded` payment never moves back to `failed`. */
  const failPayment = j.command(
    'failPayment',
    failPaymentInputSchema,
    { writes: [PaymentFailed] },
    (input, { write }) =>
      write(payment, input.paymentId, row => {
        const current = requirePayment(row, input.paymentId);
        if (isFailure(current)) return current;

        if (!isOpen(current.status)) {
          return CommandConflict({ detail: `Cannot fail payment with status ${current.status}` });
        }

        return [PaymentFailed({ failureReason: input.failureReason })];
      }),
  );

  const cancelPayment = j.command(
    'cancelPayment',
    cancelPaymentInputSchema,
    { writes: [PaymentCanceled] },
    (input, { write }) =>
      write(payment, input.paymentId, row => {
        const current = requirePayment(row, input.paymentId);
        if (isFailure(current)) return current;

        if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'canceled') {
          return CommandConflict({ detail: `Cannot cancel payment with status ${current.status}` });
        }

        return [PaymentCanceled({})];
      }),
  );

  /** The customer must act before the payment can finish. Repeating it on a payment that already waits writes nothing. */
  const markPaymentRequiresAction = j.command(
    'markPaymentRequiresAction',
    markPaymentRequiresActionInputSchema,
    { writes: [PaymentRequiresAction] },
    (input, { write }) =>
      write(payment, input.paymentId, row => {
        const current = requirePayment(row, input.paymentId);
        if (isFailure(current)) return current;

        if (current.status === 'requires_action') {
          return [];
        }

        if (!isOpen(current.status)) {
          return CommandConflict({ detail: `Cannot mark payment with status ${current.status} as requiring action` });
        }

        return [PaymentRequiresAction({})];
      }),
  );

  /**
   * The provider refunded part or all of a payment that was collected. The command takes the
   * running total, so a webhook delivered twice, or after a later one, never lowers or doubles it.
   */
  const recordPaymentRefund = j.command(
    'recordPaymentRefund',
    recordPaymentRefundInputSchema,
    { writes: [PaymentRefundRecorded] },
    (input, { write }) =>
      write(payment, input.paymentId, row => {
        const current = requirePayment(row, input.paymentId);
        if (isFailure(current)) return current;

        if (current.status !== 'succeeded') {
          return CommandConflict({ detail: `Cannot refund payment with status ${current.status}` });
        }
        if (input.refundedAmount.currency.code !== current.currency.toUpperCase()) {
          return CommandInvalid({
            detail: `Refund is in ${input.refundedAmount.currency.code}, payment is in ${current.currency}`,
          });
        }

        const refundedMinor = toMinorColumn(input.refundedAmount);
        if (refundedMinor > current.amountMinor) {
          return CommandInvalid({ detail: `Refund of ${refundedMinor} exceeds the payment of ${current.amountMinor}` });
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
    { writes: [PaymentDisputeRecorded] },
    (input, { write }) =>
      write(payment, input.paymentId, row => {
        const current = requirePayment(row, input.paymentId);
        if (isFailure(current)) return current;

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

/** What `createPaymentJournal` returns for one app's journal definitions. */
export type PaymentJournal<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = ReturnType<typeof createPaymentJournal<Meta, Tx, AppDb>>;
