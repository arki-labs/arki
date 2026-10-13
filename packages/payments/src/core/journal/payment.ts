/**
 * Payment on the journal: its events, the entity and the commands
 *
 * One `payments` row is the current state of a payment, keyed by its id.
 * A payment starts `pending` and ends `succeeded`, `failed` or `canceled`.
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

export type InitiatePaymentInput = z.input<typeof initiatePaymentInputSchema>;
export type CompletePaymentInput = z.input<typeof completePaymentInputSchema>;
export type FailPaymentInput = z.input<typeof failPaymentInputSchema>;
export type CancelPaymentInput = z.input<typeof cancelPaymentInputSchema>;

function requirePayment(row: PaymentRow | null, paymentId: string): PaymentRow {
  if (!row) {
    throw new CommandError('NOT_FOUND', `Payment ${paymentId} not found`);
  }

  return row;
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
    .on(PaymentCanceled, (_row, e) => ({ status: 'canceled', updatedAt: fromDate(e.recordedAt) }));

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

  const completePayment = j.command('completePayment', completePaymentInputSchema, (input, { write }) =>
    write(payment, input.paymentId, row => {
      const current = requirePayment(row, input.paymentId);

      if (current.status !== 'pending' && current.status !== 'processing') {
        throw new CommandError('CONFLICT', `Cannot complete payment with status ${current.status}`);
      }

      return [PaymentCompleted({ receiptUrl: input.receiptUrl ?? null })];
    }),
  );

  const failPayment = j.command('failPayment', failPaymentInputSchema, (input, { write }) =>
    write(payment, input.paymentId, row => {
      const current = requirePayment(row, input.paymentId);

      if (current.status !== 'pending' && current.status !== 'processing') {
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

  return {
    payment,
    events: { PaymentInitiated, PaymentInitiatedV2, PaymentCompleted, PaymentFailed, PaymentCanceled },
    commands: { initiatePayment, completePayment, failPayment, cancelPayment },
  };
}
