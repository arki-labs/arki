import { createDebugLogger } from '@arki/log/debug';

/**
 * Debug logger for database initialization and connection operations
 * Enable with: DEBUG=db:init
 */
export const debugInit = createDebugLogger('db:init');

/**
 * Debug logger for database factory operations
 * Enable with: DEBUG=db:factory
 */
export const debugFactory = createDebugLogger('db:factory');

/**
 * Debug logger for projection builder operations
 * Enable with: DEBUG=db:projection
 */
export const debugProjection = createDebugLogger('db:projection');

/**
 * Enable all database debug logs
 * Enable with: DEBUG=db:*
 */
