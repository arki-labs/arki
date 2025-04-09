import type { Command, Event } from '@event-driven-io/emmett';
import type { AnyRouter } from '@trpc/server';
import type { PgTable } from 'drizzle-orm/pg-core';
import { getInMemoryMessageBus } from '@event-driven-io/emmett';
import { createEnv } from '@t3-oss/env-nextjs';

import type { PostgresReadEvent } from '@arki/event-sourcing/store';
import { initDb } from '@arki/db/init';
import { drizzleProjection, drizzleWithRepoProjection, getEventStore, projections } from '@arki/event-sourcing/store';
import { KV } from '@arki/kv';

import { createCallerFactory, createTRPCRouter } from './core/trpc';

/**
 * Schema interface representing a collection of tables
 */
export interface SchemaInterface {
  [key: string]: PgTable<any>;
}

/**
 * Repository interface
 */
export interface Repository<T = unknown> {
  [key: string]: T;
}

/**
 * Router interface
 */
export interface Router {
  [key: string]: unknown;
}

/**
 * Generic type for a command handler function
 */
export type CommandHandler<C extends Command> = (eventStore: any, streamName: string, command: C) => Promise<void>;

/**
 * Command handler configuration
 */
export type CommandHandlerConfig = {
  commandType: string;
  handler: CommandHandler<any>;
  getStreamName: (command: Command) => string;
};

/**
 * Dot Framework - A builder for full-stack Node.js applications
 */
export class Dot<
  TRouters extends Record<string, unknown> = Record<string, never>,
  TSchema extends SchemaInterface = Record<string, never>,
  TRepositories extends Repository = Record<string, never>,
  TEnv extends ReturnType<typeof createEnv> | null = null,
