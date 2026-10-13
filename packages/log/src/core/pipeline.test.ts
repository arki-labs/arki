import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger, Logging } from './logging.js';
import type { LogConfig, LogRecord, Processor, Sink } from './types.js';
import { logfmt, pretty } from './formatters.js';
import { createLogging } from './logging.js';
import { dropWhen, enrich, redact } from './processors.js';
import { consoleSink, lineSink, memorySink } from './sinks.js';
import { buffer, deduplicate, fingersCrossed } from './wrappers.js';

function setup<C extends string>(config: LogConfig<C>, category = 'test'): { logging: Logging; log: Logger } {
  const logging = createLogging();
  logging.configure(config);
  return { logging, log: logging.getLogger(category) };
}

function lines(): { lines: string[]; sink: Sink } {
  const out: string[] = [];
  return { lines: out, sink: lineSink(line => out.push(line)) };
}

const templates = (records: readonly LogRecord[]): string[] => records.map(record => record.template);

const failingRedactor: Processor = () => {
  throw new Error('bad path');
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('failures inside logging', () => {
  it('a throwing sink never reaches the caller, and the other sinks still write', () => {
    const errorSpy = vi.spyOn(console, 'error').mockReturnValue();
    const good = memorySink();
    const broken: Sink = {
      write: () => {
        throw new Error('disk full');
      },
    };
    const { log } = setup({ channels: { broken, good }, default: { level: 'info', channels: ['broken', 'good'] } });
    expect(() => {
      log.info('one');
      log.info('two');
    }).not.toThrow();
    expect(templates(good.records)).toEqual(['one', 'two']);
    expect(errorSpy).toHaveBeenCalledTimes(1); // reported once per sink, not per record
  });

  it('a throwing processor drops the record instead of writing it unprocessed', () => {
    vi.spyOn(console, 'error').mockReturnValue();
    const out = memorySink();
    const { log } = setup({
      channels: { out },
      default: { level: 'info', channels: ['out'] },
      processors: [failingRedactor],
    });
    expect(() => log.info('secret {password}', { password: 'hunter2' })).not.toThrow();
    expect(out.records).toHaveLength(0);
  });

  it('a sink failing inside a buffer timer does not become an uncaught exception', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockReturnValue();
    const broken: Sink = {
      write: () => {
        throw new Error('network down');
      },
    };
    const { log } = setup({
      channels: { remote: buffer(broken, { flushIntervalMs: 10 }) },
      default: { level: 'info', channels: ['remote'] },
    });
    log.info('queued');
    expect(() => vi.advanceTimersByTime(20)).not.toThrow();
  });
});

describe('redact', () => {
  it('keeps a redacted value out of json() output and out of message()', () => {
    const out = lines();
    const memory = memorySink();
    const { log } = setup({
      channels: { out: out.sink, memory },
      default: { level: 'info', channels: ['out', 'memory'] },
      processors: [redact(['password', 'headers.authorization', '*.token'])],
    });
    log.info('login {user} with {password}', {
      user: 'ada',
      password: 'hunter2',
      headers: { authorization: 'Bearer s3cret', accept: 'json' },
      session: { token: 'tok-1', id: 7 },
    });
    expect(out.lines[0]).not.toMatch(/hunter2|s3cret|tok-1/);
    expect(memory.records[0]?.message()).toBe('login ada with [REDACTED]');
    expect(JSON.parse(out.lines[0] ?? '')).toMatchObject({
      fields: { headers: { authorization: '[REDACTED]', accept: 'json' }, session: { token: '[REDACTED]', id: 7 } },
    });
  });

  it('redacts inside the serialised error and supports a censor function', () => {
    const out = lines();
    const { log } = setup({
      channels: { out: out.sink },
      default: { level: 'info', channels: ['out'] },
      processors: [
        redact(['apiKey'], { censor: (value, path) => `${path}:${typeof value === 'string' ? value.length : -1}` }),
      ],
    });
    log.error('call failed', { error: Object.assign(new Error('upstream'), { apiKey: 'key-123456' }), apiKey: 'abc' });
    expect(out.lines[0]).not.toContain('key-123456');
    const parsed = JSON.parse(out.lines[0] ?? '') as { fields: unknown; error: unknown };
    expect(parsed.fields).toEqual({ apiKey: 'apiKey:3' });
    expect(parsed.error).toMatchObject({ message: 'upstream', apiKey: 'apiKey:10' });
  });

  it('returns the same record when no path matches', () => {
    const processor = redact(['password']);
    const memory = memorySink();
    const { log } = setup({ channels: { memory }, default: { level: 'info', channels: ['memory'] } });
    log.info('plain', { user: 'ada' });
    const record = memory.records[0];
    expect(record && processor(record)).toBe(record);
  });
});

