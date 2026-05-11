import { DeciderCommandHandler  } from '@event-driven-io/emmett';
import type {Decider} from '@event-driven-io/emmett';

import type { SubscriptionId, SubscriptionStatus } from '../types';
import type {
  ActivateSubscriptionCommand,
  CancelSubscriptionCommand,
  CreateSubscriptionCommand,
  ReactivateSubscriptionCommand,
  SubscriptionCommand,
  UpdateSubscriptionCommand,
} from './subscription-commands';
import type {
  SubscriptionActivatedEvent,
  SubscriptionCanceledEvent,
  SubscriptionCreatedEvent,
  SubscriptionEvent,
  SubscriptionReactivatedEvent,
  SubscriptionUpdatedEvent,
} from './subscription-events';

export type SubscriptionState = {
  subscriptionId: SubscriptionId;
  userId: string;
  status: SubscriptionStatus;
};

const initialState = (): SubscriptionState => ({
  subscriptionId: '' as SubscriptionId,
  userId: '',
  status: 'incomplete',
});

const evolve = (state: SubscriptionState, event: SubscriptionEvent): SubscriptionState => {
  switch (event.type) {
    case 'SubscriptionCreated': {
      return {
        subscriptionId: event.data.subscriptionId,
        userId: event.data.userId,
        status: event.data.status,
      };
    }

    case 'SubscriptionActivated': {
      return {
        ...state,
        status: event.data.status,
      };
    }

    case 'SubscriptionUpdated': {
      return state;
    } // Status doesn't change on update

    case 'SubscriptionCanceled': {
      return {
        ...state,
        status: event.data.status,
      };
    }

    case 'SubscriptionReactivated': {
      return {
        ...state,
        status: event.data.status,
      };
    }

    default: {
      return state;
    }
  }
};

const decide = (command: SubscriptionCommand, state: SubscriptionState): SubscriptionEvent | SubscriptionEvent[] => {
  switch (command.type) {
    case 'CreateSubscription': {
      const cmd = command;

      if (state.subscriptionId) {
        throw new Error(`Subscription ${cmd.data.subscriptionId} already exists`);
      }

      // Determine initial status based on trial period
      const status: SubscriptionStatus = cmd.data.trialStart ? 'trialing' : 'incomplete';

      const event: SubscriptionCreatedEvent = {
        type: 'SubscriptionCreated',
        data: {
          subscriptionId: cmd.data.subscriptionId,
          userId: cmd.data.userId,
          planId: cmd.data.planId,
          customerId: cmd.data.customerId,
          providerSubscriptionId: cmd.data.providerSubscriptionId,
          status,
          currentPeriodStart: cmd.data.currentPeriodStart,
          currentPeriodEnd: cmd.data.currentPeriodEnd,
          trialStart: cmd.data.trialStart,
          trialEnd: cmd.data.trialEnd,
          cancelAtPeriodEnd: false,
          metadata: cmd.data.metadata,
          createdAt: cmd.data.createdAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'ActivateSubscription': {
      const cmd = command;

      if (!state.subscriptionId) {
        throw new Error(`Subscription ${cmd.data.subscriptionId} not found`);
      }

      if (state.status === 'active') {
        throw new Error(`Subscription ${cmd.data.subscriptionId} is already active`);
      }

      if (state.status === 'canceled') {
        throw new Error(`Cannot activate canceled subscription ${cmd.data.subscriptionId}`);
      }

      const event: SubscriptionActivatedEvent = {
        type: 'SubscriptionActivated',
        data: {
          subscriptionId: cmd.data.subscriptionId,
          status: 'active',
          activatedAt: cmd.data.activatedAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'UpdateSubscription': {
      const cmd = command;

      if (!state.subscriptionId) {
        throw new Error(`Subscription ${cmd.data.subscriptionId} not found`);
      }

      if (state.status === 'canceled') {
        throw new Error(`Cannot update canceled subscription ${cmd.data.subscriptionId}`);
      }

      const event: SubscriptionUpdatedEvent = {
        type: 'SubscriptionUpdated',
        data: {
          subscriptionId: cmd.data.subscriptionId,
          planId: cmd.data.planId,
          currentPeriodStart: cmd.data.currentPeriodStart,
          currentPeriodEnd: cmd.data.currentPeriodEnd,
          metadata: cmd.data.metadata,
          updatedAt: cmd.data.updatedAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'CancelSubscription': {
      const cmd = command;

      if (!state.subscriptionId) {
        throw new Error(`Subscription ${cmd.data.subscriptionId} not found`);
      }

      if (state.status === 'canceled') {
        throw new Error(`Subscription ${cmd.data.subscriptionId} is already canceled`);
      }

      const event: SubscriptionCanceledEvent = {
        type: 'SubscriptionCanceled',
        data: {
          subscriptionId: cmd.data.subscriptionId,
          status: 'canceled',
          cancelAtPeriodEnd: cmd.data.cancelAtPeriodEnd,
          canceledAt: cmd.data.canceledAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'ReactivateSubscription': {
      const cmd = command;

      if (!state.subscriptionId) {
        throw new Error(`Subscription ${cmd.data.subscriptionId} not found`);
      }

      if (state.status !== 'canceled') {
        throw new Error(`Can only reactivate canceled subscriptions, current status: ${state.status}`);
      }

      const event: SubscriptionReactivatedEvent = {
        type: 'SubscriptionReactivated',
        data: {
          subscriptionId: cmd.data.subscriptionId,
          status: 'active',
          currentPeriodStart: cmd.data.currentPeriodStart,
          currentPeriodEnd: cmd.data.currentPeriodEnd,
          cancelAtPeriodEnd: false,
          reactivatedAt: cmd.data.reactivatedAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    default: {
      command satisfies never;
      throw new Error(`Unknown command type`);
    }
  }
};

const subscriptionDecider: Decider<SubscriptionState, SubscriptionCommand, SubscriptionEvent> = {
  initialState,
  evolve,
  decide,
};

const handler = DeciderCommandHandler(subscriptionDecider);

const getStreamName = (commandType: string, command: SubscriptionCommand) => {
  switch (commandType) {
    case 'CreateSubscription': {
      return `subscription-${(command as CreateSubscriptionCommand).data.subscriptionId}`;
    }
    case 'ActivateSubscription': {
      return `subscription-${(command as ActivateSubscriptionCommand).data.subscriptionId}`;
    }
    case 'UpdateSubscription': {
      return `subscription-${(command as UpdateSubscriptionCommand).data.subscriptionId}`;
    }
    case 'CancelSubscription': {
      return `subscription-${(command as CancelSubscriptionCommand).data.subscriptionId}`;
    }
    case 'ReactivateSubscription': {
      return `subscription-${(command as ReactivateSubscriptionCommand).data.subscriptionId}`;
    }
    default: {
      throw new Error(`Unknown command type: ${commandType}`);
    }
  }
};

export const subscriptionCommandHandlers = (
  ['CreateSubscription', 'ActivateSubscription', 'UpdateSubscription', 'CancelSubscription', 'ReactivateSubscription'] as const
).map(commandType => ({
  commandType,
  handler,
  getStreamName: (command: SubscriptionCommand) => getStreamName(commandType, command),
}));