> {
  readonly #appName: string;
  readonly #routers: TRouters;
  readonly #drizzleConfig: { url: string; schema: TSchema; debug?: boolean } | null;
  readonly #eventSourcingConfig: { dbUrl: string; projections: unknown[] } | null;
  readonly #kvConfig: { url: string } | null;
  readonly #envSchema: TEnv;
  readonly #repositories: TRepositories | null;
  readonly #commandHandlers: CommandHandlerConfig[];

  constructor(
    name: string,
    options: {
      routers?: TRouters;
      drizzleConfig?: { url: string; schema: TSchema; debug?: boolean } | null;
      eventSourcingConfig?: { dbUrl: string; projections: unknown[] } | null;
      kvConfig?: { url: string } | null;
      envSchema?: TEnv;
      repositories?: TRepositories | null;
      commandHandlers?: CommandHandlerConfig[];
    } = {},
  ) {
    this.#appName = name;
    this.#routers = options.routers || ({} as TRouters);
    this.#drizzleConfig = options.drizzleConfig || null;
    this.#eventSourcingConfig = options.eventSourcingConfig || null;
    this.#kvConfig = options.kvConfig || null;
    this.#envSchema = options.envSchema || (null as TEnv);
    this.#repositories = options.repositories || null;
    this.#commandHandlers = options.commandHandlers || [];
  }

  /**
   * Configure tRPC for the application
   * @param routers Object containing all the tRPC routers
   */
  withTrpc<TNewRouters extends Record<string, unknown>>(
    routers: TNewRouters,
  ): Dot<TNewRouters, TSchema, TRepositories, TEnv> {
    return new Dot<TNewRouters, TSchema, TRepositories, TEnv>(this.#appName, {
      routers,
      drizzleConfig: this.#drizzleConfig,
      eventSourcingConfig: this.#eventSourcingConfig,
      kvConfig: this.#kvConfig,
      envSchema: this.#envSchema,
      repositories: this.#repositories,
      commandHandlers: this.#commandHandlers,
    });
  }

  /**
   * Configure Drizzle ORM for the application
   * @param url Database connection URL
   * @param schema Database schema
   * @param debug Enable debug logging (defaults to true in development)
   */
  withDrizzle<TNewSchema extends SchemaInterface>(
    url: string,
    schema: TNewSchema,
    debug?: boolean,
  ): Dot<TRouters, TNewSchema, TRepositories, TEnv> {
    return new Dot<TRouters, TNewSchema, TRepositories, TEnv>(this.#appName, {
      routers: this.#routers,
      drizzleConfig: { url, schema, debug },
      eventSourcingConfig: this.#eventSourcingConfig,
      kvConfig: this.#kvConfig,
      envSchema: this.#envSchema,
      repositories: this.#repositories,
      commandHandlers: this.#commandHandlers,
    });
  }

  /**
   * Configure event sourcing for the application
   * @param dbUrl Database connection URL
   * @param projectionsList Array of projections for event handlers
   */
  withEventSourcing(dbUrl: string, projectionsList: unknown[]): Dot<TRouters, TSchema, TRepositories, TEnv> {
    return new Dot<TRouters, TSchema, TRepositories, TEnv>(this.#appName, {
      routers: this.#routers,
      drizzleConfig: this.#drizzleConfig,
      eventSourcingConfig: { dbUrl, projections: projectionsList },
      kvConfig: this.#kvConfig,
      envSchema: this.#envSchema,
      repositories: this.#repositories,
      commandHandlers: this.#commandHandlers,
    });
  }

  /**
   * Configure message bus with command handlers
   * @param commandHandlers Array of command handler configurations
   */
  withMessageBus(commandHandlers: CommandHandlerConfig[]): Dot<TRouters, TSchema, TRepositories, TEnv> {
    return new Dot<TRouters, TSchema, TRepositories, TEnv>(this.#appName, {
      routers: this.#routers,
      drizzleConfig: this.#drizzleConfig,
      eventSourcingConfig: this.#eventSourcingConfig,
      kvConfig: this.#kvConfig,
      envSchema: this.#envSchema,
      repositories: this.#repositories,
      commandHandlers: [...this.#commandHandlers, ...commandHandlers],
    });
  }

  /**
   * Configure key-value store for the application
   * @param url KV store connection URL
   */
  withKv(url: string): Dot<TRouters, TSchema, TRepositories, TEnv> {
    return new Dot<TRouters, TSchema, TRepositories, TEnv>(this.#appName, {
      routers: this.#routers,
      drizzleConfig: this.#drizzleConfig,
      eventSourcingConfig: this.#eventSourcingConfig,
      kvConfig: { url },
      envSchema: this.#envSchema,
      repositories: this.#repositories,
      commandHandlers: this.#commandHandlers,
    });
  }

  /**
   * Configure environment variables for the application
   * @param schema Environment schema created with createEnv
   */
  withEnv<TNewEnv extends ReturnType<typeof createEnv>>(
    schema: TNewEnv,
  ): Dot<TRouters, TSchema, TRepositories, TNewEnv> {
    return new Dot<TRouters, TSchema, TRepositories, TNewEnv>(this.#appName, {
      routers: this.#routers,
      drizzleConfig: this.#drizzleConfig,
      eventSourcingConfig: this.#eventSourcingConfig,
      kvConfig: this.#kvConfig,
      envSchema: schema,
      repositories: this.#repositories,
      commandHandlers: this.#commandHandlers,
    });
  }

  /**
   * Configure repositories for the application
   * @param repositories Repository objects
   */
  withRepositories<TNewRepositories extends Repository>(
    repositories: TNewRepositories,
  ): Dot<TRouters, TSchema, TNewRepositories, TEnv> {
    return new Dot<TRouters, TSchema, TNewRepositories, TEnv>(this.#appName, {
      routers: this.#routers,
      drizzleConfig: this.#drizzleConfig,
      eventSourcingConfig: this.#eventSourcingConfig,
      kvConfig: this.#kvConfig,
      envSchema: this.#envSchema,
      repositories,
      commandHandlers: this.#commandHandlers,
    });
  }

  /**
   * Build and return the configured application
   */
  build() {
    // Initialize components based on configuration
    const router = this.#initTrpc();
    const db = this.#initDrizzle();
    const eventStore = this.#initEventSourcing();
    const kv = this.#initKv();
    const env = this.#envSchema;
    const repositories = this.#repositories;
    const messageBus = this.#initMessageBus(eventStore);

    // Create projection helpers
    let createProjection;
    let createWithRepoProjection;

    if (db) {
      // Create a type-safe wrapper that does the necessary type casting
      createProjection = <E extends Event>(
        canHandle: (event: E) => boolean,
        handle: (events: PostgresReadEvent<E>[], context: any) => Promise<void>,
      ) => {
        return drizzleProjection(db, {
          handle,
          canHandle: canHandle as any,
        });
      };

      if (repositories) {
        createWithRepoProjection = <E extends Event, K extends keyof TRepositories>(
          repoKey: K,
          canHandle: (event: E) => boolean,
          handle: (events: PostgresReadEvent<E>[], context: any) => Promise<void>,
        ) => {
          const repository = repositories[repoKey];
          return drizzleWithRepoProjection(repository, {
            handle,
            canHandle: canHandle as any,
          });
        };
      }
    }

    // Create tRPC caller if router is configured
    const createCaller = router ? createCallerFactory(router) : undefined;

    return {
      name: this.#appName,
      router,
      db,
      eventStore,
      kv,
      env,
      repositories,
      messageBus,
      createProjection,
      createWithRepoProjection,
      createCaller,
    };
  }

  #initTrpc() {
    if (!this.#routers || Object.keys(this.#routers).length === 0) return undefined;
    return createTRPCRouter(this.#routers as Record<string, AnyRouter>);
  }

  #initDrizzle() {
    if (!this.#drizzleConfig) return undefined;

    const { url, schema, debug } = this.#drizzleConfig;
    return initDb(url, {
      schema,
      logger: debug ?? process.env.NODE_ENV === 'development',
    });
  }

  #initEventSourcing() {
    if (!this.#eventSourcingConfig) return undefined;

    const { dbUrl, projections: projectionsList } = this.#eventSourcingConfig;
    return getEventStore(dbUrl, {
      projections: projections.inline(projectionsList as any[]),
    });
  }

  #initKv() {
    if (!this.#kvConfig) return undefined;
    return new KV(this.#kvConfig.url, this.#appName);
  }

  #initMessageBus(eventStore: unknown) {
    const messageBus = getInMemoryMessageBus();

    // Only register command handlers if eventStore is available
    if (eventStore && this.#commandHandlers.length > 0) {
      // Helper function for creating command handlers
      const createCommandHandler = <C extends Command>(
        handler: CommandHandler<C>,
        getStreamNameFn: (cmd: C) => string,
      ) => {
        return async (command: C) => {
          const streamName = getStreamNameFn(command);
          await handler(eventStore, streamName, command);
        };
      };

      // Register all command handlers
      for (const config of this.#commandHandlers) {
        messageBus.handle(createCommandHandler(config.handler, config.getStreamName), config.commandType);
      }

      console.log(`Message Bus initialized with ${this.#commandHandlers.length} command handlers.`);
    }

    return messageBus;
  }
}

/**
 * Create a new Dot application instance
 * @param name Application name
 * @returns A new Dot instance
 * @example
 * ```ts
 * const app = createDot('my-app')
 *   .withTrpc({ user: userRouter, post: postRouter })
 *   .withDrizzle(env.DB_URL, schema)
 *   .withKv(env.KV_URL)
 *   .withEnv(env)
 *   .withMessageBus([
 *     {
 *       commandType: 'CreateUser',
 *       handler: userCommandHandler,
 *       getStreamName: cmd => `user-${cmd.userId}`
 *     }
 *   ])
 *   .build();
 *
 * // Export type definitions
 * export type AppRouter = NonNullable<typeof app.router>;
 * export type RouterInputs = inferRouterInputs<AppRouter>;
 * export type RouterOutputs = inferRouterOutputs<AppRouter>;
 * ```
 */
export function createDot(name: string): Dot {
  return new Dot(name);
}
