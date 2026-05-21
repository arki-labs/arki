import type { AnyRelations } from 'drizzle-orm';
import { defineRelations } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolConfig } from 'pg';

import { debugProjection } from './debug.js';
import { initDbWithOptions } from './init.js';

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
export type ProjectionHandlerContext<TRepos, TRelations extends AnyRelations = AnyRelations> = {
  repo: TRepos;
  db: NodePgDatabase<TRelations>;
};

/**
 * Projection handler function
 */
export type ProjectionHandler<TEvent, TRepos, TRelations extends AnyRelations = AnyRelations> = (
  events: TEvent[],
  context: ProjectionHandlerContext<TRepos, TRelations>,
) => Promise<void>;

/**
 * Projection builder interface
 */
export type ProjectionBuilder<
  TEvent = never,
  TRepos = never,
  TRelations extends AnyRelations = AnyRelations,
> = {
  named<TName extends string>(name: TName): ProjectionBuilderWithName<TEvent, TRepos, TRelations, TName>;
};

export type ProjectionBuilderWithName<
  _TEvent,
  TRepos,
  TRelations extends AnyRelations,
  TName extends string,
> = {
  on<TEventType extends { type: string }>(
    eventTypes: readonly TEventType['type'][] | TEventType['type'][],
  ): ProjectionBuilderWithEvents<TEventType, TRepos, TRelations, TName>;
};

export type ProjectionBuilderWithEvents<
  TEvent,
  TRepos,
  TRelations extends AnyRelations,
  TName extends string,
> = {
  handle(handler: ProjectionHandler<TEvent, TRepos, TRelations>): ProjectionDefinition<TName>;
};

/**
 * Emmett-compatible projection definition.
 */
export type ProjectionDefinition<TName extends string = string> = {
  name: TName;
  canHandle: string[];
  handle: (events: { type: string }[]) => Promise<void>;
};

/**
 * Database builder with projection support
 */
export type DbBuilder<TRelations extends AnyRelations, TRepos extends Record<string, unknown>> = {
  readonly db: NodePgDatabase<TRelations>;
  readonly isDev: boolean;

  registerRepository<K extends string, R>(
    key: K,
    factory: (db: NodePgDatabase<TRelations>) => R,
  ): DbBuilder<TRelations, TRepos & Record<K, R>>;

  projectionMiddleware(fn: ProjectionMiddleware): ProjectionMiddleware;

  readonly projection: ProjectionBuilderRoot<TRepos, TRelations>;
};

/**
 * Projection builder root that can have middleware applied
 */
export type ProjectionBuilderRoot<TRepos, TRelations extends AnyRelations = AnyRelations> = {
  use(middleware: ProjectionMiddleware): ProjectionBuilderRoot<TRepos, TRelations>;
} & ProjectionBuilder<never, TRepos, TRelations>;

/**
 * Schema configuration step
 */
export type SchemaBuilder<TRelations extends AnyRelations> = {
  create(options: {
    connectionString: string;
    isDev?: boolean;
    poolConfig?: Partial<PoolConfig>;
  }): DbBuilder<TRelations, Record<string, never>>;
};

/**
 * Initial builder step
 */
export type InitialBuilder = {
  /**
   * Set the database tables. Internally builds a relations config via
   * `defineRelations()` so consumers keep passing a plain table record.
   *
   * Use this for backends that don't define explicit relations and rely on
   * auto-derivation (no joins). For explicit RQBv2 relations, prefer
   * `.relations(...)` with a `defineRelations(tables, cb)` result.
   */
  schema<TSchema extends Record<string, unknown>>(
    schema: TSchema,
  ): SchemaBuilder<ReturnType<typeof defineRelations<TSchema>>>;

  /**
   * Pass a pre-built relations object (the result of
   * `defineRelations(tables, cb)`) so the database knows about every table
   * AND the explicit one/many relations declared by the application.
   */
  relations<TRelations extends AnyRelations>(relations: TRelations): SchemaBuilder<TRelations>;
};

/**
 * Applies a middleware chain around a core handler function.
 */
function applyMiddleware(
  middleware: ProjectionMiddleware[],
  name: string,
  eventCount: number,
  coreHandler: () => Promise<void>,
): Promise<void> {
  const meta = { name, eventCount };

  let next = coreHandler;
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i]!;
    const currentNext = next;
    next = () => mw({ next: currentNext, meta });
  }

  return next();
}

class ProjectionBuilderImpl<
  TEvent,
  TRepos,
  TRelations extends AnyRelations,
  TName extends string = string,
