import type { AnyRelations } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgAsyncDatabase } from 'drizzle-orm/pg-core';

import type { UserId } from '@arki/auth';
import type { KV } from '@arki/kv';

export type TestUserRole = 'public' | 'user' | 'moderator' | 'admin';

export type TestUser = {
  id: UserId;
  email: string;
  name: string;
  permissions?: string[];
  roles?: string[];
}

export type TesterUserOverrides = Partial<Record<'user' | 'moderator' | 'admin', TestUser>>;

export type TesterUsers = {
  user: TestUser;
  moderator: TestUser;
  admin: TestUser;
}

export type TesterOptions = {
  users?: TesterUserOverrides;
  autoRollback?: boolean;
  randomSeed?: string;
  connectionString?: string;
  useUniqueDatabase?: boolean;
  redisConnectionString?: string;
  useUniqueRedisNamespace?: boolean;
}

export type CreateCallerArgs<TContext> = {
  context: TContext;
  role: TestUserRole;
  user: TestUser | null;
  responseHeaders: Headers;
}

/**
 * What the tester needs from the app's database handle type.
 *
 * The handle is what the app passes to its repositories and context: the root database or
 * a transaction (for example `Db | Transaction`). The one rule is that `transaction()` hands
 * its callback a handle. A root database type alone does not meet that rule, because its
 * callback receives a transaction; so the handle type must also admit the transaction. That
 * is what lets the tester swap the database for the test transaction without a cast.
 */
export type TesterDatabase<THandle> = {
  transaction<TResult>(callback: (tx: THandle) => Promise<TResult>): Promise<TResult>;
} & PgAsyncDatabase<NodePgQueryResultHKT, AnyRelations>;

export type IntegrationTesterConfig<
  TSchema extends Record<string, unknown>,
  TDatabase extends THandle,
  TRepositories,
  TCaller,
  TContext,
  THandle extends TesterDatabase<THandle>,
> = {
  schema: TSchema;
  migrationsFolder: string;

  /**
   * Open the app's database on `connectionString`. `TDatabase`, the type of `tester.db`, is
   * whatever this returns. Build it the way the app does in production (same relations), so
   * relational queries work in tests. The tester ends its `$client` pool on teardown.
   */
  createDatabase(connectionString: string): TDatabase;
  createContext(params: { db: THandle; repo: TRepositories; kv: KV | null; connectionString: string }): TContext;
  createCaller(args: CreateCallerArgs<TContext>): TCaller;
  createRepositories(db: THandle): TRepositories;
  defaultUsers: TesterUsers;

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
