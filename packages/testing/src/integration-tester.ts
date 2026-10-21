// Fixture setup needs concrete IDs; abort setup if secure generation fails.
import { orThrow } from '@arki/failure';
import crypto from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PgTable } from 'drizzle-orm/pg-core';
import type { StartedTestContainer } from 'testcontainers';
import { is, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { UserId } from '@arki/auth';
import { createUserId } from '@arki/auth/ids';
import { initDb } from '@arki/db/builder';
import { KV } from '@arki/kv';
import { is as matchesSchema, recordSchema } from '@arki/schema';

import type {
  IntegrationTesterConfig,
  TesterDatabase,
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
import { faker } from './factories';
import * as performance from './performance';
import type { Timestamp, Timestamps } from './timestamps';
import { assertTimestamps, assertUpdatedAfterCreated, epochMilliseconds } from './timestamps';

type CallerCollection<TCaller> = {
  public: TCaller;
  user: TCaller;
  moderator: TCaller;
  admin: TCaller;
};

/**
 * `drizzle(...)` puts the connection on `$client`, but the `NodePgDatabase` type does not declare it.
 * These guards check for it at runtime instead of casting.
 */
type Endable = { end(): Promise<void> };
type Releasable = { release(): void | Promise<void> };

function isObjectWith<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return matchesSchema(value, recordSchema) && key in value;
}

function isEndable(value: unknown): value is Endable {
  return isObjectWith(value, 'end') && typeof value.end === 'function';
}

function isReleasable(value: unknown): value is Releasable {
  return isObjectWith(value, 'release') && typeof value.release === 'function';
}

/**
 * Close the connection pool (or release the client) that backs a drizzle database.
 * Returns which action ran, or `null` when the database has no `$client`.
 */
async function closeDatabaseClient(db: object): Promise<'ended' | 'released' | null> {
  if (!isObjectWith(db, '$client') || !db.$client) {
    return null;
  }
  const client = db.$client;
  if (isEndable(client)) {
    await client.end();
    return 'ended';
  }
  if (isReleasable(client)) {
    await client.release();
    return 'released';
  }
  return null;
}

/** Thrown at the end of `withTransaction` so Drizzle rolls the transaction back. Never reaches callers. */
class TransactionRollback extends Error {
  constructor() {
    super('Test transaction rollback');
  }
}

/**
 * Integration testing helper class providing comprehensive utilities for testing
 * tRPC applications with PostgreSQL and Redis.
 *
 * @template TSchema - Drizzle schema type
 * @template TDatabase - The root database type, as `createDatabase` returns it (the type of `tester.db`)
 * @template TRepositories - Repository collection type
 * @template TCaller - tRPC caller type
 * @template TContext - tRPC context type
 * @template THandle - What repositories and the context take: the root database or a transaction
 *
 * @example
 * ```typescript
 * const t = initTester.context<AppContext>().caller<Caller>().create({
 *   schema,
 *   migrationsFolder: './migrations',
 *   createDatabase,
 *   createContext,
 *   createCaller,
 *   createRepositories,
 *   defaultUsers: { user, moderator, admin },
 * });
 *
 * const createTester = t.tester.withFactories({ user: userFactory, game: gameFactory });
 *
 * // In tests
 * const tester = createTester();
 * await tester.setup();
 * await tester.withTransaction(async () => {
 *   const user = tester.factory.user(); // typed by the factories passed above
 *   const result = await tester.caller.user.someMethod();
 *   tester.assertValidId(result.id, 'prefix_');
 * });
 * await tester.teardown();
 * ```
 */
export class IntegrationTester<
  TSchema extends Record<string, unknown>,
  TDatabase extends THandle,
  TRepositories extends Record<string, unknown>,
  TCaller,
  TContext extends Record<string, unknown>,
  THandle extends TesterDatabase<THandle>,
> {
  protected readonly config: IntegrationTesterConfig<TSchema, TDatabase, TRepositories, TCaller, TContext, THandle>;
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
  protected _baseContext: TContext | null = null;

  protected currentTransaction: THandle | null = null;

  protected randomCounter = 0;
  protected randomSeed: string;

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
    config: IntegrationTesterConfig<TSchema, TDatabase, TRepositories, TCaller, TContext, THandle>,
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
  protected getCurrentDb(): THandle {
    if (!this._db) {
      throw new Error('Tester not initialized. Call setup() first.');
    }
    // Return transaction if one is active, otherwise return base db
    const useTransaction = !!this.currentTransaction;
    if (useTransaction) {
      debugTester.debug('[tester] getCurrentDb: Using transaction context');
    }
    return this.currentTransaction ?? this._db;
  }

  /**
   * Repositories on the current database: the test transaction while `withTransaction` is
   * running, the base database otherwise. So a read through `repo` sees what a caller wrote
   * in the same transaction. Read it inside the transaction; a value kept from before it
   * still uses the base database.
   */
  get repo(): TRepositories {
    if (!this._repo) {
      throw new Error('Tester not initialized. Call setup() first.');
    }
    if (this.currentTransaction) {
      return this.config.createRepositories(this.currentTransaction);
    }
    return this._repo;
  }

  /**
   * The database callers and `repo` use right now: the test transaction while `withTransaction`
   * is running, the root database otherwise. Use it to check what a caller wrote in the
   * transaction. (`db` is always the root database, so it cannot see uncommitted rows.)
   */
  get currentDb(): THandle {
    return this.getCurrentDb();
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

  /**
   * Callers for every role. Each property builds its caller when you read it, on the current
   * database: the test transaction while `withTransaction` is running, the base database
   * otherwise. Read it inside the transaction; a caller you kept from before it still writes
   * on the base database.
   */
  get caller(): CallerCollection<TCaller> {
    const users = this.users;
    const build = (role: TestUserRole, user: TestUser | null): TCaller => this.callerFor(role, user);
    return {
      get public() {
        return build('public', null);
      },
      get user() {
        return build('user', users.user);
      },
      get moderator() {
        return build('moderator', users.moderator);
      },
      get admin() {
        return build('admin', users.admin);
      },
    };
  }

  get currentTx() {
    return this.currentTransaction;
  }

  getUser(role: 'user' | 'moderator' | 'admin'): TestUser {
    const configuredUsers = this.users;
    return configuredUsers[role];
  }

  async setup(): Promise<void> {
    debugTester.debug('[tester] Setting up integration tester (useUniqueDb: {useUniqueDb})', {
      useUniqueDb: this.options.useUniqueDatabase ?? false,
    });
    const { users = {}, connectionString: customConnectionString, useUniqueDatabase = false } = this.options;

    let connectionString: string;
    const globalConnectionString = getGlobalPostgresConnectionString();
    debugTester.debug('[tester] Connection string sources (custom: {custom}, global: {global})', {
      custom: !!customConnectionString,
      global: !!globalConnectionString,
    });

    if (customConnectionString) {
      debugTester.debug('[tester] Using custom connection string');
      connectionString = customConnectionString;
      this.ownsContainer = false;
    } else if (globalConnectionString) {
      debugTester.debug('[tester] Using global connection string');
      connectionString = globalConnectionString;
      this.ownsContainer = false;
    } else {
      debugTester.debug('[tester] Starting new PostgreSQL container (owning)');
      this.container = await startPostgresContainer();
      connectionString = this.container.getConnectionUri();
      this.ownsContainer = true;
      debugTester.debug('[tester] PostgreSQL container started');
    }

    this.baseConnectionString = connectionString;

    if (useUniqueDatabase) {
      this.uniqueDatabaseName = `test_${crypto.randomBytes(8).toString('hex')}`;
      debugTester.debug('[tester] Creating unique database (name: {name})', { name: this.uniqueDatabaseName });
      const adminDb = this.openSchemaDatabase(connectionString);
      try {
        await adminDb.execute(sql.raw(`CREATE DATABASE "${this.uniqueDatabaseName}"`));

        const url = new URL(connectionString);
        url.pathname = `/${this.uniqueDatabaseName}`;
        connectionString = url.toString();
        debugTester.debug('[tester] Unique database created');
      } finally {
        // Close the admin connection after creating the database
        try {
          await closeDatabaseClient(adminDb);
          debugTester.debug('[tester] Admin database connection closed after setup');
        } catch (closeError) {
          debugTester.debug('[tester] Error closing admin connection during setup: {setup}', {
            setup: closeError instanceof Error ? closeError.message : 'unknown error',
          });
        }
      }
    }

    debugTester.debug('[tester] Creating database connection and running migrations');
    const migrationDb = this.openSchemaDatabase(connectionString);
    try {
      await migrate(migrationDb, { migrationsFolder: this.config.migrationsFolder });
    } finally {
      await closeDatabaseClient(migrationDb);
    }
    debugTester.debug('[tester] Migrations completed');
    const database = this.config.createDatabase(connectionString);
    this._db = database;

    debugTester.debug('[tester] Creating repositories');
    this._repo = this.config.createRepositories(database);
    debugTester.debug('[tester] Repositories created');

    const { redisConnectionString: customRedisConnectionString, useUniqueRedisNamespace = false } = this.options;

    let redisUrl: string;
    const globalRedisConnection = getGlobalRedisConnectionString();
    debugTester.debug('[tester] Redis sources (custom: {custom}, global: {global})', {
      custom: !!customRedisConnectionString,
      global: !!globalRedisConnection,
    });

    if (customRedisConnectionString) {
      debugTester.debug('[tester] Using custom Redis connection');
      redisUrl = customRedisConnectionString;
      this.ownsRedisContainer = false;
    } else if (globalRedisConnection) {
      debugTester.debug('[tester] Using global Redis connection');
      redisUrl = globalRedisConnection;
      this.ownsRedisContainer = false;
    } else {
      debugTester.debug('[tester] Starting new Redis container (owning)');
      this.redisContainer = await startRedisContainer();
      const redisHost = this.redisContainer.getHost();
      const redisPort = this.redisContainer.getMappedPort(6379);
      redisUrl = `redis://${redisHost}:${redisPort}`;
      this.ownsRedisContainer = true;
      debugTester.debug('[tester] Redis container started');
    }

    this.redisNamespace = useUniqueRedisNamespace ? `test:${crypto.randomBytes(8).toString('hex')}` : 'test';
    debugTester.debug('[tester] Creating KV instance (namespace: {namespace})', { namespace: this.redisNamespace });
    this._kv = new KV(redisUrl, this.redisNamespace);
    debugTester.debug('[tester] KV instance created');

    const baseContext = this.buildBaseContext();
    this._baseContext = baseContext;
    debugTester.debug('[tester] Creating test users');
    this._users = this.mergeUsers(users);

    // Call onSetup hook to create default users in database if provided
    if (this.config.onSetup) {
      debugTester.debug('[tester] Running onSetup hook');
      await this.config.onSetup({ context: baseContext, users: this._users });
      debugTester.debug('[tester] onSetup hook completed');
    }

    debugTester.debug('[tester] Setup completed successfully');
  }

  async teardown(): Promise<void> {
    debugTester.debug('[tester] Starting teardown');

    // Step 1: Close event store connection first (if exists in context)
    const contextForCleanup = this._baseContext;
    if (contextForCleanup && 'closeEventStore' in contextForCleanup) {
      debugTester.debug('[tester] Closing event store connection via cleanup function');
      try {
        const closeEventStore = contextForCleanup.closeEventStore;
        if (typeof closeEventStore === 'function') {
          await closeEventStore();
          debugTester.debug('[tester] Event store connection closed successfully');
        } else {
          debugTester.debug('[tester] closeEventStore is not a function, skipping');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        debugTester.debug('[tester] Error closing event store: {store}', { store: errorMessage });
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
      debugTester.debug('[tester] No closeEventStore function found, attempting direct close');
      try {
        const eventStore = contextForCleanup.eventStore;
        if (isObjectWith(eventStore, 'close') && typeof eventStore.close === 'function') {
          await eventStore.close();
          debugTester.debug('[tester] Event store connection closed via direct method');
        }
      } catch (error) {
        debugTester.debug('[tester] Error in fallback event store close', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Step 2: Close database connection pool
    if (this._db) {
      debugTester.debug('[tester] Closing database connection');
      try {
        const closed = await closeDatabaseClient(this._db);
        if (closed === 'ended') {
          debugTester.debug('[tester] Database pool ended successfully');
        } else if (closed === 'released') {
          debugTester.debug('[tester] Database client released successfully');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        debugTester.debug('[tester] Error closing database: {database}', { database: errorMessage });
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
      debugTester.debug('[tester] Closing KV instance');
      try {
        await this._kv.close();
        debugTester.debug('[tester] KV instance closed');
      } catch (error) {
        debugTester.debug('[tester] Error closing KV', {
          error: error instanceof Error ? error.message : 'unknown error',
        });
        console.error('Failed to close KV instance:', error);
      }
      this._kv = null;
    }

    this.redisNamespace = null;

    if (this.redisContainer && this.ownsRedisContainer) {
      debugTester.debug('[tester] Stopping owned Redis container');
      try {
        await this.redisContainer.stop();
        debugTester.debug('[tester] Redis container stopped');
      } catch (error) {
        debugTester.debug('[tester] Error stopping Redis', {
          error: error instanceof Error ? error.message : 'unknown error',
        });
        console.error('Failed to stop Redis container:', error);
      }
      this.redisContainer = null;
    }

    this.ownsRedisContainer = false;

    if (this.uniqueDatabaseName) {
      debugTester.debug('[tester] Dropping unique database (name: {name})', { name: this.uniqueDatabaseName });
      let adminDb: ReturnType<typeof this.openSchemaDatabase> | null = null;
      try {
        const connection =
          this.options.connectionString ?? this.baseConnectionString ?? getGlobalPostgresConnectionString();

        if (connection) {
          adminDb = this.openSchemaDatabase(connection);
          await adminDb.execute(sql.raw(`DROP DATABASE IF EXISTS "${this.uniqueDatabaseName}" WITH (FORCE)`));
          debugTester.debug('[tester] Unique database dropped');
        } else {
          debugTester.debug('[tester] No connection available to drop unique database');
        }
      } catch (error) {
        debugTester.debug('[tester] Error dropping unique database', {
          error: error instanceof Error ? error.message : 'unknown error',
        });
        console.error(`Failed to drop unique database ${this.uniqueDatabaseName}:`, error);
      } finally {
        // Close the admin connection
        if (adminDb) {
          try {
            await closeDatabaseClient(adminDb);
            debugTester.debug('[tester] Admin database connection closed');
          } catch (closeError) {
            const errorMessage = closeError instanceof Error ? closeError.message : String(closeError);
            if (!errorMessage.includes('terminating connection due to administrator command')) {
              debugTester.debug('[tester] Error closing admin connection: {connection}', { connection: errorMessage });
            }
          }
        }
      }

      this.uniqueDatabaseName = null;
    }

    if (this.container && this.ownsContainer) {
      debugTester.debug('[tester] Stopping owned PostgreSQL container');
      try {
        await this.container.stop();
        debugTester.debug('[tester] PostgreSQL container stopped');
      } catch (error) {
        debugTester.debug('[tester] Error stopping PostgreSQL', {
          error: error instanceof Error ? error.message : 'unknown error',
        });
        console.error('Failed to stop container:', error);
      }
      this.container = null;
    }

    debugTester.debug('[tester] Cleaning up references');
    this._users = null;
    this._baseContext = null;
    this.ownsContainer = false;
    this.baseConnectionString = null;
    debugTester.debug('[tester] Teardown completed');
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
      (value): value is PgTable => matchesSchema(value, recordSchema),
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
      .filter((entry): entry is [string, PgTable] => regex.test(entry[0]) && is(entry[1], PgTable))
      .map(([, table]) => table);

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
      (value): value is PgTable => is(value, PgTable) && !exceptSet.has(value),
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
  async seed<T extends Record<string, readonly object[]>>(data: T): Promise<void> {
    if (!this._db) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    for (const [tableName, records] of Object.entries(data)) {
      if (records.length === 0) continue;

      const table = this.config.schema[tableName];
      if (!is(table, PgTable)) {
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
    return this.asRole('user', this.users.user);
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
    const userId = orThrow(createUserId());
    const email = this.generateEmail();
    const name = `Test User ${this.generateString(8)}`;

    debugTester.debug('[tester] Creating dynamic user (id: {id}, email: {email})', { id: userId, email });

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
      debugTester.debug('[tester] Running onUserCreate hook for dynamic user');
      await this.config.onUserCreate({ user, context: baseContext });
      debugTester.debug('[tester] User created in database');
    }

    const caller = this.callerFor('user', user);
    debugTester.debug('[tester] Dynamic user and caller created');

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
    this.currentCaller = this.callerFor('user', null);
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
    return this.asRole('moderator', this.users.moderator);
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
    return this.asRole('admin', this.users.admin);
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
      this.currentCaller = this.callerFor('user', user);
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
  async withTransaction(callback: () => Promise<unknown>): Promise<void> {
    if (!this._db) {
      throw new Error('Tester not initialized. Call setup() first.');
    }

    debugTester.debug('[tester] Starting auto-rollback transaction');
    // Drizzle rolls back when the transaction function throws. The sentinel is thrown
    // outside any catch of ours, so it always reaches Drizzle and the transaction never commits.
    const rollback = new TransactionRollback();
    const outcome: { failed: boolean; error?: unknown } = { failed: false };
    try {
      await this._db.transaction(async tx => {
        this.currentTransaction = tx;
        debugTester.debug('[tester] Transaction started');
        try {
          await callback();
        } catch (error) {
          debugTester.debug('[tester] Error in transaction callback', {
            error: error instanceof Error ? error.message : 'unknown error',
          });
          outcome.failed = true;
          outcome.error = error;
        } finally {
          this.currentTransaction = null;
        }
        throw rollback;
      });
    } catch (error) {
      if (error === rollback) {
        debugTester.debug('[tester] Transaction rolled back successfully');
        if (outcome.failed) {
          throw outcome.error;
        }
        return;
      }
      // Suppress connection errors during rollback - they're expected when using the throw-to-rollback pattern
      if (
        error instanceof Error &&
        (error.message.includes('server closed the connection') ||
          error.message.includes('Connection terminated') ||
          error.message.includes('connection is closed'))
      ) {
        debugTester.debug('[tester] Connection closed during rollback (expected)');
        return;
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
   * Each may be a `Date`, or a Temporal `Instant` or `ZonedDateTime` from `@arki/date`.
   *
   * @param obj - Object to check
   * @throws Error if timestamps are missing or are not one of those types
   *
   * @example
   * ```typescript
   * const game = await tester.repo.games.create({...});
   * tester.assertTimestamps(game);
   * ```
   */
  assertTimestamps(obj: unknown): asserts obj is Timestamps {
    assertTimestamps(obj);
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
  assertUpdatedAfterCreated(obj: Timestamps): void {
    assertUpdatedAfterCreated(obj);
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

    if (!('items' in response) || !Array.isArray(response.items)) {
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
      between?: { from: Timestamp; to: Timestamp };
    } = {},
  ): Date {
    if (options.between) {
      const fromTime = epochMilliseconds(options.between.from);
      const toTime = epochMilliseconds(options.between.to);
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

    // Reuse the initial context when not in a transaction to avoid creating duplicate connections
    if (!this.currentTransaction && this._baseContext) {
      return this._baseContext;
    }

    const currentDb = this.getCurrentDb();
    const repositories = this.config.createRepositories(currentDb);

    // When running inside a transaction, reuse heavy resources (event store, message bus)
    // from the base context while swapping in the transactional db/repositories.
    if (this._baseContext && this.currentTransaction) {
      const baseContext = this._baseContext;
      return {
        ...baseContext,
        db: currentDb,
        repo: repositories,
        ...('kv' in baseContext && this._kv ? { kv: this._kv } : {}),
        ...('runInTransaction' in baseContext ? { runInTransaction: currentDb.transaction.bind(currentDb) } : {}),
      };
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

  /**
   * A short-lived connection built from `config.schema`. The tester uses it for what does not
   * depend on the app's database type: running migrations and creating or dropping the unique
   * test database. Close it with `closeDatabaseClient`.
   */
  protected openSchemaDatabase(connectionString: string) {
    return initDb.schema(this.config.schema).create({ connectionString, isDev: true }).db;
  }

  /**
   * Build a caller for `role` on the current database (the test transaction while
   * `withTransaction` runs, the base database otherwise).
   */
  protected callerFor(role: TestUserRole, user: TestUser | null): TCaller {
    return this.createCaller(role, user, this.buildBaseContext());
  }

  /** Make `user` the current user and hand out a caller for it. */
  protected asRole(role: TestUserRole, user: TestUser): { user: TestUser; caller: TCaller } {
    this.currentUser = user;
    this.currentCaller = this.callerFor(role, user);
    return { user, caller: this.currentCaller };
  }
}

export type * from './types';
