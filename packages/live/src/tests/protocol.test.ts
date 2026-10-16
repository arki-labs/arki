/**
 * Protocol prototype (plan M0.2): the hub, `fakeSource()` and two scripted
 * clients. The property under test is convergence: whenever a write commits
 * — before the first fetch, between the fetch and the stream, during the
 * hello, while disconnected, with its hint delayed past any of those — every
 * client ends with fresh results, and the reset rules of § 5 decide how
 * (resume replays, everything else resets). The last suite drives the same
 * clients from raw SQL on PGlite through the § 4 triggers.
 */
import { setImmediate as macrotask } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveFeed, LiveHub, LiveLimits, LiveManifest, TableTag } from '../index.js';
import type { LiveQuery, ScriptedClient } from './scripted-client.js';
import { debugHub } from '../debug.js';
import { createLiveHub, LIVE_ERROR_CODES } from '../index.js';
import { fakeSource } from '../testing.js';
import { CHANNEL, parsePayload, RECEIPTS, TABLES_SQL, TRIGGERS_SQL } from './fixtures.js';
import { scriptedClient } from './scripted-client.js';

const BATCH_MS = 20;
const tag = (table: string): TableTag => ({ schema: 'public', table });
const manifest: LiveManifest = [
  { path: ['posts', 'list'], reads: [tag('posts'), tag('users')] },
  { path: ['users', 'count'], reads: [tag('users')] },
  { path: ['stats'], reads: [tag('posts')] },
];

const changesOf = (client: ScriptedClient): number => client.log.filter(entry => entry === 'change').length;

/**
 * A barrier: the hub seals every cursor it yields with WebCrypto, whose work finishes on a thread
 * pool at no fixed point of the event loop. `settle()` waits for every encrypt and decrypt in
 * flight, lets the stream pumps run, and repeats until a turn starts no new one.
 */
