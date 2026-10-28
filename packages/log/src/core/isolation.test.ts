import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContextStore, Sink } from './types.js';
import { createLogging } from './logging.js';
import { memorySink } from './sinks.js';
import { buffer, deduplicate, fingersCrossed } from './wrappers.js';

const config = (sink: Sink, context?: ContextStore) =>
  ({
    channels: { sink },
    default: { level: 'info', channels: ['sink'] },
    context,
  }) as const;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => vi.restoreAllMocks());

describe('observation preserves application outcomes', () => {
  it.each(['traceId', 'spanId', 'traceFlags'] as const)('omits trace metadata when its %s getter fails', field => {
    vi.spyOn(console, 'error').mockReturnValue();
    const logging = createLogging();
    const sink = memorySink();
    logging.configure({
      ...config(sink),
      trace: () => ({
        get traceId() {
          if (field === 'traceId') throw new Error('trace getter');
          return 'trace';
        },
        get spanId() {
          if (field === 'spanId') throw new Error('span getter');
          return 'span';
        },
        get traceFlags() {
          if (field === 'traceFlags') throw new Error('flags getter');
          return 1;
        },
      }),
    });
    expect(() => logging.getLogger().info('committed')).not.toThrow();
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.traceId).toBeUndefined();
    expect(sink.records[0]?.spanId).toBeUndefined();
  });

  it('omits failed outer metadata without replacing the callback value, promise or error', async () => {
    vi.spyOn(console, 'error').mockReturnValue();
    const logging = createLogging();
    const sink = memorySink();
    logging.configure(
      config(sink, {
        get: () => ({
          inherited: 'partial metadata must not leak',
          get broken(): string {
            throw new Error('context getter');
          },
        }),
        run: (scope, fn) => {
          expect(scope).toEqual({ own: 'field' });
          return fn();
        },
      }),
    );
    const callback = vi.fn(() => 42);
    expect(logging.withContext({ own: 'field' }, callback)).toBe(42);
    expect(callback).toHaveBeenCalledTimes(1);
    const pending = Promise.resolve(43);
    expect(logging.withContext({ own: 'field' }, () => pending)).toBe(pending);
    await pending;
    const failure = new Error('business');
    expect(() =>
      logging.withContext({ own: 'field' }, () => {
        throw failure;
      }),
    ).toThrow(failure);
  });

  it('reserves callback entry before provider-exposed reentry and preserves synchronous completion', () => {
    const logging = createLogging();
    let reenter: () => unknown = vi.fn();
    logging.configure(
      config(memorySink(), {
        get: () => {
          /* no active context */
        },
        run: (_fields, fn) => {
          reenter = fn;
          return fn();
        },
      }),
    );
    const events: string[] = [];
    const callback = vi.fn(() => {
      events.push('started');
      // A provider callback reentered before completion cannot have a result yet.
      if (events.length === 1) expect(reenter()).toBeUndefined();
      events.push('finished');
      return 42;
    });
    expect(logging.withContext({}, callback)).toBe(42);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['started', 'finished']);
    expect(reenter()).toBe(42);
    const failure = new Error('business');
    const throws = vi.fn(() => {
      reenter();
      throw failure;
    });
    expect(() => logging.withContext({}, throws)).toThrow(failure);
    expect(throws).toHaveBeenCalledTimes(1);
    const pending = Promise.resolve(43);
    const asyncCallback = vi.fn(() => {
      expect(reenter()).toBeUndefined();
      return pending;
    });
    expect(logging.withContext({}, asyncCallback)).toBe(pending);
    expect(asyncCallback).toHaveBeenCalledTimes(1);
  });

  it('keeps records when context and tracing fail, even if diagnostics fail', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('diagnostic failed');
    });
    const logging = createLogging();
    const sink = memorySink();
    logging.configure({
      ...config(sink, {
        get: () => {
          throw new Error('context');
        },
        run: (_fields, fn) => fn(),
      }),
      trace: () => {
        throw new Error('trace');
      },
    });
    expect(() => logging.getLogger().info('application finished')).not.toThrow();
    expect(sink.records.map(record => record.template)).toEqual(['application finished']);
  });

  it.each(['before', 'after', 'swallow'] as const)(
    'preserves callback values and errors when context run fails %s',
    mode => {
      vi.spyOn(console, 'error').mockReturnValue();
      const logging = createLogging();
      logging.configure(
        config(memorySink(), {
          get: () => {
            /* no active context */
          },
          run: (_fields, fn) => {
            if (mode === 'before') throw new Error('before');
            try {
              fn();
            } catch {
              if (mode !== 'swallow') throw new Error('after');
            }
            throw new Error('after');
          },
        }),
      );
      const callback = vi.fn(() => 42);
      expect(logging.withContext({}, callback)).toBe(42);
      expect(callback).toHaveBeenCalledTimes(1);
      const failure = new Error('business failure');
      expect(() =>
        logging.withContext({}, () => {
          throw failure;
        }),
      ).toThrow(failure);
      const pending = Promise.resolve(43);
      expect(logging.withContext({}, () => pending)).toBe(pending);
    },
  );

  it('observes rejected async writes without dropping another sink’s record', async () => {
    vi.spyOn(console, 'error').mockReturnValue();
    const logging = createLogging();
    const good = memorySink();
    const broken: Sink = {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- JavaScript permits async callbacks in a void slot; logging must observe their rejection.
      write: async () => {
        await Promise.resolve();
        throw new Error('async write');
      },
    };
    const handle = logging.configure({
      channels: { broken, good },
      default: { level: 'info', channels: ['broken', 'good'] },
    });
    logging.getLogger().info('committed');
    await tick();
    expect(good.records).toHaveLength(1);
    await handle.close();
  });

  it('flush and close isolate sync and async faults and close every sink', async () => {
    vi.spyOn(console, 'error').mockReturnValue();
    const events: string[] = [];
    const logging = createLogging();
    const a: Sink = {
      write: () => {
        /* discard */
      },
      flush: () => {
        events.push('a flush');
        throw new Error('flush');
      },
      close: () => {
        events.push('a close');
        throw new Error('close');
      },
    };
    const b: Sink = {
      write: () => {
        /* discard */
      },
      flush: async () => {
        events.push('b flush');
        await Promise.resolve();
        throw new Error('flush');
      },
      close: async () => {
        events.push('b close');
        await Promise.resolve();
        throw new Error('close');
      },
    };
    const c: Sink = {
      write: () => {
        /* discard */
      },
      close: () => {
        events.push('c close');
      },
    };
    const handle = logging.configure({ channels: { a, b, c }, default: { level: 'info', channels: ['a'] } });
    await expect(handle.flush()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
    expect(events.toSorted()).toEqual(['a close', 'a flush', 'a flush', 'b close', 'b flush', 'b flush', 'c close']);
  });

  it('same-owner replacement observes retired cleanup rejections', async () => {
    vi.spyOn(console, 'error').mockReturnValue();
    const logging = createLogging();
    const close = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('close');
    });
    logging.configure(
      config({
        write: () => {
          /* discard */
        },
        flush: async () => {
          await Promise.resolve();
          throw new Error('flush');
        },
        close,
      }),
      { owner: 'entry' },
    );
    const handle = logging.configure(config(memorySink()), { owner: 'entry' });
    await tick();
    expect(close).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it('cleanup continues after a timeout while retained sinks keep serving the new setup', async () => {
    vi.spyOn(console, 'error').mockReturnValue();
    const logging = createLogging();
    const { promise: pending, reject: rejectFlush } = Promise.withResolvers<void>();
    const close = vi.fn();
    const retired: Sink = {
      write: () => {
        /* discard */
      },
      flush: () => pending,
      close,
    };
    const kept = memorySink();
    const handle = logging.configure({ channels: { retired, kept }, default: { level: 'info', channels: ['kept'] } });
    const replacing = handle.reconfigure(config(kept));
    logging.getLogger().info('new setup');
    await handle.close({ timeoutMs: 0 });
    rejectFlush(new Error('late flush rejection'));
    await replacing;
    expect(close).toHaveBeenCalledTimes(1);
    expect(kept.records.map(record => record.template)).toEqual(['new setup']);
  });

  it('close timeout observes a late rejection and still releases the sink', async () => {
    vi.spyOn(console, 'error').mockReturnValue();
    const logging = createLogging();
    const { promise: pending, reject: rejectFlush } = Promise.withResolvers<void>();
    const close = vi.fn();
    const handle = logging.configure(
      config({
        write: () => {
          /* discard */
        },
        flush: () => pending,
        close,
      }),
    );
    await handle.close({ timeoutMs: 0 });
    expect(close).not.toHaveBeenCalled();
    rejectFlush(new Error('late rejection'));
    await tick();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a context provider cannot execute an application callback twice or replace its rejected promise', async () => {
    const logging = createLogging();
    logging.configure(
      config(memorySink(), {
        get: () => {
          /* no active context */
        },
        run: (_fields, fn) => {
          fn();
          return fn();
        },
      }),
    );
    const businessError = new Error('business');
    const promise = Promise.reject(businessError);
    const callback = vi.fn(() => promise);
    const result = logging.withContext({}, callback);
    expect(result).toBe(promise);
    await expect(result).rejects.toBe(businessError);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('a reentrant failure diagnostic is bounded and cannot interrupt another sink', () => {
    const logging = createLogging();
    const good = memorySink();
    const broken: Sink = {
      write: () => {
        throw new Error('broken');
      },
    };
    logging.configure({ channels: { broken, good }, default: { level: 'info', channels: ['broken', 'good'] } });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => logging.getLogger().info('diagnostic'));
    logging.getLogger().info('committed');
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(good.records.map(record => record.template)).toEqual(['diagnostic', 'committed']);
  });

  it.each([buffer, deduplicate, fingersCrossed])(
    'wrapper %s isolates lifecycle faults and still closes its sink',
    async wrap => {
      vi.spyOn(console, 'error').mockReturnValue();
      const close = vi.fn(async () => {
        await Promise.resolve();
        throw new Error('close');
      });
      const sink = wrap({
        write: () => {
          /* discard */
        },
        flush: () => {
          throw new Error('flush');
        },
        close,
      });
      await expect(Promise.resolve().then(() => sink.flush?.())).resolves.toBeUndefined();
      await expect(Promise.resolve().then(() => sink.close?.())).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it('a reentrant buffered write retains the new batch until its next drain', async () => {
    const logging = createLogging();
    const seen: string[] = [];
    const wrapped = buffer({
      write: record => {
        seen.push(record.template);
        if (record.template === 'first') logging.getLogger().info('second');
      },
    });
    const handle = logging.configure(config(wrapped));
    logging.getLogger().info('first');
    await handle.flush();
    expect(seen).toEqual(['first']);
    await handle.flush();
    expect(seen).toEqual(['first', 'second']);
    await handle.close();
  });

  it('deduplicate flush retains reentrant windows for the next drain', async () => {
    const logging = createLogging();
    const seen: string[] = [];
    let summaries = 0;
    const wrapped = deduplicate({
      write: record => {
        seen.push(record.template);
        if (record.fields.suppressed !== undefined && summaries++ < 2) {
          logging.getLogger().info('new');
          logging.getLogger().info('new');
        }
      },
    });
    const handle = logging.configure(config(wrapped));
    logging.getLogger().info('first');
    logging.getLogger().info('first');
    await handle.flush();
    expect(seen).toEqual(['first', '{suppressed} duplicate records suppressed: {original}', 'new']);
    await handle.close();
  });
});