describe('enrich and dropWhen', () => {
  it('enrich adds fields but never overwrites a call field', () => {
    const memory = memorySink();
    const { log } = setup({
      channels: { memory },
      default: { level: 'info', channels: ['memory'] },
      processors: [enrich(() => ({ host: 'enriched', region: 'eu' }))],
    });
    log.info('m', { host: 'call' });
    expect(memory.records[0]?.fields).toEqual({ host: 'call', region: 'eu' });
  });

  it('dropWhen drops matching records; sink processors run only for that sink', () => {
    const kept = memorySink();
    const filtered: Sink = { ...memorySink(), processors: [dropWhen(record => record.category === 'noisy')] };
    const filteredRecords = memorySink();
    filtered.write = record => filteredRecords.write(record);
    const logging = createLogging();
    logging.configure({ channels: { kept, filtered }, default: { level: 'info', channels: ['kept', 'filtered'] } });
    logging.getLogger('noisy').info('n');
    logging.getLogger('calm').info('c');
    expect(templates(kept.records)).toEqual(['n', 'c']);
    expect(templates(filteredRecords.records)).toEqual(['c']);
  });
});

describe('formatters', () => {
  it('json() writes template and rendered message, fields, error, trace and resource', () => {
    const out = lines();
    const { log } = setup({
      channels: { out: out.sink },
      default: { level: 'info', channels: ['out'] },
      resource: { 'service.name': 'checkout' },
    });
    log
      .withTrace({ traceId: 't', spanId: 's' })
      .warn('paid {amount} for "{item}"\n', { amount: 5, item: 'tea', big: 2n });
    expect(JSON.parse(out.lines[0] ?? '')).toMatchObject({
      level: 13,
      levelName: 'warn',
      category: 'test',
      template: 'paid {amount} for "{item}"\n',
      message: 'paid 5 for "tea"\n',
      fields: { amount: 5, item: 'tea', big: '2' },
      traceId: 't',
      spanId: 's',
      resource: { 'service.name': 'checkout' },
    });
  });

  it('json() writes bound fields from the cache and lets the later layer win', () => {
    const out = lines();
    const { log } = setup({ channels: { out: out.sink }, default: { level: 'info', channels: ['out'] } });
    const bound = log.with({ requestId: 'r1', who: 'bound' });
    bound.info('a', { who: 'call' });
    bound.info('b');
    expect(JSON.parse(out.lines[0] ?? '')).toMatchObject({ fields: { requestId: 'r1', who: 'call' } });
    expect(JSON.parse(out.lines[1] ?? '')).toMatchObject({ fields: { requestId: 'r1', who: 'bound' } });
    // A shared key is written once: strict JSON readers reject duplicate keys.
    expect(out.lines[0]?.match(/"who":/g)).toHaveLength(1);
  });

  it('pretty() highlights placeholders, lists unused fields and prints the error', () => {
    const out: string[] = [];
    const { log } = setup({
      channels: { out: lineSink(line => out.push(line), { format: pretty({ colors: true }) }) },
      default: { level: 'info', channels: ['out'] },
    });
    log.error('user {id} failed', { id: 7, extra: 'x y', error: new Error('boom', { cause: new Error('root') }) });
    const line = out[0] ?? '';
    expect(line).toContain('\u001B[36m7\u001B[0m');
    expect(line).toContain('extra=');
    expect(line).toContain('"x y"');
    expect(line).toContain('Error: boom');
    expect(line).toContain('caused by: Error: root');
  });

  it('logfmt() writes key=value pairs and quotes values with spaces', () => {
    const out: string[] = [];
    const { log } = setup({
      channels: { out: lineSink(line => out.push(line), { format: logfmt() }) },
      default: { level: 'info', channels: ['out'] },
    });
    log.info('hello {name}', { name: 'Ada Lovelace', n: 1 });
    expect(out[0]).toMatch(/^time=\S+ level=info category=test msg="hello Ada Lovelace" name="Ada Lovelace" n=1$/);
  });
});

describe('consoleSink', () => {
  it('passes the fields object to console so devtools can expand it, or one formatted line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* silence */
    });
    const { log } = setup({
      channels: { objects: consoleSink(), text: consoleSink({ format: logfmt() }) },
      default: { level: 'info', channels: ['objects', 'text'] },
    });
    log.warn('slow {ms}', { ms: 900 });
    expect(warn).toHaveBeenNthCalledWith(1, 'WARN [test] slow 900', { ms: 900 });
    expect(warn.mock.calls[1]?.[0]).toMatch(/level=warn/);
  });
});