function cryptoBarrier(): { settle(): Promise<void>; restore(): void; encrypts(): number } {
  const inFlight = new Set<Promise<unknown>>();
  let encrypts = 0;
  const subtle = globalThis.crypto.subtle;
  const encrypt = subtle.encrypt.bind(subtle);
  const decrypt = subtle.decrypt.bind(subtle);
  function track<T>(promise: Promise<T>): Promise<T> {
    inFlight.add(promise);
    const forget = (): void => {
      inFlight.delete(promise);
    };
    promise.then(forget, forget);
    return promise;
  }
  const spies = [
    vi.spyOn(subtle, 'encrypt').mockImplementation((...args) => {
      encrypts += 1;
      return track(encrypt(...args));
    }),
    vi.spyOn(subtle, 'decrypt').mockImplementation((...args) => track(decrypt(...args))),
  ];
  return {
    async settle() {
      for (;;) {
        await macrotask();
        if (inFlight.size === 0) return;
        await Promise.allSettled(inFlight);
      }
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
    encrypts: () => encrypts,
  };
}

/** Lets every pending promise chain run (stream pumps, refetches, cursor seals). */
const barrier = cryptoBarrier();
const settle = (): Promise<void> => barrier.settle();
afterAll(() => barrier.restore());

/** A database of version counters: a commit bumps a table, its hint is delivered when the test says. */
function modelDatabase(source: ReturnType<typeof fakeSource>) {
  const versions = new Map<string, number>([
    ['posts', 0],
    ['users', 0],
  ]);
  const inFlight: string[] = [];
  const read = (tables: readonly string[]) => () =>
    Promise.resolve(tables.map(name => `${name}@${versions.get(name)}`).join(' '));
  return {
    queries: manifest.map((entry): LiveQuery => ({
      path: entry.path,
      read: read(entry.reads.map(reads => reads.table)),
    })),
    commit(table: string, deliver = true): void {
      versions.set(table, (versions.get(table) ?? 0) + 1);
      inFlight.push(table);
      if (deliver) this.deliver();
    },
    /** Hints of earlier commits reach the hub now (Postgres delivers them at or after commit). */
    deliver(): void {
      for (const table of inFlight.splice(0)) source.emit({ kind: 'change', tags: [tag(table)] });
    },
  };
}

function rig(limits: LiveLimits = {}) {
  const source = fakeSource();
  const hub = createLiveHub({ source, limits: { batchMs: BATCH_MS, ...limits }, receipts: RECEIPTS });
  const db = modelDatabase(source);
  const client = (): ScriptedClient => scriptedClient(hub, manifest, db.queries);
  return { source, hub, db, client };
}

async function startReady(hub: LiveHub, source: ReturnType<typeof fakeSource>): Promise<void> {
  await hub.start();
  source.emit({ kind: 'ready' });
}

const txidsOf = (frame: LiveFeed | undefined) => (frame?.kind === 'change' ? frame.txids : null);

/** Flush the batch window and let the streams drain. */
async function flush(): Promise<void> {
  vi.advanceTimersByTime(BATCH_MS);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('convergence across the handshake', () => {
  type Step = 'fetch' | 'connect' | 'disconnect' | 'flush' | 'settle';
  // Client A: fetch, stream, drop, a frame flushes while it is away, reconnect with its cursor.
  const scriptA: readonly Step[] = [
    'fetch',
    'connect',
    'settle',
    'flush',
    'settle',
    'disconnect',
    'flush',
    'settle',
    'connect',
    'settle',
    'flush',
    'settle',
  ];
  // Client B: connects late, drops while A is connected, comes back last.
  const scriptB: readonly Step[] = [
    'settle',
    'fetch',
    'settle',
    'connect',
    'flush',
    'settle',
    'settle',
    'disconnect',
    'settle',
    'flush',
    'connect',
    'settle',
  ];

  async function run(client: ScriptedClient, step: Step): Promise<void> {
    switch (step) {
      case 'fetch': {
        await client.fetchAll();
        return;
      }
      case 'connect': {
        expect(await client.connect()).toBe(true);
        return;
      }
      case 'disconnect': {
        await client.disconnect();
        return;
      }
      case 'flush': {
        await flush();
        return;
      }
      case 'settle': {
        await settle();
        return;
      }
    }
  }

  const cases: { table: string; commitAt: number; deliverAt: number }[] = [];
  for (const table of ['posts', 'users']) {
    for (let commitAt = 0; commitAt <= scriptA.length; commitAt += 1) {
      for (let deliverAt = commitAt; deliverAt <= scriptA.length; deliverAt += 1)
        cases.push({ table, commitAt, deliverAt });
    }
  }

  it(`every placement of a commit and of its hint converges for two clients (${cases.length} runs)`, async () => {
    for (const { table, commitAt, deliverAt } of cases) {
      const { source, hub, db, client } = rig();
      await startReady(hub, source);
      const a = client();
      const b = client();
      for (let index = 0; index <= scriptA.length; index += 1) {
        if (index === commitAt) db.commit(table, false);
        if (index === deliverAt) db.deliver();
        const stepA = scriptA[index];
        const stepB = scriptB[index];
        if (stepA) await run(a, stepA);
        if (stepB) await run(b, stepB);
      }
      await flush();
      await flush();
      const label = `${table} committed at ${commitAt}, hint at ${deliverAt}`;
      expect({ label, a: await a.stalePaths(), b: await b.stalePaths() }).toEqual({ label, a: [], b: [] });
      // Both reconnects stayed inside the ring, so they resumed; only the first connects reset.
      expect({ label, a: a.log.filter(entry => entry !== 'change') }).toEqual({ label, a: ['reset', 'resume'] });
      expect({ label, b: b.log.filter(entry => entry !== 'change') }).toEqual({ label, b: ['reset', 'resume'] });
      await hub.stop();
    }
  });
});

describe('reset rules', () => {
  it('a first connect has no cursor and resets: a write between the first fetch and the stream is refetched', async () => {
    const { source, hub, db, client } = rig();
    await startReady(hub, source);
    const a = client();
    await a.fetchAll();
    db.commit('posts');
    await flush(); // the frame is in the ring before the stream exists
    expect(await a.connect()).toBe(true);
    await settle();
    expect(a.log).toEqual(['reset']);
    expect(await a.stalePaths()).toEqual([]);
  });

  it('open() attaches at once: a frame flushed before the first read still reaches the stream', async () => {
    const { source, hub, db } = rig();
    await startReady(hub, source);
    // The endpoint opens the stream, then writes headers; the first read comes later.
    const feedFeed = await hub.open({ signal: new AbortController().signal });
    const feed = feedFeed[Symbol.asyncIterator]();
    db.commit('users');
    await flush();
    const first = await feed.next();
    expect(first.value).toMatchObject({ kind: 'begin', mode: 'reset', cursor: expect.stringMatching(/^[\w-]{75}$/) });
    const second = await feed.next();
    expect(second.value).toMatchObject({ kind: 'change', tags: [tag('users')] });
  });

  it('a reconnect inside the ring resumes and replays exactly the missed frames', async () => {
    const { source, hub, db, client } = rig();
    await startReady(hub, source);
    const a = client();
    await a.fetchAll();
    await a.connect();
    await settle();
    await a.disconnect();
    db.commit('posts');
    await flush();
    db.commit('users');
    await flush();
    expect(await a.connect()).toBe(true);
    await settle();
    expect(a.log).toEqual(['reset', 'resume', 'change', 'change']);
    expect(await a.stalePaths()).toEqual([]);
  });

  it('a dropped listener ends every stream with gap, refuses connects until ready, then every reconnect resets', async () => {
    const { source, hub, db, client } = rig();
    await startReady(hub, source);
    const a = client();
    const b = client();
    for (const each of [a, b]) {
      await each.fetchAll();
      await each.connect();
    }
    await settle();
    const oldCursor = a.cursor();

    source.emit({ kind: 'gap' });
    await settle();
    expect([a.log, b.log]).toEqual([
      ['reset', 'gap'],
      ['reset', 'gap'],
    ]);
    expect(hub.status()).toBe('unavailable');
    expect(hub.connections()).toBe(0);
    // A write during the gap: its hint is lost (no listener), which is why the next hello must reset.
    db.commit('posts');
    expect(await a.connect()).toBe(false);

    source.emit({ kind: 'ready' });
    expect(await a.connect()).toBe(true);
    expect(await b.connect()).toBe(true);
    await settle();
    expect(a.cursor()).not.toBe(oldCursor);
    expect([a.log.at(-1), b.log.at(-1)]).toEqual(['reset', 'reset']);
    expect([await a.stalePaths(), await b.stalePaths()]).toEqual([[], []]);
  });

  it('a second ready without a gap still ends the streams: continuity is unknown', async () => {
    const { source, hub, client } = rig();
    await startReady(hub, source);
    const a = client();
    await a.connect();
    await settle();
    source.emit({ kind: 'ready' });
    await settle();
    expect(a.log).toEqual(['reset', 'gap']);
    await a.connect();
    await settle();
    expect(a.log.at(-1)).toBe('reset');
  });

  it('resume or reset depends on the cursor age alone: thousands of frames still resume, an old cursor resets with nothing written', async () => {
    // Why (founder rule): frames of tables a client cannot see count too. If the number of frames
    // decided resume or reset, a reset would tell a client that many hidden writes happened. Only
    // the cursor's age decides, and the client knows that already.
    const { source, hub, client } = rig({ replayMs: 200_000 });
    await startReady(hub, source);
    const a = client();
    await a.fetchAll();
    await a.connect();
    await settle();
    await a.disconnect();
    // 5 000 frames (more than the old count bound of 4 096), 100 s in all, inside the age: it resumes.
    for (let frame = 0; frame < 5000; frame += 1) {
      source.emit({ kind: 'change', tags: [tag('users')] });
      vi.advanceTimersByTime(BATCH_MS);
    }
    await a.connect();
    await settle();
    expect(a.log).toEqual(['reset', 'resume', ...Array.from({ length: 5000 }, () => 'change')]);

    // Older than replayMs with no write at all since: it resets all the same.
    await a.disconnect();
    vi.advanceTimersByTime(200_001);
    await a.connect();
    await settle();
    expect(a.log.at(-1)).toBe('reset');
    expect(await a.stalePaths()).toEqual([]);
    await hub.stop();
  });

  it('a cursor exactly replayMs old resumes; one millisecond older resets', async () => {
    const { source, hub, db, client } = rig({ replayMs: 60_000 });
    await startReady(hub, source);
    const a = client();
    await a.fetchAll();
    await a.connect();
    await settle();
    await a.disconnect();
    db.commit('posts');
    await flush();
    vi.advanceTimersByTime(60_000 - BATCH_MS);
    await a.connect();
    await settle();
    expect(a.log).toEqual(['reset', 'resume', 'change']);
    await a.disconnect();
    // Its cursor is the change frame's, taken BATCH_MS after the first: still inside the age.
    vi.advanceTimersByTime(BATCH_MS);
    await a.connect();
    await settle();
    expect(a.log.at(-1)).toBe('resume');
    await a.disconnect();
    vi.advanceTimersByTime(1);
    await a.connect();
    await settle();
    expect(a.log.at(-1)).toBe('reset');
    await hub.stop();
  });

  it('the cap on the ring is an overload, not an eviction: a new epoch, every stream ends with gap, every client resets together', async () => {
    // Why: evicting the oldest frames at a cap would bring back the count leak for the clients
    // whose cursors fall off. A new epoch treats every client the same: it reveals only "overloaded".
    const warn = vi.spyOn(debugHub, 'warn');
    const { source, hub, db, client } = rig({ replayEnvelopes: 3 });
    await startReady(hub, source);
    const [a, b, c] = [client(), client(), client()];
    for (const each of [a, b, c]) {
      await each.fetchAll();
      await each.connect();
    }
    await settle();
    await c.disconnect(); // c is away, with a young cursor
    for (const table of ['posts', 'users', 'posts']) {
      db.commit(table);
      await flush();
    }
    expect(warn).not.toHaveBeenCalled();
    db.commit('users');
    await flush(); // the fourth frame meets a full ring
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ envelopes: 3, held: 3, streams: 2 });
    expect([a.log.at(-1), b.log.at(-1)]).toEqual(['gap', 'gap']);
    expect(hub.connections()).toBe(0);
    for (const each of [a, b, c]) await each.connect();
    await settle();
    expect([a.log.at(-1), b.log.at(-1), c.log.at(-1)]).toEqual(['reset', 'reset', 'reset']);
    for (const each of [a, b, c]) expect(await each.stalePaths()).toEqual([]);
    await hub.stop();
  });

  it('a cursor evicted by age resets', async () => {
    const { source, hub, db, client } = rig({ replayMs: 1000 });
    await startReady(hub, source);
    const a = client();
    await a.fetchAll();
    await a.connect();
    await settle();
    await a.disconnect();
    db.commit('posts');
    await flush();
    vi.advanceTimersByTime(1001);
    await a.connect();
    await settle();
    expect(a.log).toEqual(['reset', 'reset']);
    expect(await a.stalePaths()).toEqual([]);
  });

  it('a cursor this hub did not seal (another hub, a changed byte, the old epoch) resets; a malformed one is refused with E004', async () => {
    // Why: cursors are opaque. One the hub cannot open is unknown, like a cursor of another epoch,
    // and an unknown cursor must reset: it can never resume from a guessed position.
    const { source, hub } = rig();
    await startReady(hub, source);
    const first = async (cursor?: string): Promise<LiveFeed | undefined> => {
      const options = cursor === undefined ? {} : { cursor };
      for await (const item of await hub.open({ ...options, signal: new AbortController().signal })) return item;
      return undefined;
    };
    const begin = await first();
    const cursor = begin?.kind === 'begin' ? begin.cursor : '';
    expect(await first(cursor)).toMatchObject({ kind: 'begin', mode: 'resume' });

    // One character changed: the tag check fails, so it resets (not a 400: it is well-formed).
    const flipped = `${cursor.slice(0, 20)}${cursor[20] === 'A' ? 'B' : 'A'}${cursor.slice(21)}`;
    expect(await first(flipped)).toMatchObject({ kind: 'begin', mode: 'reset' });
    // Well-formed but not 75 characters of this hub's layout.
    expect(await first('a'.repeat(64))).toMatchObject({ kind: 'begin', mode: 'reset' });

    // Another hub's cursor, at the same position: a different key, so it resets.
    const other = rig();
    await startReady(other.hub, other.source);
    const foreign = await other.hub.cursor();
    expect(foreign).toMatch(/^[\w-]{75}$/);
    expect(await first(foreign)).toMatchObject({ kind: 'begin', mode: 'reset' });

    // The same hub after a listener gap: a new epoch, so the old cursor resets.
    source.emit({ kind: 'gap' });
    source.emit({ kind: 'ready' });
    expect(await first(cursor)).toMatchObject({ kind: 'begin', mode: 'reset' });

    await expect(hub.open({ cursor: 'not-a-cursor', signal: new AbortController().signal })).rejects.toMatchObject({
      code: LIVE_ERROR_CODES.protocol,
    });
    await expect(hub.open({ cursor: 'abcdefghijkl.1', signal: new AbortController().signal })).rejects.toMatchObject({
      code: LIVE_ERROR_CODES.protocol,
    });
    await Promise.all([hub.stop(), other.hub.stop()]);
  });

  it('hub.cursor() is undefined until ready, fresh on every call, and a client connecting with it misses no later commit', async () => {
    // Why (D4): a server-rendered page dehydrates this cursor; the client resumes from it. The
    // position is read at the call, so a commit after it (while the page renders) is replayed.
    const { source, hub, db } = rig();
    expect(await hub.cursor()).toBeUndefined();
    await startReady(hub, source);
    const page = hub.cursor();
    db.commit('posts');
    await flush();
    const [one, two] = [await page, await hub.cursor()];
    expect(one).not.toBe(two);
    const feedFeed = await hub.open({ cursor: one, signal: new AbortController().signal });
    const feed = feedFeed[Symbol.asyncIterator]();
    const { value: resumed } = await feed.next();
    expect(resumed).toMatchObject({ kind: 'begin', mode: 'resume' });
    const { value: replayed } = await feed.next();
    expect(replayed).toMatchObject({ kind: 'change', tags: [tag('posts')] });
    await hub.stop();
  });
});

