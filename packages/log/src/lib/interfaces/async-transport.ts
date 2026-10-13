import type { LogRecord } from '../types.js';

/**
 * Interface for asynchronous log transports
 *
 * Implementations of this interface can be used to send logs
 * asynchronously to external systems, databases, or services.
 */
export type AsyncTransport = {
  /**
   * Logs a message at TRACE level
   * @param record - The log record to write
   */
  trace(record: LogRecord): Promise<void>;

  /**
   * Logs a message at DEBUG level
   * @param record - The log record to write
   */
  debug(record: LogRecord): Promise<void>;

  /**
   * Logs a message at INFO level
   * @param record - The log record to write
   */
  info(record: LogRecord): Promise<void>;

  /**
   * Logs a message at WARN level
   * @param record - The log record to write
   */
  warn(record: LogRecord): Promise<void>;

  /**
   * Logs a message at ERROR level
   * @param record - The log record to write
   */
  error(record: LogRecord): Promise<void>;

  /**
   * Logs a message at FATAL level
   * @param record - The log record to write
   */
  fatal(record: LogRecord): Promise<void>;
};
