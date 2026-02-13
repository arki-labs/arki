import type { EventStore, MessageBus } from '@event-driven-io/emmett';
import type { AnyRouter } from '@trpc/server/unstable-core-do-not-import';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { KV } from '@arki/kv';

import { debugPlugin } from './debug.ts';
import type {
  BaseProjectionDefinition,
  CommandHandlerRegistration,
  Repository,
  SchemaInterface,
} from './types';
import type { TRPCKit, PluginSetupContext } from './trpc';

/**
 * Repository factory that accepts any schema type
 */
export type RepositoryFactory = (db: NodePgDatabase<SchemaInterface>) => Repository;

/**
 * Context provided to plugins during registration.
 * Plugins use these methods to register their components.
 */
export type PluginContext<TSchema extends SchemaInterface = SchemaInterface> = {
  /**
   * Register a tRPC router under a specific namespace
   * @example registerRouter('tracking', trackingRouter)
   */
  registerRouter: (name: string, router: AnyRouter) => void;

  /**
   * Register database schema definitions
   * @example registerSchema({ users, posts })
   */
  registerSchema: (schema: Record<string, unknown>) => void;

  /**
   * Register a repository factory function
   * Note: The factory will receive the concrete database instance at runtime
   * @example registerRepository('tracking', createTrackingRepositories)
   */
  registerRepository: (name: string, factory: RepositoryFactory) => void;

  /**
   * Register event sourcing projections
   * @example registerProjections(trackingProjection, userProjection)
   */
  registerProjections: (...projections: BaseProjectionDefinition[]) => void;

  /**
   * Register command handlers for the message bus
   * @example registerCommands(...trackingCommandHandlers)
   */
  registerCommands: (...handlers: CommandHandlerRegistration[]) => void;

  /**
   * Register background jobs (if using job system)
   * @example registerJobs({ syncMovies, calculateStats })
   */
  registerJobs?: (jobs: Record<string, unknown>) => void;

  /**
   * Register process managers (saga patterns)
   * @example registerProcessManager(notificationProcessManager)
   */
  registerProcessManager?: (pm: unknown) => void;

  /**
   * Access to initialized services (available during late-stage setup)
   */
  services?: {
    db?: NodePgDatabase<TSchema>;
    kv?: KV;
    eventStore?: EventStore;
    messageBus?: MessageBus;
  };
}

/**
 * Plugin configuration interface.
 * Each feature exports a plugin implementing this interface.
 */
export type PluginConfig<
  TSchema extends SchemaInterface = SchemaInterface,
  TName extends string = string,
  TRouterNames extends string = never,
  TRouterTypes extends Record<string, AnyRouter> = Record<never, never>,
  TRepositoryTypes extends Record<string, Repository> = Record<never, never>,
> = {
  /**
   * Unique identifier for this plugin
   */
  name: TName;

  /**
   * Setup function called during bootstrap.
   * Use the provided context to register components.
   *
   * @example
   * ```typescript
   * setup: ({ registerRouter, registerRepository }) => {
   *   registerRouter('tracking', trackingRouter);
   *   registerRepository('tracking', createTrackingRepositories);
   * }
   * ```
   */
  setup: (context: PluginContext<TSchema>) => void | Promise<void>;

  /**
   * Optional: Router factory function that receives tRPC procedures.
   * This is the new, portable way to define routers.
   *
   * @example
   * ```typescript
   * routerFactory: (procedures) => procedures.router({
   *   getUser: procedures.publicProcedure.query(async () => { ... }),
   * })
   * ```
   */
  routerFactory?: (procedures: TRPCKit) => AnyRouter;

  /**
   * Optional: Lifecycle hook called during plugin setup.
   * Receives procedures and initialized services.
   *
   * @example
   * ```typescript
   * onSetup: async ({ procedures, db, kv }) => {
   *   // Custom setup logic
   * }
   * ```
   */
  onSetup?: (ctx: PluginSetupContext<TSchema>) => Promise<void> | void;

  /**
   * Optional: Plugin dependencies (load order)
   * @example dependencies: ['auth', 'content']
   */
  dependencies?: string[];

  /**
   * Optional: Plugin metadata
   */
  metadata?: {
    version?: string;
    description?: string;
    author?: string;
  };

  /**
   * @internal
   * Phantom type to track registered router names at the type level.
   * This property doesn't exist at runtime but is required for type inference.
   */
  _routerNames: TRouterNames;

  /**
   * @internal
   * Phantom type to track actual router types at the type level.
   * This property doesn't exist at runtime but is required for type inference.
   */
  _routerTypes: TRouterTypes;

  /**
   * @internal
   * Phantom type to track actual repository types at the type level.
   * This property doesn't exist at runtime but is required for type inference.
   */
  _repositoryTypes: TRepositoryTypes;
}