describe('bounds and lifecycle', () => {
  it('a stream that falls behind gets bye instead of an unbounded queue, then resumes from its cursor', async () => {
    const { source, hub, db, client } = rig({ subscriberFrames: 2 });
    await startReady(hub, source);
    const stalledFeed = await hub.open({ signal: new AbortController().signal });
    const stalled = stalledFeed[Symbol.asyncIterator]();
    const begin = await stalled.next();
    expect(begin.value).toMatchObject({ kind: 'begin', mode: 'reset' });
    // It stops reading; three frames pass its limit of two.
    for (const table of ['posts', 'users', 'posts']) {
      db.commit(table);
      await flush();
    }
    // Queued frames are dropped: `bye` is all it gets, and the stream ends.
    const bye = await stalled.next();
    expect(bye.value).toEqual({ kind: 'bye' });
    const after = await stalled.next();
    expect(after.done).toBe(true);
    expect(hub.connections()).toBe(0);

    // A client at the stalled stream's cursor resumes and replays the three frames it never read.
    const a = client();
    await a.fetchAll();
    if (begin.value?.kind !== 'begin') throw new Error('expected begin');
    const replay: LiveFeed[] = [];
    for await (const item of await hub.open({ cursor: begin.value.cursor, signal: AbortSignal.timeout(60_000) })) {
      replay.push(item);
      if (replay.length === 4) break;
    }
    expect(replay.map(item => (item.kind === 'begin' ? item.mode : item.kind))).toEqual([
      'resume',
      'change',
      'change',
      'change',
    ]);
  });

  it('a write storm still flushes every window, with the tables of the window unioned', async () => {
    const { source, hub, db } = rig();
    await startReady(hub, source);
    const frames: LiveFeed[] = [];
    const controller = new AbortController();
    const pump = (async () => {
      for await (const item of await hub.open({ signal: controller.signal })) frames.push(item);
    })();
    for (let tick = 0; tick < 20; tick += 1) {
      db.commit(tick % 2 === 0 ? 'posts' : 'users');
      vi.advanceTimersByTime(5);
      await settle();
    }
    controller.abort();
    await pump;
    const changes = frames.filter(item => item.kind === 'change');
    expect(changes).toHaveLength(5); // 100 ms of writes, a 20 ms window
    for (const change of changes) expect(change.tags).toEqual([tag('posts'), tag('users')]);
    expect(new Set(changes.map(change => change.cursor)).size).toBe(5);
  });

  it('a frame carries, once each, the txids of exactly the commits that wrote its tables; replay keeps them; 256 commits flush at once', async () => {
    // Why: a client awaits its own write by txid (awaitTxId, M3); a dropped txid would never
    // resolve. And a txid on a frame of other tables would reveal writes a grant hides.
    const { source, hub } = rig();
    await startReady(hub, source);
    const feedFeed = await hub.open({ signal: new AbortController().signal });
    const feed = feedFeed[Symbol.asyncIterator]();
    const { value: begin } = await feed.next();
    source.emit({ kind: 'change', tags: [tag('posts')], txid: '9007199254740993' });
    source.emit({ kind: 'change', tags: [tag('users')], txid: '9007199254740993' });
    source.emit({ kind: 'change', tags: [tag('posts')], txid: '12' });
    await flush();
    const { value: first } = await feed.next();
    expect(first).toMatchObject({
      kind: 'change',
      tags: [tag('posts'), tag('users')],
      txids: [await RECEIPTS.of('9007199254740993'), await RECEIPTS.of('12')],
    });

    // 300 tables in one transaction: two frames, each naming it (it wrote tables of both).
    for (let index = 0; index < 300; index += 1) {
      source.emit({ kind: 'change', tags: [tag(`t${index}`)], txid: '13' });
    }
    await flush();
    const { value: head } = await feed.next();
    const { value: tail } = await feed.next();
    const thirteen = await RECEIPTS.of('13');
    expect([txidsOf(head), txidsOf(tail)]).toEqual([[thirteen], [thirteen]]);
    if (head?.kind !== 'change' || tail?.kind !== 'change') throw new Error('expected change');
    expect([head.tags.length, tail.tags.length]).toEqual([256, 44]);

    // 256 distinct transactions in one window: flushed without waiting for the timer.
    for (let index = 0; index < 256; index += 1) {
      source.emit({ kind: 'change', tags: [tag('posts')], txid: String(100 + index) });
    }
    await settle();
    const { value: storm } = await feed.next();
    expect(txidsOf(storm)).toHaveLength(256);

    // Replay from before the first frame: the ring kept its txids.
    const cursor = begin?.kind === 'begin' ? { cursor: begin.cursor } : {};
    const replay = await hub.open({ ...cursor, signal: new AbortController().signal });
    const replayed = replay[Symbol.asyncIterator]();
    const { value: resumed } = await replayed.next();
    expect(resumed).toMatchObject({ kind: 'begin', mode: 'resume' });
    const { value: again } = await replayed.next();
    // The same frame, cursor included: a frame is sealed once.
    expect(again).toEqual(first);
    await hub.stop();
  });

  it('a frame is sealed once however many streams get it: one AES-GCM call per frame, not per client', async () => {
    // Why: at 1 000 clients, sealing per stream is 1 000 encrypts per frame and dominates fan-out.
    // Sharing is safe: each client sees only its own stream, the frame number stays sealed, and
    // `begin` cursors are still fresh per stream.
    const { source, hub, db } = rig();
    await startReady(hub, source);
    const feeds = await Promise.all([1, 2, 3].map(() => hub.open({ signal: new AbortController().signal })));
    const streams = feeds.map(feed => feed[Symbol.asyncIterator]());
    const begins = await Promise.all(streams.map(stream => stream.next()));
    const before = barrier.encrypts();

    db.commit('posts');
    await flush();
    const results = await Promise.all(streams.map(stream => stream.next()));
    const frames = results.map(result => result.value);
    expect(barrier.encrypts() - before).toBe(1);
    const cursors = frames.map(frame => (frame?.kind === 'change' ? frame.cursor : undefined));
    expect(new Set(cursors).size).toBe(1);
    expect(cursors[0]).toMatch(/^[\w-]{75}$/);
    // Begin cursors of one position still differ per stream.
    expect(new Set(begins.map(begin => (begin.value?.kind === 'begin' ? begin.value.cursor : undefined))).size).toBe(3);

    // The shared cursor resumes like any other: nothing to replay after it.
    const resumedFeed = await hub.open({ cursor: cursors[0], signal: new AbortController().signal });
    const resumed = await resumedFeed[Symbol.asyncIterator]().next();
    expect(resumed.value).toMatchObject({ kind: 'begin', mode: 'resume' });
    await hub.stop();
  });

  it('stop ends blocked streams with bye and refuses new ones; an aborted stream detaches', async () => {
    const { source, hub, client } = rig();
    await startReady(hub, source);
    const a = client();
    await a.connect();
    const aborted = new AbortController();
    await hub.open({ signal: aborted.signal });
    expect(hub.connections()).toBe(2);
    aborted.abort();
    expect(hub.connections()).toBe(1);
    await settle();
    await hub.stop();
    await settle();
    expect(a.log).toEqual(['reset', 'bye']);
    expect(a.connected()).toBe(false);
    expect(hub.status()).toBe('stopped');
    await expect(hub.open({ signal: new AbortController().signal })).rejects.toMatchObject({
      code: LIVE_ERROR_CODES.source,
    });
    expect(() => source.emit({ kind: 'ready' })).toThrow(expect.objectContaining({ code: LIVE_ERROR_CODES.source }));
  });

  it('refuses bad limits and an epoch that repeats', async () => {
    expect(() => createLiveHub({ source: fakeSource(), limits: { batchMs: 0 } })).toThrow(
      expect.objectContaining({ code: LIVE_ERROR_CODES.config }),
    );
    const source = fakeSource();
    const hub = createLiveHub({ source, epoch: () => 'sameepoch123' });
    await hub.start();
    source.emit({ kind: 'ready' });
    expect(() => source.emit({ kind: 'ready' })).toThrow(expect.objectContaining({ code: LIVE_ERROR_CODES.config }));
    expect(hub.status()).toBe('unavailable');
  });
});

