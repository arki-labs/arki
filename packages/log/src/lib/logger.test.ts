import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configuration } from './config.js';
import { Logger } from './logger.js';
import { createLogger } from './rootLogger.js';
import { Severity } from './types.js';

type Line = Record<string, unknown>;

describe('Logger', () => {
  const lines: string[] = [];
  const saved = {
    transport: configuration.transport,
    batchLogging: configuration.batchLogging,
    maxBatchSize: configuration.maxBatchSize,
    autoFlushMs: configuration.autoFlushMs,
    severity: configuration.severity,
    debug: configuration.debug,
  };

  const written = (): Line[] => lines.map(line => JSON.parse(line) as Line);

  beforeEach(() => {
    lines.length = 0;
    configuration.transport = pino(
      { level: 'trace', base: null, timestamp: false },
      {
        write: line => {
          lines.push(line);
        },
      },
    );
    configuration.batchLogging = false;
    configuration.maxBatchSize = 100;
    configuration.autoFlushMs = 5000;
    configuration.severity = Severity.INFO;
    configuration.debug = undefined;
  });

  afterEach(() => {
    configuration.transport = saved.transport;
    configuration.batchLogging = saved.batchLogging;
    configuration.maxBatchSize = saved.maxBatchSize;
    configuration.autoFlushMs = saved.autoFlushMs;
    configuration.severity = saved.severity;
    configuration.debug = saved.debug;
    vi.restoreAllMocks();
  });

  it('drops debug and writes info at the default severity', () => {
    const logger = new Logger('a');
    logger.debug('hidden');
    expect(lines).toHaveLength(0);
    logger.info('hello');
    expect(lines).toHaveLength(1);
    expect(written()[0]?.['body']).toBe('hello');
  });

  it('writes debug after setSeverity(DEBUG)', () => {
    const logger = new Logger('a');
    logger.setSeverity(Severity.DEBUG);
    logger.debug('now visible');
    expect(written()).toHaveLength(1);
    expect(written()[0]?.['severityText']).toBe('DEBUG');
  });

  it('writes name, body, severityText, severityNumber and a numeric timestamp', () => {
    new Logger('a').info('hello');
    const record = written()[0];
    expect(record).toMatchObject({ name: 'a', body: 'hello', severityText: 'INFO', severityNumber: 9 });
    expect(typeof record?.['timestamp']).toBe('number');
  });

  it('merges constructor and call attributes, the call value winning', () => {
    new Logger('a', { x: 1, shared: 'ctor' }).info('m', { y: 2, shared: 'call' });
    expect(written()[0]?.['attributes']).toEqual({ x: 1, y: 2, shared: 'call' });
  });

  it('adds traceId and spanId after setTraceContext', () => {
    const logger = new Logger('a');
    logger.setTraceContext('t1', 's1');
    logger.info('m');
    expect(written()[0]).toMatchObject({ traceId: 't1', spanId: 's1' });
  });

  it('names a child of a named logger "a:b"', () => {
    new Logger('a').child('b').info('m');
    expect(written()[0]?.['name']).toBe('a:b');
  });

  it('names a child of an unnamed logger "b"', () => {
    new Logger().child('b').info('m');
    expect(written()[0]?.['name']).toBe('b');
  });

  it('withAttribute returns a new logger and leaves the original alone', () => {
    const original = new Logger('a');
    const derived = original.withAttribute('k', 'v');
    derived.info('derived');
    original.info('original');
    const [first, second] = written();
    expect(first?.['attributes']).toEqual({ k: 'v' });
    expect(second).not.toHaveProperty('attributes');
  });

  it('createLogger(name) writes records named after the argument', () => {
    createLogger('x').info('m');
    expect(written()[0]?.['name']).toBe('x');
  });

  it('does not throw when the transport throws, and reports once on console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockReturnValue();
    const boom = new Error('boom');
    configuration.transport.info = () => {
      throw boom;
    };
    expect(() => {
      new Logger('a').info('m');
    }).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Failed to log info message:', boom);
  });

  it('holds records back until flush() once batch logging is on', async () => {
    const logger = new Logger('a');
    logger.enableBatchLogging();
    logger.info('held');
    expect(lines).toHaveLength(0);
    await logger.flush();
    expect(written()).toHaveLength(1);
    expect(written()[0]?.['body']).toBe('held');
  });

  it('flushes a batch grouped by level (debug, info, error), not in insertion order', async () => {
    // Pins current behaviour: flush reorders records by level instead of keeping the order they were added.
    const logger = new Logger('a');
    logger.setSeverity(Severity.DEBUG);
    logger.enableBatchLogging();
    logger.error('e');
    logger.info('i');
    logger.debug('d');
    await logger.flush();
    expect(written().map(record => record['body'])).toEqual(['d', 'i', 'e']);
  });
});
