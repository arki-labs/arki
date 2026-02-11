import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import type { PoolConfig } from 'pg';

import { debugProjection } from './debug';
import { initDbWithOptions } from './init';

/**
 * Projection middleware context
 */
export type ProjectionMiddlewareContext = {
  next: () => Promise<void>;
  meta: {
    name: string;
    eventCount: number;
  };
};

/**
 * Projection middleware function
 */
export type ProjectionMiddleware = (context: ProjectionMiddlewareContext) => Promise<void>;

/**
 * Projection handler context
 */
export type ProjectionHandlerContext<TRepos, TSchema extends Record<string, unknown> = Record<string, unknown>> = {
  repo: TRepos;
  db: NodePgDatabase<TSchema>;
};

/**
 * Projection handler function
 */
export type ProjectionHandler<TEvent, TRepos, TSchema extends Record<string, unknown> = Record<string, unknown>> = (
  events: TEvent[],
  context: ProjectionHandlerContext<TRepos, TSchema>,
) => Promise<void>;

/**
 * Projection builder interface
 */
export type ProjectionBuilder<
  TEvent = never,
  TRepos = never,
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  /**
   * Set the projection name
   */
  named<TName extends string>(name: TName): ProjectionBuilderWithName<TEvent, TRepos, TSchema, TName>;
};

export type ProjectionBuilderWithName<
  _TEvent,
  TRepos,
  TSchema extends Record<string, unknown>,
  TName extends string,
> = {
  /**
   * Define which events this projection handles
   */
  on<TEventType extends { type: string }>(
    eventTypes: readonly TEventType['type'][] | TEventType['type'][],
  ): ProjectionBuilderWithEvents<TEventType, TRepos, TSchema, TName>;
};

export type ProjectionBuilderWithEvents<
  TEvent,
  TRepos,
  TSchema extends Record<string, unknown>,
  TName extends string,
> = {
  /**
   * Define the handler function for the events.
   * Returns an Emmett-compatible projection definition with `canHandle` and `handle`.
   */
  handle(handler: ProjectionHandler<TEvent, TRepos, TSchema>): ProjectionDefinition<TName>;
};

/**
 * Emmett-compatible projection definition.
 *
 * Produced by the builder's `.handle()` terminal method. Contains:
 * - `name`: Projection identifier for logging
 * - `canHandle`: Event type strings (mapped from `.on()` call)
 * - `handle`: Wrapped handler that constructs the `{ repo, db }` context internally
 *   and applies any registered middleware
 *
 * The `handle` function accepts events from the event store (which may include
 * metadata wrappers like ReadEvent) and an opaque context. Since the builder
 * constructs its own `{ repo, db }` context, the event store's context is unused.
 */
export type ProjectionDefinition<TName extends string = string> = {
  name: TName;
  canHandle: string[];
  handle: (events: { type: string }[]) => Promise<void>;
};

/**
 * Database builder with projection support
 */
export type DbBuilder<TSchema extends Record<string, unknown>, TRepos extends Record<string, unknown>> = {
  /**
   * Database instance
   */
  readonly db: NodePgDatabase<TSchema>;

  /**
   * Whether in development mode
   */
  readonly isDev: boolean;

  /**
   * Register a repository for a feature
   */
  registerRepository<K extends string, R>(
    key: K,
    factory: (db: NodePgDatabase<TSchema>) => R,
  ): DbBuilder<TSchema, TRepos & Record<K, R>>;

  /**
   * Create a projection middleware
   */
  projectionMiddleware(fn: ProjectionMiddleware): ProjectionMiddleware;

  /**
   * Start building a projection
   */
  readonly projection: ProjectionBuilderRoot<TRepos, TSchema>;
};

/**
 * Projection builder root that can have middleware applied
 */
export type ProjectionBuilderRoot<TRepos, TSchema extends Record<string, unknown> = Record<string, unknown>> = {
  /**
   * Apply middleware to all projections created from this builder
   */
  use(middleware: ProjectionMiddleware): ProjectionBuilderRoot<TRepos, TSchema>;
} & ProjectionBuilder<never, TRepos, TSchema>;

/**
 * Schema configuration step
 */
