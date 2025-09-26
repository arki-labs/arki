import type { Command, ProjectionDefinition } from '@event-driven-io/emmett';
import type { AnyRouter, DataTransformer } from '@trpc/server/unstable-core-do-not-import';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';

import type { Session } from '@arki/auth';
import type { DotAuth, DotRBACManager, DotSessionManager } from './auth/index';
import type { ExtractTablesWithRelations } from '@arki/db/orm';
import type { CommandHandlerType } from '@arki/event-sourcing/command';
import type { PostgreSQLProjectionHandlerContext, PostgresReadEventMetadata } from '@arki/event-sourcing/store';
import type { KV } from '@arki/kv';

// Define types for the auth functions we need
export type AuthPackage = {
  auth: () => Promise<Session | null>;
  validateSessionToken: (token: string) => Promise<Session | null>;
  invalidateSessionToken: (token: string) => Promise<void>;
};

/**
 * Represents the structure of a database schema recognized by Drizzle.
 * Should be a record mapping table names to Drizzle table objects (e.g., PgTable).
 * Using `Record<string, unknown>` for flexibility in the builder.
 * @example { users: PgTable<any>, posts: PgTable<any> }
 */
export type SchemaInterface = Record<string, unknown>;

/**
 * Represents a collection of repositories, typically mapping names to repository instances.
 * @template T The base type or interface for repository instances.
 * @example { userRepo: UserRepository, postRepo: PostRepository }
 */
export type Repository<T = unknown> = Record<string, T>;

/**
 * Represents a collection of tRPC routers.
 * Using `Record<string, AnyRouter>` for compatibility with tRPC internal types.
 * @example { user: userRouter, post: postRouter }
 */
export type RouterRecord = Record<string, AnyRouter>;

/**
 * Defines the expected structure for validated environment variables.
 * Assumes processing by a library like `@t3-oss/env-nextjs`.
 */
export type EnvConfig = {
  NODE_ENV?: string;
  DB_URL?: string;
  KV_URL?: string;
  EVENT_STORE_URL?: string;
  [key: string]: string | number | boolean | undefined; // Allow other validated keys
};

/**
 * Authentication configuration options
 */
export type AuthConfig = {
  /**
   * Authentication secret for JWT signing
   */
  secret: string;

  /**
   * Base URL for authentication redirects
   */
  baseUrl?: string;

  /**
   * Debug mode for authentication
   */
  debug?: boolean;

  /**
   * Custom session validation function
   */
  validateSession?: (token: string) => Promise<Session | null>;

  /**
   * Authentication providers
   */
  providers?: any[];

  /**
   * Custom authentication pages
   */
  pages?: {
    signIn?: string;
    signOut?: string;
    error?: string;
    verifyRequest?: string;
    newUser?: string;
  };

  /**
   * Authentication callbacks
   */
  callbacks?: {
    session?: (params: any) => any;
    signIn?: (params: any) => Promise<boolean>;
    redirect?: (params: { baseUrl: string }) => Promise<string>;
    jwt?: (params: { token: any }) => Promise<any>;
  };

  /**
   * Authentication events
   */
  events?: {
    signIn?: (message: any) => Promise<void>;
    signOut?: (message: any) => Promise<void>;
    createUser?: (message: any) => Promise<void>;
    updateUser?: (message: any) => Promise<void>;
    linkAccount?: (message: any) => Promise<void>;
    session?: (message: any) => Promise<void>;
  };
};

/**
 * Base type for projection definitions used internally.
 * Uses `any` for the event type to allow heterogeneous arrays.
 */
export type BaseProjectionDefinition = ProjectionDefinition<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  PostgresReadEventMetadata,
  PostgreSQLProjectionHandlerContext
>;

/**
 * Configuration for a specific command handler.
 * Uses `any` for state/event types for flexibility in registration.
 * @template C The specific command type this handler processes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CommandHandlerRegistration<C extends Command = any> = {
  commandType: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: CommandHandlerType<C, any, any>;
  getStreamName: (command: C) => string;
};

/**
 * Represents a session user with basic properties.
 * Specific implementations can extend this interface.
 */
export type SessionUser = Session['user'] & {
  roles?: string[];
};

/**
 * Base context for tRPC procedures.
 * Can be extended in application implementations.
 */
export type BaseTRPCContext<TSchema extends SchemaInterface> = {
  session: Session | null;
  user?: SessionUser;
  token: string | null;
  db?: NodePgDatabase<TSchema>;
  runInTransaction?: <T>(
    callback: (tx: NodePgTransaction<TSchema, ExtractTablesWithRelations<TSchema>>) => Promise<T>,
  ) => Promise<T>;
  repo?: Repository;
  kv?: KV;
  messageBus?: any;
  // Auth-related properties
  auth?: DotAuth;
  sessionManager?: DotSessionManager;
  rbac?: DotRBACManager;
  [key: string]: unknown;
};

/**
 * Options for customizing tRPC initialization.
 */
export type TRPCOptions<TSchema extends SchemaInterface> = {
  /**
   * Function to get a session from headers
   */
  getSession?: (headers: Headers) => Promise<Session | null>;

  /**
   * Optional transformer for tRPC (default: superjson)
   */
  transformer?: DataTransformer;

  /**
   * Context creator extension function
   */
  extendContext?: (
    baseContext: BaseTRPCContext<TSchema>,
    opts: { headers: Headers; session: Session | null },
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
};
