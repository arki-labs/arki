import type {
  Command,
  Event,
  EventStore,
  MessageBus,
  MessageProcessor,
  ProjectionDefinition,
} from '@event-driven-io/emmett';
import { getInMemoryMessageBus, reactor } from '@event-driven-io/emmett';

import type { CommandHandlerType } from '@arki/event-sourcing/command';
import type {
  PostgresEventStore,
  PostgreSQLProjectionHandlerContext,
  PostgresReadEventMetadata,
} from '@arki/event-sourcing/store';
import { getEventStore, projections } from '@arki/event-sourcing/store';

import type { CommandHandlerRegistration } from './types';
import { debugEventSourcing } from './debug.ts';

/**
 * Structural interface for projection definitions accepted by initEventSourcing.
 *
 * Uses method syntax for `handle` to enable TypeScript's bivariant parameter
 * checking, which allows heterogeneous projection arrays where each projection
 * is parametrized on a different event type.
 *
 * Accepts projections from three different builder patterns:
 * 1. Emmett's `postgreSQLProjection` / `PostgreSQLProjectionDefinition<E>`
 * 2. The custom `defineProjection` builder (returns `{ canHandle, handle(events, context: unknown) }`)
 * 3. The `@arki/db` builder `projection.named().on().handle()` (returns `{ canHandle, handle(events) }`)
 */
type PostgreSQLProjectionInput = {
  name?: string;
  canHandle: string[];
  handle(events: Event[], context: object): void;
};

export function createProcessManager<TEvent extends Event, TContext extends object>(
  context: TContext,
  name: string,
  eventTypes: TEvent['type'][],
  handlerFn: (event: TEvent, context: TContext) => Promise<void>,
) {
  debugEventSourcing(
    '[createProcessManager] Creating process manager: %s for event types: %s',
    name,
    eventTypes.join(', '),
  );
  return reactor({
    canHandle: [...eventTypes],
    eachMessage: async message => {
      debugEventSourcing('[createProcessManager:%s] Processing event: %s', name, message.type);
      try {
        await handlerFn(message, context);
        debugEventSourcing('[createProcessManager:%s] Successfully processed event: %s', name, message.type);
      } catch (error) {
        debugEventSourcing(
          '[createProcessManager:%s] Error processing event %s: %s',
          name,
          message.type,
          error instanceof Error ? error.message : String(error),
        );
        console.error(`Error in process manager ${name}:`, error, message);
        throw error; // Allow the consumer's error handling to take over
      }
    },
    processorId: `process-manager-${name}`,
  });
}

/** @internal Alternative names for the Event Store connection URL environment variable. */
export const EVENT_STORE_URL_VARIANTS = ['EVENT_STORE_URL', 'EVENTSTORE_URL', 'EVENT_DB_URL'];
// #endregion

/**
 * Event Sourcing functionality for the Dot framework.
 * Contains methods for setting up and interacting with the event store and message bus.
 */