export type SchemaBuilder<TSchema extends Record<string, unknown>> = {
  /**
   * Create the database instance
   */
  create(options: {
    connectionString: string;
    isDev?: boolean;
    poolConfig?: Partial<PoolConfig>;
  }): DbBuilder<TSchema, Record<string, never>>;
};

/**
 * Initial builder step
 */
export type InitialBuilder = {
  /**
   * Set the database schema
   */
  schema<TSchema extends Record<string, unknown>>(schema: TSchema): SchemaBuilder<TSchema>;
};

/**
 * Applies a middleware chain around a core handler function.
 * Each middleware wraps the next, forming an onion-like execution order.
 */
function applyMiddleware(
  middleware: ProjectionMiddleware[],
  name: string,
  eventCount: number,
  coreHandler: () => Promise<void>,
): Promise<void> {
  const meta = { name, eventCount };

  // Build the chain from inside out: the innermost "next" is the core handler
  let next = coreHandler;
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i]!;
    const currentNext = next;
    next = () => mw({ next: currentNext, meta });
  }

  return next();
}

/**
 * Implementation of the projection builder
 */
class ProjectionBuilderImpl<TEvent, TRepos, TSchema extends Record<string, unknown>, TName extends string = string>
  implements
    ProjectionBuilder<TEvent, TRepos, TSchema>,
    ProjectionBuilderWithName<TEvent, TRepos, TSchema, TName>,
    ProjectionBuilderWithEvents<TEvent, TRepos, TSchema, TName>,
    ProjectionBuilderRoot<TRepos, TSchema>
{
  private _name?: string;
  private _eventTypes?: string[];
  private _middleware: ProjectionMiddleware[] = [];

  constructor(
    private readonly repos: TRepos,
    private readonly _db: NodePgDatabase<TSchema>,
    middleware?: ProjectionMiddleware[],
  ) {
    if (middleware) {
      this._middleware = [...middleware];
    }
  }

  named<N extends string>(name: N): ProjectionBuilderWithName<TEvent, TRepos, TSchema, N> {
    debugProjection('[builder] Setting projection name: %s', name);
    this._name = name;
    return this as unknown as ProjectionBuilderImpl<TEvent, TRepos, TSchema, N>;
  }

  on<TEventType extends { type: string }>(
    eventTypes: readonly TEventType['type'][] | TEventType['type'][],
  ): ProjectionBuilderWithEvents<TEventType, TRepos, TSchema, TName> {
    debugProjection('[builder] Registering event types: %o', eventTypes);
    this._eventTypes = [...eventTypes];
    return this as unknown as ProjectionBuilderImpl<TEventType, TRepos, TSchema, TName>;
  }

  handle(handler: ProjectionHandler<TEvent, TRepos, TSchema>): ProjectionDefinition<TName> {
    if (!this._name) {
      debugProjection('[builder] Error: Projection name is required');
      throw new Error('Projection name is required. Call .named() first.');
    }
    if (!this._eventTypes) {
      debugProjection('[builder] Error: Event types are required');
      throw new Error('Event types are required. Call .on() first.');
    }

    const name = this._name as TName;
    const eventTypes = this._eventTypes;
    const middleware = this._middleware;
    const repos = this.repos;
    const db = this._db;

    debugProjection('[builder] Creating projection definition (name: %s, eventTypes: %o, middlewareCount: %d)',
      name, eventTypes, middleware.length);

    return {
      name,
      canHandle: eventTypes,
      handle: async (events: { type: string }[]) => {
        const context: ProjectionHandlerContext<TRepos, TSchema> = { repo: repos, db };
        const coreHandler = () => handler(events as TEvent[], context);

        if (middleware.length > 0) {
          await applyMiddleware(middleware, name, events.length, coreHandler);
        } else {
          await coreHandler();
        }
      },
    };
  }

  use(middleware: ProjectionMiddleware): ProjectionBuilderRoot<TRepos, TSchema> {
    debugProjection('[builder] Adding projection middleware (currentCount: %d)', this._middleware.length);
    const newBuilder = new ProjectionBuilderImpl<TEvent, TRepos, TSchema, TName>(this.repos, this._db, [
      ...this._middleware,
      middleware,
    ]);
    debugProjection('[builder] Middleware added (newCount: %d)', this._middleware.length + 1);
    return newBuilder;
  }
}

