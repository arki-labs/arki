import type {
  Event,
  EventStore,
  MessageBus,
  MessageProcessor,
  ProjectionDefinition,
} from '@event-driven-io/emmett';
import { getInMemoryMessageBus } from '@event-driven-io/emmett';

import type { CommandHandler } from './builders/command-handler.js';
import type { CommandHandlerRegistration } from './command.js';
import { debugCommand, debugStore } from './debug.js';
import type {
  PostgresEventStore,
  PostgreSQLProjectionHandlerContext,
  PostgresReadEventMetadata,
} from './store.js';
import { getEventStore, projections } from './store.js';

/**
 * Structural interface for projection definitions accepted by
 * {@link initEventSourcing}.
 *
 * Uses method syntax for `handle` to enable TypeScript's bivariant parameter
 * checking, which allows heterogeneous projection arrays where each projection
 * is parametrised on a different event type.
 *
 * Accepts projections produced by three different builder patterns:
 * 1. Emmett's `postgreSQLProjection` / `PostgreSQLProjectionDefinition<E>`.
 * 2. The `defineProjection` builder from this package.
 * 3. The `@arki/db` builder `projection.named().on().handle()`.
 */
export type PostgreSQLProjectionInput = {
  name?: string;
  canHandle: string[];
  handle(events: Event[], context: object): void;
};

/** Alternative names for the Event Store connection URL environment variable. */
export const EVENT_STORE_URL_VARIANTS = ['EVENT_STORE_URL', 'EVENTSTORE_URL', 'EVENT_DB_URL'];

/**
 * Event sourcing wiring helpers.
 *
 * Bundles the three most common bootstrap operations into a single namespace:
 *
 * - {@link eventSourcingFeatures.initEventSourcing} — open the PostgreSQL
 *   event store with a set of inline projections, returning a `close()`
 *   function for graceful shutdown.
 * - {@link eventSourcingFeatures.initMessageBus} — create an in-memory
 *   message bus and register a list of command handler descriptors against it.
 * - {@link eventSourcingFeatures.setupProcessManagers} — attach process
 *   manager consumers to the event store, start them, and wire SIGTERM-driven
 *   graceful shutdown.
 *
 * The helpers are intentionally framework-agnostic: any composition root
 * (DI container, plugin, plain `bus.ts` factory function) can call them.
 */
