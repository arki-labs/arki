import type { Event, ProjectionDefinition } from '@event-driven-io/emmett';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';

// Auth types are provided by our auth module
import type { DotAuth, DotAuthConfig, DotRBACManager, DotSession, DotSessionManager } from './auth/index.js';
import type { AnyRelations } from '@arki/db/orm';
import type { CommandHandler } from '@arki/event-sourcing/builders';
import type { PostgreSQLProjectionHandlerContext, PostgresReadEventMetadata } from '@arki/event-sourcing/store';
import type { KV } from '@arki/kv';

// Define types for the auth functions we need
export type AuthPackage = {
  auth: () => Promise<DotSession | null>;
  validateSessionToken: (token: string) => Promise<DotSession | null>;
  invalidateSessionToken: (token: string) => Promise<void>;
};

/**
 * Represents the relational config recognized by Drizzle 1.0 (RQBv2).
 *
 * In Drizzle 1.0 the legacy `schema` argument was replaced by a single
 * `relations` config built with `defineRelations(tables, builder)`. The
 * resulting object satisfies `TablesRelationalConfig`, which is exactly
 * what `AnyRelations` aliases. We keep the historical name `SchemaInterface`
 * for source-compatibility across this package.
 */
export type SchemaInterface = AnyRelations;

/**
 * Represents a collection of repositories, typically mapping names to repository instances.
 * @template T The base type or interface for repository instances.
 * @example { userRepo: UserRepository, postRepo: PostRepository }
 */
export type Repository<T = unknown> = Record<string, T>;

/**
 * Represents a collection of oRPC routers (plain objects).
 * In oRPC, routers are plain objects where each key is a procedure or nested router.
 * @example { user: userRouter, post: postRouter }
 */
export type RouterRecord = Record<string, unknown>;

/**
 * Defines the expected structure for validated environment variables.
 * Assumes processing by a library like `@t3-oss/env-core`.
 */
export type EnvConfig = {
  NODE_ENV?: string;
  DB_URL?: string;
  KV_URL?: string;
  EVENT_STORE_URL?: string;
  [key: string]: string | number | boolean | undefined; // Allow other validated keys
};

/**
 * Authentication configuration options.
 *
 * The canonical type lives in `./auth/config` as `DotAuthConfig`. We
 * re-export it here under the legacy name `AuthConfig` so existing
 * imports keep working. The previous local duplicate had drifted —
 * `providers` was typed as `unknown[]` instead of
 * `(BuiltInProvider | CustomProvider)[]` — which broke the call into
 * `authFeatures.initAuth(config: DotAuthConfig)`.
 *
 * Custom session validation can still be expressed via `DotAuthConfig.hooks`.
 */
export type AuthConfig = DotAuthConfig & {
  /**
   * Custom session validation function used by the legacy oRPC bridge
   * (`orpc/legacy.ts`) when no DotAuth instance is configured.
   */
  validateSession?: (token: string) => Promise<DotSession | null>;
};

/**
 * Base type for projection definitions used internally.
 * Uses the base `Event` type for heterogeneous projection arrays.
 */
export type BaseProjectionDefinition = ProjectionDefinition<
  Event,
  PostgresReadEventMetadata,
  PostgreSQLProjectionHandlerContext
>;

/**
 * Configuration for a specific command handler.
 *
 * Default type parameters are chosen for **variance compatibility** so that
 * `CommandHandlerRegistration[]` can hold handlers of many concrete types:
 *
 * - `C = never` — contravariant (parameter position): `never` extends every
 *   specific command type, so any handler function is assignable.
 * - `State = null | Record<string, unknown>` — covariant (return position):
 *   all aggregate states (including `null | { ... }` patterns) extend this.
 * - `StreamEvent = Event` — covariant: all events extend the base `Event`.
 *
 * @template C The specific command type this handler processes.
 * @template State The aggregate state type.
 * @template StreamEvent The stream event type.
 */
export type CommandHandlerRegistration<C = never, State = unknown, StreamEvent extends Event = Event> = {
  commandType: string;
  handler: CommandHandler<State, C, StreamEvent>;
  getStreamName: (command: C) => string;
};

/**
 * Represents a session user with basic properties.
 * Specific implementations can extend this interface.
 */
export type SessionUser = DotSession['user'] & {
  roles?: string[];
};

/**
 * Base context for oRPC procedures.
 * Can be extended in application implementations.
 */
export type BaseRPCContext<TSchema extends SchemaInterface> = {
  session: DotSession | null;
  user?: SessionUser;
  token: string | null;
  db?: NodePgDatabase<TSchema>;
  runInTransaction?: <T>(
    callback: (tx: NodePgTransaction<TSchema>) => Promise<T>,
  ) => Promise<T>;
  repo?: Repository;
  kv?: KV;
  messageBus?: unknown;
  // Auth-related properties
  auth?: DotAuth;
  sessionManager?: DotSessionManager;
  rbac?: DotRBACManager;
  [key: string]: unknown;
};

/**
 * Options for customizing RPC initialization.
 */
export type RPCOptions<TSchema extends SchemaInterface> = {
  /**
   * Function to get a session from headers
   */
  getSession?: (headers: Headers) => Promise<DotSession | null>;

  /**
   * Context creator extension function
   */
  extendContext?: (
    baseContext: BaseRPCContext<TSchema>,
    opts: { headers: Headers; session: DotSession | null },
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
};
