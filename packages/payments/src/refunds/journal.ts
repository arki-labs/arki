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
 * them exactly. Events keep amounts as numbers, the format already stored;
 * the `decimal(10,2)` columns hold strings, so reducers return
 * `amount.toFixed(2)`.
 */

import type { CommandRunner, JournalDefinitions, RootDb, TransactionSource } from '@arki/journal';
import { userIdSchema } from '@arki/auth/ids';
import { z } from '@arki/contracts';
import { CommandError } from '@arki/journal';
import { anyMoneySchema } from '@arki/money/zod';

import type { RefundsTables } from './tables';
import type { Refund } from './types';
import { writtenRow } from '../core/journal/support';
import { toStoredNumber } from '../core/money';
import { paymentIdSchema } from '../core/primitives';
import { createRefundId, refundIdSchema, refundReasonValues } from './primitives';

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

export const approveRefundInputSchema = z.object({ refundId: refundIdSchema, approvedBy: userIdSchema });

export const rejectRefundInputSchema = z.object({
  refundId: refundIdSchema,
  rejectedBy: userIdSchema,
  rejectionReason: z.string(),
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

export function createRefundsJournal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  j: JournalDefinitions<Meta, Tx, AppDb>,
  tables: Pick<RefundsTables, 'refunds'>,
) {
  const RefundRequested = j.event(
    'RefundRequested',
    z.object({
      paymentId: paymentIdSchema,
      originalAmount: z.number(),
      refundAmount: z.number(),
      currency: z.string(),
      reason: reasonSchema,
      customerNote: z.string().nullable(),
      internalNotes: z.string().nullable(),
      requestedBy: userIdSchema,
      metadata: z.string().nullable(),
    }),
  );
  const RefundApproved = j.event('RefundApproved', z.object({ approvedBy: userIdSchema }));
  const RefundRejected = j.event('RefundRejected', z.object({ rejectedBy: userIdSchema, rejectionReason: z.string() }));
  /** The refund was handed to the provider. The provider's refund id is not known yet. */
  const RefundProcessed = j.event('RefundProcessed', z.object({}));
  const RefundCompleted = j.event(
    'RefundCompleted',
    z.object({ providerRefundId: z.string(), providerResponse: z.string().nullable() }),
  );
  const RefundFailed = j.event('RefundFailed', z.object({ errorMessage: z.string() }));

  const refund = j
    .entity('refund', tables.refunds)
    .create(RefundRequested, e => ({
      paymentId: e.data.paymentId,
      originalAmount: e.data.originalAmount.toFixed(2),
      refundAmount: e.data.refundAmount.toFixed(2),
      currency: e.data.currency,
      reason: e.data.reason,
      status: 'pending',
      providerRefundId: null,
      providerResponse: null,
      requestedBy: e.data.requestedBy,
      approvedBy: null,
      rejectedBy: null,
      rejectionReason: null,
      requestedAt: e.recordedAt,
      approvedAt: null,
      processedAt: null,
      completedAt: null,
      internalNotes: e.data.internalNotes,
      customerNote: e.data.customerNote,
      metadata: e.data.metadata,
      createdAt: e.recordedAt,
      updatedAt: e.recordedAt,
    }))
    .on(RefundApproved, (_row, e) => ({
      status: 'approved',
      approvedBy: e.data.approvedBy,
      approvedAt: e.recordedAt,
      updatedAt: e.recordedAt,
    }))
    .on(RefundRejected, (_row, e) => ({
      status: 'rejected',
      rejectedBy: e.data.rejectedBy,
      rejectionReason: e.data.rejectionReason,
      updatedAt: e.recordedAt,
    }))
    .on(RefundProcessed, (_row, e) => ({ status: 'processing', processedAt: e.recordedAt, updatedAt: e.recordedAt }))
    .on(RefundCompleted, (_row, e) => ({
      status: 'completed',
      providerRefundId: e.data.providerRefundId,
      providerResponse: e.data.providerResponse,
      completedAt: e.recordedAt,
      updatedAt: e.recordedAt,
    }))
    // The row keeps the error the way the service stored it before the journal: a JSON string
    .on(RefundFailed, (_row, e) => ({
      status: 'failed',
      providerResponse: JSON.stringify({ error: e.data.errorMessage }),
      updatedAt: e.recordedAt,
    }));

  const requestRefund = j.command('requestRefund', requestRefundInputSchema, (input, { write }) => {
    const refundId = input.refundId ?? createRefundId();

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

      return [
        RefundRequested({
          paymentId: input.paymentId,
          originalAmount: toStoredNumber(input.originalAmount),
          refundAmount: toStoredNumber(input.refundAmount),
          currency: input.refundAmount.currency.code,
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

      return [RefundApproved({ approvedBy: input.approvedBy })];
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
    events: { RefundRequested, RefundApproved, RefundRejected, RefundProcessed, RefundCompleted, RefundFailed },
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
