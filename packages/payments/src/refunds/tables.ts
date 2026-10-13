import type { PgColumn, PgSchema } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigint, integer, text, varchar } from 'drizzle-orm/pg-core';

import { userIdFactory } from '../core/user-id.js';
import { instant } from '@arki/db/temporal';

import type { RefundReason, RefundStatus } from './primitives.js';
import { paymentIdFactory } from '../core/primitives.js';
import { refundIdFactory, refundReasonValues, refundStatusValues } from './primitives.js';

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
  const userFk = userIdFactory.createForeignKeyFactory(userIdRef);

  const refundReasonEnum = schema.enum('refund_reason', refundReasonValues);
  const refundStatusEnum = schema.enum('refund_status', refundStatusValues);

  const refunds = schema.table('refunds', {
    id: refundIdFactory.primaryColumn(),
    paymentId: paymentFk.required('payment_id'),
    /** Whole minor units of `currency`: 2550 is 25.50 EUR, 1500 is 1500 JPY. Read and write through `core/money.ts`. */
    originalAmountMinor: bigint('original_amount_minor', { mode: 'number' }).notNull(),
    refundAmountMinor: bigint('refund_amount_minor', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 3 }).default('USD'),
    reason: refundReasonEnum('reason').$type<RefundReason>().notNull(),
    status: refundStatusEnum('status').$type<RefundStatus>().default('pending'),
    providerRefundId: varchar('provider_refund_id', { length: 255 }),
    providerResponse: text('provider_response'),
    requestedBy: userFk.required('requested_by'),
    approvedBy: userFk.optional('approved_by'),
    rejectedBy: userFk.optional('rejected_by'),
    rejectionReason: text('rejection_reason'),
    requestedAt: instant('requested_at').default(sql`now()`),
    approvedAt: instant('approved_at'),
    processedAt: instant('processed_at'),
    completedAt: instant('completed_at'),
    internalNotes: text('internal_notes'),
    customerNote: text('customer_note'),
    metadata: text('metadata'),
    createdAt: instant('created_at').default(sql`now()`),
    updatedAt: instant('updated_at').default(sql`now()`),
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
