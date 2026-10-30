import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { Logger, Logging } from './logging.js';
import type { LogRecord, Sink } from './types.js';
import { DEFAULT_KEY, defaultLogging, getLogger } from './default.js';
import { LOG_ERROR_CODES, LogError } from './errors.js';
import { createInternalLogging, createLogging } from './logging.js';
import { memorySink } from './sinks.js';

function capture(extra: Partial<Sink> = {}): { records: LogRecord[]; sink: Sink } {
  const records: LogRecord[] = [];
  return { records, sink: { ...extra, write: record => records.push(record) } };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LogError ? error.code : `not a LogError: ${String(error)}`;
  }
  return undefined;
}

/** A setup that sends everything at `info` and up to `sink`. */
function outConfig(sink: Sink) {
  return { channels: { out: sink }, default: { level: 'info', channels: ['out'] } } as const;
}

describe('late binding', () => {
  it('a logger created before configure() obeys the level and channels set later, then the reconfigured ones', async () => {
    const logging = createLogging();
    const log = logging.getLogger('app:db');
    const a = capture();
    const b = capture();

    const handle = logging.configure({
      channels: { a: a.sink, b: b.sink },
      default: { level: 'info', channels: ['a'] },
    });
    log.debug('hidden');
    log.info('first');
    expect(a.records.map(record => record.template)).toEqual(['first']);
    expect(b.records).toHaveLength(0);

    await handle.reconfigure({ channels: { a: a.sink, b: b.sink }, default: { level: 'debug', channels: ['b'] } });
    log.debug('second');
    expect(a.records.map(record => record.template)).toEqual(['first']);
    expect(b.records.map(record => record.template)).toEqual(['second']);
  });

  it('reconfigure() drains and closes old sinks that the new config does not reuse', async () => {
    const logging = createLogging();
    const events: string[] = [];
    const old: Sink = {
      write: () => {
        /* discard */
      },
      flush: () => void events.push('flush'),
      close: () => void events.push('close'),
    };
    const kept: Sink = {
      write: () => {
        /* discard */
      },
      close: () => void events.push('kept closed'),
    };
    const handle = logging.configure({ channels: { old, kept }, default: { level: 'info', channels: ['old'] } });
    await handle.reconfigure({ channels: { kept }, default: { level: 'info', channels: ['kept'] } });
    expect(events).toEqual(['flush', 'close']);
  });
});

describe('category rules', () => {
  it('uses the nearest configured ancestor, and a rule replaces rather than adds', () => {
    const logging = createLogging();
    const root = capture();
    const kv = capture();
    logging.configure({
      channels: { root: root.sink, kv: kv.sink },
      default: { level: 'warn', channels: ['root'] },
      categories: { 'arki:kv': { level: 'debug', channels: ['kv'] } },
    });
    logging.getLogger('arki:kv:redis').debug('deep');
    logging.getLogger('arki:other').info('dropped by root warn');
    logging.getLogger('arki:other').warn('to root');
    expect(kv.records.map(record => record.template)).toEqual(['deep']);
    expect(root.records.map(record => record.template)).toEqual(['to root']);
  });

  it('inherit: false starts from no channels; a level-only rule keeps the parent channels', () => {
    const logging = createLogging();
    const root = capture();
    logging.configure({
      channels: { root: root.sink },
      default: { level: 'info', channels: ['root'] },
      categories: { quiet: { inherit: false }, loud: { level: 'debug' } },
    });
    logging.getLogger('quiet:child').error('nowhere');
    logging.getLogger('loud:child').debug('to root');
    expect(root.records.map(record => record.template)).toEqual(['to root']);
  });

  it('never delivers a record twice, even when two channels share a sink', () => {
    const logging = createLogging();
    const shared = capture();
    logging.configure({
      channels: { one: shared.sink, two: shared.sink },
      default: { level: 'info', channels: ['one', 'two'] },
      categories: { a: { channels: ['one', 'two'] } },
    });
    logging.getLogger('a:b').info('once');
    expect(shared.records).toHaveLength(1);
  });

  it('applies a sink level as a floor on top of the category level', () => {
    const logging = createLogging();
    const all = capture();
    const errors = capture({ level: 'error' });
    logging.configure({
      channels: { all: all.sink, errors: errors.sink },
      default: { level: 'info', channels: ['all', 'errors'] },
    });
    const log = logging.getLogger('x');
    log.info('info');
    log.error('error');
    expect(all.records).toHaveLength(2);
    expect(errors.records.map(record => record.template)).toEqual(['error']);
  });
});

