import type { CanHandle, Command, Event, EventStore, MessageBus, ProjectionDefinition } from '@event-driven-io/emmett';
import type { AnyRouter } from '@trpc/server/unstable-core-do-not-import';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'; // Import NodePgDatabase directly
import { getInMemoryMessageBus } from '@event-driven-io/emmett';

import type { CommandHandlerType } from '@arki/event-sourcing/command';
import type {
  DrizzleProjectionHandlerContext,
  DrizzleProjectionHandlerContextWithRepo,
  PostgreSQLProjectionHandlerContext,
  PostgresReadEvent,
  PostgresReadEventMetadata,
} from '@arki/event-sourcing/store';
import { initDb } from '@arki/db/init';
import { drizzleProjection, drizzleWithRepoProjection, getEventStore, projections } from '@arki/event-sourcing/store';
import { KV } from '@arki/kv';

import { createCallerFactory, createTRPCRouter } from './core/trpc';

// #region Core Type Definitions
/**
 * Represents the structure of a database schema recognized by Drizzle.
 * Should be a record mapping table names to Drizzle table objects (e.g., PgTable).
 * Using `Record<string, unknown>` for flexibility in the builder.
 * @example { users: PgTable<any>, posts: PgTable<any> }
 */
type SchemaInterface = Record<string, unknown>;

/**
 * Represents a collection of repositories, typically mapping names to repository instances.
 * @template T The base type or interface for repository instances.
 * @example { userRepo: UserRepository, postRepo: PostRepository }
 */
type Repository<T = unknown> = Record<string, T>;

/**
 * Represents a collection of tRPC routers.
 * Using `Record<string, AnyRouter>` for compatibility with tRPC internal types.
 * @example { user: userRouter, post: postRouter }
 */
type RouterRecord = Record<string, AnyRouter>;

/**
 * Defines the expected structure for validated environment variables.
 * Assumes processing by a library like `@t3-oss/env-nextjs`.
 */
type EnvConfig = {
  NODE_ENV?: string;
  DB_URL?: string;
  KV_URL?: string;
  EVENT_STORE_URL?: string;
  [key: string]: string | number | boolean | undefined; // Allow other validated keys
};

/**
 * Base type for projection definitions used internally.
 * Uses `any` for the event type to allow heterogeneous arrays.
 */
type BaseProjectionDefinition = ProjectionDefinition<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  PostgresReadEventMetadata,
  PostgreSQLProjectionHandlerContext
>;

/**
 * Configuration for a specific command handler.
 * Uses `any` for state/event types for flexibility in registration.
 * @template C The specific command type this handler processes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CommandHandlerRegistration<C extends Command = any> = {
  commandType: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: CommandHandlerType<C, any, any>;
  getStreamName: (command: C) => string;
};
// #endregion

/**
 * Dot Framework Builder
 *
 * Provides a fluent API (builder pattern) to configure and initialize
 * the core components of a full-stack application.
 *
 * @template TAppName A string literal type for the application name.
 * @template TRouters The structure of the combined tRPC routers.
 * @template TSchema The Drizzle database schema structure.
 * @template TRepositories The structure of the application's repositories.
 * @template TEnv The structure of the validated environment variables.
 */
export class Dot<
  TAppName extends string,
  TRouters extends RouterRecord = Record<string, never>,
  TSchema extends SchemaInterface = SchemaInterface,
  TRepositories extends Repository = Record<string, never>,
  TEnv extends EnvConfig = EnvConfig,
