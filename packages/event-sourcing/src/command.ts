import type { Command, DeciderCommandHandler, Event } from '@event-driven-io/emmett';

import type { CommandHandler } from './builders/command-handler.js';

export { DeciderCommandHandler } from '@event-driven-io/emmett';
export type {
  Command,
  CommandBus,
  CommandHandlerOptions,
  CommandHandlerResult,
  CommandHandlerRetryOptions,
  CommandTypeOf,
  DefaultCommandMetadata,
} from '@event-driven-io/emmett';

/**
 * Generic type for a command handler function
 */
export type CommandHandlerType<C extends Command, State, StreamEvent extends Event> = ReturnType<
  typeof DeciderCommandHandler<State, C, StreamEvent>
>;

/**
 * Command handler configuration
 */
export type CommandHandlerConfig<C extends Command = Command, State = unknown, StreamEvent extends Event = Event> = {
  commandType: string;
  handler: CommandHandlerType<C, State, StreamEvent>;
  getStreamName: (command: C) => string;
};

/**
 * Variance-friendly registration record describing a single command handler.
 *
 * Default type parameters are chosen so that `CommandHandlerRegistration[]`
 * can hold handlers of many concrete command types:
 *
 * - `C = never` — contravariant (parameter position): `never` extends every
 *   specific command type, so any handler function is assignable.
 * - `State = unknown` — covariant (return position): all aggregate states
 *   extend `unknown`.
 * - `StreamEvent = Event` — covariant: all events extend the base `Event`.
 *
 * @template C The specific command type this handler processes.
 * @template State The aggregate state type.
 * @template StreamEvent The stream event type.
 */
export type CommandHandlerRegistration<C = never, State = unknown, StreamEvent extends Event = Event> = {
  commandType: string;
  handler: CommandHandler<State, C, StreamEvent>;
  getStreamName: (command: C) => string;
};
