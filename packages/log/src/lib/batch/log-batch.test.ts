import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogRecord } from '../types.js';
import { configuration } from '../config.js';
import { Severity } from '../types.js';
import { LogBatch } from './log-batch.js';

type Line = Record<string, unknown>;

const makeRecord = (body: string, level?: string): LogRecord => ({
  timestamp: 1,
  severityText: Severity.INFO.text,
  severityNumber: Severity.INFO.number,
  body,
  ...(level === undefined ? {} : { _level: level }),
});

describe('LogBatch', () => {
  const lines: string[] = [];
  const savedTransport = configuration.transport;

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
  });

  afterEach(() => {
    configuration.transport = savedTransport;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects a record without _level: nothing written, console.error once', () => {
    const errorSpy = vi.spyOn(console, 'error').mockReturnValue();
    const batch = new LogBatch(100, 0);
    batch.add(makeRecord('no level'));
    expect(lines).toHaveLength(0);
    expect(batch.count).toBe(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('LogBatch: record is missing _level property');
  });

  it('flushes when the batch reaches maxBatchSize', () => {
    const batch = new LogBatch(2, 0);
    batch.add(makeRecord('one', 'info'));
    expect(lines).toHaveLength(0);
    batch.add(makeRecord('two', 'info'));
    expect(written().map(record => record['body'])).toEqual(['one', 'two']);
    expect(batch.count).toBe(0);
  });

  it('flushes after autoFlushMs when the size limit is not reached', () => {
    vi.useFakeTimers();
    const batch = new LogBatch(100, 5000);
    batch.add(makeRecord('timed', 'info'));
    expect(lines).toHaveLength(0);
    vi.advanceTimersByTime(4999);
    expect(lines).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(written().map(record => record['body'])).toEqual(['timed']);
  });

  it('flush() on an empty batch resolves and writes nothing', async () => {
    const batch = new LogBatch(100, 0);
    await expect(batch.flush()).resolves.toBeUndefined();
    expect(lines).toHaveLength(0);
  });

  it('strips _level from the written records', async () => {
    const batch = new LogBatch(100, 0);
    batch.add(makeRecord('clean', 'warn'));
    await batch.flush();
    const [record] = written();
    expect(record).toMatchObject({ body: 'clean', severityText: 'INFO' });
    expect(record).not.toHaveProperty('_level');
  });
});