/**
 * Extract router names from a single plugin
 */
export type ExtractRouterNames<P> = P extends PluginConfig<any, any, infer Names> ? Names : never;

/**
 * Extract all router names from an array of plugins recursively
 */
export type ExtractAllRouterNames<Plugins extends readonly any[]> = Plugins extends readonly [
  infer First,
  ...infer Rest,
]
  ? ExtractRouterNames<First> | ExtractAllRouterNames<Rest>
  : never;

/**
 * Extract router types from a single plugin
 */
export type ExtractRouterTypes<P> = P extends PluginConfig<any, any, any, infer Types> ? Types : Record<never, never>;

/**
 * Extract all router types from an array of plugins recursively
 */
export type ExtractAllRouterTypes<Plugins extends readonly any[]> = Plugins extends readonly [
  infer First,
  ...infer Rest,
]
  ? ExtractRouterTypes<First> & ExtractAllRouterTypes<Rest>
  : Record<never, never>;

/**
 * Extract repository types from a single plugin
 */
export type ExtractRepositoryTypes<P> = P extends PluginConfig<any, any, any, any, infer Types> ? Types : Record<never, never>;

/**
 * Extract all repository types from an array of plugins recursively
 */
export type ExtractAllRepositoryTypes<Plugins extends readonly any[]> = Plugins extends readonly [
  infer First,
  ...infer Rest,
]
  ? ExtractRepositoryTypes<First> & ExtractAllRepositoryTypes<Rest>
  : Record<never, never>;

/**
 * Create a router record type from router names
 * Uses a mapped type instead of Record to enable autocomplete
 */
export type PluginRouterRecord<Names extends string> = Record<Names, AnyRouter>;

/**
 * Fluent builder for creating type-safe plugins
 *
 * The builder implements PluginConfig directly, so no .build() call is needed.
 *
 * @example
 * ```typescript
 * export const trackingPlugin = definePlugin('tracking')
 *   .dependsOn(authPlugin, contentPlugin)
 *   .router(trackingRouter)  // Name defaults to 'tracking'
 *   .schema(schema)
 *   .repository(createTrackingRepositories)  // Name defaults to 'tracking'
 *   .projections(trackingProjection)
 *   .commands(...trackingCommandHandlers);
 * ```
 */
export class PluginBuilder<
  TSchema extends SchemaInterface = SchemaInterface,
  TName extends string = string,
  TRouterNames extends string = never,
  TRouterTypes extends Record<string, AnyRouter> = Record<never, never>,
  TRepositoryTypes extends Record<string, Repository> = Record<never, never>,
