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
 *     createDatabase,
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

import type { IntegrationTesterConfig, TesterDatabase, TesterOptions } from './types.js';
import { IntegrationTester } from './integration-tester.js';

/**
 * Configuration for tester initialization. The schema, database and repository
 * types are inferred from the functions you pass in (the database type from
 * `createRepositories`' parameter, the root database type from what `createDatabase` returns, and the
 * repository type from `createRepositories`' return value).
 */
export type TesterConfig<
  TSchema extends Record<string, unknown>,
  TDatabase extends THandle,
  TRepositories extends Record<string, unknown>,
  TContext extends Record<string, unknown>,
  TCaller,
  THandle extends TesterDatabase<THandle>,
> = IntegrationTesterConfig<TSchema, TDatabase, TRepositories, TCaller, TContext, THandle>;

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
    TDatabase extends THandle,
    TRepositories extends Record<string, unknown>,
    THandle extends TesterDatabase<THandle>,
  >(
    config: TesterConfig<TSchema, TDatabase, TRepositories, TContext, TCaller, THandle>,
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
      withFactories<TFactories extends object>(
        factories: TFactories,
      ): (
        options?: TesterOptions,
      ) => IntegrationTester<TSchema, TDatabase, TRepositories, TCaller, TContext, THandle> & {
        /** The factories passed to `withFactories`, exactly as typed there. */
        readonly factory: TFactories;
      };

      /**
       * Create a basic tester without factories (it has no `factory` property)
       */
      create(
        options?: TesterOptions,
      ): IntegrationTester<TSchema, TDatabase, TRepositories, TCaller, TContext, THandle>;
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
  TDatabase extends THandle,
  TRepositories extends Record<string, unknown>,
  TContext extends Record<string, unknown>,
  TCaller,
  THandle extends TesterDatabase<THandle>,
> {
  constructor(private config: TesterConfig<TSchema, TDatabase, TRepositories, TContext, TCaller, THandle>) {}

  get tester() {
    return {
      withFactories: <TFactories extends object>(factories: TFactories) => {
        return (options?: TesterOptions) => {
          class ConfiguredTester extends IntegrationTester<TSchema, TDatabase, TRepositories, TCaller, TContext, THandle> {
            readonly factory = factories;
          }

          return new ConfiguredTester(this.config, options);
        };
      },

      create: (options?: TesterOptions) => {
        class ConfiguredTester extends IntegrationTester<TSchema, TDatabase, TRepositories, TCaller, TContext, THandle> {}

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