> {
  readonly #appName: TAppName;
  readonly #routers: TRouters | null;
  readonly #dbConfig: { url?: string; schema: TSchema; debug?: boolean; repositories?: TRepositories } | null;
  readonly #eventSourcingConfig: { dbUrl?: string; projections: BaseProjectionDefinition[] } | null;
  readonly #kvConfig: { url: string } | null;
  readonly #env: TEnv;
  readonly #commandHandlers: CommandHandlerRegistration[];

  // #region Environment Variable Constants
  /** @internal Alternative names for the primary database connection URL environment variable. */
  static readonly #DB_URL_VARIANTS = ['DB_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL', 'PG_URL', 'SQL_URL'];

  /** @internal Alternative names for the Key-Value store connection URL environment variable. */
  static readonly #KV_URL_VARIANTS = ['KV_URL', 'REDIS_URL', 'KEYVALUE_URL', 'CACHE_URL', 'UPSTASH_REDIS_URL'];

  /** @internal Alternative names for the Event Store connection URL environment variable. */
  static readonly #EVENT_STORE_URL_VARIANTS = ['EVENT_STORE_URL', 'EVENTSTORE_URL', 'EVENT_DB_URL'];
  // #endregion

  /**
   * @internal Use `createDot(appName)` to start building.
   */
  constructor(
    name: TAppName,
    options: {
      routers?: TRouters | null;
      dbConfig?: { url?: string; schema: TSchema; debug?: boolean; repositories?: TRepositories } | null;
      eventSourcingConfig?: { dbUrl?: string; projections: BaseProjectionDefinition[] } | null;
      kvConfig?: { url: string } | null;
      env?: TEnv;
      commandHandlers?: CommandHandlerRegistration[];
    } = {},
  ) {
    this.#appName = name;
    this.#routers = options.routers ?? null;
    this.#dbConfig = options.dbConfig ?? null;
    this.#eventSourcingConfig = options.eventSourcingConfig ?? null;
    this.#kvConfig = options.kvConfig ?? null;
    this.#env = options.env ?? ({} as TEnv);
    this.#commandHandlers = options.commandHandlers ?? [];
  }

  // #region Helper Methods
  /**
   * @internal Finds an environment variable value from multiple possible names.
   * @param variantNames Priority-ordered list of environment variable names.
   * @returns The string value of the first found variable, or undefined.
   */
  #getEnvVar(variantNames: string[]): string | undefined {
    for (const name of variantNames) {
      if (name in this.#env) {
        const value = this.#env[name as keyof TEnv];
        // Ensure the value retrieved is actually a string, as expected for URLs
        return typeof value === 'string' ? value : undefined;
      }
    }
    return undefined;
  }
  // #endregion

  // #region Configuration Methods
  /**
   * Adds tRPC routers to the application configuration.
   * @param routers An object mapping router names to tRPC router instances (`AnyRouter`).
   * @returns A new Dot instance with the updated configuration.
   * @example
   * .withTrpc({ user: userRouter, post: postRouter })
   */
  withTrpc<TNewRouters extends RouterRecord>(routers: TNewRouters) {
    return new Dot<TAppName, TNewRouters, TSchema, TRepositories, TEnv>(this.#appName, {
      routers,
      dbConfig: this.#dbConfig,
      eventSourcingConfig: this.#eventSourcingConfig,
      kvConfig: this.#kvConfig,
      env: this.#env,
      commandHandlers: this.#commandHandlers,
    });
  }

  /**
   * Configures the database connection, schema, and repositories.
   *
   * This is the primary method for setting up Drizzle ORM and associated repositories.
   * The database URL will be automatically inferred from environment variables
   * (e.g., DB_URL, DATABASE_URL) if not explicitly provided in `options.url`.
   *
   * @param schema The Drizzle schema definition (type: `SchemaInterface`).
   * @param repositories An object containing repository instances, keyed by name (optional).
   * @param options Optional configuration: `url` overrides environment variables, `debug` enables Drizzle logging.
   * @returns A new Dot instance with the updated configuration.
   * @example
   * .withDb(schema, { userRepo, postRepo }, { debug: true })
   * .withDb(schema, { userRepo }, { url: 'postgres://...' })
   * .withDb(schema) // Only configure schema and default DB connection
   */
  withDb<TNewSchema extends SchemaInterface, TNewRepositories extends Repository = TRepositories>(
    schema: Readonly<TNewSchema>,
    repositories?: Readonly<TNewRepositories>,
    options: { url?: string; debug?: boolean } = {},
  ): Dot<TAppName, TRouters, TNewSchema, TNewRepositories, TEnv> {
    // Explicitly cast repositories to ensure type compatibility if provided
    const currentRepositories = repositories as TNewRepositories | undefined;
    return new Dot<TAppName, TRouters, TNewSchema, TNewRepositories, TEnv>(this.#appName, {
      routers: this.#routers,
      // Combine url, schema, debug, and repositories into dbConfig
      dbConfig: { url: options.url, schema, debug: options.debug, repositories: currentRepositories },
      eventSourcingConfig: this.#eventSourcingConfig,
      kvConfig: this.#kvConfig,
      env: this.#env,
      commandHandlers: this.#commandHandlers,
    });
  }

  /**
   * Configures the Event Store connection details.
   *
   * The database URL will be automatically inferred from environment variables
   * (e.g., EVENT_STORE_URL, DB_URL) or the Drizzle configuration if not explicitly provided.
   * Projections should be added separately using `.withProjections()`.
   *
   * @param dbUrl Optional explicit URL for the event store database.
   * @returns A new Dot instance with the updated configuration.
   * @example
   * .withEventSourcing() // Infers URL
   * .withEventSourcing('postgres://...') // Explicit URL
   */
  withEventSourcing(dbUrl?: string): Dot<TAppName, TRouters, TSchema, TRepositories, TEnv> {
    return new Dot<TAppName, TRouters, TSchema, TRepositories, TEnv>(this.#appName, {
      routers: this.#routers,
      dbConfig: this.#dbConfig, // Pass existing dbConfig
      eventSourcingConfig: { dbUrl, projections: this.#eventSourcingConfig?.projections ?? [] },
      kvConfig: this.#kvConfig,
      env: this.#env,
      commandHandlers: this.#commandHandlers,
    });
  }

  /**
   * Adds projections to the Event Sourcing configuration.
   *
   * Can be called multiple times. Projections are appended to any existing ones.
   * It's recommended to configure the event store URL via `withEventSourcing()` first.
   *
   * @param projections An array of Emmett ProjectionDefinitions (use `ProjectionDefinition<any,...>` for heterogeneous arrays).
   * @returns A new Dot instance with the updated configuration.
   * @example
   * .withProjections([...userProjections, postProjection] as BaseProjectionDefinition[])
   * .withProjections(orderProjection as BaseProjectionDefinition) // Called again
   */
  withProjections(...projections: BaseProjectionDefinition[]): Dot<TAppName, TRouters, TSchema, TRepositories, TEnv> {
    return new Dot<TAppName, TRouters, TSchema, TRepositories, TEnv>(this.#appName, {
      routers: this.#routers,
      dbConfig: this.#dbConfig, // Pass existing dbConfig
      eventSourcingConfig: {
        dbUrl: this.#eventSourcingConfig?.dbUrl,
        projections: [...(this.#eventSourcingConfig?.projections ?? []), ...projections],
      },
      kvConfig: this.#kvConfig,
      env: this.#env,
      commandHandlers: this.#commandHandlers,
    });
  }

  /**
   * Adds command handlers to the Message Bus configuration.
   *
   * Can be called multiple times. Handlers are appended to any existing ones.
   * It's recommended to configure the event store via `withEventSourcing()` first,
   * as the message bus relies on it.
   *
   * @param commandHandlers An array of `CommandHandlerRegistration` objects.
   * @returns A new Dot instance with the updated configuration.
   * @example
   * .withCommandHandlers(...userCommandHandlers)
   * .withCommandHandlers(orderCommandHandler) // Called again
   */
  withCommandHandlers(...commandHandlers: CommandHandlerRegistration[]) {
    return new Dot<TAppName, TRouters, TSchema, TRepositories, TEnv>(this.#appName, {
      routers: this.#routers,
      dbConfig: this.#dbConfig, // Pass existing dbConfig
      eventSourcingConfig: this.#eventSourcingConfig,
      kvConfig: this.#kvConfig,
      env: this.#env,
      commandHandlers: [...this.#commandHandlers, ...commandHandlers],
    });
  }

  /**
   * Configures the Key-Value store connection.
   *
   * The KV store URL will be automatically inferred from environment variables
   * (e.g., KV_URL, REDIS_URL) if not explicitly provided.
   *
   * @param url Optional explicit URL for the KV store.
   * @returns A new Dot instance with the updated configuration.
   * @example
   * .withKv() // Infers URL
   * .withKv('redis://...') // Explicit URL
   */
  withKv(url?: string): Dot<TAppName, TRouters, TSchema, TRepositories, TEnv> {
    let kvUrl = url;
    kvUrl ??= this.#getEnvVar(Dot.#KV_URL_VARIANTS);

    if (!kvUrl) {
      throw new Error(
        `KV URL is required. Provide it directly or configure one of these environment variables: ${Dot.#KV_URL_VARIANTS.join(', ')}`,
      );
    }

    return new Dot<TAppName, TRouters, TSchema, TRepositories, TEnv>(this.#appName, {
      routers: this.#routers,
      dbConfig: this.#dbConfig, // Pass existing dbConfig
      eventSourcingConfig: this.#eventSourcingConfig,
      kvConfig: { url: kvUrl },
      env: this.#env,
      commandHandlers: this.#commandHandlers,
    });
  }

  /**
   * Provides the validated environment variables to the application configuration.
   * This should typically be called early in the chain if defaults from environment
   * are desired for database URLs, KV URLs, etc.
   *
   * @param environment The validated environment object (type: `EnvConfig`).
   * @returns A new Dot instance with the updated configuration.
   * @example
   * .withEnv(env)
   */
  withEnv<TNewEnv extends EnvConfig>(
    environment: Readonly<TNewEnv>,
  ): Dot<TAppName, TRouters, TSchema, TRepositories, TNewEnv> {
    // Ensure environment is treated as readonly
    const currentEnv = environment as TNewEnv;
    return new Dot<TAppName, TRouters, TSchema, TRepositories, TNewEnv>(this.#appName, {
      routers: this.#routers,
      dbConfig: this.#dbConfig,
      eventSourcingConfig: this.#eventSourcingConfig,
      kvConfig: this.#kvConfig,
      env: currentEnv,
      commandHandlers: this.#commandHandlers,
    });
  }
  // #endregion

  // #region Initialization and Bootstrap
  /**
   * Initializes all configured components and returns the application instance.
   *
   * This method performs the final setup based on the preceding `with...` calls.
   * It resolves connection URLs, initializes databases, event stores, KV stores,
   * the message bus, and creates utility functions.
   *
   * @returns An object containing the initialized application components and utilities.
   */
  bootstrap() {
    // Initialize components, respecting dependencies
    const db = this.#initDrizzle();
    const eventStore = this.#initEventSourcing();
    const router = this.#initTrpc();
    const kv = this.#initKv();
    // Pass initialized eventStore to message bus
    const messageBus = this.#initMessageBus(eventStore);

    // Extract env and repositories from config
    const env = this.#env;
    // Provide default empty object if repositories aren't configured
    const repositories = this.#dbConfig?.repositories ?? ({} as TRepositories);

    // Create projection helper utilities - only if db is initialized
    const createProjection = db ? this.#createProjectionHelper(db) : undefined;
    // Only create repo projection helper if both db and repositories exist
    const createWithRepoProjection =
      db && Object.keys(repositories).length > 0 ? this.#createWithRepoProjectionHelper(repositories) : undefined;

    // Create tRPC caller utility
    const createCaller = router ? createCallerFactory(router) : undefined;

    return {
      name: this.#appName,
      /** The configured and merged tRPC router instance, or undefined if not configured. */
      router,
      /** The initialized Drizzle database instance, or undefined if not configured. */
      db,
      /** The initialized Event Store instance, or undefined if not configured. */
      eventStore,
      /** The initialized Key-Value store instance, or undefined if not configured. */
      kv,
      /** The validated environment variables object. */
      env,
      /** The configured repositories object. */
      repositories,
      /** The initialized message bus instance. */
      bus: messageBus,
      /** Utility function to create a Drizzle projection definition, or undefined if DB not configured. */
      createProjection,
      /** Utility function to create a Drizzle projection definition with repository access, or undefined if DB/Repositories not configured. */
      createWithRepoProjection,
      /** Utility function to create a server-side tRPC caller, or undefined if router not configured. */
      createCaller,
    };
  }

  /** @internal Initializes the tRPC router. */
  #initTrpc() {
    if (!this.#routers || Object.keys(this.#routers).length === 0) return;

    return createTRPCRouter(this.#routers);
  }

  /** @internal Initializes the Drizzle ORM database connection. */
  #initDrizzle() {
    if (!this.#dbConfig) return;

    const { url, schema, debug } = this.#dbConfig;
    let dbUrl: string | undefined = url;
    dbUrl ??= this.#getEnvVar(Dot.#DB_URL_VARIANTS);

    if (!dbUrl) {
      // If no URL found and Drizzle was configured, it's an error.
      throw new Error(
        `Database URL is required for Drizzle. Provide it via withDb() or environment variables: ${Dot.#DB_URL_VARIANTS.join(', ')}`,
      );
    }

    return initDb(dbUrl, {
      schema,
      logger: debug ?? this.#env.NODE_ENV === 'development',
    });
  }

  /** @internal Initializes the Event Store. */
  #initEventSourcing() {
    if (!this.#eventSourcingConfig) return;

    const { dbUrl: configDbUrl, projections: projectionsList } = this.#eventSourcingConfig;
    let eventDbUrl = configDbUrl;

    eventDbUrl ??= this.#getEnvVar(Dot.#EVENT_STORE_URL_VARIANTS);
    eventDbUrl ??= this.#getEnvVar(Dot.#DB_URL_VARIANTS);

    // Try to get URL from resolved Drizzle config if available
    if (!eventDbUrl && this.#dbConfig?.url) {
      eventDbUrl = this.#dbConfig.url;
    }

    if (!eventDbUrl) {
      // Check if projections were added; if so, URL is mandatory.
      if (projectionsList.length > 0) {
        throw new Error(
          `Event Store database URL is required when projections are configured. Provide via withEventSourcing(), Drizzle config, or environment variables: ${[...Dot.#EVENT_STORE_URL_VARIANTS, ...Dot.#DB_URL_VARIANTS].join(', ')}`,
        );
      } else {
        // No projections, Event Store not strictly needed, return undefined.
        return;
      }
    }

    return getEventStore(eventDbUrl, {
      // Ensure projections are passed correctly
      projections: projections.inline(projectionsList),
    });
  }

  /** @internal Initializes the Key-Value store. */
  #initKv(): KV | undefined {
    if (!this.#kvConfig) return undefined;
    // URL is guaranteed to be resolved by withKv method
    return new KV(this.#kvConfig.url, this.#appName);
  }

  /** @internal Initializes the Message Bus and registers command handlers. */
  #initMessageBus(eventStore: EventStore | undefined): MessageBus {
    const messageBus = getInMemoryMessageBus();

    // Event Store is required to handle commands that interact with aggregates
    if (!eventStore) {
      if (this.#commandHandlers.length > 0) {
        // Log a warning if handlers were configured but event store is missing
        console.warn('Command handlers were configured, but the Event Store is not initialized. Commands may fail.');
      }
      return messageBus; // Return bus even if handlers can't be registered
    }

    if (this.#commandHandlers.length > 0) {
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

      for (const config of this.#commandHandlers) {
        messageBus.handle(createCommandHandlerWrapper(config.handler, config.getStreamName), config.commandType);
      }

      console.log(`Message Bus initialized with ${this.#commandHandlers.length} command handlers.`);
    }

    return messageBus;
  }

  /**
   * @internal Creates the `createProjection` helper function.
   * Provides type safety for the handle context based on the configured schema.
   */
  #createProjectionHelper(db: NodePgDatabase<TSchema>) {
    type Context = DrizzleProjectionHandlerContext<TSchema>; // Define context type locally
    return <E extends Event>(
      canHandle: CanHandle<E>,
      handle: (events: PostgresReadEvent<E>[], context: Context) => Promise<void>,
    ) => {
      // Cast needed because CanHandle type from emmett might not perfectly match drizzleProjection's expectation
      return drizzleProjection(db, {
        handle,
        canHandle: canHandle as unknown as CanHandle<E>,
      });
    };
  }

  /**
   * @internal Creates the `createWithRepoProjection` helper function.
   * Provides type safety for the handle context based on the configured schema and specific repository.
   */
  #createWithRepoProjectionHelper(repositories: TRepositories) {
    // Define context type locally with repository access
    type ContextWithRepo<K extends keyof TRepositories> = DrizzleProjectionHandlerContextWithRepo<TRepositories[K]>;
    return <E extends Event, K extends keyof TRepositories>(
      repoKey: K,
      canHandle: CanHandle<E>,
      handle: (events: PostgresReadEvent<E>[], context: ContextWithRepo<K>) => Promise<void>,
    ) => {
      const repository = repositories[repoKey];
      if (!repository) {
        // Ensure a clear error if the specified repository wasn't configured
        throw new Error(
          `Repository with key "${String(repoKey)}" not found. Available repositories: ${Object.keys(repositories).join(', ')}`,
        );
      }
      // Cast needed for CanHandle and return type
      return drizzleWithRepoProjection(repository, {
        handle,
        canHandle: canHandle as unknown as CanHandle<E>,
      });
    };
  }
  // #endregion
}

/**
 * Creates a new Dot application builder instance.
 * @param name A unique name for the application (used for KV namespacing, etc.).
 * @returns A new Dot instance to start configuration.
 * @example
 * const appBuilder = createDot('my-cool-app');
 */
export function createDot<TAppName extends string>(name: TAppName) {
  return new Dot(name);
}