describe('demo: raw SQL on PGlite drives two scripted clients', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('commits converge; a dropped listener and an evicted cursor both reset', async () => {
    const pglite = new PGlite();
    await pglite.exec(TABLES_SQL + TRIGGERS_SQL);
    const source = fakeSource();
    const hub = createLiveHub({ source, limits: { replayMs: 60_000 } });
    let hints = 0;
    const listen = () =>
      pglite.listen(CHANNEL, payload => {
        hints += 1;
        source.emit({ kind: 'change', tags: [parsePayload(payload)] });
      });
    await hub.start();
    let unlisten = await listen();
    source.emit({ kind: 'ready' });

    const rowsOf = (text: string) => async () => {
      const result = await pglite.query(text);
      return JSON.stringify(result.rows);
    };
    const queries: LiveQuery[] = [
      {
        path: ['posts', 'list'],
        read: rowsOf('select p.id, u.name from posts p left join users u on u.id = p.author_id order by p.id'),
      },
      { path: ['users', 'count'], read: rowsOf('select count(*)::int as n from users') },
      { path: ['stats'], read: rowsOf('select count(*)::int as n from posts') },
    ];
    const a = scriptedClient(hub, manifest, queries);
    const b = scriptedClient(hub, manifest, queries);
    const fresh = async () => [...(await a.stalePaths()), ...(await b.stalePaths())];

    for (const client of [a, b]) {
      await client.fetchAll();
      await client.connect();
    }
    // Raw SQL: an autocommit insert, a multi-statement transaction, a rolled-back one.
    await pglite.query(`insert into users values ('u1', 'Ada')`);
    await pglite.exec(
      `begin; insert into posts values ('p1', 'One', 'u1'); insert into posts values ('p2', 'Two', 'u1'); commit;`,
    );
    await pglite.exec(`begin; insert into posts values ('p3', 'Never', 'u1'); rollback;`);
    await expect.poll(fresh).toEqual([]);
    expect(hints).toBe(2); // users, then posts once for the transaction; nothing for the rollback

    // B drops and comes back inside the ring: it resumes.
    await b.disconnect();
    await pglite.query(`update users set name = 'Grace'`);
    await expect.poll(() => changesOf(a)).toBeGreaterThanOrEqual(2);
    await b.connect();
    await expect.poll(fresh).toEqual([]);
    expect(b.log.filter(entry => entry !== 'change')).toEqual(['reset', 'resume']);

    // Dropped listener: the source loses LISTEN, a commit lands in the gap, LISTEN comes back.
    await unlisten();
    source.emit({ kind: 'gap' });
    await pglite.query(`insert into posts values ('p4', 'In the gap', 'u1')`);
    unlisten = await listen();
    source.emit({ kind: 'ready' });
    await expect.poll(() => [a.connected(), b.connected()]).toEqual([false, false]);
    expect([a.log.at(-1), b.log.at(-1)]).toEqual(['gap', 'gap']);
    await a.connect();
    await b.connect();
    await expect.poll(fresh).toEqual([]);
    expect([a.log.at(-1), b.log.at(-1)]).toEqual(['reset', 'reset']);

    // Evicted cursor: B is away longer than the ring's age while a commit lands.
    await b.disconnect();
    const before = changesOf(a);
    await pglite.query(`insert into posts values ('p5', 'p5', 'u1')`);
    await expect.poll(() => changesOf(a)).toBe(before + 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_001);
    await b.connect();
    vi.useRealTimers();
    await expect.poll(fresh).toEqual([]);
    expect(b.log.at(-1)).toBe('reset');

    await hub.stop();
    await unlisten();
    await pglite.close();
  });
});