export const eventSourcingFeatures = {
  /**
   * Initialises the PostgreSQL event store with the given inline projections.
   *
   * @param p Projections to register inline on the event store.
   * @param dbUrl Connection string for the event store. When omitted, an
   *   error is thrown that names the recognised environment variables.
   * @returns The event store handle plus a `close()` function that releases
   *   the underlying connection pool.
   */
  initEventSourcing(p: readonly PostgreSQLProjectionInput[], dbUrl?: string) {
    if (!dbUrl) {
      debugStore(
        '[eventSourcingFeatures] Event Store URL not found. Required environment variables: %s',
        EVENT_STORE_URL_VARIANTS.join(', '),
      );
      throw new Error(
        `Event Store database URL is not defined. Please set one of the following environment variables: ${EVENT_STORE_URL_VARIANTS.join(
          ', ',
        )}`,
      );
    }
    debugStore('[eventSourcingFeatures] Initializing Event Store with %d projection(s)', p.length);
    const { eventStore, close } = getEventStore(dbUrl, {
      projections: projections.inline(
        p as ProjectionDefinition<Event, PostgresReadEventMetadata, PostgreSQLProjectionHandlerContext>[],
      ),
    });
    debugStore('[eventSourcingFeatures] Event Store initialized successfully');
    return { eventStore, close };
  },

  /**
   * Creates an in-memory message bus and registers a list of command handlers.
   *
   * Each registration is bound to the event store so command handlers can
   * load and append to streams. If the event store is missing, a warning is
   * logged and an empty bus is returned.
   *
   * @param eventStore Event store used to load and append streams.
   * @param commandHandlers Command handler descriptors to register.
   * @returns A message bus with handlers attached.
   */
  initMessageBus(eventStore: EventStore | undefined, commandHandlers: CommandHandlerRegistration[]): MessageBus {
    debugCommand(
      '[eventSourcingFeatures] Initializing Message Bus with %d command handler(s)',
      commandHandlers.length,
    );
    const messageBus = getInMemoryMessageBus();

    if (!eventStore) {
      if (commandHandlers.length > 0) {
        debugCommand(
          '[eventSourcingFeatures] Warning: %d command handler(s) configured but Event Store not initialized',
          commandHandlers.length,
        );
        console.warn('Command handlers were configured, but the Event Store is not initialized. Commands may fail.');
      } else {
        debugCommand(
          '[eventSourcingFeatures] No Event Store and no command handlers - returning empty Message Bus',
        );
      }
      return messageBus;
    }

    if (commandHandlers.length > 0) {
      const createCommandHandlerWrapper = <C extends { type: string }, State, StreamEvent extends Event>(
        handler: CommandHandler<State, C, StreamEvent>,
        getStreamNameFn: (cmd: C) => string,
      ) => {
        return async (command: C) => {
          const streamName = getStreamNameFn(command);
          debugCommand('[MessageBus] Executing command handler for %s on stream: %s', command.type, streamName);
          try {
            if (typeof handler === 'function') {
              await handler(eventStore, streamName, command);
              debugCommand('[MessageBus] Command handler for %s completed successfully', command.type);
            } else {
              debugCommand('[MessageBus] Invalid handler type for command: %s', command.type);
              console.error(`Invalid handler type encountered for command: ${command.type}`);
            }
          } catch (error) {
            debugCommand(
              '[MessageBus] Error executing command handler for %s on stream %s: %s',
              command.type,
              streamName,
              error instanceof Error ? error.message : String(error),
            );
            console.error(`Error executing command handler for ${command.type} on stream ${streamName}:`, error);
            throw error;
          }
        };
      };

      for (const config of commandHandlers) {
        debugCommand('[eventSourcingFeatures] Registering command handler for type: %s', config.commandType);
        // Type erasure boundary: registrations are stored with C=never so
        // arrays of differently-typed handlers compose. We cast back to
        // callable types for the runtime dispatch wrapper.
        type Cmd = { type: string };
        const handler = config.handler as CommandHandler<unknown, Cmd, Event>;
        const getStreamName = config.getStreamName as (cmd: Cmd) => string;
        messageBus.handle(createCommandHandlerWrapper(handler, getStreamName), config.commandType);
      }

      debugCommand(
        '[eventSourcingFeatures] Message Bus initialized with %d command handler(s)',
        commandHandlers.length,
      );
    } else {
      debugCommand('[eventSourcingFeatures] No command handlers to register');
    }

    return messageBus;
  },

  /**
   * Attaches process managers as event store consumers, starts them, and
   * wires SIGTERM-driven shutdown of the resulting consumers.
   *
   * @param eventStore Event store the process managers consume from.
   * @param processManagers Process manager `MessageProcessor` instances to
   *   register, typically produced by {@link createProcessManager},
   *   {@link createStatefulProcessManager}, or
   *   `createSimpleProcessManager`.
   * @returns The started consumer handles. Useful for tests that need to
   *   stop them explicitly.
   */
  async setupProcessManagers(eventStore: PostgresEventStore, processManagers: MessageProcessor[]) {
    debugStore('[eventSourcingFeatures] Setting up %d process manager(s)', processManagers.length);
    const processManagerConsumers = processManagers.map(pm => {
      debugStore('[eventSourcingFeatures] Creating consumer for process manager: %s', pm.id);
      return eventStore.consumer({
        consumerId: pm.id,
        processors: [pm],
      });
    });

    debugStore(
      '[eventSourcingFeatures] Starting %d process manager consumer(s)',
      processManagerConsumers.length,
    );
    await Promise.all(processManagerConsumers.map(consumer => consumer.start()));
    debugStore('[eventSourcingFeatures] All process manager consumers started successfully');

    process.on('SIGTERM', async () => {
      debugStore('[eventSourcingFeatures] SIGTERM received, stopping process managers');
      await Promise.all(processManagerConsumers.map(consumer => consumer.stop()));
      debugStore('[eventSourcingFeatures] All process managers stopped, closing consumers');
      await Promise.all(processManagerConsumers.map(consumer => consumer.close()));
      debugStore('[eventSourcingFeatures] All consumers closed, exiting');
      process.exit(0);
    });

    return processManagerConsumers;
  },
};
