import { DeciderCommandHandler  } from '@event-driven-io/emmett';
import type {Decider} from '@event-driven-io/emmett';

import type { PaymentId, PaymentStatus } from '../types';
import type {
  CancelPaymentCommand,
  CompletePaymentCommand,
  FailPaymentCommand,
  InitiatePaymentCommand,
  PaymentCommand,
} from './payment-commands';
import type {
  PaymentCanceledEvent,
  PaymentCompletedEvent,
  PaymentEvent,
  PaymentFailedEvent,
  PaymentInitiatedEvent,
} from './payment-events';

export type PaymentState = {
  paymentId: PaymentId;
  userId: string;
  status: PaymentStatus;
  amount: number;
  refundedAmount: number;
};

const initialState = (): PaymentState => ({
  paymentId: '' as PaymentId,
  userId: '',
  status: 'pending',
  amount: 0,
  refundedAmount: 0,
});

const evolve = (state: PaymentState, event: PaymentEvent): PaymentState => {
  switch (event.type) {
    case 'PaymentInitiated': {
      return {
        paymentId: event.data.paymentId,
        userId: event.data.userId,
        status: event.data.status,
        amount: event.data.amount,
        refundedAmount: event.data.refundedAmount,
      };
    }

    case 'PaymentCompleted': {
      return {
        ...state,
        status: event.data.status,
      };
    }

    case 'PaymentFailed': {
      return {
        ...state,
        status: event.data.status,
      };
    }

    case 'PaymentCanceled': {
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

const decide = (command: PaymentCommand, state: PaymentState): PaymentEvent | PaymentEvent[] => {
  switch (command.type) {
    case 'InitiatePayment': {
      const cmd = command;

      if (state.paymentId && state.status !== 'pending') {
        throw new Error(`Payment ${cmd.data.paymentId} already exists with status ${state.status}`);
      }

      const event: PaymentInitiatedEvent = {
        type: 'PaymentInitiated',
        data: {
          paymentId: cmd.data.paymentId,
          subscriptionId: cmd.data.subscriptionId,
          userId: cmd.data.userId,
          customerId: cmd.data.customerId,
          amount: cmd.data.amount,
          currency: cmd.data.currency,
          status: 'pending',
          paymentMethod: cmd.data.paymentMethod,
          description: cmd.data.description,
          metadata: cmd.data.metadata,
          providerPaymentId: cmd.data.providerPaymentId,
          refunded: false,
          refundedAmount: 0,
          initiatedAt: cmd.data.initiatedAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'CompletePayment': {
      const cmd = command;

      if (!state.paymentId) {
        throw new Error(`Payment ${cmd.data.paymentId} not found`);
      }

      if (state.status !== 'pending' && state.status !== 'processing') {
        throw new Error(`Cannot complete payment with status ${state.status}`);
      }

      const event: PaymentCompletedEvent = {
        type: 'PaymentCompleted',
        data: {
          paymentId: cmd.data.paymentId,
          status: 'succeeded',
          receiptUrl: cmd.data.receiptUrl,
          completedAt: cmd.data.completedAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'FailPayment': {
      const cmd = command;

      if (!state.paymentId) {
        throw new Error(`Payment ${cmd.data.paymentId} not found`);
      }

      if (state.status !== 'pending' && state.status !== 'processing') {
        throw new Error(`Cannot fail payment with status ${state.status}`);
      }

      const event: PaymentFailedEvent = {
        type: 'PaymentFailed',
        data: {
          paymentId: cmd.data.paymentId,
          status: 'failed',
          failureReason: cmd.data.failureReason,
          failedAt: cmd.data.failedAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'CancelPayment': {
      const cmd = command;

      if (!state.paymentId) {
        throw new Error(`Payment ${cmd.data.paymentId} not found`);
      }

      if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'canceled') {
        throw new Error(`Cannot cancel payment with status ${state.status}`);
      }

      const event: PaymentCanceledEvent = {
        type: 'PaymentCanceled',
        data: {
          paymentId: cmd.data.paymentId,
          status: 'canceled',
          canceledAt: cmd.data.canceledAt,
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

const paymentDecider: Decider<PaymentState, PaymentCommand, PaymentEvent> = {
  initialState,
  evolve,
  decide,
};

const handler = DeciderCommandHandler(paymentDecider);

const getStreamName = (commandType: string, command: PaymentCommand) => {
  switch (commandType) {
    case 'InitiatePayment': {
      return `payment-${(command as InitiatePaymentCommand).data.paymentId}`;
    }
    case 'CompletePayment': {
      return `payment-${(command as CompletePaymentCommand).data.paymentId}`;
    }
    case 'FailPayment': {
      return `payment-${(command as FailPaymentCommand).data.paymentId}`;
    }
    case 'CancelPayment': {
      return `payment-${(command as CancelPaymentCommand).data.paymentId}`;
    }
    default: {
      throw new Error(`Unknown command type: ${commandType}`);
    }
  }
};

export const paymentCommandHandlers = (['InitiatePayment', 'CompletePayment', 'FailPayment', 'CancelPayment'] as const).map(
  commandType => ({
    commandType,
    handler,
    getStreamName: (command: PaymentCommand) => getStreamName(commandType, command),
  }),
);
