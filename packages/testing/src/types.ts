import type { UserId } from '@arki/auth';
import type { KV } from '@arki/kv';

import type { Factory } from './factories';

export type TestUserRole = 'public' | 'user' | 'moderator' | 'admin';

export interface TestUser {
  id: UserId;
  email: string;
  name: string;
  permissions?: string[];
  roles?: string[];
}

export type TesterUserOverrides = Partial<Record<'user' | 'moderator' | 'admin', TestUser>>;

export interface TesterUsers {
  user: TestUser;
  moderator: TestUser;
  admin: TestUser;
}

export interface TesterOptions {
  users?: TesterUserOverrides;
  autoRollback?: boolean;
  randomSeed?: string;
  connectionString?: string;
  useUniqueDatabase?: boolean;
  redisConnectionString?: string;
  useUniqueRedisNamespace?: boolean;
}

export interface CreateCallerArgs<TContext> {
  context: TContext;
  role: TestUserRole;
  user: TestUser | null;
  responseHeaders: Headers;
}

export interface IntegrationTesterConfig<
  TSchema extends Record<string, unknown>,
  TDatabase,
  TRepositories,
  TCaller,
  TContext,
> {
  schema: TSchema;
  migrationsFolder: string;
  createContext(params: { db: TDatabase; repo: TRepositories; kv: KV | null; connectionString: string }): TContext;
  createCaller(args: CreateCallerArgs<TContext>): TCaller;
  createRepositories(db: TDatabase): TRepositories;
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
