/**
 * `listenOnPool` against a scripted pool (no database).
 *
 * Why these tests exist: live queries trust `onState` to know when hints may
 * have been missed, so `disconnected` must fire on every way a connection dies
 * (error, end, a silent socket), exactly once, and `ready` only after `LISTEN`
 * worked. A client must be released exactly once: `pg` throws on a second
 * release, and a client returned to the pool with our handlers would fire
 * them for the next borrower. The real-socket cases are in `pg-listen.pg.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListenClient, ListenPool } from './pg-listen.js';
import { listenOnPool, ListenUnavailable } from './pg-listen.js';

type Notification = { readonly channel: string; readonly payload?: string };

type Handlers = {
  notification: (message: Notification) => void;
  error: (error: Error) => void;
  end: () => void;
};

/** A pool client the test drives: it records queries and releases, and emits events on demand. */
function scriptedClient(answer: (text: string) => Promise<unknown> = () => Promise.resolve()) {
  const handlers: { [Event in keyof Handlers]: Handlers[Event][] } = { notification: [], error: [], end: [] };
  const queries: string[] = [];
  const releases: (Error | boolean | undefined)[] = [];
  const client: ListenClient = {
    query(text) {
      queries.push(text);
      return answer(text);
    },
    on<Event extends keyof Handlers>(event: Event, listener: Handlers[Event]) {
      handlers[event].push(listener);
    },
    release(error) {
      releases.push(error);
    },
  };
  return {
    client,
    queries,
    releases,
    notify: (message: Notification) => {
      for (const listener of handlers.notification) listener(message);
    },
    fail: (error: Error) => {
      for (const listener of handlers.error) listener(error);
    },
    end: () => {
      for (const listener of handlers.end) listener();
    },
  };
}

type Scripted = ReturnType<typeof scriptedClient>;

/** A pool that hands out the next scripted client on each `connect()`. */
function scriptedPool(...clients: Scripted[]): ListenPool & { connects(): number } {
  let next = 0;
  return {
    connect() {
      const scripted = clients[next];
      next += 1;
      return scripted ? Promise.resolve(scripted.client) : Promise.reject(new Error('pool exhausted'));
    },
    connects: () => next,
  };
}

const never = () =>
  new Promise<unknown>(() => {
    // Never settles: a socket that went silent.
  });

