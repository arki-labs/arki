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

import type { KV } from '@arki/kv';

import type { Factory } from './factories';
import type { CreateCallerArgs, TesterOptions, TesterUsers, TestUser } from './types';
import { IntegrationTester } from './integration-tester';

/**
 * Extract database type from context if it exists
 */
type InferDatabase<TContext> = TContext extends { db: infer TDb } ? TDb : any;

/**
 * Extract repositories type from context if it exists
 */
type InferRepositories<TContext> = TContext extends { repo: infer TRepo } ? TRepo : any;

/**
 * Configuration for tester initialization
 * All generic types are inferred from the factory functions
 */
export interface TesterConfig<TContext extends Record<string, unknown>, TCaller> {
  schema: Record<string, unknown>;
  migrationsFolder: string;
  createContext(params: {
    db: InferDatabase<TContext>;
    repo: InferRepositories<TContext>;
    kv: KV | null;
    connectionString: string;
  }): TContext;
  createCaller(args: CreateCallerArgs<TContext>): TCaller;
  createRepositories(db: InferDatabase<TContext>): InferRepositories<TContext>;
  defaultUsers: TesterUsers;
  baseFactories?: Record<string, Factory<any>>;

  /**
   * Optional hook called after a test user is created.
   * Use this to perform additional setup like creating related records.
   */
  onUserCreate?: (params: { user: TestUser; context: TContext }) => Promise<void>;

  /**
   * Optional hook called during setup after database and context are ready,
   * but before default callers are created.
   * Use this to create default users in the database (via auth system).
   */
  onSetup?: (params: { context: TContext; users: TesterUsers }) => Promise<void>;
}

/**
 * Tester builder with context and caller types captured
 */
export interface TesterBuilder<TContext extends Record<string, unknown>, TCaller> {
  /**
   * Create the tester builder with configuration
   *
   * @param config - Tester configuration
   * @returns Object with tester factory methods
   */
  create(config: TesterConfig<TContext, TCaller>): {
    /**
     * Tester factory with methods to create configured testers
     */
    tester: {
      /**
       * Create a tester with typed factories
       *
       * @param factories - Factory registry to inject
       * @returns Function that creates configured tester instances
       *
       * @example
       * ```typescript
       * const createTester = t.tester.withFactories(factories);
       * const tester = createTester();
       * tester.factory.gameRegistry.game(); // Fully typed!
       * ```
       */
      withFactories<TFactories>(
        factories: TFactories,
      ): (options?: TesterOptions) => IntegrationTester<any, any, any, TCaller, TContext, TFactories>;

      /**
       * Create a basic tester without custom factories
       *
       * @param options - Optional tester configuration
       * @returns Configured tester instance
       */
      create(options?: TesterOptions): IntegrationTester<any, any, any, TCaller, TContext>;
    };
  };
}

/**
 * Builder with context type captured
 */
export interface ContextTesterBuilder<TContext extends Record<string, unknown>> {
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
export interface InitialTesterBuilder {
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
class TesterBuilderImpl<TContext extends Record<string, unknown>, TCaller> {
  constructor(private config: TesterConfig<TContext, TCaller>) {}

  get tester() {
    return {
      withFactories: <TFactories>(factories: TFactories) => {
        return (options?: TesterOptions) => {
          // Create internal tester class that extends IntegrationTester
          class ConfiguredTester extends IntegrationTester<any, any, any, TCaller, TContext, TFactories> {}

          const tester = new ConfiguredTester(this.config as any, options);
          tester.setFactoryRegistry(factories);
          return tester;
        };
      },

      create: (options?: TesterOptions) => {
        class ConfiguredTester extends IntegrationTester<any, any, any, TCaller, TContext> {}

        return new ConfiguredTester(this.config as any, options);
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
      create: (config: TesterConfig<TContext, TCaller>) => {
        return new TesterBuilderImpl<TContext, TCaller>(config) as any;
      },
    }),
  }),
};