export const eventSourcingFeatures = {
  /**
   * @internal Initializes the Event Store.
   * @param projections The projections to initialize the event store with
   * @param dbUrl The database URL to initialize the event store with
   * @returns Object with eventStore and close function for cleanup
   */
  initEventSourcing(p: readonly PostgreSQLProjectionInput[], dbUrl?: string) {
    if (!dbUrl) {
      debugEventSourcing(
        '[eventSourcingFeatures] Event Store URL not found. Required environment variables: %s',
        EVENT_STORE_URL_VARIANTS.join(', '),
      );
      throw new Error(
        `Event Store database URL is not defined. Please set one of the following environment variables: ${EVENT_STORE_URL_VARIANTS.join(
          ', ',
        )}`,
      );
    }
    debugEventSourcing('[eventSourcingFeatures] Initializing Event Store with %d projection(s)', p.length);
    const { eventStore, close } = getEventStore(dbUrl, {
      projections: projections.inline(
        p as ProjectionDefinition<Event, PostgresReadEventMetadata, PostgreSQLProjectionHandlerContext>[],
      ),
    });
    debugEventSourcing('[eventSourcingFeatures] Event Store initialized successfully');
    return { eventStore, close };
  },

  /**
   * @internal Initializes the Message Bus and registers command handlers.
   * @param eventStore The initialized Event Store
   * @param commandHandlers The command handlers to register
   */
  initMessageBus(eventStore: EventStore | undefined, commandHandlers: CommandHandlerRegistration[]): MessageBus {
    debugEventSourcing(
      '[eventSourcingFeatures] Initializing Message Bus with %d command handler(s)',
      commandHandlers.length,
    );
    const messageBus = getInMemoryMessageBus();

    // Event Store is required to handle commands that interact with aggregates
    if (!eventStore) {
      if (commandHandlers.length > 0) {
        debugEventSourcing(
          '[eventSourcingFeatures] Warning: %d command handler(s) configured but Event Store not initialized',
          commandHandlers.length,
        );
        // Log a warning if handlers were configured but event store is missing
        console.warn('Command handlers were configured, but the Event Store is not initialized. Commands may fail.');
      } else {
        debugEventSourcing(
          '[eventSourcingFeatures] No Event Store and no command handlers - returning empty Message Bus',
        );
      }
      return messageBus; // Return bus even if handlers can't be registered
    }

    if (commandHandlers.length > 0) {
      const createCommandHandlerWrapper = <C extends Command, State, StreamEvent extends Event>(
        handler: CommandHandlerType<C, State, StreamEvent>,
        getStreamNameFn: (cmd: C) => string,
      ) => {
        return async (command: C) => {
          const streamName = getStreamNameFn(command);
          debugEventSourcing('[MessageBus] Executing command handler for %s on stream: %s', command.type, streamName);
          try {
            // Runtime check for safety
            if (typeof handler === 'function') {
              await handler(eventStore, streamName, command);
              debugEventSourcing('[MessageBus] Command handler for %s completed successfully', command.type);
            } else {
              debugEventSourcing('[MessageBus] Invalid handler type for command: %s', command.type);
              console.error(`Invalid handler type encountered for command: ${command.type}`);
            }
          } catch (error) {
            debugEventSourcing(
              '[MessageBus] Error executing command handler for %s on stream %s: %s',
              command.type,
              streamName,
              error instanceof Error ? error.message : String(error),
            );
            console.error(`Error executing command handler for ${command.type} on stream ${streamName}:`, error);
            // Decide if errors should be re-thrown or handled differently
            throw error;
          }
        };
      };

      for (const config of commandHandlers) {
        debugEventSourcing('[eventSourcingFeatures] Registering command handler for type: %s', config.commandType);
        messageBus.handle(createCommandHandlerWrapper(config.handler, config.getStreamName), config.commandType);
      }

      debugEventSourcing(
        '[eventSourcingFeatures] Message Bus initialized with %d command handler(s)',
        commandHandlers.length,
      );
      console.log(`Message Bus initialized with ${commandHandlers.length} command handlers.`);
    } else {
      debugEventSourcing('[eventSourcingFeatures] No command handlers to register');
    }

    return messageBus;
  },

  async setupProcessManagers(eventStore: PostgresEventStore, processManagers: MessageProcessor[]) {
    debugEventSourcing('[eventSourcingFeatures] Setting up %d process manager(s)', processManagers.length);
    const processManagerConsumers = processManagers.map(pm => {
      debugEventSourcing('[eventSourcingFeatures] Creating consumer for process manager: %s', pm.id);
      return eventStore.consumer({
        consumerId: pm.id,
        processors: [pm],
      });
    });

    debugEventSourcing(
      '[eventSourcingFeatures] Starting %d process manager consumer(s)',
      processManagerConsumers.length,
    );
    await Promise.all(processManagerConsumers.map(consumer => consumer.start()));
    debugEventSourcing('[eventSourcingFeatures] All process manager consumers started successfully');

    process.on('SIGTERM', async () => {
      debugEventSourcing('[eventSourcingFeatures] SIGTERM received, stopping process managers');
      await Promise.all(processManagerConsumers.map(consumer => consumer.stop()));
      debugEventSourcing('[eventSourcingFeatures] All process managers stopped, closing consumers');
      await Promise.all(processManagerConsumers.map(consumer => consumer.close()));
      debugEventSourcing('[eventSourcingFeatures] All consumers closed, exiting');
      process.exit(0);
    });

    return processManagerConsumers;
  },
};
