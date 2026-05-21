import type { EventStore, MessageBus } from '@event-driven-io/emmett';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Session type is provided by our auth module
import type { KV } from '@arki/kv';

import type { DotAuth, DotSession } from './auth';
import type { ExtractAllRepositoryTypes, ExtractAllRouterTypes, PluginConfig } from './plugin';
import type { PluginSetupContext } from './orpc/init';
import type {
  AuthConfig,
  BaseProjectionDefinition,
  CommandHandlerRegistration,
  EnvConfig,
  Repository,
  RouterRecord,
  SchemaInterface,
  RPCOptions,
} from './types';
import { authFeatures } from './auth';
import { dbFeatures } from './db';
import { EVENT_STORE_URL_VARIANTS, eventSourcingFeatures } from './event-sourcing';
import { kvFeatures } from './kv';
import { PluginRegistry } from './plugin';
import { createDotProcedures, rpcFeatures } from './orpc';

/**
 * Dot Framework Builder
 *
 * Provides a fluent API (builder pattern) to configure and initialize
 * the core components of a full-stack application.
 *
 * @deprecated Use `defineApp` from the new kernel. The legacy `Dot` class is
 * preserved for in-tree consumers (games-platform, kapodopera) only.
 *
 * @template TAppName A string literal type for the application name.
 * @template TRouters The structure of the combined oRPC routers.
 * @template TSchema The Drizzle database schema structure.
 * @template TRepositories The structure of the application's repositories.
 * @template TEnv The structure of the validated environment variables.
 */
export class Dot<
  TAppName extends string,
  TRouters extends RouterRecord = {},
  TSchema extends SchemaInterface = SchemaInterface,
  TRepositories extends Repository = {},
  TEnv extends EnvConfig = EnvConfig,
