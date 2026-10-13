import { describe, expect, it } from 'vitest';

import type { LogRecord } from './types.js';
import { LoggingFormatter } from './formatter.js';

const base: LogRecord = {
  timestamp: 42,
  severityText: 'INFO',
  severityNumber: 9,
  body: 'text',
};

describe('LoggingFormatter.format', () => {
  it('maps WARN to WARNING', () => {
    expect(LoggingFormatter.format({ ...base, severityText: 'WARN' }).severity).toBe('WARNING');
  });

  it('maps FATAL to EMERGENCY', () => {
    expect(LoggingFormatter.format({ ...base, severityText: 'FATAL' }).severity).toBe('EMERGENCY');
  });

  it('maps TRACE to DEFAULT', () => {
    expect(LoggingFormatter.format({ ...base, severityText: 'TRACE' }).severity).toBe('DEFAULT');
  });

  it('puts a string body in textPayload only', () => {
    const entry = LoggingFormatter.format({ ...base, body: 'hello' });
    expect(entry.textPayload).toBe('hello');
    expect(entry).not.toHaveProperty('jsonPayload');
  });

  it('puts an object body in jsonPayload only', () => {
    const entry = LoggingFormatter.format({ ...base, body: { a: 1 } });
    expect(entry.jsonPayload).toEqual({ a: 1 });
    expect(entry).not.toHaveProperty('textPayload');
  });

  it('puts an Error body in message (message + stack) with serviceContext', () => {
    const error = new Error('kaboom');
    const entry = LoggingFormatter.format({ ...base, body: error });
    expect(entry.message).toBe(`kaboom ${error.stack}`);
    expect(entry).toHaveProperty('serviceContext');
    expect(entry).not.toHaveProperty('textPayload');
    expect(entry).not.toHaveProperty('jsonPayload');
  });

  it('maps name, attributes, traceId and spanId to logName, labels, trace and spanId', () => {
    const entry = LoggingFormatter.format({
      ...base,
      name: 'svc',
      attributes: { k: 'v' },
      traceId: 't1',
      spanId: 's1',
    });
    expect(entry).toMatchObject({ logName: 'svc', labels: { k: 'v' }, trace: 't1', spanId: 's1', timestamp: 42 });
  });
});
