import type { Logger, LoggerOptions } from 'pino';
import pino from 'pino';

import type { LogRecord, SeverityKind, SeverityText } from './types.js';
import { LoggingFormatter } from './formatter.js';
import { Severity, SeverityName } from './types.js';

/**
 * Logger configuration options
 */
export type LoggerConfigOptions = {
  /**
   * Enable batch logging mode
   * @default false
   */
  batchLogging?: boolean;

  /**
   * Maximum batch size before auto-flush
   * @default 100
   */
  maxBatchSize?: number;

  /**
   * Auto-flush interval in milliseconds
   * @default 5000
   */
  autoFlushMs?: number;
};

export class Configuration {
  debug?: string[];

  severity: SeverityKind;

  transport: Logger;

  /**
   * Batching configuration
   */
  batchLogging: boolean;
  maxBatchSize: number;
  autoFlushMs: number;

  constructor(options: LoggerConfigOptions = {}) {
    if (process.env['DEBUG']) {
      this.debug = process.env['DEBUG'].split(',');
    }

    // Safely get severity from environment variable
    this.severity = process.env['LOG_LEVEL'] ? this.getSeverityFromString(process.env['LOG_LEVEL']) : Severity.INFO;

    const transportOptions: LoggerOptions = {
      level: 'trace',
      base: null,
      timestamp: false,
    };

    if (process.env['NODE_ENV'] === 'production') {
      const formatter = new LoggingFormatter();
      transportOptions.formatters = {
        log: (obj: Record<string, unknown>) => formatter.log(obj as unknown as LogRecord),
      };
    }

    this.transport = pino(transportOptions);

    // Initialize batching configuration
    this.batchLogging = options.batchLogging ?? false;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.autoFlushMs = options.autoFlushMs ?? 5000;
  }

  getSeverity(name?: string) {
    if (this.debug && name && this.debug.includes(name)) {
      return Severity.DEBUG;
    }

    return this.severity;
  }

  setDebug(debug: string) {
    this.debug = debug.split(',');
  }

  /**
   * Configure batching options
   * @param options - Batching configuration options
   */
  configureBatching(options: Pick<LoggerConfigOptions, 'batchLogging' | 'maxBatchSize' | 'autoFlushMs'>) {
    if (options.batchLogging !== undefined) {
      this.batchLogging = options.batchLogging;
    }

    if (options.maxBatchSize !== undefined) {
      this.maxBatchSize = options.maxBatchSize;
    }

    if (options.autoFlushMs !== undefined) {
      this.autoFlushMs = options.autoFlushMs;
    }
  }

  /**
   * Safely convert a string to a SeverityKind
   * @param levelName - The string severity level
   * @returns The corresponding SeverityKind or Severity.INFO as fallback
   */
  private getSeverityFromString(levelName: string): SeverityKind {
    // Check if the level name is a valid severity
    if (Object.values(SeverityName).includes(levelName as SeverityName)) {
      return Severity[levelName as SeverityText];
    }
    return Severity.INFO;
  }
}

export const configuration = new Configuration();