>
  implements
    ProjectionBuilder<TEvent, TRepos, TRelations>,
    ProjectionBuilderWithName<TEvent, TRepos, TRelations, TName>,
    ProjectionBuilderWithEvents<TEvent, TRepos, TRelations, TName>,
    ProjectionBuilderRoot<TRepos, TRelations>
{
  private _name?: string;
  private _eventTypes?: string[];
  private _middleware: ProjectionMiddleware[] = [];

  constructor(
    private readonly repos: TRepos,
    private readonly _db: NodePgDatabase<TRelations>,
    middleware?: ProjectionMiddleware[],
  ) {
    if (middleware) {
      this._middleware = [...middleware];
    }
  }

  named<N extends string>(name: N): ProjectionBuilderWithName<TEvent, TRepos, TRelations, N> {
    debugProjection('[builder] Setting projection name: %s', name);
    this._name = name;
    return this as unknown as ProjectionBuilderImpl<TEvent, TRepos, TRelations, N>;
  }

  on<TEventType extends { type: string }>(
    eventTypes: readonly TEventType['type'][] | TEventType['type'][],
  ): ProjectionBuilderWithEvents<TEventType, TRepos, TRelations, TName> {
    debugProjection('[builder] Registering event types: %o', eventTypes);
    this._eventTypes = [...eventTypes];
    return this as unknown as ProjectionBuilderImpl<TEventType, TRepos, TRelations, TName>;
  }

  handle(handler: ProjectionHandler<TEvent, TRepos, TRelations>): ProjectionDefinition<TName> {
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
        const context: ProjectionHandlerContext<TRepos, TRelations> = { repo: repos, db };
        const coreHandler = () => handler(events as TEvent[], context);

        if (middleware.length > 0) {
          await applyMiddleware(middleware, name, events.length, coreHandler);
        } else {
          await coreHandler();
        }
      },
    };
  }

  use(middleware: ProjectionMiddleware): ProjectionBuilderRoot<TRepos, TRelations> {
    debugProjection('[builder] Adding projection middleware (currentCount: %d)', this._middleware.length);
    const newBuilder = new ProjectionBuilderImpl<TEvent, TRepos, TRelations, TName>(this.repos, this._db, [
      ...this._middleware,
      middleware,
    ]);
    debugProjection('[builder] Middleware added (newCount: %d)', this._middleware.length + 1);
    return newBuilder;
  }
}

class DbBuilderImpl<TRelations extends AnyRelations, TRepos extends Record<string, unknown>>
  implements DbBuilder<TRelations, TRepos>
{
  readonly db: NodePgDatabase<TRelations>;
  readonly isDev: boolean;
  private _repos?: TRepos;
  private readonly _repoFactories: Map<string, (db: NodePgDatabase<TRelations>) => unknown>;

  constructor(
    db: NodePgDatabase<TRelations>,
    isDev: boolean,
    repoFactories?: Map<string, (db: NodePgDatabase<TRelations>) => unknown>,
  ) {
    this.db = db;
    this.isDev = isDev;
    this._repoFactories = repoFactories ?? new Map();
  }

  registerRepository<K extends string, R>(
    key: K,
    factory: (db: NodePgDatabase<TRelations>) => R,
  ): DbBuilder<TRelations, TRepos & Record<K, R>> {
    debugProjection('[builder] Registering repository (key: %s, currentCount: %d)', key, this._repoFactories.size);
    const newFactories = new Map(this._repoFactories);
    newFactories.set(key, factory);
    debugProjection('[builder] Repository registered (key: %s, newCount: %d)', key, newFactories.size);
    return new DbBuilderImpl<TRelations, TRepos & Record<K, R>>(this.db, this.isDev, newFactories) as DbBuilder<
      TRelations,
      TRepos & Record<K, R>
    >;
  }

  projectionMiddleware(fn: ProjectionMiddleware): ProjectionMiddleware {
    return fn;
  }

  get projection(): ProjectionBuilderRoot<TRepos, TRelations> {
    if (!this._repos) {
      debugProjection('[builder] Initializing repositories from factories (count: %d)', this._repoFactories.size);
      const repos: Record<string, unknown> = {};
      for (const [key, factory] of this._repoFactories) {
        debugProjection('[builder] Creating repository: %s', key);
        repos[key] = factory(this.db);
      }
      this._repos = repos as TRepos;
      debugProjection('[builder] All repositories initialized');
    }
    debugProjection('[builder] Creating projection builder');
    return new ProjectionBuilderImpl<never, TRepos, TRelations>(this._repos, this.db);
  }
}

class SchemaBuilderImpl<TRelations extends AnyRelations> implements SchemaBuilder<TRelations> {
  constructor(private readonly relations: TRelations) {}

  create(options: {
    connectionString: string;
    isDev?: boolean;
    poolConfig?: Partial<PoolConfig>;
  }): DbBuilder<TRelations, Record<string, never>> {
    debugProjection('[builder] Creating database builder (isDev: %s, hasPoolConfig: %s)',
      options.isDev ?? false, !!options.poolConfig);

    const poolConfig: PoolConfig = {
      connectionString: options.connectionString,
      ...options.poolConfig,
    };

    debugProjection('[builder] Initializing database with pool config');
    const db = initDbWithOptions<TRelations>(poolConfig, {
      relations: this.relations,
      logger: options.isDev,
    });

    debugProjection('[builder] Database builder created successfully');
    return new DbBuilderImpl<TRelations, Record<string, never>>(db, options.isDev ?? false);
  }
}

class InitialBuilderImpl implements InitialBuilder {
  schema<TSchema extends Record<string, unknown>>(
    schema: TSchema,
  ): SchemaBuilder<ReturnType<typeof defineRelations<TSchema>>> {
    debugProjection('[builder] Setting database schema (deriving relations via defineRelations)');
    const relations = defineRelations(schema) as ReturnType<typeof defineRelations<TSchema>>;
    return new SchemaBuilderImpl(relations);
  }

  relations<TRelations extends AnyRelations>(relations: TRelations): SchemaBuilder<TRelations> {
    debugProjection('[builder] Setting database relations (explicit RQBv2)');
    return new SchemaBuilderImpl(relations);
  }
}

/**
 * Initialize the database builder.
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
