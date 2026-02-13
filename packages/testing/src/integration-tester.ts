import crypto from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTable, PgTransaction } from 'drizzle-orm/pg-core';
import type { StartedTestContainer } from 'testcontainers';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { UserId } from '@arki/auth';
import { createUserId } from '@arki/auth';
import type { ExtractTablesWithRelations } from '@arki/db/id-factory';
import { initDb } from '@arki/db/builder';
import { KV } from '@arki/kv';

import type {
  IntegrationTesterConfig,
  TesterOptions,
  TesterUserOverrides,
  TesterUsers,
  TestUser,
  TestUserRole,
} from './types';
import * as assertions from './assertions';
import {
  getGlobalPostgresConnectionString,
  getGlobalRedisConnectionString,
  startPostgresContainer,
  startRedisContainer,
} from './containers';
import * as debug from './debug';
import { debugTester } from './debug';
import { FactoryRegistry, faker } from './factories';
import * as performance from './performance';

type CallerCollection<TCaller> = {
  public: TCaller;
  user: TCaller;
  moderator: TCaller;
  admin: TCaller;
};

/**
 * Integration testing helper class providing comprehensive utilities for testing
 * tRPC applications with PostgreSQL and Redis.
 *
 * @template TSchema - Drizzle schema type
 * @template TDatabase - Database instance type (NodePgDatabase)
 * @template TRepositories - Repository collection type
 * @template TCaller - tRPC caller type
 * @template TContext - tRPC context type
 *
 * @example
 * ```typescript
 * const TesterBase = createIntegrationTester({
 *   schema,
 *   migrationsFolder: './migrations',
 *   createContext,
 *   createCaller,
 *   createRepositories,
 *   defaultUsers: { user, moderator, admin },
 *   baseFactories: {
 *     user: userFactory,
 *     game: gameFactory,
 *   },
 * });
 *
 * export class Tester extends TesterBase {}
 *
 * // In tests
 * const tester = new Tester();
 * await tester.setup();
 * await tester.withTransaction(async () => {
 *   const user = tester.factory.create('user'); // Base factory auto-registered
 *   const result = await tester.caller.user.someMethod();
 *   tester.assertValidId(result.id, 'prefix_');
 * });
 * await tester.teardown();
 * ```
 */
export class IntegrationTester<
  TSchema extends Record<string, unknown>,
  TDatabase extends NodePgDatabase<TSchema>,
  TRepositories extends Record<string, unknown>,
  TCaller,
  TContext extends Record<string, unknown>,
  TFactories = FactoryRegistry,
