import type { TablesRelationalConfig } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { PostgresReadEvent } from '@arki/event-sourcing/store';

import type { RefundEvent } from '../domain/refund-events';
import type { RefundsTables } from '../tables';

export const REFUND_EVENT_TYPES: RefundEvent['type'][] = [
  'RefundRequested',
  'RefundApproved',
  'RefundRejected',
  'RefundProcessed',
  'RefundCompleted',
  'RefundFailed',
];

export function createRefundProjectionHandler({ refunds }: Pick<RefundsTables, 'refunds'>) {
  return async function refundProjectionHandler<TSchema extends TablesRelationalConfig>(
    events: PostgresReadEvent<RefundEvent>[],
    ctx: { db: NodePgDatabase<TSchema> },
  ): Promise<void> {
    const { db } = ctx;

    for (const event of events) {
      switch (event.type) {
        case 'RefundRequested': {
          const {
            refundId,
            paymentId,
            originalAmount,
            refundAmount,
            currency,
            reason,
            status,
            customerNote,
            internalNotes,
            requestedBy,
            requestedAt,
          } = event.data;

          await db.insert(refunds).values({
            id: refundId,
            paymentId,
            originalAmount: originalAmount.toString(),
            refundAmount: refundAmount.toString(),
            currency: currency ?? 'USD',
            reason,
            status: status ?? 'pending',
            providerRefundId: null,
            providerResponse: null,
            requestedBy,
            approvedBy: null,
            rejectedBy: null,
            rejectionReason: null,
            requestedAt,
            approvedAt: null,
            processedAt: null,
            completedAt: null,
            internalNotes: internalNotes ?? null,
            customerNote: customerNote ?? null,
            metadata: null,
            createdAt: requestedAt,
            updatedAt: requestedAt,
          });
          break;
        }

        case 'RefundApproved': {
          const { refundId, status, approvedBy, approvedAt } = event.data;

          await db
            .update(refunds)
            .set({
              status: status ?? 'approved',
              approvedBy,
              approvedAt,
              updatedAt: approvedAt,
            })
            .where(eq(refunds.id, refundId));
          break;
        }

        case 'RefundRejected': {
          const { refundId, status, rejectedBy, rejectionReason, rejectedAt } = event.data;

          await db
            .update(refunds)
            .set({
              status: status ?? 'rejected',
              rejectedBy,
              rejectionReason,
              updatedAt: rejectedAt,
            })
            .where(eq(refunds.id, refundId));
          break;
        }

        case 'RefundProcessed': {
          const { refundId, status, providerRefundId, processedAt } = event.data;

          await db
            .update(refunds)
            .set({
              status: status ?? 'processing',
              providerRefundId,
              processedAt,
              updatedAt: processedAt,
            })
            .where(eq(refunds.id, refundId));
          break;
        }

        case 'RefundCompleted': {
          const { refundId, status, providerResponse, completedAt } = event.data;

          await db
            .update(refunds)
            .set({
              status: status ?? 'completed',
              providerResponse: providerResponse ?? null,
              completedAt,
              updatedAt: completedAt,
            })
            .where(eq(refunds.id, refundId));
          break;
        }

        case 'RefundFailed': {
          const { refundId, status, errorMessage, failedAt } = event.data;

          await db
            .update(refunds)
            .set({
              status: status ?? 'failed',
              providerResponse: errorMessage,
              updatedAt: failedAt,
            })
            .where(eq(refunds.id, refundId));
          break;
        }
      }
    }
  };
}
