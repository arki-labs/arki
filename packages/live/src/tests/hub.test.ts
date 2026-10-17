/**
 * The hub's server steps of plan § 5 under a fake clock: start (2), batch and
 * ring (5), connect (6), hello (7), close (8), gap (9), stop (10). Convergence
 * across every placement of a commit lives in `protocol.test.ts`; this file
 * pins the bounds and the lifecycle edges.
 *
 * Why these tests exist: a replay must never be partial (one evicted frame
 * means reset, exactly at the bound), a hub is not `ready` before its source
 * says so, and `stop()` must settle once, after the source stopped, whoever
 * calls it and whenever: the Dot plugin calls it from both `stop` and
 * `dispose`, and a rollback can call it while `start()` is still listening.
 */
import { setImmediate as macrotask } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveFeed, LiveSource, LiveSourceEvent, TableTag } from '../index.js';
import { createLiveHub, LIVE_ERROR_CODES, parseLiveCursor } from '../index.js';
import { replayRing } from '../replay.js';
import { fakeSource } from '../testing.js';

const tag = (table: string): TableTag => ({ schema: 'public', table });
const settle = (): Promise<void> => macrotask();

const unset = (): void => {
  throw new Error('deferred used before its promise ran');
};

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve: () => void = unset;
  let reject: (error: Error) => void = unset;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A source whose start and stop resolve only when the test says, counting the calls. */
function gatedSource() {
  let receive: ((event: LiveSourceEvent) => void) | undefined;
  const started = deferred();
  const stopped = deferred();
  const calls = { start: 0, stop: 0 };
  const source: LiveSource = {
    async start(next) {
      calls.start += 1;
      receive = next;
      await started.promise;
      return async () => {
        calls.stop += 1;
        await stopped.promise;
      };
    },
  };
  return {
    source,
    calls,
    emit: (event: LiveSourceEvent) => receive?.(event),
    listen: () => started.resolve(),
    failListen: () => started.reject(new Error('LISTEN failed')),
    release: () => stopped.resolve(),
  };
}

/** The next value of a stream (`undefined` once it ended). */
async function nextOf(stream: AsyncIterator<LiveFeed>): Promise<LiveFeed | undefined> {
  const result = await stream.next();
  return result.value;
}

/** Tracks whether a promise has settled yet. */
function track(promise: Promise<unknown>): () => boolean {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  return () => done;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the replay ring (step 5)', () => {
  it('never evicts by count: every frame inside the age is kept, and a cursor anywhere in it resumes', () => {
    // Why: hidden-table frames count too; a count bound would make resume depend on them.
    const ring = replayRing<string>({ ms: 1000 });
    for (let seq = 1; seq <= 10_000; seq += 1) ring.add(seq, 0, `f${seq}`, 1);
    ring.evict(1000);
    expect(ring.size()).toBe(10_000);
    expect(ring.after(0, 10_000)).toHaveLength(10_000);
    expect(ring.after(9997, 10_000)).toEqual(['f9998', 'f9999', 'f10000']);
    expect(ring.after(10_000, 10_000)).toEqual([]);
    // A cursor ahead of the last frame (another hub's numbering) never resumes.
    expect(ring.after(10_001, 10_000)).toBeUndefined();
  });

  it('keeps a frame exactly `ms` old and evicts it one millisecond later', () => {
    const ring = replayRing<string>({ ms: 1000 });
    ring.add(1, 0, 'old', 1);
    ring.add(2, 500, 'new', 1);
    ring.evict(1000);
    expect(ring.after(0, 2)).toEqual(['old', 'new']);
    ring.evict(1001);
    expect(ring.after(0, 2)).toBeUndefined();
    expect(ring.after(1, 2)).toEqual(['new']);
    // Everything aged out: a client at the last frame still resumes, with nothing to replay.
    ring.evict(1501);
    expect(ring.after(2, 2)).toEqual([]);
    expect(ring.after(1, 2)).toBeUndefined();
    ring.clear();
    expect(ring.after(0, 0)).toEqual([]);
  });

  it('the hub evicts by age when a stream connects, not only when a frame flushes', async () => {
    const source = fakeSource();
    const hub = createLiveHub({ source, limits: { batchMs: 10, replayMs: 1000 } });
    await hub.start();
    source.emit({ kind: 'ready' });
    const firstFeed = await hub.open({ signal: new AbortController().signal });
    const first = firstFeed[Symbol.asyncIterator]();
    const begin = await nextOf(first);
    source.emit({ kind: 'change', tags: [tag('posts')] });
    vi.advanceTimersByTime(10);
    if (begin?.kind !== 'begin') throw new Error('expected begin');
    // No write since: only the clock moved past the ring's age.
    vi.advanceTimersByTime(1001);
    const lateFeed = await hub.open({ cursor: begin.cursor, signal: new AbortController().signal });
    const late = lateFeed[Symbol.asyncIterator]();
    expect(await nextOf(late)).toMatchObject({ kind: 'begin', mode: 'reset' });
    await hub.stop();
  });
});

