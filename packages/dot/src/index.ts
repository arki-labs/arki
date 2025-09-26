import type { EventStore, MessageBus } from '@event-driven-io/emmett';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { Session } from '@arki/auth';
import type { KV } from '@arki/kv';

import type {
  AuthConfig,
  BaseProjectionDefinition,
  CommandHandlerRegistration,
  EnvConfig,
  Repository,
  RouterRecord,
  SchemaInterface,
  TRPCOptions,
} from './types';
import { authFeatures, type DotAuth } from './auth';
import { dbFeatures } from './db';
import { EVENT_STORE_URL_VARIANTS, eventSourcingFeatures } from './event-sourcing';
import { kvFeatures } from './kv';
import { trpcFeatures } from './trpc';

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
  readonly #trpcOptions: TRPCOptions<TSchema> | null;
  readonly #authConfig: AuthConfig | null;

  // #region Environment Variable Constants
  /** @internal Alternative names for the primary database connection URL environment variable. */
  static readonly #DB_URL_VARIANTS = ['DB_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL', 'PG_URL', 'SQL_URL'];

  /** @internal Alternative names for the Key-Value store connection URL environment variable. */
  static readonly #KV_URL_VARIANTS = ['KV_URL', 'REDIS_URL', 'KEYVALUE_URL', 'CACHE_URL', 'UPSTASH_REDIS_URL'];

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
      trpcOptions?: TRPCOptions<TSchema> | null;
      authConfig?: AuthConfig | null;
    } = {},
  ) {
    this.#appName = name;
    this.#routers = options.routers ?? null;
    this.#dbConfig = options.dbConfig ?? null;
    this.#eventSourcingConfig = options.eventSourcingConfig ?? null;
    this.#kvConfig = options.kvConfig ?? null;
    this.#env = options.env ?? ({} as TEnv);
    this.#commandHandlers = options.commandHandlers ?? [];
    this.#trpcOptions = options.trpcOptions ?? null;
    this.#authConfig = options.authConfig ?? null;
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

  /**
   * Create a new Dot instance with updated options.
   */
  createNew<
    TNewRouters extends RouterRecord = TRouters,
    TNewSchema extends SchemaInterface = TSchema,
    TNewRepositories extends Repository = TRepositories,
    TNewEnv extends EnvConfig = TEnv,
  >(options: {
    routers?: TNewRouters | null;
    dbConfig?: { url?: string; schema: TNewSchema; debug?: boolean; repositories?: TNewRepositories } | null;
    eventSourcingConfig?: { dbUrl?: string; projections: BaseProjectionDefinition[] } | null;
    kvConfig?: { url: string } | null;
    env?: TNewEnv;
    commandHandlers?: CommandHandlerRegistration[];
    trpcOptions?: TRPCOptions<TNewSchema> | null;
    authConfig?: AuthConfig | null;
  }) {
    return new Dot<TAppName, TNewRouters, TNewSchema, TNewRepositories, TNewEnv>(this.#appName, {
      routers: options.routers ?? (this.#routers as unknown as TNewRouters),
      dbConfig:
        options.dbConfig ??
        (this.#dbConfig as unknown as {
          url?: string;
          schema: TNewSchema;
          debug?: boolean;
          repositories?: TNewRepositories;
        }),
      eventSourcingConfig: options.eventSourcingConfig ?? this.#eventSourcingConfig,
      kvConfig: options.kvConfig ?? this.#kvConfig,
      env: options.env ?? (this.#env as unknown as TNewEnv),
      commandHandlers: options.commandHandlers ?? this.#commandHandlers,
      trpcOptions: options.trpcOptions ?? (this.#trpcOptions as unknown as TRPCOptions<TNewSchema>),
      authConfig: options.authConfig ?? this.#authConfig,
    });
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
  withTrpc<TNewRouters extends RouterRecord>(routers: TNewRouters, options?: TRPCOptions<TSchema>) {
    return this.createNew<TNewRouters>({
      routers,
      trpcOptions: options ?? this.#trpcOptions,
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
  ) {
    // Explicitly cast repositories to ensure type compatibility if provided
    const currentRepositories = repositories as TNewRepositories | undefined;
    return this.createNew<TRouters, TNewSchema, TNewRepositories>({
      dbConfig: {
        url: options.url,
        schema,
        debug: options.debug,
        repositories: currentRepositories,
      },
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
  withEventSourcing(dbUrl?: string) {
    return this.createNew({
      eventSourcingConfig: {
        dbUrl,
        projections: this.#eventSourcingConfig?.projections ?? [],
      },
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
  withProjections(...projections: BaseProjectionDefinition[]) {
    return this.createNew({
      eventSourcingConfig: {
        dbUrl: this.#eventSourcingConfig?.dbUrl,
        projections: [...(this.#eventSourcingConfig?.projections ?? []), ...projections],
      },
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
    return this.createNew({
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
  withKv(url?: string) {
    let kvUrl = url;
    kvUrl ??= this.#getEnvVar(Dot.#KV_URL_VARIANTS);

    if (!kvUrl) {
      throw new Error(
        `KV URL is required. Provide it directly or configure one of these environment variables: ${Dot.#KV_URL_VARIANTS.join(', ')}`,
      );
    }

    return this.createNew({
      kvConfig: { url: kvUrl },
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
  withEnv<TNewEnv extends EnvConfig>(environment: Readonly<TNewEnv>) {
    // Ensure environment is treated as readonly
    const currentEnv = environment as TNewEnv;
    return this.createNew<TRouters, TSchema, TRepositories, TNewEnv>({
      env: currentEnv,
    });
  }

  // Get access to dbConfig for internal use
  getDbConfig() {
    return this.#dbConfig;
  }

  // Add auth method
  withAuth = authFeatures.withAuth;
  // #endregion

  // #region TRPC and Context Functions
  /**
   * @internal Creates a TRPC context based on the provided options and Dot configuration.
   */
  #createTRPCContext = (opts: { headers: Headers; session: Session | null }) => {
    return trpcFeatures.createTRPCContextFactory<TSchema>(
      this.#dbConfig,
      () => this.#initDrizzle(),
      () => this.#initKv(),
      () => this.#initEventSourcing(),
      eventStore => this.#initMessageBus(eventStore),
      this.#authConfig,
      this.#trpcOptions,
    )(opts);
  };

  /**
   * @internal Initialize the TRPC instance with middlewares and procedures.
   */
  #initTrpc() {
    return trpcFeatures.initTrpc<TSchema>(this.#routers, this.#trpcOptions, this.#env);
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
  async bootstrap() {
    // Initialize components, respecting dependencies
    const db = this.#initDrizzle();
    const eventStore = this.#initEventSourcing();
    const kv = this.#initKv();
    // Pass initialized eventStore to message bus
    const messageBus = this.#initMessageBus(eventStore);

    // Initialize auth if configured
    let dotAuth: DotAuth | undefined;
    if (this.#authConfig) {
      dotAuth = await authFeatures.initAuth(this.#authConfig, db);
    }

    // Initialize tRPC with all components
    const trpc = this.#initTrpc();

    // Extract env and repositories from config
    const env = this.#env;
    // Provide default empty object if repositories aren't configured
    const repositories = this.#dbConfig?.repositories ?? ({} as TRepositories);

    // Create projection helper utilities - only if db is initialized
    const createProjection = db ? this.#createProjectionHelper(db) : undefined;
    // Only create repo projection helper if both db and repositories exist
    const createWithRepoProjection =
      db && Object.keys(repositories).length > 0 ? this.#createWithRepoProjectionHelper(repositories) : undefined;

    // Return all the initialized components
    return {
      name: this.#appName,
      /** The configured and merged tRPC router instance, or undefined if not configured. */
      router: trpc?.router,
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
      createCaller: trpc?.createCaller,
      /** All tRPC procedures and middlewares */
      trpc: trpc?.procedures,
      /** Custom context creation function that can be used in API routes */
      createContext: this.#createTRPCContext,
      /** The initialized DotAuth instance with better-auth integration */
      auth: dotAuth,
    };
  }

  /** @internal Initializes the Drizzle ORM database connection. */
  #initDrizzle() {
    return dbFeatures.initDrizzle<TSchema>(this.#dbConfig, this.#env, Dot.#DB_URL_VARIANTS, this.#getEnvVar.bind(this));
  }

  /** @internal Initializes the Event Store. */
  #initEventSourcing() {
    let eventDbUrl = this.#eventSourcingConfig?.dbUrl;

    eventDbUrl ??= this.#getEnvVar(EVENT_STORE_URL_VARIANTS);
    eventDbUrl ??= this.#getEnvVar(Dot.#DB_URL_VARIANTS);

    // Try to get URL from resolved Drizzle config if available
    if (!eventDbUrl && this.#dbConfig?.url) {
      eventDbUrl = this.#dbConfig.url;
    }

    if (!eventDbUrl) {
      if (this.#eventSourcingConfig?.projections && this.#eventSourcingConfig.projections.length > 0) {
        throw new Error(
          `Event Store database URL is required when projections are configured. Provide via withEventSourcing(), Drizzle config, or environment variables: ${[...EVENT_STORE_URL_VARIANTS, ...Dot.#DB_URL_VARIANTS].join(', ')}`,
        );
      } else {
        // No projections, Event Store not strictly needed, return undefined.
        return;
      }
    }

    return eventSourcingFeatures.initEventSourcing(this.#eventSourcingConfig?.projections ?? [], eventDbUrl);
  }

  /** @internal Initializes the Key-Value store. */
  #initKv(): KV | undefined {
    return kvFeatures.initKv(this.#kvConfig, this.#appName);
  }

  /** @internal Initializes the Message Bus and registers command handlers. */
  #initMessageBus(eventStore: EventStore | undefined): MessageBus {
    return eventSourcingFeatures.initMessageBus(eventStore, this.#commandHandlers);
  }

  /**
   * @internal Creates the `createProjection` helper function.
   */
  #createProjectionHelper(db: NodePgDatabase<TSchema>) {
    return dbFeatures.createProjectionHelper(db);
  }

  /**
   * @internal Creates the `createWithRepoProjection` helper function.
   */
  #createWithRepoProjectionHelper(repositories: TRepositories) {
    return dbFeatures.createWithRepoProjectionHelper<TRepositories>(repositories);
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

// Re-export types
export * from './types';

// Re-export auth module
export {
  // Main auth functionality
  createDotAuth,
  createAuthConfigFromEnv,
  authPresets,
  dotAuthIntegration,
  sessionUtils,

  // Types
  type DotAuth,
  type DotAuthConfig,
  type DotUser,
  type DotSession,
  type DotSessionManager,
  type DotRBACManager,

  // Auth types
  type Role,
  type Permission,
  type PolicyContext,
  type SessionConfig,
  type RBACConfig,
  type MFAConfig,
  type SecurityConfig,
  type EmailConfig,

  // Provider types
  type BuiltInProvider,
  type CustomProvider,
  type ProviderConfig,

  // Error types
  type AuthErrorCode,
} from './auth/index';

// Re-export auth features
export { authFeatures } from './auth';