> {
  readonly #appName: TAppName;
  readonly #routers: TRouters | null;
  readonly #dbConfig: { url?: string; relations: TSchema; debug?: boolean; repositories?: TRepositories } | null;
  readonly #eventSourcingConfig: { dbUrl?: string; projections: BaseProjectionDefinition[] } | null;
  readonly #kvConfig: { url: string } | null;
  readonly #env: TEnv;
  readonly #commandHandlers: CommandHandlerRegistration[];
  readonly #rpcOptions: RPCOptions<TSchema> | null;
  readonly #authConfig: AuthConfig | null;
  readonly #pluginRegistry: PluginRegistry<TSchema>;

  // #region Environment Variable Constants
  /** @internal Alternative names for the primary database connection URL environment variable. */
  static readonly #DB_URL_VARIANTS = ['DB_URL', 'DB_URL', 'POSTGRES_URL', 'POSTGRESQL_URL', 'PG_URL', 'SQL_URL'];

  /** @internal Alternative names for the Key-Value store connection URL environment variable. */
  static readonly #KV_URL_VARIANTS = ['KV_URL', 'REDIS_URL', 'KEYVALUE_URL', 'CACHE_URL', 'UPSTASH_REDIS_URL'];

  /**
   * @internal Use `createDot(appName)` to start building.
   */
  constructor(
    name: TAppName,
    options: {
      routers?: TRouters | null;
      dbConfig?: { url?: string; relations: TSchema; debug?: boolean; repositories?: TRepositories } | null;
      eventSourcingConfig?: { dbUrl?: string; projections: BaseProjectionDefinition[] } | null;
      kvConfig?: { url: string } | null;
      env?: TEnv;
      commandHandlers?: CommandHandlerRegistration[];
      rpcOptions?: RPCOptions<TSchema> | null;
      authConfig?: AuthConfig | null;
      pluginRegistry?: PluginRegistry<TSchema>;
    } = {},
  ) {
    this.#appName = name;
    this.#routers = options.routers ?? null;
    this.#dbConfig = options.dbConfig ?? null;
    this.#eventSourcingConfig = options.eventSourcingConfig ?? null;
    this.#kvConfig = options.kvConfig ?? null;
    this.#env = options.env ?? ({} as TEnv);
    this.#commandHandlers = options.commandHandlers ?? [];
    this.#rpcOptions = options.rpcOptions ?? null;
    this.#authConfig = options.authConfig ?? null;
    this.#pluginRegistry = options.pluginRegistry ?? new PluginRegistry<TSchema>();
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
    dbConfig?: { url?: string; relations: TNewSchema; debug?: boolean; repositories?: TNewRepositories } | null;
    eventSourcingConfig?: { dbUrl?: string; projections: BaseProjectionDefinition[] } | null;
    kvConfig?: { url: string } | null;
    env?: TNewEnv;
    commandHandlers?: CommandHandlerRegistration[];
    rpcOptions?: RPCOptions<TNewSchema> | null;
    authConfig?: AuthConfig | null;
    pluginRegistry?: PluginRegistry<TNewSchema>;
  }) {
    return new Dot<TAppName, TNewRouters, TNewSchema, TNewRepositories, TNewEnv>(this.#appName, {
      routers: options.routers ?? (this.#routers as unknown as TNewRouters),
      dbConfig:
        options.dbConfig ??
        (this.#dbConfig as unknown as {
          url?: string;
          relations: TNewSchema;
          debug?: boolean;
          repositories?: TNewRepositories;
        }),
      eventSourcingConfig: options.eventSourcingConfig ?? this.#eventSourcingConfig,
      kvConfig: options.kvConfig ?? this.#kvConfig,
      env: options.env ?? (this.#env as unknown as TNewEnv),
      commandHandlers: options.commandHandlers ?? this.#commandHandlers,
      rpcOptions: options.rpcOptions ?? (this.#rpcOptions as unknown as RPCOptions<TNewSchema>),
      authConfig: options.authConfig ?? this.#authConfig,
      pluginRegistry: options.pluginRegistry ?? (this.#pluginRegistry as unknown as PluginRegistry<TNewSchema>),
    });
  }
  // #endregion

  // #region Configuration Methods
  /**
   * Adds oRPC routers to the application configuration.
   * @param routers An object mapping router names to oRPC router instances (`AnyRouter`).
   * @returns A new Dot instance with the updated configuration.
   * @example
   * .withRouters({ user: userRouter, post: postRouter })
   */
  withRouters<TNewRouters extends RouterRecord>(routers: TNewRouters, options?: RPCOptions<TSchema>) {
    return this.createNew<TNewRouters>({
      routers,
      rpcOptions: options ?? this.#rpcOptions,
    });
  }

  /**
   * Configures the database connection, relations, and repositories.
   *
   * This is the primary method for setting up Drizzle ORM and associated repositories.
   * The database URL will be automatically inferred from environment variables
   * (e.g., DB_URL, DB_URL) if not explicitly provided in `options.url`.
   *
   * @param relations The Drizzle 1.0 relations config produced by
   *   `defineRelations(tables, builder)` (type: `SchemaInterface` aka `AnyRelations`).
   * @param repositories An object containing repository instances, keyed by name (optional).
   * @param options Optional configuration: `url` overrides environment variables, `debug` enables Drizzle logging.
   * @returns A new Dot instance with the updated configuration.
   * @example
   * .withDb(relations, { userRepo, postRepo }, { debug: true })
   * .withDb(relations, { userRepo }, { url: 'postgres://...' })
   * .withDb(relations) // Only configure relations and default DB connection
   */
  withDb<TNewSchema extends SchemaInterface, TNewRepositories extends Repository = TRepositories>(
    relations: Readonly<TNewSchema>,
    repositories?: Readonly<TNewRepositories>,
    options: { url?: string; debug?: boolean } = {},
  ) {
    // Explicitly cast repositories to ensure type compatibility if provided
    const currentRepositories = repositories as TNewRepositories | undefined;
    return this.createNew<TRouters, TNewSchema, TNewRepositories>({
      dbConfig: {
        url: options.url,
        relations,
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

  /**
   * Register plugins with the application.
   * Plugins will be initialized during bootstrap in dependency order.
   *
   * @param plugins Array of plugin configurations
   * @returns A new Dot instance with the plugins registered, router types and repository types merged
   * @example
   * .registerPlugins([authPlugin, trackingPlugin, socialPlugin])
   */
  registerPlugins<
    const Plugins extends readonly PluginConfig<TSchema, string, string, Record<string, any>, Record<string, any>>[],
  >(
    plugins: Plugins,
  ): Dot<
    TAppName,
    TRouters & ExtractAllRouterTypes<Plugins>,
    TSchema,
    TRepositories & ExtractAllRepositoryTypes<Plugins>,
    TEnv
  > {
    type MergedRouters = TRouters & ExtractAllRouterTypes<Plugins>;
    type MergedRepositories = TRepositories & ExtractAllRepositoryTypes<Plugins>;

    const newRegistry = new PluginRegistry<TSchema>();
    // Spread to convert readonly array to mutable array
    newRegistry.add([...plugins]);

    // Type assertion is necessary here because:
    // 1. Plugin routers and repositories are registered in the plugin registry
    // 2. They will be merged during bootstrap()
    // 3. The type system can't verify this multi-step process
    // 4. We're promising the routers and repositories will be available after bootstrap
    return this.createNew<MergedRouters, TSchema, MergedRepositories>({
      pluginRegistry: newRegistry,
    });
  }

  // Get access to dbConfig for internal use
  getDbConfig() {
    return this.#dbConfig;
  }

  // TODO: Add auth method when implemented
  // withAuth = authFeatures.withAuth;
  // #endregion

  // #region RPC and Context Functions
  /**
   * @internal Creates an RPC context based on the provided options and Dot configuration.
   */
  #createRPCContext = (opts: { headers: Headers; session: DotSession | null }) => {
    return rpcFeatures.createRPCContextFactory<TSchema>(
      this.#dbConfig,
      () => this.#initDrizzle(),
      () => this.#initKv(),
      () => this.#initEventSourcing(),
      eventStore => this.#initMessageBus(eventStore),
      this.#authConfig,
      this.#rpcOptions,
    )(opts);
  };

  // #endregion

  // #region Initialization and Bootstrap
  /**
   * Initializes all configured components and returns the application instance.
   *
   * This method performs the final setup based on the preceding `with...` calls.
   * It resolves connection URLs, initializes databases, event stores, KV stores,
   * the message bus, and creates utility functions.
   *
   * If plugins are registered, they will be initialized first and their registrations
   * will be merged with any explicit configuration.
   *
   * @returns An object containing the initialized application components and utilities.
   */
  async bootstrap() {
    // Create a mutable working copy for plugin merging
    let workingRouters = this.#routers ? { ...this.#routers } : {};
    let workingDbConfig = this.#dbConfig ? { ...this.#dbConfig } : null;
    let workingEventSourcingConfig = this.#eventSourcingConfig ? { ...this.#eventSourcingConfig } : null;
    const workingCommandHandlers = [...this.#commandHandlers];

    // Step 1: Initialize plugins if any are registered
    if (this.#pluginRegistry.size > 0) {
      // Initialize basic services that plugins might need during setup
      const pluginDb = this.#initDrizzle();
      const pluginKv = this.#initKv();
      const pluginEventStore = this.#initEventSourcing();
      const pluginMessageBus = this.#initMessageBus(pluginEventStore);

      // Create oRPC procedures for portable plugins
      // Plugins use these procedures to define routers without importing app-specific code
      const procedures = createDotProcedures({
        isDevelopment: this.#env['NODE_ENV'] === 'development',
        env: this.#env,
      });

      // Create setup context with procedures and services for plugin onSetup hooks
      const setupContext: PluginSetupContext<TSchema> = {
        procedures,
        db: pluginDb,
        kv: pluginKv,
        eventStore: pluginEventStore,
        messageBus: pluginMessageBus,
      };

      // Initialize plugins with services and setup context
      await this.#pluginRegistry.initialize(
        {
          db: pluginDb,
          kv: pluginKv,
          eventStore: pluginEventStore,
          messageBus: pluginMessageBus,
        },
        setupContext,
      );

      // Build routers from factory functions (new portable pattern)
      this.#pluginRegistry.buildRoutersFromFactories(procedures);

      // Get plugin registrations (includes both direct routers and factory-built routers)
      const registrations = this.#pluginRegistry.getRegistrations();

      // Merge plugin registrations with explicit config
      // Plugins take precedence - they extend/override manual config
      workingRouters = { ...workingRouters, ...registrations.routers };

      if (Object.keys(registrations.schemas).length > 0) {
        workingDbConfig = {
          url: workingDbConfig?.url,
          // Plugin builders' `.schema(...)` registry is type-erased (a plain
          // bag of unknown). The cast here bridges that bag into the
          // type-safe `relations` field; runtime correctness is the
          // responsibility of the plugin author calling `defineRelations`.
          relations: { ...workingDbConfig?.relations, ...registrations.schemas } as TSchema,
          debug: workingDbConfig?.debug,
          repositories: workingDbConfig?.repositories,
        };
      }

      // Merge command handlers and projections
      workingCommandHandlers.push(...registrations.commandHandlers);
      workingEventSourcingConfig = {
        dbUrl: workingEventSourcingConfig?.dbUrl,
        projections: [...(workingEventSourcingConfig?.projections ?? []), ...registrations.projections],
      };

      // Note: Repositories are handled separately since they need db instance
    }

    // Step 2: Initialize components with merged configuration
    const db = this.#initDrizzle();
    const eventStore = this.#initEventSourcing();
    const kv = this.#initKv();
    const messageBus = this.#initMessageBus(eventStore);

    // Step 3: Build repositories (including plugin repos)
    let repositories = this.#dbConfig?.repositories ?? ({} as TRepositories);

    if (this.#pluginRegistry.size > 0 && db) {
      const pluginRegistrations = this.#pluginRegistry.getRegistrations();
      const pluginRepos: Record<string, unknown> = {};

      for (const [name, factory] of pluginRegistrations.repositories.entries()) {
        pluginRepos[name] = factory(db);
      }

      repositories = { ...repositories, ...pluginRepos } as TRepositories;
    }

    // Step 4: Initialize auth if configured
    let dotAuth: DotAuth | undefined;
    if (this.#authConfig) {
      dotAuth = await authFeatures.initAuth(this.#authConfig, db);
    }

    // Step 5: Initialize oRPC with merged routers
    // Use the merged workingRouters instead of this.#routers to include plugin routers
    const rpc = rpcFeatures.initRPC<TRouters>(workingRouters as TRouters, this.#rpcOptions as RPCOptions<SchemaInterface> | null, this.#env);

    // Step 6: Extract env
    const env = this.#env;

    // Step 7: Create projection helper utilities - only if db is initialized
    const createProjection = db ? this.#createProjectionHelper(db) : undefined;
    // Only create repo projection helper if both db and repositories exist
    const createWithRepoProjection =
      db && Object.keys(repositories).length > 0 ? this.#createWithRepoProjectionHelper(repositories) : undefined;

    // Return all the initialized components
    return {
      name: this.#appName,
      /** The configured and merged oRPC router instance, or undefined if not configured. */
      router: rpc?.router,
      /** The initialized Drizzle database instance, or undefined if not configured. */
      db,
      /** The initialized Event Store instance, or undefined if not configured. */
      eventStore,
      /** The initialized Key-Value store instance, or undefined if not configured. */
      kv,
      /** The validated environment variables object. */
      env,
      /** The configured repositories object (includes plugin repositories). */
      repositories,
      /** The initialized message bus instance. */
      bus: messageBus,
      /** Utility function to create a Drizzle projection definition, or undefined if DB not configured. */
      createProjection,
      /** Utility function to create a Drizzle projection definition with repository access, or undefined if DB/Repositories not configured. */
      createWithRepoProjection,
      /** Utility function to create a server-side oRPC caller, or undefined if router not configured. */
      createCaller: rpc?.createCaller,
      /** All oRPC procedures */
      rpc: rpc?.procedures,
      /** Custom context creation function that can be used in API routes */
      createContext: this.#createRPCContext,
      /** The initialized DotAuth instance with better-auth integration */
      auth: dotAuth,
      /** Plugin registry for inspection */
      plugins: this.#pluginRegistry,
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

    // Destructure to extract only the eventStore
    // The close function is available but not currently used by the Dot framework
    const { eventStore } = eventSourcingFeatures.initEventSourcing(
      this.#eventSourcingConfig?.projections ?? [],
      eventDbUrl,
    );
    return eventStore;
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
 *
 * @deprecated Use `defineApp(name)` from the new kernel — the legacy `createDot`
 * builder is kept for in-tree consumers (games-platform, kapodopera) and will
 * be removed once they migrate. New code MUST use `defineApp`.
 *
 * @param name A unique name for the application (used for KV namespacing, etc.).
 * @returns A new Dot instance to start configuration.
 * @example
 * const appBuilder = createDot('my-cool-app');
 */
export function createDot<TAppName extends string>(name: TAppName) {
  return new Dot(name);
}

// #region New kernel — public surface (Task 9a)
//
// `defineApp` is the new entry point. `createDot` / `definePlugin` / `Dot`
// remain as @deprecated aliases for the duration of the migration.
export { defineApp } from './define-app';
export type { DotApp, DotAppBuilder, DotAppConfigured } from './define-app';
export { defineDotPlugin } from './plugin-contract';
export type {
  DotPlugin,
  DotBootContext,
  DotBootResult,
  DotConfigureContext,
  DotDisposeContext,
  DotManifestContext,
  DotManifestContribution,
  DotStartContext,
  DotStopContext,
} from './plugin-contract';
export {
  DotLifecycleError,
  DotLifecycleErrorCode,
  DOT_LIFECYCLE_HOOKS,
} from './lifecycle';
export type {
  DotLifecycleHook,
  DotLifecycleState,
  DotLifecyclePluginFailure,
  DotLifecycleErrorCodeValue,
} from './lifecycle';
export type {
  DotAppManifest,
  PluginManifest,
  RouteManifest,
  ServiceManifest,
  LifecycleManifest,
  DependencyEdge,
  DependencyEdgeKind,
  ServiceKind,
  RouteTransport,
} from './manifest';
export type {
  DotDiagnosticsSnapshot,
  PluginDiagnostic,
  RouteDiagnostic,
  ServiceDiagnostic,
  LifecycleDiagnostic,
  DiagnosticIssue,
  DiagnosticSeverity,
  DiagnosticStatus,
} from './diagnostics';
export { testApp, bootTestApp } from './test-harness';
export type { TestAppOptions } from './test-harness';
// #endregion

// Re-export types
export * from './types';

// Re-export plugin system
export { definePlugin, PluginBuilder, type PluginConfig, type PluginContext } from './plugin';

// Re-export context management utilities
export * from './context';

// Re-export oRPC module (portable API)
export { createDotProcedures } from './orpc';
export type { DotContext, PluginSetupContext, ORPCKit, ORPCKitWithO } from './orpc';
export type { CreateDotProceduresOptions, DotMiddlewareConfig } from './orpc/types';

// Re-export auth module
export {
  authPresets,
  createAuthConfigFromEnv,
  // Main auth functionality
  createDotAuth,
  dotAuthIntegration,
  sessionUtils,
  // Provider types
  type BuiltInProvider,
  type CustomProvider,
  // Types
  type DotAuth,
  type DotAuthConfig,
  type DotRBACManager,
  type DotSession,
  type DotSessionManager,
  type DotUser,
  type EmailConfig,
  type MFAConfig,
  type Permission,
  type PolicyContext,
  type ProviderConfigs,
  type RBACConfig,
  // Auth types
  type Role,
  type SecurityConfig,
  type SessionConfig,
} from './auth/index';

// Re-export auth features
export { authFeatures } from './auth';
