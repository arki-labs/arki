import type { TablesRelationalConfig } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { PostgresReadEvent } from '@arki/event-sourcing/store';

import type { PaymentEvent } from '../domain/payment-events';
import type { CoreTables } from '../tables';

/**
 * Event types handled by the payment projection.
 *
 * Exported so host projection-runners can pass it as the `canHandle` filter
 * to `drizzleProjection` / `createProjectionWithRepos`.
 */
export const PAYMENT_EVENT_TYPES: PaymentEvent['type'][] = [
  'PaymentInitiated',
  'PaymentCompleted',
  'PaymentFailed',
  'PaymentCanceled',
];

/**
 * Build the projection handler for the `payments` table.
 *
 * Returns a pure handler function: events → table writes. Apps wrap this
 * handler with their own projection registration (`drizzleProjection` or
 * a repos-injected variant) at boot time.
 *
 * The handler is parameterised over `TSchema extends TablesRelationalConfig`
 * so it accepts whatever relations graph the host registered — `db` is the
 * narrow surface we use (`insert`, `update`, `eq`), no relational queries.
 */
export function createPaymentProjectionHandler({ payments }: Pick<CoreTables, 'payments'>) {
  return async function paymentProjectionHandler<TSchema extends TablesRelationalConfig>(
    events: PostgresReadEvent<PaymentEvent>[],
    ctx: { db: NodePgDatabase<TSchema> },
  ): Promise<void> {
    const { db } = ctx;

    for (const event of events) {
      switch (event.type) {
        case 'PaymentInitiated': {
          const {
            paymentId,
            subscriptionId,
            userId,
            customerId,
            amount,
            currency,
            status,
            paymentMethod,
            description,
            metadata,
            providerPaymentId,
            refunded,
            refundedAmount,
            initiatedAt,
          } = event.data;

          await db.insert(payments).values({
            id: paymentId,
            subscriptionId: subscriptionId ?? null,
            userId,
            customerId,
            providerPaymentId,
            amount,
            currency,
            status,
            paymentMethod,
            description: description ?? null,
            failureReason: null,
            receiptUrl: null,
            refunded,
            refundedAmount,
            metadata: metadata ?? null,
            createdAt: initiatedAt,
            updatedAt: initiatedAt,
          });
          break;
        }

        case 'PaymentCompleted': {
          const { paymentId, status, receiptUrl, completedAt } = event.data;

          await db
            .update(payments)
            .set({
              status,
              receiptUrl: receiptUrl ?? null,
              updatedAt: completedAt,
            })
            .where(eq(payments.id, paymentId));
          break;
        }

        case 'PaymentFailed': {
          const { paymentId, status, failureReason, failedAt } = event.data;

          await db
            .update(payments)
            .set({
              status,
              failureReason,
              updatedAt: failedAt,
            })
            .where(eq(payments.id, paymentId));
          break;
        }

        case 'PaymentCanceled': {
          const { paymentId, status, canceledAt } = event.data;

          await db
            .update(payments)
            .set({
              status,
              updatedAt: canceledAt,
            })
            .where(eq(payments.id, paymentId));
          break;
        }
      }
    }
  };
}
