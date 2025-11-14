/**
 * Standard middleware for @arki/queue
 *
 * These middleware provide common functionality like error handling,
 * logging, timing, and validation that can be composed with jobs.
 */

// Error handling
export { errorHandlingMiddleware, errorHandlingMiddlewareWithFormatter, JobError } from './error-handling.ts';

// Logging
export {
  ConsoleLogger,
  customLoggingMiddleware,
  loggingMiddleware,
  observabilityMiddleware,
  structuredLoggingMiddleware,
} from './logging.ts';
export type { LogEntry, Logger, LogLevel } from './logging.ts';

// Timing
export {
  devTimingMiddleware,
  PerformanceTracker,
  performanceMiddleware,
  timeoutMiddleware,
  timingMiddleware,
} from './timing.ts';

// Validation
export {
  customValidationMiddleware,
  JobValidationError,
  outputValidationMiddleware,
  validationMiddleware,
} from './validation.ts';
