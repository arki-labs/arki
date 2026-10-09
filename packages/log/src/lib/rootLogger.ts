import type { Attributes } from './types.js';
import { Logger } from './logger.js';

/**
 * Singleton root logger instance
 *
 * This is the main entry point for logging when a specific named logger
 * isn't needed. It provides a shared logger instance across the application.
 *
 * Example:
 * ```
 * import { rootLogger } from '@your-org/logger';
 *
 * rootLogger.info('Application started');
 * ```
 */
export const rootLogger = new Logger();

/**
 * Creates a named child logger from the root logger
 *
 * This is a convenience function to create child loggers from the root logger.
 *
 * Example:
 * ```
 * import { createLogger } from '@your-org/logger';
 *
 * const userLogger = createLogger('user-service');
 * userLogger.info('User service initialized');
 * ```
 *
 * @param name - Name of the logger
 * @param attributes - Optional default attributes
 * @returns A new child logger
 */
export function createLogger(name: string, attributes?: Attributes) {
  return rootLogger.child(name, attributes);
}
