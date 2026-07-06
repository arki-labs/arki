/**
 * Logger class for structured logging with severity levels and attributes
 */
import type { Attributes, Body, LogRecord, SeverityKind } from './types.js';
import { LogBatch } from './batch/log-batch.js';
import { configuration } from './config.js';
import { Severity } from './types.js';

// Define the log level methods available on the transport
type LogLevelMethod = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export class Logger {
  private severity: SeverityKind;
  private traceId?: string;
  private spanId?: string;
  private logBatch?: LogBatch;

  /**
   * Creates a new logger instance
   * @param name - Optional name for the logger
   * @param attributes - Optional default attributes to include with all logs
   */
  constructor(
    private readonly name?: string,
    private readonly attributes?: Attributes,
  ) {
    this.severity = configuration.getSeverity(name);

    // Initialize batch logging if enabled globally
    if (configuration.batchLogging) {
      this.enableBatchLogging();
    }
  }

  /**
   * Sets the severity level for this logger
   * @param severity - The severity level to set
   */
  setSeverity(severity: SeverityKind) {
    this.severity = severity;
  }

  /**
   * Sets the trace context for distributed tracing
   * @param traceId - The trace ID
   * @param spanId - Optional span ID
   */
  setTraceContext(traceId: string, spanId?: string): void {
    this.traceId = traceId;
    this.spanId = spanId;
  }

  /**
   * Enables batch logging for this logger instance
   */
  enableBatchLogging(): void {
    if (!this.logBatch) {
      this.logBatch = new LogBatch(configuration.maxBatchSize, configuration.autoFlushMs);
    }
  }

  /**
   * Disables batch logging for this logger instance
   * This will flush any pending log records
   */
  async disableBatchLogging(): Promise<void> {
    if (this.logBatch) {
      await this.logBatch.flush();
      this.logBatch = undefined;
    }
  }

  /**
   * Manually flushes any batched log records
   * No-op if batch logging is not enabled
   */
  async flush(): Promise<void> {
    if (this.logBatch) {
      await this.logBatch.flush();
    }
  }

  /**
   * Creates a new logger with an attribute added to the context
   * @param key - Attribute key
   * @param value - Attribute value
   * @returns A new logger instance with the attribute
   */
  withAttribute(key: string, value: Attributes[string]): Logger {
    const newAttributes = { ...this.attributes, [key]: value };
    const logger = new Logger(this.name, newAttributes);

    // Copy configuration from this logger
    if (this.traceId) {
      logger.setTraceContext(this.traceId, this.spanId);
    }
    logger.setSeverity(this.severity);

    // Copy batch logging setting
    if (this.logBatch) {
      logger.enableBatchLogging();
    }

    return logger;
  }

  /**
   * Logs a message at TRACE level
   * @param body - The message or data to log
   * @param attributes - Optional attributes to include with this log entry
   */
  trace(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.TRACE.number) {
      const record = this.buildRecord(Severity.TRACE, body, attributes);
      this.logWithLevel('trace', record);
    }
  }

  /**
   * Logs a message at DEBUG level
   * @param body - The message or data to log
   * @param attributes - Optional attributes to include with this log entry
   */
  debug(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.DEBUG.number) {
      const record = this.buildRecord(Severity.DEBUG, body, attributes);
      this.logWithLevel('debug', record);
    }
  }

  /**
   * Logs a message at INFO level
   * @param body - The message or data to log
   * @param attributes - Optional attributes to include with this log entry
   */
  info(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.INFO.number) {
      const record = this.buildRecord(Severity.INFO, body, attributes);
      this.logWithLevel('info', record);
    }
  }

  /**
   * Logs a message at WARN level
   * @param body - The message or data to log
   * @param attributes - Optional attributes to include with this log entry
   */
  warn(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.WARN.number) {
      const record = this.buildRecord(Severity.WARN, body, attributes);
      this.logWithLevel('warn', record);
    }
  }

  /**
   * Logs a message at ERROR level
   * @param body - The message or data to log
   * @param attributes - Optional attributes to include with this log entry
   */
  error(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.ERROR.number) {
      const record = this.buildRecord(Severity.ERROR, body, attributes);
      this.logWithLevel('error', record);
    }
  }

  /**
   * Logs a message at FATAL level
   * @param body - The message or data to log
   * @param attributes - Optional attributes to include with this log entry
   */
  fatal(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.FATAL.number) {
      const record = this.buildRecord(Severity.FATAL, body, attributes);
      this.logWithLevel('fatal', record);
    }
  }

  /**
   * Creates a child logger with the given name and optional attributes
   * @param name - Name for the child logger
   * @param attributes - Optional attributes to merge with parent attributes
   * @returns A new child logger instance
   */
  child(name: string, attributes?: Attributes) {
    const childLogger = new Logger(this.getName(name), this.mergeAttributes(attributes));

    // Copy configuration from parent
    if (this.traceId) {
      childLogger.setTraceContext(this.traceId, this.spanId);
    }

    // Copy batch logging setting
    if (this.logBatch) {
      childLogger.enableBatchLogging();
    }

    return childLogger;
  }

  /**
   * Routes a log record to the appropriate destination (batch or direct)
   * @param level - The log level
   * @param record - The log record
   */
  private logWithLevel(level: LogLevelMethod, record: LogRecord): void {
    if (this.logBatch) {
      // For batch logging, we need to add the level to the record for later processing
      const recordWithLevel = { ...record, _level: level };
      this.logBatch.add(recordWithLevel);
    } else {
      // Log directly
      this.logWithErrorHandling(level, record);
    }
  }

  /**
   * Logs a record with error handling
   * @param level - The log level method name
   * @param record - The log record to write
   */
  protected logWithErrorHandling(level: LogLevelMethod, record: LogRecord): void {
    try {
      configuration.transport[level](record);
    } catch (error) {
      console.error(`Failed to log ${level} message:`, error);
    }
  }

  /**
   * Builds a log record with all necessary fields
   * @param severityType - The severity level
   * @param body - The message or data to log
   * @param attributes - Optional attributes to include
   * @returns A complete log record
   */
  protected buildRecord(severityType: SeverityKind, body: Body, attributes?: Attributes): LogRecord {
    return {
      name: this.name,
      body,
      attributes: this.mergeAttributes(attributes),
      severityNumber: severityType.number,
      severityText: severityType.text,
      timestamp: Date.now(),
      traceId: this.traceId,
      spanId: this.spanId,
    };
  }

  /**
   * Builds a fully qualified logger name
   * @param name - Optional name to append
   * @returns The complete logger name
   */
  protected getName(name?: string): string | undefined {
    if (!(this.name || name)) {
      return undefined;
    }

    return [this.name, name].filter(Boolean).join(':');
  }

  /**
   * Merges default attributes with per-log attributes
   * @param attributes - Optional attributes to merge
   * @returns Merged attributes or undefined
   */
  protected mergeAttributes(attributes?: Attributes): Attributes | undefined {
    if (!(this.attributes || attributes)) {
      return undefined;
    }

    return Object.assign({}, this.attributes || {}, attributes || {});
  }
}