/** For tests that watch states, not payloads. */
const ignorePayload = (): void => {
  // Nothing to record.
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('listenOnPool', () => {
  it('reports ready only after LISTEN, quotes the channel, and forwards its own channel only', async () => {
    let finishListen: (() => void) | undefined;
    const first = scriptedClient(text =>
      text.startsWith('LISTEN')
        ? new Promise<unknown>(resolve => {
            finishListen = () => resolve(null);
          })
        : Promise.resolve(),
    );
    const states: string[] = [];
    const seen: string[] = [];
    const starting = listenOnPool(scriptedPool(first), 'odd"name', { onState: state => states.push(state) })(payload =>
      seen.push(payload),
    );
    await vi.waitFor(() => expect(first.queries).toEqual(['LISTEN "odd""name"']));
    expect(states).toEqual([]);
    finishListen?.();
    const stop = await starting;
    expect(states).toEqual(['ready']);

    first.notify({ channel: 'odd"name', payload: 'a' });
    first.notify({ channel: 'other', payload: 'b' });
    first.notify({ channel: 'odd"name' });
    expect(seen).toEqual(['a']);
    await stop();
  });

  it('an error then an end release the client once, report one disconnect, and reconnect once', async () => {
    const first = scriptedClient();
    const second = scriptedClient();
    const pool = scriptedPool(first, second);
    const states: string[] = [];
    const seen: string[] = [];
    const stop = await listenOnPool(pool, 'ch', { retryMs: 50, onState: state => states.push(state) })(payload =>
      seen.push(payload),
    );

    const boom = new Error('socket reset');
    first.fail(boom);
    first.end();
    first.fail(new Error('again'));
    expect(first.releases).toEqual([boom]);
    expect(states).toEqual(['ready', 'disconnected']);

    // The dead client's socket still delivering does not reach the caller.
    first.notify({ channel: 'ch', payload: 'stale' });
    expect(seen).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);
    expect(states).toEqual(['ready', 'disconnected', 'ready']);
    // A late event from the old client does not start a second connection.
    first.end();
    await vi.advanceTimersByTimeAsync(500);
    expect(pool.connects()).toBe(2);

    second.notify({ channel: 'ch', payload: 'fresh' });
    expect(seen).toEqual(['fresh']);
    await stop();
  });

  it('an end without an error is a lost connection too', async () => {
    const first = scriptedClient();
    const states: string[] = [];
    await listenOnPool(scriptedPool(first, scriptedClient()), 'ch', { onState: state => states.push(state) })(
      ignorePayload,
    );
    first.end();
    expect(first.releases).toHaveLength(1);
    expect(first.releases[0]).toBeInstanceOf(Error);
    expect(states).toEqual(['ready', 'disconnected']);
  });

  it('a health check with no answer within healthMs drops the client', async () => {
    const first = scriptedClient(text => (text === 'select 1' ? never() : Promise.resolve()));
    const states: string[] = [];
    await listenOnPool(scriptedPool(first, scriptedClient()), 'ch', {
      healthMs: 100,
      onState: state => states.push(state),
    })(ignorePayload);

    await vi.advanceTimersByTimeAsync(100);
    expect(first.queries).toEqual(['LISTEN "ch"', 'select 1']);
    expect(states).toEqual(['ready']);
    await vi.advanceTimersByTimeAsync(100);
    expect(states).toEqual(['ready', 'disconnected']);
    expect(first.releases).toHaveLength(1);
    expect(String(first.releases[0])).toContain('health check');
  });

  it('a health check that answers keeps the client; one that fails drops it', async () => {
    let healthy = true;
    const first = scriptedClient(text =>
      text === 'select 1' && !healthy ? Promise.reject(new Error('terminated')) : Promise.resolve(),
    );
    const states: string[] = [];
    await listenOnPool(scriptedPool(first, scriptedClient()), 'ch', {
      healthMs: 100,
      onState: state => states.push(state),
    })(ignorePayload);
    await vi.advanceTimersByTimeAsync(1000);
    expect(states).toEqual(['ready']);
    healthy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(states).toEqual(['ready', 'disconnected']);
    expect(first.releases).toEqual([new Error('terminated')]);
  });

  it('a first connection that fails rejects the start and retries nothing', async () => {
    const first = scriptedClient(() => Promise.reject(new Error('permission denied')));
    const pool = scriptedPool(first, scriptedClient());
    const states: string[] = [];
    const started = listenOnPool(pool, 'ch', { onState: state => states.push(state) })(ignorePayload);
    await expect(started).rejects.toMatchObject({ code: ListenUnavailable.code });
    await expect(started).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'permission denied' }) });
    first.fail(new Error('late'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(first.releases).toEqual([new Error('permission denied')]);
    expect(pool.connects()).toBe(1);
    expect(states).toEqual([]);
  });

  it('a throwing onState observer neither rejects the start nor drops the client', async () => {
    const first = scriptedClient();
    const pool = scriptedPool(first, scriptedClient());
    const stop = await listenOnPool(pool, 'ch', {
      onState: () => {
        throw new Error('observer bug');
      },
    })(ignorePayload);
    expect(first.releases).toEqual([]);
    first.fail(new Error('lost'));
    await stop();
  });

  it('stop unlistens and closes the client (never hands it back), then reports nothing more', async () => {
    const first = scriptedClient();
    const pool = scriptedPool(first, scriptedClient());
    const states: string[] = [];
    const seen: string[] = [];
    const stop = await listenOnPool(pool, 'ch', { onState: state => states.push(state) })(payload =>
      seen.push(payload),
    );
    await stop();
    expect(first.queries).toEqual(['LISTEN "ch"', 'UNLISTEN "ch"']);
    expect(first.releases).toEqual([true]);
    first.notify({ channel: 'ch', payload: 'after stop' });
    first.fail(new Error('after stop'));
    first.end();
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toEqual([]);
    expect(states).toEqual(['ready']);
    expect(pool.connects()).toBe(1);
  });

  it('stop during a reconnect drops the new client and never reports ready', async () => {
    const first = scriptedClient();
    let finishListen: (() => void) | undefined;
    const second = scriptedClient(text =>
      text.startsWith('LISTEN')
        ? new Promise<unknown>(resolve => {
            finishListen = () => resolve(null);
          })
        : Promise.resolve(),
    );
    const states: string[] = [];
    const stop = await listenOnPool(scriptedPool(first, second), 'ch', {
      retryMs: 10,
      onState: state => states.push(state),
    })(ignorePayload);
    first.fail(new Error('gone'));
    await vi.advanceTimersByTimeAsync(10);
    expect(second.queries).toEqual(['LISTEN "ch"']);
    await stop();
    finishListen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.releases).toEqual([true]);
    expect(states).toEqual(['ready', 'disconnected']);
  });

  it('refuses a non-positive retryMs or healthMs', () => {
    expect(() => listenOnPool(scriptedPool(), 'ch', { retryMs: 0 })).toThrow(RangeError);
    expect(() => listenOnPool(scriptedPool(), 'ch', { healthMs: Number.NaN })).toThrow(RangeError);
  });
});
