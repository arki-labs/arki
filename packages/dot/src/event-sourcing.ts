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

export function createProcessManager<TEvent extends Event, TContext extends Record<string, any>>(
  context: TContext,
  name: string,
  eventTypes: TEvent['type'][],
  handlerFn: (event: TEvent, context: TContext) => Promise<void>,
) {
  return reactor({
    canHandle: [...eventTypes],
    eachMessage: async message => {
      try {
        await handlerFn(message, context);
      } catch (error) {
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
   */
  initEventSourcing(
    p: ProjectionDefinition<any, PostgresReadEventMetadata, PostgreSQLProjectionHandlerContext>[],
    dbUrl?: string,
  ) {
    if (!dbUrl) {
      throw new Error(
        `Event Store database URL is not defined. Please set one of the following environment variables: ${EVENT_STORE_URL_VARIANTS.join(
          ', ',
        )}`,
      );
    }
    return getEventStore(dbUrl, {
      // Ensure projections are passed correctly
      projections: projections.inline(p),
    });
  },

  /**
   * @internal Initializes the Message Bus and registers command handlers.
   * @param eventStore The initialized Event Store
   * @param commandHandlers The command handlers to register
   */
  initMessageBus(eventStore: EventStore | undefined, commandHandlers: CommandHandlerRegistration[]): MessageBus {
    const messageBus = getInMemoryMessageBus();

    // Event Store is required to handle commands that interact with aggregates
    if (!eventStore) {
      if (commandHandlers.length > 0) {
        // Log a warning if handlers were configured but event store is missing
        console.warn('Command handlers were configured, but the Event Store is not initialized. Commands may fail.');
      }
      return messageBus; // Return bus even if handlers can't be registered
    }

    if (commandHandlers.length > 0) {
      const createCommandHandlerWrapper = <C extends Command>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: CommandHandlerType<C, any, any>,
        getStreamNameFn: (cmd: C) => string,
      ) => {
        return async (command: C) => {
          const streamName = getStreamNameFn(command);
          try {
            // Runtime check for safety
            if (typeof handler === 'function') {
              await handler(eventStore, streamName, command);
            } else {
              console.error(`Invalid handler type encountered for command: ${command.type}`);
            }
          } catch (error) {
            console.error(`Error executing command handler for ${command.type} on stream ${streamName}:`, error);
            // Decide if errors should be re-thrown or handled differently
            throw error;
          }
        };
      };

      for (const config of commandHandlers) {
        messageBus.handle(createCommandHandlerWrapper(config.handler, config.getStreamName), config.commandType);
      }

      console.log(`Message Bus initialized with ${commandHandlers.length} command handlers.`);
    }

    return messageBus;
  },

  async setupProcessManagers(
    eventStore: PostgresEventStore,
    processManagers: MessageProcessor<any, any, any, bigint>[],
  ) {
    const processManagerConsumers = processManagers.map(pm =>
      eventStore.consumer({
        consumerId: pm.id,
        processors: [pm],
      }),
    );

    await Promise.all(processManagerConsumers.map(consumer => consumer.start()));

    process.on('SIGTERM', async () => {
      await Promise.all(processManagerConsumers.map(consumer => consumer.stop()));
      await Promise.all(processManagerConsumers.map(consumer => consumer.close()));
      process.exit(0);
    });

    return processManagerConsumers;
  },
};