describe('fields', () => {
  it('layers shared < bound < scoped < call, later wins', () => {
    const logging = createLogging();
    const out = capture();
    logging.configure({ channels: { out: out.sink }, default: { level: 'info', channels: ['out'] } });
    logging.shareContext({ a: 'shared', b: 'shared', c: 'shared', d: 'shared' });
    const log = logging.getLogger('x').with({ b: 'bound', c: 'bound', d: 'bound' });
    logging.withContext({ c: 'scoped', d: 'scoped' }, () => log.info('m', { d: 'call' }));
    expect(out.records[0]?.fields).toEqual({ a: 'shared', b: 'bound', c: 'scoped', d: 'call' });
  });

  it('with() is immutable and bound fields satisfy placeholders', () => {
    const logging = createLogging();
    const out = capture();
    logging.configure({ channels: { out: out.sink }, default: { level: 'info', channels: ['out'] } });
    const base = logging.getLogger('x');
    const order = base.with({ orderId: 'ord_1' });
    order.info('charged {orderId}', { amount: 42 });
    base.info('plain');
    expect(out.records[0]?.message()).toBe('charged ord_1');
    expect(out.records[1]?.fields).toEqual({});
  });

  it('turns an Error under error, err or cause into record.error and accepts log.error(err)', () => {
    const logging = createLogging();
    const out = capture();
    logging.configure({ channels: { out: out.sink }, default: { level: 'info', channels: ['out'] } });
    const log = logging.getLogger('x');
    const boom = new Error('boom');
    log.warn('failed', { err: boom, id: 1 });
    log.error(boom);
    log.fatal(boom, { id: 2 });
    expect(out.records[0]?.error).toBe(boom);
    expect(out.records[0]?.fields).toEqual({ id: 1 });
    expect(out.records[1]).toMatchObject({ template: 'boom', error: boom, levelName: 'error' });
    expect(out.records[2]).toMatchObject({ template: 'boom', error: boom, levelName: 'fatal', fields: { id: 2 } });
  });
});

describe('before configure()', () => {
  it('keeps warn and up in a 64-record ring and replays it once, in order, on configure', () => {
    const logging = createLogging();
    const log = logging.getLogger('early');
    log.info('dropped');
    for (let index = 0; index < 70; index++) log.warn(`w${index}`);
    const out = capture();
    const handle = logging.configure({ channels: { out: out.sink }, default: { level: 'info', channels: ['out'] } });
    const templates = out.records.map(record => record.template);
    expect(templates).toHaveLength(64);
    expect(templates[0]).toBe('w6');
    expect(templates.at(-1)).toBe('w69');
    expect(templates).not.toContain('dropped');

    void handle.reconfigure({ channels: { out: out.sink }, default: { level: 'info', channels: ['out'] } });
    expect(out.records).toHaveLength(64);
  });
});

