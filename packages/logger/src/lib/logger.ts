import type { Attributes, Body, LogRecord, SeverityKind } from './types';
import { configuration } from './config';
import { Severity } from './types';

export class Logger {
  private severity: SeverityKind;

  constructor(
    private readonly name?: string,
    private readonly attributes?: Attributes,
  ) {
    this.severity = configuration.getSeverity(name);
  }

  setSeverity(severity: SeverityKind) {
    this.severity = severity;
  }

  trace(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.TRACE.number) {
      configuration.transport.trace(this.buildRecord(Severity.TRACE, body, attributes));
    }
  }

  debug(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.DEBUG.number) {
      configuration.transport.debug(this.buildRecord(Severity.DEBUG, body, attributes));
    }
  }

  info(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.INFO.number) {
      configuration.transport.info(this.buildRecord(Severity.INFO, body, attributes));
    }
  }

  warn(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.WARN.number) {
      configuration.transport.warn(this.buildRecord(Severity.WARN, body, attributes));
    }
  }

  error(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.ERROR.number) {
      configuration.transport.error(this.buildRecord(Severity.ERROR, body, attributes));
    }
  }

  fatal(body: Body, attributes?: Attributes): void {
    if (this.severity.number <= Severity.FATAL.number) {
      configuration.transport.fatal(this.buildRecord(Severity.FATAL, body, attributes));
    }
  }

  child(name: string, attributes?: Attributes) {
    return new Logger(this.getName(name), this.mergeAttributes(attributes));
  }

  protected buildRecord(severityType: SeverityKind, body: Body, attributes?: Attributes): LogRecord {
    return {
      name: this.name,
      body,
      attributes: this.mergeAttributes(attributes),
      severityNumber: severityType.number,
      severityText: severityType.text,
      timestamp: Date.now(),
    };
  }

  protected getName(name?: string): string | undefined {
    if (!(this.name || name)) {
      return undefined;
    }

    return [this.name, name].filter(Boolean).join(':');
  }

  protected mergeAttributes(attributes?: Attributes): Attributes | undefined {
    if (!(this.attributes || attributes)) {
      return undefined;
    }

    return Object.assign({}, this.attributes || {}, attributes || {});
  }
}
