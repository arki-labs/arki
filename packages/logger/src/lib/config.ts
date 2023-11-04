import type { Logger, LoggerOptions } from 'pino';
import pino from 'pino';

import { LoggingFormatter } from './formatter';
import type { SeverityKind } from './types';
import { Severity } from './types';

export class Configuration {
  debug?: string[];

  severity: SeverityKind;

  transport: Logger;

  constructor() {
    if (process.env.DEBUG) {
      this.debug = process.env.DEBUG.split(',');
    }

    this.severity = process.env.LOG_LEVEL ? Severity[process.env.LOG_LEVEL] || Severity.INFO : Severity.INFO;

    const transportOptions: LoggerOptions = {
      level: 'trace',
      base: null,
      timestamp: false,
    };

    if (process.env.NODE_ENV === 'production') {
      transportOptions.formatters = new LoggingFormatter();
    }

    this.transport = pino(transportOptions);
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
}

export const configuration = new Configuration();
