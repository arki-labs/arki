import { DeciderCommandHandler  } from '@event-driven-io/emmett';
import type {Decider} from '@event-driven-io/emmett';

import type { RefundId, RefundStatus } from '../primitives';
import type {
  ApproveRefundCommand,
  CompleteRefundCommand,
  FailRefundCommand,
  ProcessRefundCommand,
  RefundCommand,
  RejectRefundCommand,
  RequestRefundCommand,
} from './refund-commands';
import type {
  RefundApprovedEvent,
  RefundCompletedEvent,
  RefundEvent,
  RefundFailedEvent,
  RefundProcessedEvent,
  RefundRejectedEvent,
  RefundRequestedEvent,
} from './refund-events';

export type RefundState = {
  refundId: RefundId;
  paymentId: string;
  status: RefundStatus;
  refundAmount: number;
};

const initialState = (): RefundState => ({
  refundId: '' as RefundId,
  paymentId: '',
  status: 'pending',
  refundAmount: 0,
});

const evolve = (state: RefundState, event: RefundEvent): RefundState => {
  switch (event.type) {
    case 'RefundRequested': {
      return {
        refundId: event.data.refundId,
        paymentId: event.data.paymentId,
        status: event.data.status,
        refundAmount: event.data.refundAmount,
      };
    }

    case 'RefundApproved': {
      return {
        ...state,
        status: event.data.status,
      };
    }

    case 'RefundRejected': {
      return {
        ...state,
        status: event.data.status,
      };
    }

    case 'RefundProcessed': {
      return {
        ...state,
        status: event.data.status,
      };
    }

    case 'RefundCompleted': {
      return {
        ...state,
        status: event.data.status,
      };
    }

    case 'RefundFailed': {
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

const decide = (command: RefundCommand, state: RefundState): RefundEvent | RefundEvent[] => {
  switch (command.type) {
    case 'RequestRefund': {
      const cmd = command;

      if (state.refundId) {
        throw new Error(`Refund ${cmd.data.refundId} already exists`);
      }

      if (cmd.data.refundAmount > cmd.data.originalAmount) {
        throw new Error(`Refund amount (${cmd.data.refundAmount}) cannot exceed original amount (${cmd.data.originalAmount})`);
      }

      if (cmd.data.refundAmount <= 0) {
        throw new Error(`Refund amount must be positive`);
      }

      const event: RefundRequestedEvent = {
        type: 'RefundRequested',
        data: {
          refundId: cmd.data.refundId,
          paymentId: cmd.data.paymentId,
          originalAmount: cmd.data.originalAmount,
          refundAmount: cmd.data.refundAmount,
          currency: cmd.data.currency,
          reason: cmd.data.reason,
          status: 'pending',
          customerNote: cmd.data.customerNote,
          internalNotes: cmd.data.internalNotes,
          requestedBy: cmd.data.requestedBy,
          requestedAt: cmd.data.requestedAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'ApproveRefund': {
      const cmd = command;

      if (!state.refundId) {
        throw new Error(`Refund ${cmd.data.refundId} not found`);
      }

      if (state.status !== 'pending') {
        throw new Error(`Cannot approve refund with status ${state.status}`);
      }

      const event: RefundApprovedEvent = {
        type: 'RefundApproved',
        data: {
          refundId: cmd.data.refundId,
          status: 'approved',
          approvedBy: cmd.data.approvedBy,
          approvedAt: cmd.data.approvedAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'RejectRefund': {
      const cmd = command;

      if (!state.refundId) {
        throw new Error(`Refund ${cmd.data.refundId} not found`);
      }

      if (state.status !== 'pending') {
        throw new Error(`Cannot reject refund with status ${state.status}`);
      }

      const event: RefundRejectedEvent = {
        type: 'RefundRejected',
        data: {
          refundId: cmd.data.refundId,
          status: 'rejected',
          rejectedBy: cmd.data.rejectedBy,
          rejectionReason: cmd.data.rejectionReason,
          rejectedAt: cmd.data.rejectedAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'ProcessRefund': {
      const cmd = command;

      if (!state.refundId) {
        throw new Error(`Refund ${cmd.data.refundId} not found`);
      }

      if (state.status !== 'approved') {
        throw new Error(`Cannot process refund with status ${state.status}. Must be approved first.`);
      }

      const event: RefundProcessedEvent = {
        type: 'RefundProcessed',
        data: {
          refundId: cmd.data.refundId,
          status: 'processing',
          providerRefundId: cmd.data.providerRefundId,
          processedAt: cmd.data.processedAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'CompleteRefund': {
      const cmd = command;

      if (!state.refundId) {
        throw new Error(`Refund ${cmd.data.refundId} not found`);
      }

      if (state.status !== 'processing') {
        throw new Error(`Cannot complete refund with status ${state.status}. Must be processing first.`);
      }

      const event: RefundCompletedEvent = {
        type: 'RefundCompleted',
        data: {
          refundId: cmd.data.refundId,
          status: 'completed',
          providerResponse: cmd.data.providerResponse,
          completedAt: cmd.data.completedAt,
        },
        metadata: command.metadata,
      };

      return event;
    }

    case 'FailRefund': {
      const cmd = command;

      if (!state.refundId) {
        throw new Error(`Refund ${cmd.data.refundId} not found`);
      }

      if (state.status !== 'processing') {
        throw new Error(`Cannot fail refund with status ${state.status}. Must be processing first.`);
      }

      const event: RefundFailedEvent = {
        type: 'RefundFailed',
        data: {
          refundId: cmd.data.refundId,
          status: 'failed',
          errorMessage: cmd.data.errorMessage,
          failedAt: cmd.data.failedAt,
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

const refundDecider: Decider<RefundState, RefundCommand, RefundEvent> = {
  initialState,
  evolve,
  decide,
};

const handler = DeciderCommandHandler(refundDecider);

const getStreamName = (commandType: string, command: RefundCommand) => {
  switch (commandType) {
    case 'RequestRefund': {
      return `refund-${(command as RequestRefundCommand).data.refundId}`;
    }
    case 'ApproveRefund': {
      return `refund-${(command as ApproveRefundCommand).data.refundId}`;
    }
    case 'RejectRefund': {
      return `refund-${(command as RejectRefundCommand).data.refundId}`;
    }
    case 'ProcessRefund': {
      return `refund-${(command as ProcessRefundCommand).data.refundId}`;
    }
    case 'CompleteRefund': {
      return `refund-${(command as CompleteRefundCommand).data.refundId}`;
    }
    case 'FailRefund': {
      return `refund-${(command as FailRefundCommand).data.refundId}`;
    }
    default: {
      throw new Error(`Unknown command type: ${commandType}`);
    }
  }
};

export const refundCommandHandlers = (
  ['RequestRefund', 'ApproveRefund', 'RejectRefund', 'ProcessRefund', 'CompleteRefund', 'FailRefund'] as const
).map(commandType => ({
  commandType,
  handler,
  getStreamName: (command: RefundCommand) => getStreamName(commandType, command),
}));
