import type { TablesRelationalConfig } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { PostgresReadEvent } from '@arki/event-sourcing/store';

import type { SubscriptionEvent } from '../domain/subscription-events';
import type { CoreTables } from '../tables';

export const SUBSCRIPTION_EVENT_TYPES: SubscriptionEvent['type'][] = [
  'SubscriptionCreated',
  'SubscriptionActivated',
  'SubscriptionUpdated',
  'SubscriptionCanceled',
  'SubscriptionReactivated',
];

export function createSubscriptionProjectionHandler({
  subscriptions,
}: Pick<CoreTables, 'subscriptions'>) {
  return async function subscriptionProjectionHandler<TSchema extends TablesRelationalConfig>(
    events: PostgresReadEvent<SubscriptionEvent>[],
    ctx: { db: NodePgDatabase<TSchema> },
  ): Promise<void> {
    const { db } = ctx;

    for (const event of events) {
      switch (event.type) {
        case 'SubscriptionCreated': {
          const {
            subscriptionId,
            userId,
            planId,
            customerId,
            providerSubscriptionId,
            status,
            currentPeriodStart,
            currentPeriodEnd,
            trialStart,
            trialEnd,
            cancelAtPeriodEnd,
            metadata,
            createdAt,
          } = event.data;

          await db.insert(subscriptions).values({
            id: subscriptionId,
            userId,
            planId,
            customerId,
            providerSubscriptionId,
            status,
            currentPeriodStart,
            currentPeriodEnd,
            trialStart: trialStart ?? null,
            trialEnd: trialEnd ?? null,
            canceledAt: null,
            cancelAtPeriodEnd,
            metadata: metadata ?? null,
            createdAt,
            updatedAt: createdAt,
          });
          break;
        }

        case 'SubscriptionActivated': {
          const { subscriptionId, status, activatedAt } = event.data;

          await db
            .update(subscriptions)
            .set({
              status,
              updatedAt: activatedAt,
            })
            .where(eq(subscriptions.id, subscriptionId));
          break;
        }

        case 'SubscriptionUpdated': {
          const { subscriptionId, planId, currentPeriodStart, currentPeriodEnd, metadata, updatedAt } =
            event.data;

          const updateData: Record<string, unknown> = { updatedAt };

          if (planId !== undefined) updateData['planId'] = planId;
          if (currentPeriodStart !== undefined) updateData['currentPeriodStart'] = currentPeriodStart;
          if (currentPeriodEnd !== undefined) updateData['currentPeriodEnd'] = currentPeriodEnd;
          if (metadata !== undefined) updateData['metadata'] = metadata;

          await db.update(subscriptions).set(updateData).where(eq(subscriptions.id, subscriptionId));
          break;
        }

        case 'SubscriptionCanceled': {
          const { subscriptionId, status, cancelAtPeriodEnd, canceledAt } = event.data;

          await db
            .update(subscriptions)
            .set({
              status,
              cancelAtPeriodEnd,
              canceledAt,
              updatedAt: canceledAt,
            })
            .where(eq(subscriptions.id, subscriptionId));
          break;
        }

        case 'SubscriptionReactivated': {
          const {
            subscriptionId,
            status,
            currentPeriodStart,
            currentPeriodEnd,
            cancelAtPeriodEnd,
            reactivatedAt,
          } = event.data;

          await db
            .update(subscriptions)
            .set({
              status,
              currentPeriodStart,
              currentPeriodEnd,
              cancelAtPeriodEnd,
              canceledAt: null,
              updatedAt: reactivatedAt,
            })
            .where(eq(subscriptions.id, subscriptionId));
          break;
        }
      }
    }
  };
}
