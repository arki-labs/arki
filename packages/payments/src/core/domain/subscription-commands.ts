import type { Command } from '@event-driven-io/emmett';

import type { UserId } from '@arki/auth/ids';
import type { CustomerId, PlanId, SubscriptionId } from '../types';

export type SubscriptionCommandMetadata = {
  userId: UserId;
  timestamp: Date;
  now: Date;
};

export type CreateSubscriptionCommand = Command<
  'CreateSubscription',
  {
    subscriptionId: SubscriptionId;
    userId: UserId;
    planId: PlanId;
    customerId: CustomerId;
    providerSubscriptionId: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    trialStart?: Date;
    trialEnd?: Date;
    metadata?: Record<string, unknown>;
    createdAt: Date;
  },
  SubscriptionCommandMetadata
>;

export type ActivateSubscriptionCommand = Command<
  'ActivateSubscription',
  {
    subscriptionId: SubscriptionId;
    activatedAt: Date;
  },
  SubscriptionCommandMetadata
>;

export type UpdateSubscriptionCommand = Command<
  'UpdateSubscription',
  {
    subscriptionId: SubscriptionId;
    planId?: PlanId;
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date;
    metadata?: Record<string, unknown>;
    updatedAt: Date;
  },
  SubscriptionCommandMetadata
>;

export type CancelSubscriptionCommand = Command<
  'CancelSubscription',
  {
    subscriptionId: SubscriptionId;
    cancelAtPeriodEnd: boolean;
    canceledAt: Date;
  },
  SubscriptionCommandMetadata
>;

export type ReactivateSubscriptionCommand = Command<
  'ReactivateSubscription',
  {
    subscriptionId: SubscriptionId;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    reactivatedAt: Date;
  },
  SubscriptionCommandMetadata
>;

export type SubscriptionCommand =
  | CreateSubscriptionCommand
  | ActivateSubscriptionCommand
  | UpdateSubscriptionCommand
  | CancelSubscriptionCommand
  | ReactivateSubscriptionCommand;
