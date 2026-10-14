/**
 * Refunds on `@arki/journal`
 *
 * `createRefundsJournal(j, { refunds })` takes the app's journal definitions
 * and the app's `refunds` table. It returns the entity, the events, the
 * commands, and `writes(run)`: plain async functions for `RefundService`.
 *
 * A refund goes: requested (`pending`) → approved or rejected → processing →
 * completed or failed. Every step is one command and one event.
 *
 * Who approved, rejected or requested is command input, not journal metadata:
 * the metadata belongs to the app, and these are columns of the row anyway.
 *
 * Event data is plain JSON. Times come from `e.recordedAt`. Commands take
 * amounts as `Money` JSON (`{ amount: '25.50', currency: 'EUR' }`) and check
 * them exactly. `RefundRequestedV2` keeps them in that form; the row holds
 * whole minor units (`*_amount_minor`) beside `currency`.
 *
 * `RefundRequested` is the event written while the amounts were
 * `decimal(10,2)` columns: JS numbers of major units. No command writes it any
 * more; it stays declared so stored refunds still replay. Its reducer rebuilds
 * what the column migration wrote: the two-decimal text the column held,
 * rounded half-even to the currency's minor units.
 */

import type { Instant } from '@arki/date';
import type { CommandRunner, JournalDefinitions, RootDb, TransactionSource } from '@arki/journal';
import { userIdSchema } from '../core/user-id.js';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { z } from '@arki/contracts';
import { fromDate } from '@arki/date';
import { CommandError } from '@arki/journal';
import { Money } from '@arki/money';
import { anyMoneySchema } from '@arki/money/zod';

import type { CoreTables } from '../core/tables.js';
import type { RefundsTables } from './tables.js';
import type { Refund } from './types.js';
import { writtenRow } from '../core/journal/support.js';
import { fromStoredNumber, moneyJsonSchema, toMinorColumn } from '../core/money.js';
import { paymentIdSchema } from '../core/primitives.js';
import { createRefundId, refundIdSchema, refundReasonValues } from './primitives.js';

type RefundRow = RefundsTables['refunds']['$inferSelect'];

const reasonSchema = z.enum(refundReasonValues);

export const requestRefundInputSchema = z.object({
  /** Left out: the command makes a new id */
  refundId: refundIdSchema.optional(),
  paymentId: paymentIdSchema,
  /** The two amounts share one currency, which is the refund's */
  originalAmount: anyMoneySchema(),
  refundAmount: anyMoneySchema(),
  reason: reasonSchema,
  customerNote: z.string().nullable().optional(),
  internalNotes: z.string().nullable().optional(),
  requestedBy: userIdSchema,
  /** A JSON string: the column is `text` */
  metadata: z.string().nullable().optional(),
});

export const approveRefundInputSchema = z.object({
  refundId: refundIdSchema,
  approvedBy: userIdSchema,
  /** The approver's notes. Left out or null: none. */
  notes: z.string().nullable().optional(),
});

export const rejectRefundInputSchema = z.object({
  refundId: refundIdSchema,
  rejectedBy: userIdSchema,
  /** The customer-facing why. A blank reason says nothing, so it is turned down. */
  rejectionReason: z.string().trim().min(1),
});

export const processRefundInputSchema = z.object({ refundId: refundIdSchema });

export const completeRefundInputSchema = z.object({
  refundId: refundIdSchema,
  /** The provider's id of the refund. It is known only when the provider answered. */
  providerRefundId: z.string().min(1).max(255),
  providerResponse: z.string().nullable().optional(),
});

export const failRefundInputSchema = z.object({ refundId: refundIdSchema, errorMessage: z.string() });

export type RequestRefundInput = z.input<typeof requestRefundInputSchema>;
export type ApproveRefundInput = z.input<typeof approveRefundInputSchema>;
export type RejectRefundInput = z.input<typeof rejectRefundInputSchema>;
export type ProcessRefundInput = z.input<typeof processRefundInputSchema>;
export type CompleteRefundInput = z.input<typeof completeRefundInputSchema>;
export type FailRefundInput = z.input<typeof failRefundInputSchema>;

