import type { EventStore, MessageBus } from '@event-driven-io/emmett';
import type { AnyRouter } from '@trpc/server/unstable-core-do-not-import';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { KV } from '@arki/kv';

import type {
  BaseProjectionDefinition,
  CommandHandlerRegistration,
  Repository,
  SchemaInterface,
} from './types';

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
   * Use 'never' type assertion to satisfy the compiler.
   */
  _routerNames: TRouterNames;
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
 * Create a router record type from router names
 * Uses a mapped type instead of Record to enable autocomplete
 */
export type PluginRouterRecord<Names extends string> = {
  [K in Names]: AnyRouter;
};

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
> implements PluginConfig<TSchema, TName, TRouterNames>
{
  readonly name: TName;
  #dependencies?: string[];
  #metadata?: { version?: string; description?: string; author?: string };

  #routers: Record<string, AnyRouter> = {};
  #schemas: Record<string, unknown> = {};
  #repositories = new Map<string, RepositoryFactory>();
  #projections: BaseProjectionDefinition[] = [];
  #commands: CommandHandlerRegistration[] = [];
  #jobs: Record<string, unknown> = {};
  #processManagers: unknown[] = [];

  /**
   * Phantom property for type inference - never accessed at runtime
   * @internal
   */
  _routerNames!: TRouterNames;

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
  router(router: AnyRouter): PluginBuilder<TSchema, TName, TRouterNames | TName>;
  router<N extends string>(name: N, router: AnyRouter): PluginBuilder<TSchema, TName, TRouterNames | N>;
  router(nameOrRouter: string | AnyRouter, maybeRouter?: AnyRouter) {
    if (typeof nameOrRouter === 'string') {
      this.#routers[nameOrRouter] = maybeRouter!;
    } else {
      this.#routers[this.name] = nameOrRouter;
    }
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
  repository(factory: RepositoryFactory): this;
  repository(name: string, factory: RepositoryFactory): this;
  repository(nameOrFactory: string | RepositoryFactory, maybeFactory?: RepositoryFactory): this {
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
): PluginBuilder<SchemaInterface, TName, never> {
  return new PluginBuilder<SchemaInterface, TName, never>(name);
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
    for (const plugin of plugins) {
      if (this.plugins.has(plugin.name)) {
        throw new Error(`Plugin "${plugin.name}" is already registered`);
      }
      this.plugins.set(plugin.name, plugin);
    }
  }

  /**
   * Get plugins in dependency order
   */
  private getOrderedPlugins(): PluginConfig<TSchema, string, string>[] {
    const sorted: PluginConfig<TSchema, string, string>[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected for plugin "${name}"`);
      }

      const plugin = this.plugins.get(name);
      if (!plugin) {
        throw new Error(`Plugin "${name}" not found (required as dependency)`);
      }

      visiting.add(name);

      // Visit dependencies first
      if (plugin.dependencies) {
        for (const dep of plugin.dependencies) {
          visit(dep);
        }
      }

      visiting.delete(name);
      visited.add(name);
      sorted.push(plugin);
    };

    // Visit all plugins
    for (const name of this.plugins.keys()) {
      visit(name);
    }

    return sorted;
  }

  /**
   * Initialize all plugins in dependency order
   */
  async initialize(services?: PluginContext<TSchema>['services']) {
    const orderedPlugins = this.getOrderedPlugins();

    const context: PluginContext<TSchema> = {
      registerRouter: (name, router) => {
        if (this.routers[name]) {
          throw new Error(`Router "${name}" is already registered`);
        }
        this.routers[name] = router;
      },
      registerSchema: schema => {
        Object.assign(this.schemas, schema);
      },
      registerRepository: (name, factory) => {
        if (this.repositories.has(name)) {
          throw new Error(`Repository "${name}" is already registered`);
        }
        this.repositories.set(name, factory);
      },
      registerProjections: (...projections) => {
        this.projections.push(...projections);
      },
      registerCommands: (...handlers) => {
        this.commandHandlers.push(...handlers);
      },
      registerJobs: jobs => {
        Object.assign(this.jobs, jobs);
      },
      registerProcessManager: pm => {
        this.processManagers.push(pm);
      },
      services,
    };

    // Execute each plugin's setup function
    for (const plugin of orderedPlugins) {
      try {
        await plugin.setup(context);
      } catch (error) {
        throw new Error(
          `Failed to initialize plugin "${plugin.name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }
  }

  /**
   * Get all registered components
   */
  getRegistrations() {
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
    return this.plugins.has(name);
  }

  /**
   * Get plugin count
   */
  get size(): number {
    return this.plugins.size;
  }
}