> {
  protected readonly config: IntegrationTesterConfig<TSchema, TDatabase, TRepositories, TCaller, TContext>;
  protected readonly options: TesterOptions;

  protected container: StartedPostgreSqlContainer | null = null;
  protected ownsContainer = false;
  protected baseConnectionString: string | null = null;
  protected uniqueDatabaseName: string | null = null;

  protected redisContainer: StartedTestContainer | null = null;
  protected ownsRedisContainer = false;
  protected redisNamespace: string | null = null;

  protected _db: TDatabase | null = null;
  protected _repo: TRepositories | null = null;
  protected _kv: KV | null = null;
  protected _users: TesterUsers | null = null;
  protected _caller: CallerCollection<TCaller> | null = null;
  protected _baseContext: TContext | null = null;

  protected currentTransaction: PgTransaction<
    NodePgQueryResultHKT,
    TSchema,
    ExtractTablesWithRelations<TSchema>
  > | null = null;

  protected randomCounter = 0;
  protected randomSeed: string;

  protected _factoryRegistry: TFactories | null = null;

  protected currentUser: TestUser | null = null;
  protected currentCaller: TCaller | null = null;

  /**
   * Access to assertion utilities
   */
  public readonly assert = assertions;

  /**
   * Access to debug utilities
   */
  public readonly debug = debug;

  /**
   * Access to performance utilities
   */
  public readonly performance = performance;

  /**
   * Access to faker instance for custom data generation
   */
  public readonly faker = faker;

  constructor(
    config: IntegrationTesterConfig<TSchema, TDatabase, TRepositories, TCaller, TContext>,
    options: TesterOptions = {},
  ) {
    this.config = config;
    this.options = options;
    this.randomSeed = options.randomSeed ?? crypto.randomBytes(16).toString('hex');
  }

  get db(): TDatabase {
    if (!this._db) {
      throw new Error('Tester not initialized. Call setup() first.');
    }
    return this._db;
  }

  /**
   * Get the current database context (transaction if active, otherwise base db)
   * This ensures operations use the transaction when running inside withTransaction()
   */
  protected getCurrentDb(): TDatabase {
    if (!this._db) {
      throw new Error('Tester not initialized. Call setup() first.');
    }
    // Return transaction if one is active, otherwise return base db
    const useTransaction = !!this.currentTransaction;
    if (useTransaction) {
      debugTester('[tester] getCurrentDb: Using transaction context');
    }
    return (this.currentTransaction ?? this._db) as TDatabase;
  }

  get repo(): TRepositories {
    if (!this._repo) {
      throw new Error('Tester not initialized. Call setup() first.');
    }
    return this._repo;
  }

  get kv(): KV {
    if (!this._kv) {
      throw new Error('Tester not initialized. Call setup() first.');
    }
    return this._kv;
  }

  get users(): TesterUsers {
    if (!this._users) {
      throw new Error('Tester not initialized. Call setup() first.');
    }
    return this._users;
  }

  get caller(): CallerCollection<TCaller> {
    if (!this._caller) {
      throw new Error('Tester not initialized. Call setup() first.');
    }
    return this._caller;
  }

  get currentTx() {
    return this.currentTransaction;
  }

  /**
   * Get factory registry for managing test data factories
   * When using createTester pattern, factories are injected via setFactoryRegistry()
   */
  get factory(): TFactories {
    if (!this._factoryRegistry) {
      // Fallback for backward compatibility
      this._factoryRegistry = new FactoryRegistry() as TFactories;
      this.registerBaseFactories();
    }
    return this._factoryRegistry;
  }

  /**
   * Inject typed factory registry from outside
   * Used by createTester() factory function to avoid inheritance
   *
   * @example
   * ```typescript
   * const tester = new AppTester(config);
   * tester.setFactoryRegistry(factories);
   * ```
   */
  setFactoryRegistry<T extends TFactories>(registry: T): void {
    this._factoryRegistry = registry as TFactories;
  }

  getUser(role: 'user' | 'moderator' | 'admin'): TestUser {
    const configuredUsers = this.users;
    return configuredUsers[role];
  }

  async setup(): Promise<void> {
    debugTester('[tester] Setting up integration tester (useUniqueDb: %s)', this.options.useUniqueDatabase ?? false);
    const { users = {}, connectionString: customConnectionString, useUniqueDatabase = false } = this.options;

    let connectionString: string;
    const globalConnectionString = getGlobalPostgresConnectionString();
    debugTester('[tester] Connection string sources (custom: %s, global: %s)', !!customConnectionString, !!globalConnectionString);

    if (customConnectionString) {
      debugTester('[tester] Using custom connection string');
      connectionString = customConnectionString;
      this.ownsContainer = false;
    } else if (globalConnectionString) {
      debugTester('[tester] Using global connection string');
      connectionString = globalConnectionString;
      this.ownsContainer = false;
    } else {
      debugTester('[tester] Starting new PostgreSQL container (owning)');
      this.container = await startPostgresContainer();
      connectionString = this.container.getConnectionUri();
      this.ownsContainer = true;
      debugTester('[tester] PostgreSQL container started');
    }

    this.baseConnectionString = connectionString;

    if (useUniqueDatabase) {
      this.uniqueDatabaseName = `test_${crypto.randomBytes(8).toString('hex')}`;
      debugTester('[tester] Creating unique database (name: %s)', this.uniqueDatabaseName);
      const adminDb = this.createDatabaseConnection(connectionString);
      try {
        await adminDb.execute(sql.raw(`CREATE DATABASE "${this.uniqueDatabaseName}"`));

        const url = new URL(connectionString);
        url.pathname = `/${this.uniqueDatabaseName}`;
        connectionString = url.toString();
        debugTester('[tester] Unique database created');
      } finally {
        // Close the admin connection after creating the database
        try {
          const dbWithClient = adminDb as any;
          if (dbWithClient.$client) {
            if (typeof dbWithClient.$client.end === 'function') {
              await dbWithClient.$client.end();
            } else if (typeof dbWithClient.$client.release === 'function') {
              await dbWithClient.$client.release();
            }
          }
          debugTester('[tester] Admin database connection closed after setup');
        } catch (closeError) {
          debugTester('[tester] Error closing admin connection during setup: %s', closeError instanceof Error ? closeError.message : 'unknown error');
        }
      }
    }

    debugTester('[tester] Creating database connection and running migrations');
    const database = this.createDatabaseConnection(connectionString);
    this._db = database;
    await migrate(this._db as any, { migrationsFolder: this.config.migrationsFolder });
    debugTester('[tester] Migrations completed');

    debugTester('[tester] Creating repositories');
    this._repo = this.config.createRepositories(this._db);
    debugTester('[tester] Repositories created');

    const { redisConnectionString: customRedisConnectionString, useUniqueRedisNamespace = false } = this.options;

    let redisUrl: string;
    const globalRedisConnection = getGlobalRedisConnectionString();
    debugTester('[tester] Redis sources (custom: %s, global: %s)', !!customRedisConnectionString, !!globalRedisConnection);

    if (customRedisConnectionString) {
      debugTester('[tester] Using custom Redis connection');
      redisUrl = customRedisConnectionString;
      this.ownsRedisContainer = false;
    } else if (globalRedisConnection) {
      debugTester('[tester] Using global Redis connection');
      redisUrl = globalRedisConnection;
      this.ownsRedisContainer = false;
    } else {
      debugTester('[tester] Starting new Redis container (owning)');
      this.redisContainer = await startRedisContainer();
      const redisHost = this.redisContainer.getHost();
      const redisPort = this.redisContainer.getMappedPort(6379);
      redisUrl = `redis://${redisHost}:${redisPort}`;
      this.ownsRedisContainer = true;
      debugTester('[tester] Redis container started');
    }

    this.redisNamespace = useUniqueRedisNamespace ? `test:${crypto.randomBytes(8).toString('hex')}` : 'test';
    debugTester('[tester] Creating KV instance (namespace: %s)', this.redisNamespace);
    this._kv = new KV(redisUrl, this.redisNamespace);
    debugTester('[tester] KV instance created');

    const baseContext = this.buildBaseContext();
    this._baseContext = baseContext;
    debugTester('[tester] Creating test users');
    this._users = this.mergeUsers(users);

    // Call onSetup hook to create default users in database if provided
    if (this.config.onSetup) {
      debugTester('[tester] Running onSetup hook');
      await this.config.onSetup({ context: baseContext, users: this._users });
      debugTester('[tester] onSetup hook completed');
    }

    debugTester('[tester] Creating callers for all roles');
    this._caller = {
      public: this.createCaller('public', null, baseContext),
      user: this.createCaller('user', this._users.user, baseContext),
      moderator: this.createCaller('moderator', this._users.moderator, baseContext),
      admin: this.createCaller('admin', this._users.admin, baseContext),
    };
    debugTester('[tester] Setup completed successfully');
  }

  async teardown(): Promise<void> {
    debugTester('[tester] Starting teardown');

    // Step 1: Close event store connection first (if exists in context)
    const contextForCleanup = this._baseContext;
    if (contextForCleanup && 'closeEventStore' in contextForCleanup) {
      debugTester('[tester] Closing event store connection via cleanup function');
      try {
        const closeEventStore = (contextForCleanup as any).closeEventStore;
        if (typeof closeEventStore === 'function') {
          await closeEventStore();
          debugTester('[tester] Event store connection closed successfully');
        } else {
          debugTester('[tester] closeEventStore is not a function, skipping');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        debugTester('[tester] Error closing event store: %s', errorMessage);
        // Only log significant errors, not expected cleanup messages
        if (
          !errorMessage.includes('server closed the connection') &&
          !errorMessage.includes('Connection terminated') &&
          !errorMessage.includes('connection is closed') &&
          !errorMessage.includes('terminating connection due to administrator command')
        ) {
          console.error('Failed to close event store connection:', error);
        }
      }
    } else if (contextForCleanup && 'eventStore' in contextForCleanup) {
      // Fallback: try old method if closeEventStore function doesn't exist
      debugTester('[tester] No closeEventStore function found, attempting direct close');
      try {
        const eventStore = (contextForCleanup as any).eventStore;
        if (eventStore && typeof eventStore.close === 'function') {
          await eventStore.close();
          debugTester('[tester] Event store connection closed via direct method');
        }
      } catch (error) {
        debugTester('[tester] Error in fallback event store close: %s', error instanceof Error ? error.message : String(error));
      }
    }

    // Step 2: Close database connection pool
    if (this._db) {
      debugTester('[tester] Closing database connection');
      try {
        const dbWithClient = this._db as any;
        if (dbWithClient.$client) {
          if (typeof dbWithClient.$client.end === 'function') {
            debugTester('[tester] Ending database pool');
            await dbWithClient.$client.end();
            debugTester('[tester] Database pool ended successfully');
          } else if (typeof dbWithClient.$client.release === 'function') {
            debugTester('[tester] Releasing database client');
            await dbWithClient.$client.release();
            debugTester('[tester] Database client released successfully');
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        debugTester('[tester] Error closing database: %s', errorMessage);
        // Only log significant errors
        if (
          !errorMessage.includes('server closed the connection') &&
          !errorMessage.includes('Connection terminated') &&
          !errorMessage.includes('connection is closed') &&
          !errorMessage.includes('terminating connection due to administrator command')
        ) {
          console.error('Failed to close database connection:', error);
        }
      }

      this._db = null;
      this._repo = null;
    }

    if (this._kv) {
      debugTester('[tester] Closing KV instance');
      try {
        await this._kv.close();
        debugTester('[tester] KV instance closed');
      } catch (error) {
        debugTester('[tester] Error closing KV: %s', error instanceof Error ? error.message : 'unknown error');
        console.error('Failed to close KV instance:', error);
      }
      this._kv = null;
    }

    this.redisNamespace = null;

    if (this.redisContainer && this.ownsRedisContainer) {
      debugTester('[tester] Stopping owned Redis container');
      try {
        await this.redisContainer.stop();
        debugTester('[tester] Redis container stopped');
      } catch (error) {
        debugTester('[tester] Error stopping Redis: %s', error instanceof Error ? error.message : 'unknown error');
        console.error('Failed to stop Redis container:', error);
      }
      this.redisContainer = null;
    }

    this.ownsRedisContainer = false;

    if (this.uniqueDatabaseName) {
      debugTester('[tester] Dropping unique database (name: %s)', this.uniqueDatabaseName);
      let adminDb: TDatabase | null = null;
      try {
        const connection =
          this.options.connectionString ?? this.baseConnectionString ?? getGlobalPostgresConnectionString();

        if (connection) {
          adminDb = this.createDatabaseConnection(connection);
          await adminDb.execute(sql.raw(`DROP DATABASE IF EXISTS "${this.uniqueDatabaseName}" WITH (FORCE)`));
          debugTester('[tester] Unique database dropped');
        } else {
          debugTester('[tester] No connection available to drop unique database');
        }
      } catch (error) {
        debugTester('[tester] Error dropping unique database: %s', error instanceof Error ? error.message : 'unknown error');
        console.error(`Failed to drop unique database ${this.uniqueDatabaseName}:`, error);
      } finally {
        // Close the admin connection
        if (adminDb) {
          try {
            const dbWithClient = adminDb as any;
            if (dbWithClient.$client) {
              if (typeof dbWithClient.$client.end === 'function') {
                await dbWithClient.$client.end();
              } else if (typeof dbWithClient.$client.release === 'function') {
                await dbWithClient.$client.release();
              }
            }
            debugTester('[tester] Admin database connection closed');
          } catch (closeError) {
            const errorMessage = closeError instanceof Error ? closeError.message : String(closeError);
            if (!errorMessage.includes('terminating connection due to administrator command')) {
              debugTester('[tester] Error closing admin connection: %s', errorMessage);
            }
          }
        }
      }

      this.uniqueDatabaseName = null;
    }

    if (this.container && this.ownsContainer) {
      debugTester('[tester] Stopping owned PostgreSQL container');
      try {
        await this.container.stop();
        debugTester('[tester] PostgreSQL container stopped');
      } catch (error) {
        debugTester('[tester] Error stopping PostgreSQL: %s', error instanceof Error ? error.message : 'unknown error');
        console.error('Failed to stop container:', error);
      }
      this.container = null;
    }

    debugTester('[tester] Cleaning up references');
    this._caller = null;
    this._users = null;
    this._baseContext = null;
    this.ownsContainer = false;
    this.baseConnectionString = null;
    debugTester('[tester] Teardown completed');
  }

  /**
   * Clear specific tables by deleting all rows
   *
   * @param tables - Tables to clear
   *
   * @example
   * ```typescript
   * await tester.clearTables(users, games, sessions);
   * ```
   */
  async clearTables(...tables: PgTable[]): Promise<void> {
    if (!this._db) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    for (const table of tables) {
      await this._db.delete(table);
    }
  }

  /**
   * Clear all tables in the schema
   *
   * @example
   * ```typescript
   * await tester.clearAllTables();
   * ```
   */
  async clearAllTables(): Promise<void> {
    if (!this._db) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    // Get all table names from schema
    const tables = Object.values(this.config.schema).filter(
      (value): value is PgTable => typeof value === 'object' && value !== null,
    );

    for (const table of tables) {
      await this._db.delete(table);
    }
  }

  /**
   * Clear tables matching a pattern
   *
   * @param pattern - RegExp or string pattern to match table names
   *
   * @example
   * ```typescript
   * // Clear all tables starting with 'temp_'
   * await tester.clearTablesByPattern(/^temp_/);
   * ```
   */
  async clearTablesByPattern(pattern: RegExp | string): Promise<void> {
    if (!this._db) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

    const tables = Object.entries(this.config.schema)
      .filter(([name, value]) => {
        return regex.test(name) && typeof value === 'object' && value !== null;
      })
      .map(([, table]) => table as PgTable);

    for (const table of tables) {
      await this._db.delete(table);
    }
  }

  /**
   * Clear all tables except specified ones
   *
   * @param exceptTables - Tables to preserve
   *
   * @example
   * ```typescript
   * // Clear all tables except users and settings
   * await tester.clearTablesExcept(users, settings);
   * ```
   */
  async clearTablesExcept(...exceptTables: PgTable[]): Promise<void> {
    if (!this._db) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    const exceptSet = new Set(exceptTables);
    const tables = Object.values(this.config.schema).filter(
      (value): value is PgTable => typeof value === 'object' && value !== null && !exceptSet.has(value as PgTable),
    );

    for (const table of tables) {
      await this._db.delete(table);
    }
  }

  /**
   * Seed the database with test data
   *
   * @param data - Object mapping table names to arrays of records
   *
   * @example
   * ```typescript
   * await tester.seed({
   *   users: [user1, user2, user3],
   *   games: [game1, game2],
   *   sessions: [session1, session2, session3, session4],
   * });
   * ```
   */
  async seed<T extends Record<string, any[]>>(data: T): Promise<void> {
    if (!this._db) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    for (const [tableName, records] of Object.entries(data)) {
      if (records.length === 0) continue;

      const table = (this.config.schema as any)[tableName];
      if (!table) {
        throw new Error(`Table '${tableName}' not found in schema`);
      }

      await this._db.insert(table).values(records);
    }
  }

  /**
   * Create a custom caller for a specific user
   *
   * @param user - User to create caller for
   * @returns tRPC caller instance
   *
   * @example
   * ```typescript
   * const customUser = { id: 'usr_custom', email: 'custom@example.com', name: 'Custom' };
   * const caller = tester.createCustomCaller(customUser);
   * const result = await caller.someMethod();
   * ```
   */
  createCustomCaller(user: TestUser): TCaller {
    if (!this._db || !this.baseConnectionString) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    // Use current db (transaction if active) to ensure operations are isolated
    const currentDb = this.getCurrentDb();
    const repositories = this.config.createRepositories(currentDb);
    const context = this.config.createContext({
      db: currentDb,
      repo: repositories,
      kv: this._kv,
      connectionString: this.baseConnectionString,
    });

    return this.config.createCaller({
      context,
      role: 'user',
      user,
      responseHeaders: new Headers(),
    });
  }

  /**
   * Return the default test user and caller with 'user' role
   *
   * @returns Object with user and caller
   *
   * @example
   * ```typescript
   * const { user, caller } = tester.asUser();
   * await caller.someMethod();
   * ```
   */
  asUser(): { user: TestUser; caller: TCaller } {
    if (!this._users || !this._caller) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    this.currentUser = this._users.user;
    this.currentCaller = this._caller.user;

    return { user: this._users.user, caller: this._caller.user };
  }

  /**
   * Create a new dynamic test user with 'user' role and return caller.
   * This creates a new user in the database via the onUserCreate hook.
   * Use this when you need multiple different users in a test.
   *
   * @returns Promise with user and caller
   *
   * @example
   * ```typescript
   * const { user: player1, caller: caller1 } = await tester.createUser();
   * const { user: player2, caller: caller2 } = await tester.createUser();
   * ```
   */
  async createUser(): Promise<{ user: TestUser; caller: TCaller }> {
    const userId = createUserId();
    const email = this.generateEmail();
    const name = `Test User ${this.generateString(8)}`;

    debugTester('[tester] Creating dynamic user (id: %s, email: %s)', userId, email);

    const user: TestUser = {
      id: userId,
      email,
      name,
      permissions: [],
      roles: ['user'],
    };

    const baseContext = this.buildBaseContext();

    // Call onUserCreate hook if provided to create user in database
    if (this.config.onUserCreate) {
      debugTester('[tester] Running onUserCreate hook for dynamic user');
      await this.config.onUserCreate({ user, context: baseContext });
      debugTester('[tester] User created in database');
    }

    const caller = this.createCaller('user', user, baseContext);
    debugTester('[tester] Dynamic user and caller created');

    return { user, caller };
  }

  /**
   * Create a guest (unauthenticated) caller
   *
   * @returns Caller without authentication
   *
   * @example
   * ```typescript
   * const caller = tester.asGuest();
   * await caller.public.getPublicData();
   * ```
   */
  asGuest(): TCaller {
    this.currentUser = null;
    const baseContext = this.buildBaseContext();
    this.currentCaller = this.createCaller('user', null, baseContext);
    return this.currentCaller;
  }

  /**
   * Return the default test user and caller with 'moderator' role
   *
   * @returns Object with moderator user and caller
   *
   * @example
   * ```typescript
   * const { user, caller } = tester.asModerator();
   * await caller.moderation.reviewContent();
   * ```
   */
  asModerator(): { user: TestUser; caller: TCaller } {
    if (!this._users || !this._caller) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    this.currentUser = this._users.moderator;
    this.currentCaller = this._caller.moderator;

    return { user: this._users.moderator, caller: this._caller.moderator };
  }

  /**
   * Return the default test user and caller with 'admin' role
   *
   * @returns Object with admin user and caller
   *
   * @example
   * ```typescript
   * const { user, caller } = tester.asAdmin();
   * await caller.admin.deleteUser();
   * ```
   */
  asAdmin(): { user: TestUser; caller: TCaller } {
    if (!this._users || !this._caller) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    this.currentUser = this._users.admin;
    this.currentCaller = this._caller.admin;

    return { user: this._users.admin, caller: this._caller.admin };
  }

  /**
   * Switch context to a different user and return caller
   *
   * @param userId - User ID to switch to
   * @returns Caller for the specified user
   *
   * @example
   * ```typescript
   * const { user: user1 } = tester.asUser();
   * const { user: user2 } = tester.asUser();
   * const caller1 = tester.withUser(user1.id);
   * await caller1.someMethod();
   * ```
   */
  withUser(userId: UserId): TCaller {
    if (this.currentUser?.id !== userId) {
      // Create a user with this ID
      const user: TestUser = {
        id: userId,
        email: `${userId}@example.com`,
        name: `User ${userId}`,
        permissions: [],
        roles: ['user'],
      };
      this.currentUser = user;
      const baseContext = this.buildBaseContext();
      this.currentCaller = this.createCaller('user', user, baseContext);
    }

    if (!this.currentCaller) {
      throw new Error('No caller available');
    }

    return this.currentCaller;
  }

  /**
   * Get the current user in the test context
   *
   * @returns Current test user or null if unauthenticated
   *
   * @example
   * ```typescript
   * const { user } = tester.asUser();
   * const currentUser = tester.getCurrentUser();
   * expect(currentUser?.id).toBe(user.id);
   * ```
   */
  getCurrentUser(): TestUser | null {
    return this.currentUser;
  }

  /**
   * Get the current caller
   *
   * @returns Current caller instance
   * @throws Error if no caller is available
   *
   * @example
   * ```typescript
   * tester.asUser();
   * const caller = tester.getCaller();
   * await caller.someMethod();
   * ```
   */
  getCaller(): TCaller {
    if (!this.currentCaller) {
      throw new Error('No caller available. Call asUser(), asGuest(), asModerator(), or asAdmin() first.');
    }
    return this.currentCaller;
  }

  /**
   * Wait for async projections to complete
   *
   * In event-sourced systems, projections update asynchronously after events are stored.
   * This method waits for a short period to allow projections to process.
   *
   * @param ms - Milliseconds to wait (default: 100ms)
   *
   * @example
   * ```typescript
   * await tester.caller.user.createUser({ ... });
   * await tester.waitForProjections();
   * const user = await tester.caller.user.getUser();
   * ```
   */
  async waitForProjections(ms = 100): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get the current test context with all services
   */
  get context(): TContext {
    return this.buildBaseContext();
  }

  /**
   * Execute a callback within an auto-rollback transaction
   *
   * The transaction is automatically rolled back after the callback completes,
   * leaving the database in a clean state for the next test.
   *
   * @param callback - Async function to execute in transaction
   * @returns Result of callback (always undefined due to rollback)
   *
   * @example
   * ```typescript
   * await tester.withTransaction(async () => {
   *   const user = await tester.db.insert(users).values({...}).returning();
   *   const result = await tester.caller.user.someMethod();
   *   expect(result).toBeDefined();
   *   // Transaction automatically rolls back after this
   * });
   * ```
   */
  async withTransaction<T>(callback: () => Promise<T>): Promise<T> {
    if (!this._db) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    debugTester('[tester] Starting auto-rollback transaction');
    try {
      return await this._db.transaction(async tx => {
        this.currentTransaction = tx;
        debugTester('[tester] Transaction started');
        try {
          await callback();
          debugTester('[tester] Callback completed, initiating rollback');
          throw new Error('__ROLLBACK__');
        } catch (error) {
          if (error instanceof Error && error.message === '__ROLLBACK__') {
            debugTester('[tester] Transaction rolled back successfully');
            return undefined as T;
          }
          debugTester('[tester] Error in transaction callback: %s', error instanceof Error ? error.message : 'unknown error');
          throw error;
        } finally {
          this.currentTransaction = null;
        }
      });
    } catch (error) {
      // Suppress connection errors during rollback - they're expected when using the throw-to-rollback pattern
      if (
        error instanceof Error &&
        (error.message.includes('server closed the connection') ||
          error.message.includes('Connection terminated') ||
          error.message.includes('connection is closed'))
      ) {
        debugTester('[tester] Connection closed during rollback (expected)');
        return undefined as T;
      }
      throw error;
    }
  }

  /**
   * Assert that a value is a valid branded ID with the expected prefix
   *
   * @param value - Value to check
   * @param prefix - Expected ID prefix (e.g., 'usr_', 'game_')
   * @throws Error if value is not a string or doesn't have the correct prefix
   *
   * @example
   * ```typescript
   * const user = await createUser();
   * tester.assertValidId(user.id, 'usr_');
   * ```
   */
  assertValidId(value: unknown, prefix: string): asserts value is string {
    if (typeof value !== 'string') {
      throw new TypeError(`Expected ID to be a string, got ${typeof value}`);
    }
    if (!value.startsWith(prefix)) {
      throw new Error(`Expected ID to start with '${prefix}', got '${value}'`);
    }
    if (value.length <= prefix.length) {
      throw new Error(`Expected ID to have content after prefix '${prefix}', got '${value}'`);
    }
  }

  /**
   * Assert that an object has valid createdAt and updatedAt timestamps
   *
   * @param obj - Object to check
   * @throws Error if timestamps are missing or not Date instances
   *
   * @example
   * ```typescript
   * const game = await tester.repo.games.create({...});
   * tester.assertTimestamps(game);
   * ```
   */
  assertTimestamps(obj: unknown): asserts obj is { createdAt: Date; updatedAt: Date } {
    if (!obj || typeof obj !== 'object') {
      throw new Error('Expected object with timestamps');
    }

    const record = obj as any;
    if (!(record.createdAt instanceof Date)) {
      throw new TypeError(`Expected createdAt to be a Date, got ${typeof record.createdAt}`);
    }
    if (!(record.updatedAt instanceof Date)) {
      throw new TypeError(`Expected updatedAt to be a Date, got ${typeof record.updatedAt}`);
    }
  }

  /**
   * Assert that updatedAt is greater than or equal to createdAt
   *
   * @param obj - Object with timestamps
   * @throws Error if updatedAt is before createdAt
   *
   * @example
   * ```typescript
   * const game = await tester.repo.games.update(id, {...});
   * tester.assertTimestamps(game);
   * tester.assertUpdatedAfterCreated(game);
   * ```
   */
  assertUpdatedAfterCreated(obj: { createdAt: Date; updatedAt: Date }): void {
    if (obj.updatedAt.getTime() < obj.createdAt.getTime()) {
      throw new Error(
        `Expected updatedAt (${obj.updatedAt.toISOString()}) to be >= createdAt (${obj.createdAt.toISOString()})`,
      );
    }
  }

  /**
   * Assert that a response has valid pagination structure
   *
   * @param response - Response to check
   * @throws Error if response doesn't have items array
   *
   * @example
   * ```typescript
   * const result = await tester.caller.user.games.list();
   * tester.assertPaginatedResponse(result);
   * expect(result.items).toHaveLength(10);
   * ```
   */
  assertPaginatedResponse(response: unknown): asserts response is {
    items: unknown[];
    total?: number;
    nextCursor?: string | null;
    hasMore?: boolean;
  } {
    if (!response || typeof response !== 'object') {
      throw new Error('Expected paginated response to be an object');
    }

    const resp = response as any;
    if (!Array.isArray(resp.items)) {
      throw new TypeError('Expected paginated response to have items array');
    }
  }

  /**
   * Generate a deterministic URL-safe slug
   *
   * @param prefix - Optional prefix for the slug
   * @returns Generated slug
   *
   * @example
   * ```typescript
   * const slug = tester.generateSlug(); // 'test-a1b2c3d4'
   * const slug = tester.generateSlug('game'); // 'game-a1b2c3d4'
   * ```
   */
  generateSlug(prefix?: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(`${this.randomSeed}-${this.randomCounter++}`)
      .digest('hex')
      .slice(0, 8);

    return prefix ? `${prefix}-${hash}` : `test-${hash}`;
  }

  /**
   * Generate a deterministic email address
   *
   * @param prefix - Optional prefix for the email
   * @returns Generated email
   *
   * @example
   * ```typescript
   * const email = tester.generateEmail(); // 'test-a1b2c3d4@example.com'
   * const email = tester.generateEmail('admin'); // 'admin-a1b2c3d4@example.com'
   * ```
   */
  generateEmail(prefix?: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(`${this.randomSeed}-${this.randomCounter++}`)
      .digest('hex')
      .slice(0, 8);

    const emailPrefix = prefix ?? 'test';
    return `${emailPrefix}-${hash}@example.com`;
  }

  /**
   * Generate a deterministic URL
   *
   * @param path - Optional path component
   * @returns Generated URL
   *
   * @example
   * ```typescript
   * const url = tester.generateUrl(); // 'https://example.com/test-a1b2c3d4'
   * const url = tester.generateUrl('games/chess'); // 'https://example.com/games/chess'
   * ```
   */
  generateUrl(path?: string): string {
    if (path) {
      return `https://example.com/${path}`;
    }

    const hash = crypto
      .createHash('sha256')
      .update(`${this.randomSeed}-${this.randomCounter++}`)
      .digest('hex')
      .slice(0, 8);

    return `https://example.com/test-${hash}`;
  }

  /**
   * Generate a deterministic random string
   *
   * @param length - Length of string (default: 16)
   * @returns Generated string
   *
   * @example
   * ```typescript
   * const token = tester.generateString(32);
   * const code = tester.generateString(6);
   * ```
   */
  generateString(length = 16): string {
    const hash = crypto.createHash('sha256').update(`${this.randomSeed}-${this.randomCounter++}`).digest('hex');
    return hash.slice(0, Math.max(0, Math.min(length, hash.length)));
  }

  /**
   * Generate a random phone number
   *
   * @param format - Phone format (default: 'US')
   * @returns Generated phone number
   *
   * @example
   * ```typescript
   * const phone = tester.generatePhone(); // '+1-555-123-4567'
   * ```
   */
  generatePhone(format: 'US' | 'INTERNATIONAL' = 'US'): string {
    const areaCode = this.generateBetween(200, 999);
    const prefix = this.generateBetween(200, 999);
    const line = this.generateBetween(1000, 9999);

    if (format === 'US') {
      return `+1-${areaCode}-${prefix}-${line}`;
    }
    return `+1${areaCode}${prefix}${line}`;
  }

  /**
   * Generate a random date within a range
   *
   * @param options - Options for date generation
   * @returns Generated date
   *
   * @example
   * ```typescript
   * // Date in the past year
   * const date = tester.generateDate({ past: { years: 1 } });
   *
   * // Date in the next 30 days
   * const date = tester.generateDate({ future: { days: 30 } });
   *
   * // Date between two dates
   * const date = tester.generateDate({
   *   between: { from: new Date('2024-01-01'), to: new Date('2024-12-31') }
   * });
   * ```
   */
  generateDate(
    options: {
      past?: { years?: number; months?: number; days?: number };
      future?: { years?: number; months?: number; days?: number };
      between?: { from: Date; to: Date };
    } = {},
  ): Date {
    if (options.between) {
      const fromTime = options.between.from.getTime();
      const toTime = options.between.to.getTime();
      const randomTime = this.generateBetween(fromTime, toTime);
      return new Date(randomTime);
    }

    const now = Date.now();

    if (options.past) {
      const { years = 0, months = 0, days = 0 } = options.past;
      const msInDay = 24 * 60 * 60 * 1000;
      const msInYear = 365 * msInDay;
      const msInMonth = 30 * msInDay;

      const totalMs = years * msInYear + months * msInMonth + days * msInDay;
      const randomTime = this.generateBetween(now - totalMs, now);
      return new Date(randomTime);
    }

    if (options.future) {
      const { years = 0, months = 0, days = 0 } = options.future;
      const msInDay = 24 * 60 * 60 * 1000;
      const msInYear = 365 * msInDay;
      const msInMonth = 30 * msInDay;

      const totalMs = years * msInYear + months * msInMonth + days * msInDay;
      const randomTime = this.generateBetween(now, now + totalMs);
      return new Date(randomTime);
    }

    // Default: random date in past year
    return new Date(this.generateBetween(now - 365 * 24 * 60 * 60 * 1000, now));
  }

  /**
   * Generate a random number between min and max (inclusive)
   *
   * @param min - Minimum value
   * @param max - Maximum value
   * @returns Random number
   *
   * @example
   * ```typescript
   * const score = tester.generateBetween(0, 100);
   * const priority = tester.generateBetween(1, 5);
   * ```
   */
  generateBetween(min: number, max: number): number {
    const hash = crypto.createHash('sha256').update(`${this.randomSeed}-${this.randomCounter++}`).digest('hex');

    // Use first 8 characters as hex number
    const randomHex = Number.parseInt(hash.slice(0, 8), 16);
    const range = max - min + 1;
    return min + (randomHex % range);
  }

  /**
   * Generate a random value from an enum or array
   *
   * @param values - Enum object or array of values
   * @returns Random value
   *
   * @example
   * ```typescript
   * enum Status { Active = 'active', Inactive = 'inactive', Pending = 'pending' }
   * const status = tester.generateFromEnum(Status);
   *
   * const role = tester.generateFromEnum(['user', 'admin', 'moderator']);
   * ```
   */
  generateFromEnum<T>(values: T[] | Record<string, T>): T {
    const valuesArray = Array.isArray(values) ? values : Object.values(values);
    const index = this.generateBetween(0, valuesArray.length - 1);
    return valuesArray[index]!;
  }

  /**
   * Get the random seed used for generation (for debugging)
   *
   * @returns Random seed string
   */
  getRandomSeed(): string {
    return this.randomSeed;
  }

  /**
   * Reset the random counter (useful for creating reproducible sequences within a test)
   *
   * @example
   * ```typescript
   * tester.resetRandomCounter();
   * const email1 = tester.generateEmail(); // Deterministic
   * tester.resetRandomCounter();
   * const email2 = tester.generateEmail(); // Same as email1
   * ```
   */
  resetRandomCounter(): void {
    this.randomCounter = 0;
  }

  /**
   * Register base factories from config
   * Only works with FactoryRegistry instances, skipped for custom typed registries
   */
  protected registerBaseFactories(): void {
    if (!this.config.baseFactories || !this._factoryRegistry) {
      return;
    }

    // Only register if using base FactoryRegistry (not custom typed registry)
    if (this._factoryRegistry instanceof FactoryRegistry) {
      for (const [name, factory] of Object.entries(this.config.baseFactories)) {
        this._factoryRegistry.register(name, factory);
      }
    }
  }

  protected mergeUsers(overrides: TesterUserOverrides = {}): TesterUsers {
    return {
      user: overrides.user ?? { ...this.config.defaultUsers.user },
      moderator: overrides.moderator ?? { ...this.config.defaultUsers.moderator },
      admin: overrides.admin ?? { ...this.config.defaultUsers.admin },
    };
  }

  protected createCaller(role: TestUserRole, user: TestUser | null, context: TContext): TCaller {
    return this.config.createCaller({
      context,
      role,
      user,
      responseHeaders: new Headers(),
    });
  }

  protected buildBaseContext(): TContext {
    if (!this._db || !this._repo || !this.baseConnectionString) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    const currentDb = this.getCurrentDb();
    const repositories = this.config.createRepositories(currentDb);

    // Reuse the initial context when not in a transaction to avoid creating duplicate connections
    if (!this.currentTransaction && this._baseContext) {
      return this._baseContext;
    }

    // When running inside a transaction, reuse heavy resources (event store, message bus)
    // from the base context while swapping in the transactional db/repositories.
    if (this._baseContext && this.currentTransaction) {
      const clonedContext: any = {
        ...(this._baseContext as any),
        db: currentDb,
        repo: repositories,
      };

      if ('kv' in clonedContext && this._kv) {
        clonedContext.kv = this._kv;
      }

      if ('runInTransaction' in clonedContext && typeof (currentDb as any).transaction === 'function') {
        clonedContext.runInTransaction = (currentDb as any).transaction.bind(currentDb);
      }

      return clonedContext as TContext;
    }

    const context = this.config.createContext({
      db: currentDb,
      repo: repositories,
      kv: this._kv,
      connectionString: this.baseConnectionString,
    });

    if (!this.currentTransaction) {
      this._baseContext = context;
    }

    return context;
  }

  protected createDatabaseConnection(connectionString: string): TDatabase {
    return initDb.schema(this.config.schema).create({
      connectionString,
      isDev: true,
    }).db as TDatabase;
  }
}
