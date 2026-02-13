import type { EventStore, MessageBus } from '@event-driven-io/emmett';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { KV } from '@arki/kv';

import type { DotSession, DotAuth, DotSessionManager, DotRBACManager } from '../auth';
import type { BaseTRPCContext, SessionUser, SchemaInterface } from '../types';

/**
 * Standard Dot context interface that all plugins can depend on.
 * Apps can extend this, but must implement at least these fields.
 *
 * This interface provides a portable contract for plugins - they only need
 * to import from @arki/dot, not from app-specific code.
 */
export type DotContext<TSchema extends SchemaInterface = SchemaInterface> = {
  // Auth - session information
  session: DotSession | null;
  user?: SessionUser;
  token: string | null;

  // Core services (optional - plugins request these)
  db?: NodePgDatabase<TSchema>;
  kv?: KV;
  eventStore?: EventStore;
  messageBus?: MessageBus;

  // Utilities
  responseHeaders?: Headers;
  runInTransaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;

  // Repositories - plugins add their own here
  repo?: Record<string, any>;

  // Auth-related services
  auth?: DotAuth;
  sessionManager?: DotSessionManager;
  rbac?: DotRBACManager;
} & BaseTRPCContext<TSchema>

/**
 * NOTE: TRPCKit and TRPCKitWithT are now inferred from createDotProcedures()
 * and exported from ./init.ts to preserve full type information without 'any'.
 * These interfaces are kept for documentation purposes only.
 */

/**
 * Context available to plugins during setup.
 * Plugins receive this during initialization and can use it
 * to set up their routers and other components.
 *
 * Note: procedures type is inferred from createDotProcedures() at runtime,
 * preserving full type information for plugin router factories.
 */
export type PluginSetupContext<TSchema extends SchemaInterface = SchemaInterface> = {
  /** tRPC procedures for building routers (type inferred at runtime) */
  procedures: any;

  /** Database instance (if configured) */
  db?: NodePgDatabase<TSchema>;

  /** Key-value store instance (if configured) */
  kv?: KV;

  /** Event store instance (if configured) */
  eventStore?: EventStore;

  /** Message bus instance (if configured) */
  messageBus?: MessageBus;
}

/**
 * Configuration for custom middleware injection.
 * Apps can provide custom middleware to extend the default behavior.
 *
 * Note: All middleware properties use flexible typing to allow TypeScript
 * to properly infer types from the actual middleware provided. The middleware
 * must be compatible with tRPC's middleware builder API.
 */
export type DotTRPCMiddlewareConfig<
  TBeforeAuth = never,
  TAfterAuth = never,
  TErrorHandling = never,
  TTiming = never,
> = {
  /** Middleware to run before authentication check */
  beforeAuth?: TBeforeAuth;

  /** Middleware to run after authentication check (on protected procedures) */
  afterAuth?: TAfterAuth;

  /** Custom error handling middleware (replaces default) */
  errorHandling?: TErrorHandling;

  /** Custom timing middleware (replaces default) */
  timing?: TTiming;
}

/**
 * Options for creating Dot procedures.
 */
export type CreateDotProceduresOptions<
  TBeforeAuth = never,
  TAfterAuth = never,
  TErrorHandling = never,
  TTiming = never,
> = {
  /** Custom middleware configuration */
  customMiddleware?: DotTRPCMiddlewareConfig<TBeforeAuth, TAfterAuth, TErrorHandling, TTiming>;

  /** Environment configuration for conditional behavior */
  env?: Record<string, unknown>;

  /** Whether to include development features (artificial delays, verbose logging) */
  isDevelopment?: boolean;
}