describe('start (step 2)', () => {
  it('is idle until the source is ready, then ready and handing out opaque cursors', async () => {
    const source = fakeSource();
    const hub = createLiveHub({ source });
    expect(hub.status()).toBe('idle');
    await hub.start();
    expect(hub.status()).toBe('idle');
    await expect(hub.open({ signal: new AbortController().signal })).rejects.toMatchObject({
      code: LIVE_ERROR_CODES.source,
    });
    source.emit({ kind: 'ready' });
    expect(hub.status()).toBe('ready');
    const opened = await hub.open({ signal: new AbortController().signal });
    const begin = await nextOf(opened[Symbol.asyncIterator]());
    expect(begin).toMatchObject({ kind: 'begin', mode: 'reset' });
    if (begin?.kind !== 'begin') throw new Error('expected begin');
    // Opaque: 64 base64url characters, nothing ordinal to read.
    expect(parseLiveCursor(begin.cursor)).toMatch(/^[\w-]{75}$/);
    await hub.stop();
  });

  it('rejects when the source fails to start; a hub starts once and never after stop', async () => {
    const failing = gatedSource();
    const hub = createLiveHub({ source: failing.source });
    const start = hub.start();
    // The hub makes its cursor key first; the source starts after.
    await vi.waitFor(() => expect(failing.calls.start).toBe(1));
    failing.failListen();
    await expect(start).rejects.toThrow('LISTEN failed');
    await expect(hub.stop()).resolves.toBeUndefined();
    expect(failing.calls.stop).toBe(0);

    const twice = createLiveHub({ source: fakeSource() });
    await twice.start();
    await expect(twice.start()).rejects.toMatchObject({ code: LIVE_ERROR_CODES.config });
    await twice.stop();
    await expect(twice.start()).rejects.toMatchObject({ code: LIVE_ERROR_CODES.config });

    const neverStarted = gatedSource();
    const stopped = createLiveHub({ source: neverStarted.source });
    await stopped.stop();
    await expect(stopped.start()).rejects.toMatchObject({ code: LIVE_ERROR_CODES.config });
    expect(neverStarted.calls.start).toBe(0);
  });
});

describe('stop (step 10)', () => {
  it('settles once, after the source stopped, for every caller', async () => {
    const gated = gatedSource();
    const hub = createLiveHub({ source: gated.source });
    const start = hub.start();
    gated.listen();
    await start;
    gated.emit({ kind: 'ready' });

    const first = hub.stop();
    const second = hub.stop();
    const firstDone = track(first);
    const secondDone = track(second);
    await settle();
    // UNLISTEN has not finished: neither caller may think the client is back in the pool.
    expect(gated.calls.stop).toBe(1);
    expect(firstDone()).toBe(false);
    expect(secondDone()).toBe(false);
    expect(hub.status()).toBe('stopped');
    gated.release();
    await Promise.all([first, second]);
    expect(gated.calls.stop).toBe(1);
  });

  it('called while start() is still listening, waits for it and stops what it started', async () => {
    const gated = gatedSource();
    const hub = createLiveHub({ source: gated.source });
    const start = hub.start();
    const stop = hub.stop();
    const stopDone = track(stop);
    await settle();
    expect(stopDone()).toBe(false);
    gated.listen();
    await start;
    // The listener came up after stop(): it must still be torn down, and stop() waits for that.
    await settle();
    expect(gated.calls.stop).toBe(1);
    expect(stopDone()).toBe(false);
    gated.release();
    await stop;
    // A `ready` arriving late does not revive a stopped hub.
    gated.emit({ kind: 'ready' });
    expect(hub.status()).toBe('stopped');
  });

  it('clears the batch timer and ends blocked streams with bye', async () => {
    const source = fakeSource();
    const hub = createLiveHub({ source, limits: { batchMs: 50 } });
    await hub.start();
    source.emit({ kind: 'ready' });
    const streamFeed = await hub.open({ signal: new AbortController().signal });
    const stream = streamFeed[Symbol.asyncIterator]();
    await stream.next();
    const blocked = nextOf(stream);
    source.emit({ kind: 'change', tags: [tag('posts')], txid: '7' });
    expect(vi.getTimerCount()).toBe(1);
    await hub.stop();
    expect(vi.getTimerCount()).toBe(0);
    const frames = [await blocked, await nextOf(stream)];
    expect(frames).toEqual([{ kind: 'bye' }, undefined]);
    expect(hub.connections()).toBe(0);
  });
});

describe('a consumer that stops reading', () => {
  it('return() closes the stream: the hub forgets it, and nothing more comes', async () => {
    // Why: a tab that goes away must free its hub slot at once; a leak keeps a subscriber and its queue per dead tab.
    const source = fakeSource();
    const hub = createLiveHub({ source });
    await hub.start();
    source.emit({ kind: 'ready' });
    const feed = await hub.open({ signal: new AbortController().signal });
    const stream = feed[Symbol.asyncIterator]();
    expect(await nextOf(stream)).toMatchObject({ kind: 'begin' });
    expect(hub.connections()).toBe(1);
    await stream.return?.();
    expect(hub.connections()).toBe(0);
    expect(await nextOf(stream)).toBeUndefined();
    await hub.stop();
  });
});