/**
 * What `RefundService` calls to change a refund. Each function runs one
 * command and returns the row as it is after the write.
 */
export type RefundWrites = {
  requestRefund(input: RequestRefundInput): Promise<Refund>;
  approveRefund(input: ApproveRefundInput): Promise<Refund>;
  rejectRefund(input: RejectRefundInput): Promise<Refund>;
  processRefund(input: ProcessRefundInput): Promise<Refund>;
  completeRefund(input: CompleteRefundInput): Promise<Refund>;
  failRefund(input: FailRefundInput): Promise<Refund>;
};

function requireRefund(row: RefundRow | null, refundId: string): RefundRow {
  if (!row) {
    throw new CommandError('NOT_FOUND', `Refund ${refundId} not found`);
  }

  return row;
}

/** What a `decimal(10,2)` column held for a legacy amount, in minor units of `currency`. */
function legacyMinor(amount: number, currency: string): number {
  return toMinorColumn(fromStoredNumber(Number(amount.toFixed(2)), currency));
}

export function createRefundsJournal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  j: JournalDefinitions<Meta, Tx, AppDb>,
  tables: Pick<RefundsTables, 'refunds'> & Pick<CoreTables, 'payments'>,
) {
  const { payments } = tables;
  const refundRequest = {
    paymentId: paymentIdSchema,
    reason: reasonSchema,
    customerNote: z.string().nullable(),
    internalNotes: z.string().nullable(),
    requestedBy: userIdSchema,
    metadata: z.string().nullable(),
  };
  /** Before minor units: a refund was asked for, its amounts JS numbers of major units. Replay only. */
  const RefundRequested = j.event(
    'RefundRequested',
    z.object({ ...refundRequest, originalAmount: z.number(), refundAmount: z.number(), currency: z.string() }),
  );
  /** A refund was asked for. It is `pending`. Both amounts are exact `Money` JSON in the refund's currency. */
  const RefundRequestedV2 = j.event(
    'RefundRequestedV2',
    z.object({ ...refundRequest, originalAmount: moneyJsonSchema, refundAmount: moneyJsonSchema }),
  );
  // `notes` is optional: refunds approved before approval notes existed have events without it
  const RefundApproved = j.event('RefundApproved', z.object({ approvedBy: userIdSchema, notes: z.string().nullable().optional() }));
  const RefundRejected = j.event('RefundRejected', z.object({ rejectedBy: userIdSchema, rejectionReason: z.string() }));
  /** The refund was handed to the provider. The provider's refund id is not known yet. */
  const RefundProcessed = j.event('RefundProcessed', z.object({}));
  const RefundCompleted = j.event(
    'RefundCompleted',
    z.object({ providerRefundId: z.string(), providerResponse: z.string().nullable() }),
  );
  const RefundFailed = j.event('RefundFailed', z.object({ errorMessage: z.string() }));

  type RequestData = Pick<z.output<typeof RefundRequestedV2.schema>, keyof typeof refundRequest>;
  const requested = (
    data: RequestData,
    originalAmountMinor: number,
    refundAmountMinor: number,
    currency: string,
    at: Instant,
  ) => ({
    paymentId: data.paymentId,
    originalAmountMinor,
    refundAmountMinor,
    currency,
    reason: data.reason,
    status: 'pending' as const,
    providerRefundId: null,
    providerResponse: null,
    requestedBy: data.requestedBy,
    approvedBy: null,
    rejectedBy: null,
    rejectionReason: null,
    approvalNotes: null,
    requestedAt: at,
    approvedAt: null,
    processedAt: null,
    completedAt: null,
    internalNotes: data.internalNotes,
    customerNote: data.customerNote,
    metadata: data.metadata,
    createdAt: at,
    updatedAt: at,
  });

  const refund = j
    .entity('refund', tables.refunds)
    .create(RefundRequested, e =>
      requested(
        e.data,
        legacyMinor(e.data.originalAmount, e.data.currency),
        legacyMinor(e.data.refundAmount, e.data.currency),
        e.data.currency,
        fromDate(e.recordedAt),
      ),
    )
    .create(RefundRequestedV2, e =>
      requested(
        e.data,
        toMinorColumn(Money.fromJSON(e.data.originalAmount)),
        toMinorColumn(Money.fromJSON(e.data.refundAmount)),
        e.data.refundAmount.currency,
        fromDate(e.recordedAt),
      ),
    )
    .on(RefundApproved, (_row, e) => ({
      status: 'approved',
      approvedBy: e.data.approvedBy,
      approvalNotes: e.data.notes ?? null,
      approvedAt: fromDate(e.recordedAt),
      updatedAt: fromDate(e.recordedAt),
    }))
    .on(RefundRejected, (_row, e) => ({
      status: 'rejected',
      rejectedBy: e.data.rejectedBy,
      rejectionReason: e.data.rejectionReason,
      updatedAt: fromDate(e.recordedAt),
    }))
    .on(RefundProcessed, (_row, e) => ({ status: 'processing', processedAt: fromDate(e.recordedAt), updatedAt: fromDate(e.recordedAt) }))
    .on(RefundCompleted, (_row, e) => ({
      status: 'completed',
      providerRefundId: e.data.providerRefundId,
      providerResponse: e.data.providerResponse,
      completedAt: fromDate(e.recordedAt),
      updatedAt: fromDate(e.recordedAt),
    }))
    // The row keeps the error the way the service stored it before the journal: a JSON string
    .on(RefundFailed, (_row, e) => ({
      status: 'failed',
      providerResponse: JSON.stringify({ error: e.data.errorMessage }),
      updatedAt: fromDate(e.recordedAt),
    }));

  /**
   * The payment row is locked for the rest of the transaction, so two requests for one payment take
   * turns: the second counts the first. Without the lock both could read the same total and together
   * refund more than was paid. A refund that is pending, approved, processing or completed holds money.
   */
  const requestRefund = j.command('requestRefund', requestRefundInputSchema, async (input, { tx, write }) => {
    const refundId = input.refundId ?? createRefundId();

    const [payment] = await tx
      .select({ amountMinor: payments.amountMinor, currency: payments.currency })
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .for('update');
    if (!payment) {
      throw new CommandError('NOT_FOUND', `Payment ${input.paymentId} not found`);
    }

    const refundMinor = toMinorColumn(input.refundAmount);
    let exceedsPayment = false;
    if (input.refundAmount.currency.code === payment.currency.toUpperCase()) {
      const [held] = await tx
        .select({ total: sql<string | null>`SUM(${tables.refunds.refundAmountMinor})` })
        .from(tables.refunds)
        .where(
          and(
            eq(tables.refunds.paymentId, input.paymentId),
            eq(tables.refunds.currency, payment.currency.toUpperCase()),
            inArray(tables.refunds.status, ['pending', 'approved', 'processing', 'completed']),
          ),
        );

      exceedsPayment = Number(held?.total ?? 0) + refundMinor > payment.amountMinor;
    }

    return write(refund, refundId, row => {
      if (row) {
        throw new CommandError('CONFLICT', `Refund ${refundId} already exists`);
      }

      if (!input.refundAmount.hasSameCurrency(input.originalAmount)) {
        throw new CommandError(
          'BAD_REQUEST',
          `Refund currency (${input.refundAmount.currency.code}) differs from the original currency (${input.originalAmount.currency.code})`,
        );
      }

      if (input.refundAmount.gt(input.originalAmount)) {
        throw new CommandError(
          'BAD_REQUEST',
          `Refund amount (${input.refundAmount.toString()}) cannot exceed original amount (${input.originalAmount.toString()})`,
        );
      }

      if (!input.refundAmount.isPositive()) {
        throw new CommandError('BAD_REQUEST', 'Refund amount must be positive');
      }

      if (exceedsPayment) {
        throw new CommandError(
          'CONFLICT',
          `Refund of ${input.refundAmount.toString()} exceeds what is left of the payment`,
        );
      }

      return [
        RefundRequestedV2({
          paymentId: input.paymentId,
          originalAmount: input.originalAmount.toJSON(),
          refundAmount: input.refundAmount.toJSON(),
          reason: input.reason,
          customerNote: input.customerNote ?? null,
          internalNotes: input.internalNotes ?? null,
          requestedBy: input.requestedBy,
          metadata: input.metadata ?? null,
        }),
      ];
    });
  });

  const approveRefund = j.command('approveRefund', approveRefundInputSchema, (input, { write }) =>
    write(refund, input.refundId, row => {
      const current = requireRefund(row, input.refundId);

      if (current.status !== 'pending') {
        throw new CommandError('CONFLICT', `Cannot approve refund with status ${current.status}`);
      }

      return [RefundApproved({ approvedBy: input.approvedBy, notes: input.notes ?? null })];
    }),
  );

  const rejectRefund = j.command('rejectRefund', rejectRefundInputSchema, (input, { write }) =>
    write(refund, input.refundId, row => {
      const current = requireRefund(row, input.refundId);

      if (current.status !== 'pending') {
        throw new CommandError('CONFLICT', `Cannot reject refund with status ${current.status}`);
      }

      return [RefundRejected({ rejectedBy: input.rejectedBy, rejectionReason: input.rejectionReason })];
    }),
  );

  const processRefund = j.command('processRefund', processRefundInputSchema, (input, { write }) =>
    write(refund, input.refundId, row => {
      const current = requireRefund(row, input.refundId);

      if (current.status !== 'approved') {
        throw new CommandError(
          'CONFLICT',
          `Cannot process refund with status ${current.status}. Must be approved first.`,
        );
      }

      return [RefundProcessed({})];
    }),
  );

  const completeRefund = j.command('completeRefund', completeRefundInputSchema, (input, { write }) =>
    write(refund, input.refundId, row => {
      const current = requireRefund(row, input.refundId);

      // The provider's webhook and the service both report the same refund: the second changes nothing
      if (current.status === 'completed' && current.providerRefundId === input.providerRefundId) {
        return [];
      }

      if (current.status !== 'processing') {
        throw new CommandError(
          'CONFLICT',
          `Cannot complete refund with status ${current.status}. Must be processing first.`,
        );
      }

      return [
        RefundCompleted({
          providerRefundId: input.providerRefundId,
          providerResponse: input.providerResponse ?? null,
        }),
      ];
    }),
  );

  const failRefund = j.command('failRefund', failRefundInputSchema, (input, { write }) =>
    write(refund, input.refundId, row => {
      const current = requireRefund(row, input.refundId);

      if (current.status !== 'processing') {
        throw new CommandError(
          'CONFLICT',
          `Cannot fail refund with status ${current.status}. Must be processing first.`,
        );
      }

      return [RefundFailed({ errorMessage: input.errorMessage })];
    }),
  );

  const commands = { requestRefund, approveRefund, rejectRefund, processRefund, completeRefund, failRefund };

  return {
    entities: { refund },
    events: { RefundRequested, RefundRequestedV2, RefundApproved, RefundRejected, RefundProcessed, RefundCompleted, RefundFailed },
    commands,
    /** `run` is the app's command runner: `context.runCommand` in a request, `ctx.run` inside a command. */
    writes: (run: CommandRunner<z.output<Meta>, Tx>): RefundWrites => ({
      requestRefund: input => writtenRow(run(commands.requestRefund, input), 'requestRefund'),
      approveRefund: input => writtenRow(run(commands.approveRefund, input), 'approveRefund'),
      rejectRefund: input => writtenRow(run(commands.rejectRefund, input), 'rejectRefund'),
      processRefund: input => writtenRow(run(commands.processRefund, input), 'processRefund'),
      completeRefund: input => writtenRow(run(commands.completeRefund, input), 'completeRefund'),
      failRefund: input => writtenRow(run(commands.failRefund, input), 'failRefund'),
    }),
  };
}