/**
 * Implementation of the database builder
 */
class DbBuilderImpl<TSchema extends Record<string, unknown>, TRepos extends Record<string, unknown>>
  implements DbBuilder<TSchema, TRepos>
{
  readonly db: NodePgDatabase<TSchema>;
  readonly isDev: boolean;
  private _repos?: TRepos;
  private readonly _repoFactories: Map<string, (db: NodePgDatabase<TSchema>) => unknown>;

  constructor(
    db: NodePgDatabase<TSchema>,
    isDev: boolean,
    repoFactories?: Map<string, (db: NodePgDatabase<TSchema>) => unknown>,
  ) {
    this.db = db;
    this.isDev = isDev;
    this._repoFactories = repoFactories ?? new Map();
  }

  registerRepository<K extends string, R>(
    key: K,
    factory: (db: NodePgDatabase<TSchema>) => R,
  ): DbBuilder<TSchema, TRepos & Record<K, R>> {
    debugProjection('[builder] Registering repository (key: %s, currentCount: %d)', key, this._repoFactories.size);
    const newFactories = new Map(this._repoFactories);
    newFactories.set(key, factory);
    debugProjection('[builder] Repository registered (key: %s, newCount: %d)', key, newFactories.size);
    return new DbBuilderImpl<TSchema, TRepos & Record<K, R>>(this.db, this.isDev, newFactories) as DbBuilder<
      TSchema,
      TRepos & Record<K, R>
    >;
  }

  projectionMiddleware(fn: ProjectionMiddleware): ProjectionMiddleware {
    return fn;
  }

  get projection(): ProjectionBuilderRoot<TRepos, TSchema> {
    if (!this._repos) {
      debugProjection('[builder] Initializing repositories from factories (count: %d)', this._repoFactories.size);
      // Build all repositories from factories
      const repos: Record<string, unknown> = {};
      for (const [key, factory] of this._repoFactories) {
        debugProjection('[builder] Creating repository: %s', key);
        repos[key] = factory(this.db);
      }
      this._repos = repos as TRepos;
      debugProjection('[builder] All repositories initialized');
    }
    debugProjection('[builder] Creating projection builder');
    return new ProjectionBuilderImpl<never, TRepos, TSchema>(this._repos, this.db);
  }
}

/**
 * Implementation of schema builder
 */
class SchemaBuilderImpl<TSchema extends Record<string, unknown>> implements SchemaBuilder<TSchema> {
  constructor(private readonly schema: TSchema) {}

  create(options: {
    connectionString: string;
    isDev?: boolean;
    poolConfig?: Partial<PoolConfig>;
  }): DbBuilder<TSchema, Record<string, never>> {
    debugProjection('[builder] Creating database builder (isDev: %s, hasPoolConfig: %s)',
      options.isDev ?? false, !!options.poolConfig);

    const poolConfig: PoolConfig = {
      connectionString: options.connectionString,
      ...options.poolConfig,
    };

    const drizzleConfig: DrizzleConfig<TSchema> = {
      schema: this.schema,
      logger: options.isDev,
    };

    debugProjection('[builder] Initializing database with pool config');
    const db = initDbWithOptions(poolConfig, drizzleConfig);

    debugProjection('[builder] Database builder created successfully');
    return new DbBuilderImpl<TSchema, Record<string, never>>(db, options.isDev ?? false);
  }
}

/**
 * Implementation of initial builder
 */
class InitialBuilderImpl implements InitialBuilder {
  schema<TSchema extends Record<string, unknown>>(schema: TSchema): SchemaBuilder<TSchema> {
    debugProjection('[builder] Setting database schema');
    return new SchemaBuilderImpl(schema);
  }
}

/**
 * Initialize the database builder
 *
 * @example
 * ```typescript
 * const d = initDb
 *   .schema(schema)
 *   .create({
 *     connectionString: env.DB_URL,
 *     isDev: process.env.NODE_ENV === 'development',
 *   });
 *
 * const db = d.db;
 * const projection = d.projection.named('my-proj').on(['EventA']).handle(async (events, ctx) => {
 *   // handler
 * });
 * ```
 */
export const initDb: InitialBuilder = new InitialBuilderImpl();
