import type { Event } from '@event-driven-io/emmett';

import type { UserId } from '@arki/auth/ids';
import type { CustomerId, PlanId, SubscriptionId, SubscriptionStatus } from '../types';

export type SubscriptionEventMetadata = {
  userId: UserId;
  timestamp: Date;
};

export type SubscriptionCreatedEvent = Event<
  'SubscriptionCreated',
  {
    subscriptionId: SubscriptionId;
    userId: UserId;
    planId: PlanId;
    customerId: CustomerId;
    providerSubscriptionId: string;
    status: SubscriptionStatus;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    trialStart?: Date;
    trialEnd?: Date;
    cancelAtPeriodEnd: boolean;
    metadata?: Record<string, unknown>;
    createdAt: Date;
  },
  SubscriptionEventMetadata
>;

export type SubscriptionActivatedEvent = Event<
  'SubscriptionActivated',
  {
    subscriptionId: SubscriptionId;
    status: SubscriptionStatus;
    activatedAt: Date;
  },
  SubscriptionEventMetadata
>;

export type SubscriptionUpdatedEvent = Event<
  'SubscriptionUpdated',
  {
    subscriptionId: SubscriptionId;
    planId?: PlanId;
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date;
    metadata?: Record<string, unknown>;
    updatedAt: Date;
  },
  SubscriptionEventMetadata
>;

export type SubscriptionCanceledEvent = Event<
  'SubscriptionCanceled',
  {
    subscriptionId: SubscriptionId;
    status: SubscriptionStatus;
    cancelAtPeriodEnd: boolean;
    canceledAt: Date;
  },
  SubscriptionEventMetadata
>;

export type SubscriptionReactivatedEvent = Event<
  'SubscriptionReactivated',
  {
    subscriptionId: SubscriptionId;
    status: SubscriptionStatus;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    reactivatedAt: Date;
  },
  SubscriptionEventMetadata
>;

export type SubscriptionEvent =
  | SubscriptionCreatedEvent
  | SubscriptionActivatedEvent
  | SubscriptionUpdatedEvent
  | SubscriptionCanceledEvent
  | SubscriptionReactivatedEvent;
