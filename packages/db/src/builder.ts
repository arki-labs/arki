import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import type { PoolConfig } from 'pg';

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
   * Define the handler function for the events
   */
  handle(handler: ProjectionHandler<TEvent, TRepos, TSchema>): ProjectionDefinition<TEvent, TRepos, TSchema, TName>;
};

/**
 * Complete projection definition
 */
export type ProjectionDefinition<TEvent, TRepos, TSchema extends Record<string, unknown>, TName extends string> = {
  name: TName;
  eventTypes: string[];
  handler: ProjectionHandler<TEvent, TRepos, TSchema>;
  middleware: ProjectionMiddleware[];
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
    private readonly db: NodePgDatabase<TSchema>,
    middleware?: ProjectionMiddleware[],
  ) {
    if (middleware) {
      this._middleware = [...middleware];
    }
  }

  named<N extends string>(name: N): ProjectionBuilderWithName<TEvent, TRepos, TSchema, N> {
    this._name = name;
    return this as unknown as ProjectionBuilderImpl<TEvent, TRepos, TSchema, N>;
  }

  on<TEventType extends { type: string }>(
    eventTypes: readonly TEventType['type'][] | TEventType['type'][],
  ): ProjectionBuilderWithEvents<TEventType, TRepos, TSchema, TName> {
    this._eventTypes = [...eventTypes];
    return this as unknown as ProjectionBuilderImpl<TEventType, TRepos, TSchema, TName>;
  }

  handle(handler: ProjectionHandler<TEvent, TRepos, TSchema>): ProjectionDefinition<TEvent, TRepos, TSchema, TName> {
    if (!this._name) {
      throw new Error('Projection name is required. Call .named() first.');
    }
    if (!this._eventTypes) {
      throw new Error('Event types are required. Call .on() first.');
    }

    return {
      name: this._name as TName,
      eventTypes: this._eventTypes,
      handler,
      middleware: this._middleware,
    };
  }

  use(middleware: ProjectionMiddleware): ProjectionBuilderRoot<TRepos, TSchema> {
    const newBuilder = new ProjectionBuilderImpl<TEvent, TRepos, TSchema, TName>(this.repos, this.db, [
      ...this._middleware,
      middleware,
    ]);
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
    const newFactories = new Map(this._repoFactories);
    newFactories.set(key, factory);
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
      // Build all repositories from factories
      const repos: Record<string, unknown> = {};
      for (const [key, factory] of this._repoFactories) {
        repos[key] = factory(this.db);
      }
      this._repos = repos as TRepos;
    }
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
    const poolConfig: PoolConfig = {
      connectionString: options.connectionString,
      ...options.poolConfig,
    };

    const drizzleConfig: DrizzleConfig<TSchema> = {
      schema: this.schema,
      logger: options.isDev,
    };

    const db = initDbWithOptions(poolConfig, drizzleConfig);

    return new DbBuilderImpl<TSchema, Record<string, never>>(db, options.isDev ?? false);
  }
}

/**
 * Implementation of initial builder
 */
class InitialBuilderImpl implements InitialBuilder {
  schema<TSchema extends Record<string, unknown>>(schema: TSchema): SchemaBuilder<TSchema> {
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