describe('fingersCrossed', () => {
  it('writes nothing without a trigger, then the ring in order plus the trigger, then passes records through', () => {
    const inner = memorySink();
    const { log } = setup({
      channels: { fc: fingersCrossed(inner, { scope: 'global', maxRecords: 2 }) },
      default: { level: 'warn', channels: ['fc'] },
    });
    log.debug('d1');
    log.info('i1');
    log.info('i2');
    expect(inner.records).toHaveLength(0);
    log.error('boom');
    expect(templates(inner.records)).toEqual(['i1', 'i2', 'boom']);
    log.debug('after');
    expect(templates(inner.records)).toEqual(['i1', 'i2', 'boom', 'after']);
  });

  it('keeps a separate ring per withContext scope', () => {
    const inner = memorySink();
    const { logging, log } = setup({
      channels: { fc: fingersCrossed(inner) },
      default: { level: 'info', channels: ['fc'] },
    });
    logging.withContext({ requestId: 'a' }, () => log.debug('a-debug'));
    logging.withContext({ requestId: 'b' }, () => {
      log.debug('b-debug');
      log.error('b-error');
    });
    expect(templates(inner.records)).toEqual(['b-debug', 'b-error']);
  });

  it('captureFrom lets debug reach the wrapper only, never lowering another sink', () => {
    const inner = memorySink();
    const plain = memorySink();
    const { log } = setup({
      channels: { fc: fingersCrossed(inner, { scope: 'global' }), plain },
      default: { level: 'info', channels: ['fc', 'plain'] },
    });
    log.debug('captured');
    log.error('trigger');
    expect(templates(inner.records)).toEqual(['captured', 'trigger']);
    expect(templates(plain.records)).toEqual(['trigger']);
  });
});

describe('buffer', () => {
  it('writes in order on the interval and on flush', () => {
    vi.useFakeTimers();
    const inner = memorySink();
    const buffered = buffer(inner, { flushIntervalMs: 100 });
    const { log } = setup({ channels: { buffered }, default: { level: 'info', channels: ['buffered'] } });
    log.info('1');
    log.info('2');
    expect(inner.records).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(templates(inner.records)).toEqual(['1', '2']);
    log.info('3');
    void buffered.flush?.();
    expect(templates(inner.records)).toEqual(['1', '2', '3']);
  });

  it('applies its overflow rule when full', () => {
    const oldest = memorySink();
    const newest = memorySink();
    const dropOldest = buffer(oldest, { maxRecords: 2, overflow: 'drop-oldest' });
    const dropNewest = buffer(newest, { maxRecords: 2, overflow: 'drop-newest' });
    const { log } = setup({
      channels: { dropOldest, dropNewest },
      default: { level: 'info', channels: ['dropOldest', 'dropNewest'] },
    });
    for (const name of ['a', 'b', 'c']) log.info(name);
    void dropOldest.flush?.();
    void dropNewest.flush?.();
    expect(templates(oldest.records)).toEqual(['b', 'c']);
    expect(templates(newest.records)).toEqual(['a', 'b']);
  });
});

describe('deduplicate', () => {
  it('writes a record once per window, then a record with the suppressed count', () => {
    vi.useFakeTimers();
    const inner = memorySink();
    const { log } = setup({
      channels: { dedup: deduplicate(inner, { windowMs: 1000 }) },
      default: { level: 'info', channels: ['dedup'] },
    });
    log.warn('disk almost full');
    log.warn('disk almost full');
    log.warn('disk almost full');
    log.warn('other');
    expect(templates(inner.records)).toEqual(['disk almost full', 'other']);
    vi.advanceTimersByTime(1000);
    const summary = inner.records[2];
    expect(summary?.fields).toMatchObject({ suppressed: 2, original: 'disk almost full' });
    expect(summary?.message()).toBe('2 duplicate records suppressed: disk almost full');
    log.warn('disk almost full');
    expect(inner.records).toHaveLength(4);
  });
});

describe('sink level', () => {
  it('a wrapped sink keeps its own level floor', () => {
    const errorsOnly: Sink = { ...memorySink(), level: 'error' };
    const seen = memorySink();
    errorsOnly.write = record => seen.write(record);
    const passThrough: Processor = record => record;
    const { log } = setup({
      channels: { fc: fingersCrossed(errorsOnly, { scope: 'global' }) },
      default: { level: 'info', channels: ['fc'] },
      processors: [passThrough],
    });
    log.info('held');
    log.error('trigger');
    expect(templates(seen.records)).toEqual(['trigger']);
  });
});
