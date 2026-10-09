import { debug } from '@arki/log/debug';

/**
 * Debug logger for event store operations
 * Enable with: DEBUG=es:store
 */
export const debugStore = debug('es:store');

/**
 * Debug logger for command flow operations
 * Enable with: DEBUG=es:command
 */
export const debugCommand = debug('es:command');

/**
 * Debug logger for projection operations
 * Enable with: DEBUG=es:projection
 */
export const debugProjection = debug('es:projection');

/**
 * Debug logger for process manager/saga operations
 * Enable with: DEBUG=es:process
 */
export const debugProcess = debug('es:process');

/**
 * Debug logger for builder operations
 * Enable with: DEBUG=es:builder
 */
export const debugBuilder = debug('es:builder');

/**
 * Enable all event sourcing debug logs
 * Enable with: DEBUG=es:*
 */
