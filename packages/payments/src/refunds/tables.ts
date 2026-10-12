import type { PgColumn, PgSchema } from 'drizzle-orm/pg-core';
import { decimal, integer, text, timestamp, varchar } from 'drizzle-orm/pg-core';

import type { UserId } from '@arki/auth/ids';
import { createIdFactory } from '@arki/db/id-factory';

import type { RefundReason, RefundStatus } from './primitives';
import { paymentIdFactory } from '../core/primitives';
import { refundIdFactory, refundReasonValues, refundStatusValues } from './primitives';

export type CreateRefundsTablesDeps = {
  schema: PgSchema;
  /** `() => payments.id` from the host app's payments-core tables. */
  paymentIdRef: () => PgColumn;
  /** `() => User.id` from the host app's auth tables. */
  userIdRef: () => PgColumn;
};

export function createRefundsTables({ schema, paymentIdRef, userIdRef }: CreateRefundsTablesDeps) {
  // Re-build FK factories locally so COLUMN_ZOD_SCHEMA tagging matches the host-app's
  // version of these column builders exactly.
  const paymentFk = paymentIdFactory.createForeignKeyFactory(paymentIdRef);
  const userIdFactory = createIdFactory<'usr_', UserId>('usr_');
  const userFk = userIdFactory.createForeignKeyFactory(userIdRef);

  const refundReasonEnum = schema.enum('refund_reason', refundReasonValues);
  const refundStatusEnum = schema.enum('refund_status', refundStatusValues);

  const refunds = schema.table('refunds', {
    id: refundIdFactory.primaryColumn(),
    paymentId: paymentFk.required('payment_id'),
    originalAmount: decimal('original_amount', { precision: 10, scale: 2 }).notNull(),
    refundAmount: decimal('refund_amount', { precision: 10, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).default('USD'),
    reason: refundReasonEnum('reason').$type<RefundReason>().notNull(),
    status: refundStatusEnum('status').$type<RefundStatus>().default('pending'),
    providerRefundId: varchar('provider_refund_id', { length: 255 }),
    providerResponse: text('provider_response'),
    requestedBy: userFk.required('requested_by'),
    approvedBy: userFk.optional('approved_by'),
    rejectedBy: userFk.optional('rejected_by'),
    rejectionReason: text('rejection_reason'),
    requestedAt: timestamp('requested_at', { mode: 'date', withTimezone: true }).defaultNow(),
    approvedAt: timestamp('approved_at', { mode: 'date', withTimezone: true }),
    processedAt: timestamp('processed_at', { mode: 'date', withTimezone: true }),
    completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }),
    internalNotes: text('internal_notes'),
    customerNote: text('customer_note'),
    metadata: text('metadata'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).defaultNow(),
    /** Set by `@arki/journal`. 0 means: this row was written before the journal. */
    version: integer('version').notNull().default(0),
  });

  const refundForeignKeys = refundIdFactory.createForeignKeyFactory(() => refunds.id);

  return {
    enums: {
      refundReasonEnum,
      refundStatusEnum,
    },
    refunds,
    foreignKeys: {
      refundForeignKeys,
    },
  };
}

export type RefundsTables = ReturnType<typeof createRefundsTables>;