> implements PluginConfig<TSchema, TName, TRouterNames, TRouterTypes, TRepositoryTypes>
{
  readonly name: TName;
  #dependencies?: string[];
  #metadata?: { version?: string; description?: string; author?: string };

  #routers: Record<string, AnyRouter> = {};
  #routerFactories: Record<string, (procedures: TRPCKit) => AnyRouter> = {};
  #schemas: Record<string, unknown> = {};
  #repositories = new Map<string, RepositoryFactory>();
  #projections: BaseProjectionDefinition[] = [];
  #commands: CommandHandlerRegistration[] = [];
  #jobs: Record<string, unknown> = {};
  #processManagers: unknown[] = [];
  #onSetupHandler?: (ctx: PluginSetupContext<TSchema>) => Promise<void> | void;

  /**
   * Phantom property for type inference - never accessed at runtime
   * @internal
   */
  _routerNames!: TRouterNames;

  /**
   * Phantom property for type inference - never accessed at runtime
   * @internal
   */
  _routerTypes!: TRouterTypes;

  /**
   * Phantom property for type inference - never accessed at runtime
   * @internal
   */
  _repositoryTypes!: TRepositoryTypes;

  constructor(name: TName) {
    this.name = name;
  }

  // Implement PluginConfig interface getters
  get dependencies(): string[] | undefined {
    return this.#dependencies;
  }

  get metadata(): { version?: string; description?: string; author?: string } | undefined {
    return this.#metadata;
  }

  get routerFactory(): ((procedures: TRPCKit) => AnyRouter) | undefined {
    // If we have router factories, return a combined factory
    const factories = Object.entries(this.#routerFactories);
    if (factories.length === 0) return undefined;

    if (factories.length === 1) {
      return factories[0]![1];
    }

    // Multiple factories - need to merge routers
    return (procedures) => {
      const routers: Record<string, AnyRouter> = {};
      for (const [name, factory] of factories) {
        routers[name] = factory(procedures);
      }
      return procedures.mergeRouters(...Object.values(routers));
    };
  }

  get onSetup(): ((ctx: PluginSetupContext<TSchema>) => Promise<void> | void) | undefined {
    return this.#onSetupHandler;
  }

  /**
   * Declare dependencies on other plugins (for load ordering)
   * @param plugins - Plugin instances (not strings!)
   * @example
   * ```typescript
   * .dependsOn(authPlugin, contentPlugin)
   * ```
   */
  dependsOn<TDepNames extends string>(
    ...plugins: PluginConfig<TSchema, TDepNames, string>[]
  ): this {
    const depNames = plugins.map(p => p.name);
    this.#dependencies = depNames;
    return this;
  }

  /**
   * Register a tRPC router
   * @param router - Router to register (name defaults to plugin name)
   * @param name - Optional explicit name
   * @example
   * ```typescript
   * .router(trackingRouter)  // Registered as 'tracking'
   * .router('tracking.movies', moviesRouter)  // Explicit name
   * ```
   */
  router<R extends AnyRouter>(
    router: R,
  ): PluginBuilder<TSchema, TName, TRouterNames | TName, TRouterTypes & Record<TName, R>>;
  router<N extends string, R extends AnyRouter>(
    name: N,
    router: R,
  ): PluginBuilder<TSchema, TName, TRouterNames | N, TRouterTypes & Record<N, R>>;
  router(nameOrRouter: string | AnyRouter, maybeRouter?: AnyRouter) {
    if (typeof nameOrRouter === 'string') {
      this.#routers[nameOrRouter] = maybeRouter!;
    } else {
      this.#routers[this.name] = nameOrRouter;
    }
    return this;
  }

  /**
   * Define a tRPC router using a factory function (NEW - portable pattern)
   * The factory receives tRPC procedures from the framework, making plugins portable.
   *
   * @param factory - Factory function that receives procedures and returns a router
   * @param name - Optional explicit name (defaults to plugin name)
   * @example
   * ```typescript
   * .defineRouter((procedures) => procedures.router({
   *   getUser: procedures.publicProcedure.query(async ({ ctx }) => { ... }),
   *   createUser: procedures.protectedProcedure.mutation(async ({ ctx, input }) => { ... }),
   * }))
   * ```
   */
  defineRouter<R extends AnyRouter>(
    factory: (procedures: TRPCKit) => R,
  ): PluginBuilder<TSchema, TName, TRouterNames | TName, TRouterTypes & Record<TName, R>>;
  defineRouter<N extends string, R extends AnyRouter>(
    name: N,
    factory: (procedures: TRPCKit) => R,
  ): PluginBuilder<TSchema, TName, TRouterNames | N, TRouterTypes & Record<N, R>>;
  defineRouter(
    nameOrFactory: string | ((procedures: TRPCKit) => AnyRouter),
    maybeFactory?: (procedures: TRPCKit) => AnyRouter,
  ) {
    if (typeof nameOrFactory === 'string') {
      this.#routerFactories[nameOrFactory] = maybeFactory!;
    } else {
      this.#routerFactories[this.name] = nameOrFactory;
    }
    return this;
  }

  /**
   * Configure plugin initialization hook (NEW - advanced use cases)
   * Called during plugin setup with access to procedures and services.
   *
   * @param handler - Setup function that receives plugin setup context
   * @example
   * ```typescript
   * .configure(async ({ procedures, db, kv }) => {
   *   // Custom initialization logic
   *   console.log('Plugin initialized with procedures:', procedures);
   * })
   * ```
   */
  configure(
    handler: (ctx: PluginSetupContext<TSchema>) => Promise<void> | void,
  ): this {
    this.#onSetupHandler = handler;
    return this;
  }

  /**
   * Register database schema
   * @param schema - Schema definitions
   * @example
   * ```typescript
   * .schema(schema)
   * ```
   */
  schema(schema: Record<string, unknown>): this {
    Object.assign(this.#schemas, schema);
    return this;
  }

  /**
   * Register a repository factory
   * @param factory - Repository factory function (name defaults to plugin name)
   * @param name - Optional explicit name
   * @example
   * ```typescript
   * .repository(createTrackingRepositories)  // Registered as 'tracking'
   * .repository('tracking.movies', createMoviesRepository)  // Explicit name
   * ```
   */
  repository<R extends Repository>(
    factory: (db: NodePgDatabase<SchemaInterface>) => R,
  ): PluginBuilder<TSchema, TName, TRouterNames, TRouterTypes, TRepositoryTypes & Record<TName, R>>;
  repository<N extends string, R extends Repository>(
    name: N,
    factory: (db: NodePgDatabase<SchemaInterface>) => R,
  ): PluginBuilder<TSchema, TName, TRouterNames, TRouterTypes, TRepositoryTypes & Record<N, R>>;
  repository(nameOrFactory: string | RepositoryFactory, maybeFactory?: RepositoryFactory) {
    if (typeof nameOrFactory === 'string') {
      this.#repositories.set(nameOrFactory, maybeFactory!);
    } else {
      this.#repositories.set(this.name, nameOrFactory);
    }
    return this;
  }

  /**
   * Register event sourcing projections
   * @param projections - Projection definitions
   * @example
   * ```typescript
   * .projections(trackingProjection, analyticsProjection)
   * ```
   */
  projections(...projections: BaseProjectionDefinition[]): this {
    this.#projections.push(...projections);
    return this;
  }

  /**
   * Register command handlers
   * @param handlers - Command handler registrations
   * @example
   * ```typescript
   * .commands(...trackingCommandHandlers)
   * ```
   */
  commands(...handlers: CommandHandlerRegistration[]): this {
    this.#commands.push(...handlers);
    return this;
  }

  /**
   * Register background jobs
   * @param jobs - Job definitions
   * @example
   * ```typescript
   * .jobs({ syncMovies, calculateStats })
   * ```
   */
  jobs(jobs: Record<string, unknown>): this {
    Object.assign(this.#jobs, jobs);
    return this;
  }

  /**
   * Register a process manager (saga)
   * @param pm - Process manager instance
   * @example
   * ```typescript
   * .processManager(notificationProcessManager)
   * ```
   */
  processManager(pm: unknown): this {
    this.#processManagers.push(pm);
    return this;
  }

  /**
   * Set plugin metadata
   * @param metadata - Version, description, author
   * @example
   * ```typescript
   * .withMetadata({ version: '1.0.0', description: 'Tracking features' })
   * ```
   */
  withMetadata(metadata: { version?: string; description?: string; author?: string }): this {
    this.#metadata = metadata;
    return this;
  }

  /**
   * Generate setup function on-demand (implements PluginConfig interface)
   * This is called by the plugin registry during initialization
   */
  get setup(): (context: PluginContext<TSchema>) => void | Promise<void> {
    return (context) => {
      // Register routers
      for (const [name, router] of Object.entries(this.#routers)) context.registerRouter(name, router);

      // Register schemas
      if (Object.keys(this.#schemas).length > 0) {
        context.registerSchema(this.#schemas);
      }

      // Register repositories
      for (const [name, factory] of this.#repositories.entries()) context.registerRepository(name, factory);

      // Register projections
      if (this.#projections.length > 0) {
        context.registerProjections(...this.#projections);
      }

      // Register commands
      if (this.#commands.length > 0) {
        context.registerCommands(...this.#commands);
      }

      // Register jobs
      if (Object.keys(this.#jobs).length > 0 && context.registerJobs) {
        context.registerJobs(this.#jobs);
      }

      // Register process managers
      if (this.#processManagers.length > 0 && context.registerProcessManager) {
        for (const pm of this.#processManagers) context.registerProcessManager?.(pm);
      }
    };
  }
}

/**
 * Create a new plugin builder
 *
 * @param name - Unique plugin identifier
 * @returns Fluent builder for configuring the plugin
 *
 * @example
 * ```typescript
 * export const trackingPlugin = definePlugin('tracking')
 *   .dependsOn(authPlugin)
 *   .router(trackingRouter)
 *   .repository(createTrackingRepositories);
 * ```
 */
export function definePlugin<TName extends string>(
  name: TName,
): PluginBuilder<SchemaInterface, TName, never, Record<never, never>, Record<never, never>> {
  return new PluginBuilder<SchemaInterface, TName, never, Record<never, never>, Record<never, never>>(name);
}

/**
 * Internal plugin registry used by Dot
 * @internal
 */
export class PluginRegistry<TSchema extends SchemaInterface = SchemaInterface> {
  private plugins = new Map<string, PluginConfig<TSchema, string, string>>();
  private routers: Record<string, AnyRouter> = {};
  private schemas: Record<string, unknown> = {};
  private repositories = new Map<string, RepositoryFactory>();
  private projections: BaseProjectionDefinition[] = [];
  private commandHandlers: CommandHandlerRegistration[] = [];
  private jobs: Record<string, unknown> = {};
  private processManagers: unknown[] = [];

  /**
   * Add plugins to the registry
   */
  add(plugins: PluginConfig<TSchema, string, string>[]) {
    debugPlugin('[PluginRegistry] Adding %d plugin(s) to registry', plugins.length);
    for (const plugin of plugins) {
      if (this.plugins.has(plugin.name)) {
        debugPlugin('[PluginRegistry] Error: Plugin "%s" is already registered', plugin.name);
        throw new Error(`Plugin "${plugin.name}" is already registered`);
      }
      debugPlugin('[PluginRegistry] Registering plugin: %s', plugin.name);
      this.plugins.set(plugin.name, plugin);
    }
    debugPlugin('[PluginRegistry] Successfully added %d plugin(s). Total plugins: %d', plugins.length, this.plugins.size);
  }

  /**
   * Get plugins in dependency order
   */
  private getOrderedPlugins(): PluginConfig<TSchema, string, string>[] {
    debugPlugin('[PluginRegistry] Sorting %d plugin(s) by dependency order', this.plugins.size);
    const sorted: PluginConfig<TSchema, string, string>[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        debugPlugin('[PluginRegistry] Circular dependency detected for plugin: %s', name);
        throw new Error(`Circular dependency detected for plugin "${name}"`);
      }

      const plugin = this.plugins.get(name);
      if (!plugin) {
        debugPlugin('[PluginRegistry] Plugin not found: %s (required as dependency)', name);
        throw new Error(`Plugin "${name}" not found (required as dependency)`);
      }

      visiting.add(name);

      // Visit dependencies first
      if (plugin.dependencies) {
        debugPlugin('[PluginRegistry] Processing %d dependency/dependencies for plugin: %s', plugin.dependencies.length, name);
        for (const dep of plugin.dependencies) {
          visit(dep);
        }
      }

      visiting.delete(name);
      visited.add(name);
      sorted.push(plugin);
      debugPlugin('[PluginRegistry] Plugin "%s" added to sorted list (position: %d)', name, sorted.length);
    };

    // Visit all plugins
    for (const name of this.plugins.keys()) {
      visit(name);
    }

    debugPlugin('[PluginRegistry] Dependency sorting complete. Order: %s', sorted.map(p => p.name).join(' -> '));
    return sorted;
  }

  /**
   * Build routers from plugin factories
   * This should be called after plugins are initialized but before the app starts
   * @param procedures - tRPC procedures from the framework
   */
  buildRoutersFromFactories(procedures: TRPCKit) {
    const orderedPlugins = this.getOrderedPlugins();
    const pluginsWithFactories = orderedPlugins.filter(p => p.routerFactory);
    debugPlugin('[PluginRegistry] Building routers from %d plugin(s) with router factories', pluginsWithFactories.length);

    for (const plugin of orderedPlugins) {
      // Skip plugins without router factories
      if (!plugin.routerFactory) continue;

      debugPlugin('[PluginRegistry] Building router for plugin: %s', plugin.name);
      try {
        const router = plugin.routerFactory(procedures);

        // Register the router under the plugin name
        if (this.routers[plugin.name]) {
          debugPlugin('[PluginRegistry] Error: Router "%s" is already registered', plugin.name);
          throw new Error(`Router "${plugin.name}" is already registered`);
        }
        this.routers[plugin.name] = router;
        debugPlugin('[PluginRegistry] Successfully built and registered router for plugin: %s', plugin.name);
      } catch (error) {
        debugPlugin('[PluginRegistry] Failed to build router for plugin "%s": %s', plugin.name, error instanceof Error ? error.message : 'Unknown error');
        throw new Error(
          `Failed to build router for plugin "${plugin.name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    debugPlugin('[PluginRegistry] Router building complete. Total routers: %d', Object.keys(this.routers).length);
  }

  /**
   * Initialize all plugins in dependency order
   * @param services - Optional services to provide to plugins
   * @param setupContext - Optional setup context with procedures for onSetup hooks
   */
  async initialize(
    services?: PluginContext<TSchema>['services'],
    setupContext?: PluginSetupContext<TSchema>,
  ) {
    const orderedPlugins = this.getOrderedPlugins();
    debugPlugin('[PluginRegistry] Initializing %d plugin(s) in dependency order', orderedPlugins.length);

    const context: PluginContext<TSchema> = {
      registerRouter: (name, router) => {
        if (this.routers[name]) {
          debugPlugin('[PluginRegistry] Error: Router "%s" is already registered', name);
          throw new Error(`Router "${name}" is already registered`);
        }
        debugPlugin('[PluginRegistry] Registered router: %s', name);
        this.routers[name] = router;
      },
      registerSchema: schema => {
        const schemaKeys = Object.keys(schema);
        debugPlugin('[PluginRegistry] Registered %d schema definition(s): %s', schemaKeys.length, schemaKeys.join(', '));
        Object.assign(this.schemas, schema);
      },
      registerRepository: (name, factory) => {
        if (this.repositories.has(name)) {
          debugPlugin('[PluginRegistry] Error: Repository "%s" is already registered', name);
          throw new Error(`Repository "${name}" is already registered`);
        }
        debugPlugin('[PluginRegistry] Registered repository: %s', name);
        this.repositories.set(name, factory);
      },
      registerProjections: (...projections) => {
        debugPlugin('[PluginRegistry] Registered %d projection(s)', projections.length);
        this.projections.push(...projections);
      },
      registerCommands: (...handlers) => {
        debugPlugin('[PluginRegistry] Registered %d command handler(s)', handlers.length);
        this.commandHandlers.push(...handlers);
      },
      registerJobs: jobs => {
        const jobKeys = Object.keys(jobs);
        debugPlugin('[PluginRegistry] Registered %d job(s): %s', jobKeys.length, jobKeys.join(', '));
        Object.assign(this.jobs, jobs);
      },
      registerProcessManager: pm => {
        debugPlugin('[PluginRegistry] Registered process manager');
        this.processManagers.push(pm);
      },
      services,
    };

    // Execute each plugin's setup function and onSetup hooks
    for (const plugin of orderedPlugins) {
      debugPlugin('[PluginRegistry] Initializing plugin: %s', plugin.name);
      try {
        // Call the standard setup function (registers routers, schemas, etc.)
        await plugin.setup(context);
        debugPlugin('[PluginRegistry] Plugin "%s" setup completed', plugin.name);

        // Call the onSetup hook if present and setup context is provided
        if (plugin.onSetup && setupContext) {
          debugPlugin('[PluginRegistry] Calling onSetup hook for plugin: %s', plugin.name);
          await plugin.onSetup(setupContext);
          debugPlugin('[PluginRegistry] Plugin "%s" onSetup hook completed', plugin.name);
        }
      } catch (error) {
        debugPlugin('[PluginRegistry] Failed to initialize plugin "%s": %s', plugin.name, error instanceof Error ? error.message : 'Unknown error');
        throw new Error(
          `Failed to initialize plugin "${plugin.name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    debugPlugin('[PluginRegistry] All plugins initialized successfully. Routers: %d, Repositories: %d, Projections: %d, Commands: %d',
      Object.keys(this.routers).length,
      this.repositories.size,
      this.projections.length,
      this.commandHandlers.length
    );
  }

  /**
   * Get all registered components
   */
  getRegistrations() {
    debugPlugin('[PluginRegistry] Getting registrations (Routers: %d, Repositories: %d, Projections: %d, Commands: %d, Jobs: %d, Process Managers: %d)',
      Object.keys(this.routers).length,
      this.repositories.size,
      this.projections.length,
      this.commandHandlers.length,
      Object.keys(this.jobs).length,
      this.processManagers.length
    );
    return {
      routers: this.routers,
      schemas: this.schemas,
      repositories: this.repositories,
      projections: this.projections,
      commandHandlers: this.commandHandlers,
      jobs: this.jobs,
      processManagers: this.processManagers,
    };
  }

  /**
   * Check if a plugin is registered
   */
  has(name: string): boolean {
    const exists = this.plugins.has(name);
    debugPlugin('[PluginRegistry] Checking if plugin "%s" exists: %s', name, exists);
    return exists;
  }

  /**
   * Get plugin count
   */
  get size(): number {
    debugPlugin('[PluginRegistry] Getting plugin count: %d', this.plugins.size);
    return this.plugins.size;
  }
}
