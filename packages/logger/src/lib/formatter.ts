import type { LogRecord, SeverityText } from './types.js';
import { SeverityName } from './types.js';

const serviceContext = {
  service: process.env['SERVICE_NAME'] || process.env['SERVICE_CONTEXT_NAME'] || process.env['HOSTNAME'],
  version: process.env['SERVICE_CONTEXT_VERSION'],
};

const convertSeverity = (severity: SeverityText) => {
  switch (severity) {
    case SeverityName.TRACE: {
      return 'DEFAULT';
    }
    case SeverityName.DEBUG: {
      return 'DEBUG';
    }
    case SeverityName.INFO: {
      return 'INFO';
    }
    case SeverityName.WARN: {
      return 'WARNING';
    }
    case SeverityName.ERROR: {
      return 'ERROR';
    }
    case SeverityName.FATAL: {
      return 'EMERGENCY';
    }
    default: {
      return 'DEFAULT';
    }
  }
};

export class LoggingFormatter {
  log(object: LogRecord) {
    return LoggingFormatter.format(object);
  }

  static format(record: LogRecord) {
    const entry: any = {
      severity: convertSeverity(record.severityText),
      logName: record.name,
      resource: record.resource,
      timestamp: record.timestamp,
      labels: record.attributes,
      trace: record.traceId,
      spanId: record.spanId,
    };

    if (typeof record.body === 'string') {
      entry.textPayload = record.body;
    } else if (record.body instanceof Error) {
      entry.message = record.body.message ? `${record.body.message} ${record.body.stack}` : record.body.stack;

      entry.serviceContext = serviceContext;
    } else {
      entry.jsonPayload = record.body;
    }

    return entry;
  }
}
