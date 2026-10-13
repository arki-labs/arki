/**
 * Tester Builder - tRPC-style initialization pattern
 *
 * Following tRPC's initTRPC pattern:
 * - Builder pattern with chainable methods
 * - Type inference from context
 * - Generic parameters inferred from usage, not declared upfront
 *
 * @example
 * ```typescript
 * const t = initTester
 *   .context<AppContext>()
 *   .caller<Caller>()
 *   .create({
 *     schema,
 *     migrationsFolder: './migrations',
 *     createContext,
 *     createCaller,
 *     createRepositories,
 *     defaultUsers,
 *   });
 *
 * export const createTester = t.tester.withFactories(factories);
 * export type AppTester = ReturnType<typeof createTester>;
 * ```
 */

import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { TesterOptions, IntegrationTesterConfig } from './types';
import { IntegrationTester } from './integration-tester';

/**
 * Configuration for tester initialization. The schema, database and repository
 * types are inferred from the functions you pass in (for example, the database
 * type from `createRepositories`' parameter, the repository type from its
 * return value).
 */
export type TesterConfig<
  TSchema extends Record<string, unknown>,
  TDatabase extends NodePgDatabase<AnyRelations>,
  TRepositories extends Record<string, unknown>,
  TContext extends Record<string, unknown>,
  TCaller,
> = IntegrationTesterConfig<TSchema, TDatabase, TRepositories, TCaller, TContext>;

/**
 * Tester builder with context and caller types captured
 */
export type TesterBuilder<TContext extends Record<string, unknown>, TCaller> = {
  /**
   * Create the tester builder with configuration. The schema, database and
   * repository types are inferred from `config`.
   */
  create<
    TSchema extends Record<string, unknown>,
    TDatabase extends NodePgDatabase<AnyRelations>,
    TRepositories extends Record<string, unknown>,
  >(
    config: TesterConfig<TSchema, TDatabase, TRepositories, TContext, TCaller>,
  ): {
    /**
     * Tester factory with methods to create configured testers
     */
    tester: {
      /**
       * Create a tester with typed factories
       *
       * @example
       * ```typescript
       * const createTester = t.tester.withFactories(factories);
       * const tester = createTester();
       * tester.db; // the app's database type
       * tester.repo; // the app's repositories
       * tester.factory.gameRegistry.game(); // Fully typed!
       * ```
       */
      withFactories<TFactories>(
        factories: TFactories,
      ): (
        options?: TesterOptions,
      ) => IntegrationTester<TSchema, TDatabase, TRepositories, TCaller, TContext, TFactories>;

      /**
       * Create a basic tester without custom factories
       */
      create(
        options?: TesterOptions,
      ): IntegrationTester<TSchema, TDatabase, TRepositories, TCaller, TContext>;
    };
  };
}

/**
 * Builder with context type captured
 */
export type ContextTesterBuilder<TContext extends Record<string, unknown>> = {
  /**
   * Capture the caller type for type inference
   *
   * @example
   * ```typescript
   * const t = initTester
   *   .context<AppContext>()
   *   .caller<Caller>()
   *   .create({ ... });
   * ```
   */
  caller<TCaller>(): TesterBuilder<TContext, TCaller>;
}

/**
 * Initial tester builder (no types captured yet)
 */
export type InitialTesterBuilder = {
  /**
   * Capture the context type for type inference
   *
   * @example
   * ```typescript
   * const t = initTester
   *   .context<AppContext>()
   *   .caller<Caller>()
   *   .create({ ... });
   * ```
   */
  context<TContext extends Record<string, unknown>>(): ContextTesterBuilder<TContext>;
}

/**
 * Internal implementation class
 */
class TesterBuilderImpl<
  TSchema extends Record<string, unknown>,
  TDatabase extends NodePgDatabase<AnyRelations>,
  TRepositories extends Record<string, unknown>,
  TContext extends Record<string, unknown>,
  TCaller,
> {
  constructor(private config: TesterConfig<TSchema, TDatabase, TRepositories, TContext, TCaller>) {}

  get tester() {
    return {
      withFactories: <TFactories>(factories: TFactories) => {
        return (options?: TesterOptions) => {
          // Create internal tester class that extends IntegrationTester
          class ConfiguredTester extends IntegrationTester<
            TSchema,
            TDatabase,
            TRepositories,
            TCaller,
            TContext,
            TFactories
          > {}

          const tester = new ConfiguredTester(this.config, options);
          tester.setFactoryRegistry(factories);
          return tester;
        };
      },

      create: (options?: TesterOptions) => {
        class ConfiguredTester extends IntegrationTester<TSchema, TDatabase, TRepositories, TCaller, TContext> {}

        return new ConfiguredTester(this.config, options);
      },
    };
  }
}

/**
 * Initialize the tester builder
 *
 * Following tRPC's initTRPC pattern - start by capturing types,
 * then provide configuration.
 *
 * @example
 * ```typescript
 * // In tester.ts
 * const t = initTester
 *   .context<AppContext>()
 *   .caller<Caller>()
 *   .create({
 *     schema,
 *     migrationsFolder: './migrations',
 *     createContext,
 *     createCaller,
 *     createRepositories,
 *     defaultUsers,
 *   });
 *
 * // Export tester factory with typed factories
 * export const createTester = t.tester.withFactories(factories);
 * export type AppTester = ReturnType<typeof createTester>;
 * ```
 */
export const initTester: InitialTesterBuilder = {
  context: <TContext extends Record<string, unknown>>(): ContextTesterBuilder<TContext> => ({
    caller: <TCaller>(): TesterBuilder<TContext, TCaller> => ({
      create: config => new TesterBuilderImpl(config),
    }),
  }),
};
