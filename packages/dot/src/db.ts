import type { CanHandle, Event } from '@event-driven-io/emmett';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  DrizzleProjectionHandlerContext,
  DrizzleProjectionHandlerContextWithRepo,
  PostgresReadEvent,
} from '@arki/event-sourcing/store';
import { initDb } from '@arki/db/init';
import { drizzleProjection, drizzleWithRepoProjection } from '@arki/event-sourcing/store';

import type { Repository, SchemaInterface } from './types';

/**
 * Database functionality for the Dot framework.
 * Contains methods for setting up and interacting with the database.
 */
export const dbFeatures = {
  /**
   * @internal Initializes the Drizzle ORM database connection.
   * @param dbConfig The database configuration with URL and schema
   * @param env The environment configuration
   * @param dbUrlVariants Priority-ordered list of environment variable names
   * @param getEnvVar Function to get environment variables
   */
  initDrizzle<TSchema extends SchemaInterface>(
    dbConfig: { url?: string; schema: TSchema; debug?: boolean } | null,
    env: Record<string, any>,
    dbUrlVariants: string[],
    getEnvVar: (variantNames: string[]) => string | undefined,
  ) {
    if (!dbConfig) return;

    const { url, schema, debug } = dbConfig;
    let dbUrl: string | undefined = url;
    dbUrl ??= getEnvVar(dbUrlVariants);

    if (!dbUrl) {
      // If no URL found and Drizzle was configured, it's an error.
      throw new Error(
        `Database URL is required for Drizzle. Provide it via withDb() or environment variables: ${dbUrlVariants.join(', ')}`,
      );
    }

    return initDb(dbUrl, {
      schema,
      logger: debug ?? env['NODE_ENV'] === 'development',
    });
  },

  /**
   * @internal Creates the `createProjection` helper function.
   * Provides type safety for the handle context based on the configured schema.
   */
  createProjectionHelper<TSchema extends SchemaInterface>(db: NodePgDatabase<TSchema>) {
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
  },

  /**
   * @internal Creates the `createWithRepoProjection` helper function.
   * Provides type safety for the handle context based on the configured schema and specific repository.
   */
  createWithRepoProjectionHelper<TRepositories extends Repository>(repositories: TRepositories) {
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
  },
};
