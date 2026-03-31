import type { EventStore, MessageBus } from '@event-driven-io/emmett';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { KV } from '@arki/kv';

import type { DotSession, DotAuth, DotSessionManager, DotRBACManager, DotUser } from '../auth';
import type { SchemaInterface } from '../types';

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
  user?: DotUser;
  token: string | null;

  // Core services (optional - plugins request these)
  db?: NodePgDatabase<TSchema>;
  kv?: KV;
  eventStore?: EventStore;
  messageBus?: MessageBus;

  // Utilities
  responseHeaders?: Headers;
  runInTransaction?: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;

  // Repositories - plugins add their own here
  repo?: Record<string, unknown>;

  // Auth-related services
  auth?: DotAuth;
  sessionManager?: DotSessionManager;
  rbac?: DotRBACManager;
}


/**
 * Configuration for custom middleware injection.
 * Apps can provide custom middleware to extend the default behavior.
 */
export type DotMiddlewareConfig<
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
  customMiddleware?: DotMiddlewareConfig<TBeforeAuth, TAfterAuth, TErrorHandling, TTiming>;

  /** Environment configuration for conditional behavior */
  env?: Record<string, unknown>;

  /** Whether to include development features (artificial delays, verbose logging) */
  isDevelopment?: boolean;
}
