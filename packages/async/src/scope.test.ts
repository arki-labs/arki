import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncError } from './errors.js';
import { scoped } from './scope.js';
import { sleep } from './sleep.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function settled<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe('scoped', () => {
  it('resolves with the body value and runs finalizers newest first', async () => {
    const log: string[] = [];
    const value = await scoped(scope => {
      scope.defer(() => void log.push('a'));
      scope.defer(() => void log.push('b'));
      scope.defer(() => void log.push('c'));
      return Promise.resolve(42);
    });
    expect(value).toBe(42);
    expect(log).toEqual(['c', 'b', 'a']);
  });

  it('awaits each finalizer before the next, so a later cleanup never races an earlier one', async () => {
    const log: string[] = [];
    const promise = scoped(scope => {
      scope.defer(() => void log.push('outer'));
      scope.defer(async () => {
        log.push('inner start');
        await sleep(10);
        log.push('inner end');
      });
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(10);
    await promise;
    expect(log).toEqual(['inner start', 'inner end', 'outer']);
  });

  it('rethrows the body error unchanged when cleanup is clean', async () => {
    const boom = new Error('boom');
    const cleaned = vi.fn();
    const result = await settled(
      scoped(scope => {
        scope.defer(cleaned);
        return Promise.reject(boom);
      }),
    );
    expect(result).toEqual({ error: boom });
    expect(cleaned).toHaveBeenCalledOnce();
  });

  it('runs every finalizer even when one throws, then rejects with E003 listing the errors in run order', async () => {
    const first = new Error('first to run');
    const second = new Error('second to run');
    const log: string[] = [];
    const result = await settled(
      scoped(scope => {
        scope.defer(() => {
          log.push('a');
          throw second;
        });
        scope.defer(() => void log.push('b'));
        scope.defer(() => {
          log.push('c');
          throw first;
        });
        return Promise.resolve('lost');
      }),
    );
    expect(log).toEqual(['c', 'b', 'a']);
    const error = (result as { error: AsyncError }).error;
    expect(error).toBeInstanceOf(AsyncError);
    expect(error.code).toBe('ARKI_ASYNC_E003');
    expect(error.errors).toEqual([first, second]);
    expect(error.cause).toBeUndefined();
    expect(error.remediation).not.toBe('');
  });

  it('keeps the body error as `cause` when cleanup also fails, so neither error is lost', async () => {
    const bodyError = new Error('body');
    const closeError = new Error('close');
    const result = await settled(
      scoped(scope => {
        scope.defer(() => {
          throw closeError;
        });
        return Promise.reject(bodyError);
      }),
    );
    expect(result).toMatchObject({ error: { code: 'ARKI_ASYNC_E003', cause: bodyError, errors: [closeError] } });
  });

  it('aborts scope.signal before finalizers run, with the body error as the reason', async () => {
    const boom = new Error('boom');
    let seen: { aborted: boolean; reason: unknown } | undefined;
    await settled(
      scoped(scope => {
        scope.defer(() => {
          seen = { aborted: scope.signal.aborted, reason: scope.signal.reason };
        });
        return Promise.reject(boom);
      }),
    );
    expect(seen).toEqual({ aborted: true, reason: boom });
  });

  it('stops stragglers: work started on scope.signal and not awaited is aborted when the scope ends', async () => {
    let straggler: Promise<{ value: void } | { error: unknown }> | undefined;
    await scoped(scope => {
      straggler = settled(sleep(10_000, { signal: scope.signal }));
      return Promise.resolve();
    });
    expect(await straggler).toMatchObject({ error: { code: 'ARKI_ASYNC_E002' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('acquire registers close only after open succeeds, and closes resources newest first', async () => {
    const closed: string[] = [];
    const close = vi.fn((name: string) => void closed.push(name));
    const failure = new Error('open failed');
    const result = await settled(
      scoped(async scope => {
        const a = await scope.acquire(() => 'a', close);
        const b = await scope.acquire(() => Promise.resolve('b'), close);
        expect([a, b]).toEqual(['a', 'b']);
        await scope.acquire(() => Promise.reject(failure), close);
      }),
    );
    expect(result).toEqual({ error: failure });
    expect(closed).toEqual(['b', 'a']);
  });

  it('acquire passes scope.signal to open, so a slow open can be cancelled with the scope', async () => {
    const controller = new AbortController();
    const close = vi.fn();
    const promise = settled(
      scoped(scope => scope.acquire(signal => sleep(1000, { signal }), close), { signal: controller.signal }),
    );
    controller.abort('cancel');
    expect(await promise).toMatchObject({ error: { code: 'ARKI_ASYNC_E002', cause: 'cancel' } });
    expect(close).not.toHaveBeenCalled();
  });

  it('a straggling acquire that opens after the scope ended closes its resource at once and rejects', async () => {
    const close = vi.fn();
    let late: Promise<{ value: string } | { error: unknown }> | undefined;
    await scoped(scope => {
      late = settled(
        scope.acquire(async () => {
          await sleep(10);
          return 'late';
        }, close),
      );
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await late).toMatchObject({ error: { code: 'ARKI_ASYNC_E002' } });
    expect(close).toHaveBeenCalledWith('late');
  });

  it('defer after the scope ended throws E002 instead of silently never running', async () => {
    let escaped: Parameters<Parameters<typeof scoped>[0]>[0] | undefined;
    await scoped(scope => {
      escaped = scope;
      return Promise.resolve();
    });
    expect(() => escaped?.defer(vi.fn())).toThrow(expect.objectContaining({ code: 'ARKI_ASYNC_E002' }));
  });

  it('an already-aborted outer signal rejects with E002 and never runs the body', async () => {
    const body = vi.fn(() => Promise.resolve(1));
    const result = await settled(scoped(body, { signal: AbortSignal.abort('gone') }));
    expect(result).toMatchObject({ error: { code: 'ARKI_ASYNC_E002', cause: 'gone' } });
    expect(body).not.toHaveBeenCalled();
  });

  it('an outer abort during the body aborts scope.signal with the outer reason', async () => {
    const controller = new AbortController();
    const promise = settled(scoped(scope => sleep(1000, { signal: scope.signal }), { signal: controller.signal }));
    controller.abort('outer');
    expect(await promise).toMatchObject({ error: { code: 'ARKI_ASYNC_E002', cause: 'outer' } });
  });

  it('treats a synchronous throw in the body like a rejection and still cleans up', async () => {
    const boom = new Error('sync');
    const cleaned = vi.fn();
    const result = await settled(
      scoped(scope => {
        scope.defer(cleaned);
        throw boom;
      }),
    );
    expect(result).toEqual({ error: boom });
    expect(cleaned).toHaveBeenCalledOnce();
  });
});
