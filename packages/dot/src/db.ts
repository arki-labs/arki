import type { CanHandle, Event } from '@event-driven-io/emmett';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  DrizzleProjectionHandlerContext,
  DrizzleProjectionHandlerContextWithRepo,
  PostgresReadEvent,
} from '@arki/event-sourcing/store';
import { initDb } from '@arki/db/init';
import { drizzleProjection, drizzleWithRepoProjection } from '@arki/event-sourcing/store';

import { debugDB } from './debug.ts';
import type { Repository, SchemaInterface } from './types';

/**
 * Database functionality for the Dot framework.
 * Contains methods for setting up and interacting with the database.
 */
export const dbFeatures = {
  /**
   * @internal Initializes the Drizzle ORM database connection.
   * @param dbConfig The database configuration with URL and relations
   * @param env The environment configuration
   * @param dbUrlVariants Priority-ordered list of environment variable names
   * @param getEnvVar Function to get environment variables
   */
  initDrizzle<TSchema extends SchemaInterface>(
    dbConfig: { url?: string; relations: TSchema; debug?: boolean } | null,
    env: Record<string, any>,
    dbUrlVariants: string[],
    getEnvVar: (variantNames: string[]) => string | undefined,
  ) {
    if (!dbConfig) {
      debugDB('[dbFeatures] No database configuration provided, skipping Drizzle initialization');
      return;
    }

    debugDB('[dbFeatures] Initializing Drizzle database connection');
    const { url, relations, debug } = dbConfig;
    let dbUrl: string | undefined = url;
    dbUrl ??= getEnvVar(dbUrlVariants);

    if (!dbUrl) {
      debugDB('[dbFeatures] Database URL not found in config or environment variables: %s', dbUrlVariants.join(', '));
      // If no URL found and Drizzle was configured, it's an error.
      throw new Error(
        `Database URL is required for Drizzle. Provide it via withDb() or environment variables: ${dbUrlVariants.join(', ')}`,
      );
    }

    const enableLogging = debug ?? env['NODE_ENV'] === 'development';
    debugDB('[dbFeatures] Initializing database (logging: %s)', enableLogging);
    const db = initDb<TSchema>(dbUrl, {
      relations,
      logger: enableLogging,
    });
    debugDB('[dbFeatures] Database connection initialized successfully');
    return db;
  },

  /**
   * @internal Creates the `createProjection` helper function.
   * Provides type safety for the handle context based on the configured schema.
   */
  createProjectionHelper<TSchema extends SchemaInterface>(db: NodePgDatabase<TSchema>) {
    debugDB('[dbFeatures] Creating projection helper function');
    type Context = DrizzleProjectionHandlerContext<TSchema>; // Define context type locally
    return <E extends Event>(
      canHandle: CanHandle<E>,
      handle: (events: PostgresReadEvent<E>[], context: Context) => Promise<void>,
    ) => {
      debugDB('[dbFeatures] Creating projection with canHandle: %O', canHandle);
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
    const repoKeys = Object.keys(repositories);
    debugDB('[dbFeatures] Creating projection helper with %d repository/repositories: %s', repoKeys.length, repoKeys.join(', '));
    // Define context type locally with repository access
    type ContextWithRepo<K extends keyof TRepositories> = DrizzleProjectionHandlerContextWithRepo<TRepositories[K]>;
    return <E extends Event, K extends keyof TRepositories>(
      repoKey: K,
      canHandle: CanHandle<E>,
      handle: (events: PostgresReadEvent<E>[], context: ContextWithRepo<K>) => Promise<void>,
    ) => {
      const repository = repositories[repoKey];
      if (!repository) {
        debugDB('[dbFeatures] Repository "%s" not found. Available: %s', String(repoKey), Object.keys(repositories).join(', '));
        // Ensure a clear error if the specified repository wasn't configured
        throw new Error(
          `Repository with key "${String(repoKey)}" not found. Available repositories: ${Object.keys(repositories).join(', ')}`,
        );
      }
      debugDB('[dbFeatures] Creating projection with repository: %s', String(repoKey));
      // Cast needed for CanHandle and return type
      return drizzleWithRepoProjection(repository, {
        handle,
        canHandle: canHandle as unknown as CanHandle<E>,
      });
    };
  },
};