describe('configure()', () => {
  it('throws ARKI_LOG_E001 on a second configure()', () => {
    const logging = createLogging();
    const config = { channels: { out: capture().sink }, default: { level: 'info', channels: ['out'] } } as const;
    logging.configure(config);
    expect(codeOf(() => logging.configure(config))).toBe(LOG_ERROR_CODES.alreadyConfigured);
  });

  it('a stale handle never closes or replaces a newer configuration', async () => {
    // Vite dev reload: the old module's handle can be closed again after the
    // reloaded module has configured. That late close must be a no-op.
    const logging = createLogging();
    const first = capture();
    const second = capture();
    const old = logging.configure({ channels: { out: first.sink }, default: { level: 'info', channels: ['out'] } });
    await old.close();
    logging.configure({ channels: { out: second.sink }, default: { level: 'info', channels: ['out'] } });
    await old.close();
    logging.getLogger('app').info('still logging');
    expect(second.records).toHaveLength(1);
    await expect(
      old.reconfigure({ channels: { out: first.sink }, default: { level: 'info', channels: ['out'] } }),
    ).rejects.toMatchObject({ code: LOG_ERROR_CODES.staleHandle });
  });

  describe('owner', () => {
    // Nitro's dev worker imports the app entry again after an edit, in the same
    // process, and runs no import.meta.hot dispose hooks. The entry's re-run must
    // take over its own setup; any other second configure() is still a bug.

    it('lets the same owner configure again: the new setup takes over and the old sinks close', async () => {
      const logging = createLogging();
      let closed = false;
      const first = capture({ close: () => void (closed = true) });
      const second = capture();
      logging.configure(outConfig(first.sink), { owner: 'file:///app/src/server.ts' });
      logging.configure(outConfig(second.sink), { owner: 'file:///app/src/server.ts' });
      logging.getLogger('app').info('after reload');
      expect(first.records).toHaveLength(0);
      expect(second.records).toHaveLength(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(closed).toBe(true);
    });

    it('still throws ARKI_LOG_E001 when another owner, or no owner, configures again', () => {
      const owned = createLogging();
      owned.configure(outConfig(capture().sink), { owner: 'file:///app/src/server.ts' });
      expect(codeOf(() => owned.configure(outConfig(capture().sink), { owner: 'file:///lib/setup.ts' }))).toBe(
        LOG_ERROR_CODES.alreadyConfigured,
      );
      expect(codeOf(() => owned.configure(outConfig(capture().sink)))).toBe(LOG_ERROR_CODES.alreadyConfigured);

      const unowned = createLogging();
      unowned.configure(outConfig(capture().sink));
      expect(codeOf(() => unowned.configure(outConfig(capture().sink), { owner: 'file:///app/src/server.ts' }))).toBe(
        LOG_ERROR_CODES.alreadyConfigured,
      );
    });

    it("makes the previous run's handle stale, so its late close() leaves the new setup alone", async () => {
      const logging = createLogging();
      const second = capture();
      const old = logging.configure(outConfig(capture().sink), { owner: 'file:///app/src/server.ts' });
      logging.configure(outConfig(second.sink), { owner: 'file:///app/src/server.ts' });
      await old.close();
      logging.getLogger('app').info('still logging');
      expect(second.records).toHaveLength(1);
      await expect(old.reconfigure(outConfig(capture().sink))).rejects.toMatchObject({
        code: LOG_ERROR_CODES.staleHandle,
      });
    });
  });

  it('keeps createLogging() instances independent', () => {
    const one = createLogging();
    const two = createLogging();
    const a = capture();
    const b = capture();
    one.configure({ channels: { a: a.sink }, default: { level: 'info', channels: ['a'] } });
    two.configure({ channels: { b: b.sink }, default: { level: 'error', channels: ['b'] } });
    one.getLogger('x').info('one');
    two.getLogger('x').info('two dropped');
    expect(a.records).toHaveLength(1);
    expect(b.records).toHaveLength(0);
  });

  it('rejects an unknown channel with ARKI_LOG_E002 and an unknown level with ARKI_LOG_E003', () => {
    const logging: Logging = createLogging();
    const sink = capture().sink;
    expect(
      codeOf(() =>
        // @ts-expect-error -- 'stdot' is not a channel
        logging.configure({ channels: { stdout: sink }, default: { level: 'info', channels: ['stdot'] } }),
      ),
    ).toBe(LOG_ERROR_CODES.unknownChannel);
    expect(
      codeOf(() =>
        logging.configure({
          channels: { stdout: sink },
          default: { level: 'info', channels: ['stdout'] },
          // @ts-expect-error -- 'nope' is not a channel
          categories: { a: { channels: ['nope'] } },
        }),
      ),
    ).toBe(LOG_ERROR_CODES.unknownChannel);
    expect(
      codeOf(() =>
        // @ts-expect-error -- 'verbose' is not a level
        logging.configure({ channels: { stdout: sink }, default: { level: 'verbose', channels: ['stdout'] } }),
      ),
    ).toBe(LOG_ERROR_CODES.invalidLevel);
    expect(codeOf(() => logging.getLogger('x').log(25, 'too high'))).toBe(LOG_ERROR_CODES.invalidLevel);
  });

  it('close() flushes and closes every sink, then drops records below warn again', async () => {
    const logging = createLogging();
    const events: string[] = [];
    const out = capture({ flush: () => void events.push('flush'), close: () => void events.push('close') });
    const handle = logging.configure({ channels: { out: out.sink }, default: { level: 'info', channels: ['out'] } });
    await handle.close({ timeoutMs: 1000 });
    logging.getLogger('x').info('after close');
    expect(events).toEqual(['flush', 'close']);
    expect(out.records).toHaveLength(0);
  });
});

describe('lazy fields', () => {
  it('never runs the thunk of a disabled call, runs an enabled one once, and survives a throwing thunk', () => {
    const logging = createLogging();
    const out = capture();
    logging.configure({ channels: { out: out.sink }, default: { level: 'info', channels: ['out'] } });
    const log = logging.getLogger('x');
    let runs = 0;
    log.debug('disabled', () => {
      runs++;
      return {};
    });
    expect(runs).toBe(0);
    log.info('enabled {n}', () => {
      runs++;
      return { n: runs };
    });
    expect(runs).toBe(1);
    expect(out.records[0]?.message()).toBe('enabled 1');
    log.info('broken', () => {
      throw new Error('thunk failed');
    });
    expect(out.records[1]?.fields['log.thunk_error']).toBeInstanceOf(Error);
  });
});

describe('routing with to()', () => {
  it('sends only to the named channel instead of the category channels', () => {
    const logging = createLogging();
    const main = capture();
    const audit = capture();
    logging.configure({
      channels: { main: main.sink, audit: audit.sink },
      default: { level: 'info', channels: ['main'] },
    });
    logging.getLogger('x').to('audit').info('audited');
    expect(audit.records.map(record => record.template)).toEqual(['audited']);
    expect(main.records).toHaveLength(0);
  });
});

describe('logger API', () => {
  it('child() extends the category and is memoised for plain loggers', () => {
    const logging = createLogging();
    const kv = logging.getLogger('arki:kv');
    expect(kv.child('redis').category).toBe('arki:kv:redis');
    expect(kv.child('redis')).toBe(logging.getLogger('arki:kv:redis'));
    expect(logging.getLogger().child('top').category).toBe('top');
  });

  it('isEnabled(), log() with a number, emit() and withTrace() follow the configuration', () => {
    const logging = createLogging();
    const out = capture();
    logging.configure({
      channels: { out: out.sink },
      default: { level: 'info', channels: ['out'] },
      resource: { 'service.name': 'checkout' },
      trace: () => ({ traceId: 'from-source', spanId: 's1' }),
    });
    const log = logging.getLogger('x');
    expect(log.isEnabled('debug')).toBe(false);
    expect(log.isEnabled(9)).toBe(true);
    log.log(10, 'severity ten');
    log.emit({ level: 'warn', eventName: 'payment.accepted', body: { amount: 5 } });
    log.withTrace({ traceId: 't1', spanId: 's2', traceFlags: 1 }).info('traced');
    expect(out.records[0]).toMatchObject({ level: 10, levelName: 'info', traceId: 'from-source' });
    expect(out.records[1]).toMatchObject({ template: '', eventName: 'payment.accepted', body: { amount: 5 } });
    expect(out.records[2]).toMatchObject({ traceId: 't1', spanId: 's2', traceFlags: 1 });
    expect(out.records[2]?.resource).toEqual({ 'service.name': 'checkout' });
  });

  it('types to() against the Register channel names (plain string without a Register)', () => {
    expectTypeOf<Parameters<Logger['to']>[0]>().toEqualTypeOf<string>();
    expect(createLogging().getLogger('x').to('anything').category).toBe('x');
  });
});

describe('default instance', () => {
  it('lives on globalThis under Symbol.for, so a second copy of the package shares it', () => {
    const fromOtherCopy = createInternalLogging();
    Object.defineProperty(globalThis, Symbol.for('@arki/log/default@1'), { value: fromOtherCopy, configurable: true });
    expect(DEFAULT_KEY).toBe(Symbol.for('@arki/log/default@1'));
    expect(defaultLogging()).toBe(fromOtherCopy);
    expect(getLogger('shared')).toBe(fromOtherCopy.getLogger('shared'));
  });
});

describe('to() with a channel that is not defined', () => {
  it('never throws into the caller, skips the unknown channel and reports it once', () => {
    const consoleError = vi.spyOn(console, 'error').mockReturnValue();
    const logging = createLogging();
    expect(() => logging.getLogger('x').to('missing').info('x')).not.toThrow();
    const out = memorySink();
    logging.configure({ channels: { out }, default: { level: 'info', channels: ['out'] } });
    const log = logging.getLogger('x').to('missing', 'out');
    expect(() => log.info('kept')).not.toThrow();
    expect(out.records.map(record => record.template)).toEqual(['kept']);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('survives reconfigure() removing the channel a to() logger was built for', async () => {
    vi.spyOn(console, 'error').mockReturnValue();
    const logging = createLogging();
    const audit = memorySink();
    const handle = logging.configure({ channels: { audit }, default: { level: 'info', channels: ['audit'] } });
    const log = logging.getLogger('x').to('audit');
    log.info('before');
    await handle.reconfigure({ channels: {}, default: { level: 'info', channels: [] } });
    expect(() => log.info('after')).not.toThrow();
    expect(audit.records.map(record => record.template)).toEqual(['before']);
  });
});
