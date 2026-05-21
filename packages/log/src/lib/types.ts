export type AttributeValue =
  | string
  | number
  | boolean
  | (null | undefined | string)[]
  | (null | undefined | number)[]
  | (null | undefined | boolean)[];

export type Attributes = Record<string, AttributeValue | undefined>;

export type StructuredBody = Record<string, unknown>;
export type Body = string | Error | StructuredBody;

export type SeverityNumber = number;

export enum SeverityName {
  TRACE = 'TRACE',
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FATAL = 'FATAL',
}

export type SeverityText = keyof typeof SeverityName;

export type SeverityKind = {
  text: SeverityText;
  number: SeverityNumber;
};

export class Severity {
  static TRACE: SeverityKind = {
    text: SeverityName.TRACE,
    number: 1,
  };

  static DEBUG: SeverityKind = {
    text: SeverityName.DEBUG,
    number: 5,
  };

  static INFO: SeverityKind = {
    text: SeverityName.INFO,
    number: 9,
  };

  static WARN: SeverityKind = {
    text: SeverityName.WARN,
    number: 13,
  };

  static ERROR: SeverityKind = {
    text: SeverityName.ERROR,
    number: 17,
  };

  static FATAL: SeverityKind = {
    text: SeverityName.FATAL,
    number: 21,
  };
}

export type LogRecord = {
  timestamp: number;
  traceId?: string;
  spanId?: string;
  severityText: SeverityText;
  severityNumber: SeverityNumber;
  name?: string;
  body: Body;
  attributes?: Attributes;
  resource?: any;

  /**
   * @internal
   * Used internally for batch processing
   */
  _level?: string;
};
