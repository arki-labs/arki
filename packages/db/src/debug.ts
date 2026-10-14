import { getLogger } from '@arki/log';

/**
 * Debug logger for database initialization and connection operations
 * Enable with: DEBUG=db:init
 */
export const debugInit = getLogger('db:init');

/**
 * Debug logger for database factory operations
 * Enable with: DEBUG=db:factory
 */
export const debugFactory = getLogger('db:factory');

/**
 * Debug logger for projection builder operations
 * Enable with: DEBUG=db:projection
 */
export const debugProjection = getLogger('db:projection');

/**
 * Enable all database debug logs
 * Enable with: DEBUG=db:*
 */
