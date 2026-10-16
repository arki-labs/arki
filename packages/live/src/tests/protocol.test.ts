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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveFeed, LiveHub, LiveLimits, LiveManifest, TableTag } from '../index.js';
import type { LiveQuery, ScriptedClient } from './scripted-client.js';
import { createLiveHub, LIVE_ERROR_CODES } from '../index.js';
import { fakeSource } from '../testing.js';
import { CHANNEL, parsePayload, TABLES_SQL, TRIGGERS_SQL } from './fixtures.js';
import { scriptedClient } from './scripted-client.js';

const BATCH_MS = 20;
const tag = (table: string): TableTag => ({ schema: 'public', table });
const manifest: LiveManifest = [
  { path: ['posts', 'list'], reads: [tag('posts'), tag('users')] },
  { path: ['users', 'count'], reads: [tag('users')] },
  { path: ['stats'], reads: [tag('posts')] },
];

const changesOf = (client: ScriptedClient): number => client.log.filter(entry => entry === 'change').length;

/** Lets every pending promise chain run (stream pumps, refetches). */
const settle = (): Promise<void> => macrotask();

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
  const hub = createLiveHub({ source, limits: { batchMs: BATCH_MS, ...limits } });
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
        expect(client.connect()).toBe(true);
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
    expect(a.connect()).toBe(true);
    await settle();
    expect(a.log).toEqual(['reset']);
    expect(await a.stalePaths()).toEqual([]);
  });

  it('open() attaches at once: a frame flushed before the first read still reaches the stream', async () => {
    const { source, hub, db } = rig();
    await startReady(hub, source);
    // The endpoint opens the stream, then writes headers; the first read comes later.
    const feed = hub.open({ signal: new AbortController().signal })[Symbol.asyncIterator]();
    db.commit('users');
    await flush();
    const first = await feed.next();
    expect(first.value).toMatchObject({ kind: 'begin', mode: 'reset', cursor: expect.stringMatching(/\.0$/) });
    const second = await feed.next();
    expect(second.value).toMatchObject({ kind: 'change', tags: [tag('users')] });
  });

  it('a reconnect inside the ring resumes and replays exactly the missed frames', async () => {
    const { source, hub, db, client } = rig();
    await startReady(hub, source);
    const a = client();
    await a.fetchAll();
    a.connect();
    await settle();
    await a.disconnect();
    db.commit('posts');
    await flush();
    db.commit('users');
    await flush();
    expect(a.connect()).toBe(true);
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
      each.connect();
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
    expect(a.connect()).toBe(false);

    source.emit({ kind: 'ready' });
    expect(a.connect()).toBe(true);
    expect(b.connect()).toBe(true);
    await settle();
    expect(a.cursor()).not.toBe(oldCursor);
    expect([a.log.at(-1), b.log.at(-1)]).toEqual(['reset', 'reset']);
    expect([await a.stalePaths(), await b.stalePaths()]).toEqual([[], []]);
  });

  it('a second ready without a gap still ends the streams: continuity is unknown', async () => {
    const { source, hub, client } = rig();
    await startReady(hub, source);
    const a = client();
    a.connect();
    await settle();
    source.emit({ kind: 'ready' });
    await settle();
    expect(a.log).toEqual(['reset', 'gap']);
    a.connect();
    await settle();
    expect(a.log.at(-1)).toBe('reset');
  });

  it('a cursor evicted by count resets; the oldest cursor still covered resumes', async () => {
    const { source, hub, db, client } = rig({ replayFrames: 2 });
    await startReady(hub, source);
    const a = client();
    await a.fetchAll();
    a.connect();
    await settle();
    await a.disconnect(); // cursor at frame 0
    db.commit('posts');
    await flush(); // frame 1
    db.commit('users');
    await flush(); // frame 2: the ring holds 1..2, so cursor 0 is the exact boundary
    a.connect();
    await settle();
    expect(a.log).toEqual(['reset', 'resume', 'change', 'change']);

    await a.disconnect(); // cursor at frame 2
    for (const table of ['posts', 'users', 'posts']) {
      db.commit(table);
      await flush(); // frames 3, 4, 5: frame 3 is evicted
    }
    a.connect();
    await settle();
    expect(a.log.slice(4)).toEqual(['reset']);
    expect(await a.stalePaths()).toEqual([]);
  });

  it('a cursor evicted by age resets', async () => {
    const { source, hub, db, client } = rig({ replayMs: 1000 });
    await startReady(hub, source);
    const a = client();
    await a.fetchAll();
    a.connect();
    await settle();
    await a.disconnect();
    db.commit('posts');
    await flush();
    vi.advanceTimersByTime(1001);
    a.connect();
    await settle();
    expect(a.log).toEqual(['reset', 'reset']);
    expect(await a.stalePaths()).toEqual([]);
  });

  it('a cursor of another epoch or from the future resets; a malformed one is refused with E004', async () => {
    const { source, hub } = rig();
    await startReady(hub, source);
    const first = async (cursor: string): Promise<LiveFeed | undefined> => {
      for await (const item of hub.open({ cursor, signal: new AbortController().signal })) return item;
      return undefined;
    };
    expect(await first('aaaaaaaaaaaa.0')).toMatchObject({ kind: 'begin', mode: 'reset' });
    const begin = await first('aaaaaaaaaaaa.0');
    const epoch = begin?.kind === 'begin' ? begin.cursor.split('.')[0] : '';
    expect(await first(`${epoch}.0`)).toMatchObject({ kind: 'begin', mode: 'resume' });
    expect(await first(`${epoch}.7`)).toMatchObject({ kind: 'begin', mode: 'reset' });
    expect(() => hub.open({ cursor: 'not-a-cursor', signal: new AbortController().signal })).toThrow(
      expect.objectContaining({ code: LIVE_ERROR_CODES.protocol }),
    );
  });
});

describe('bounds and lifecycle', () => {
  it('a stream that falls behind gets bye instead of an unbounded queue, then resumes from its cursor', async () => {
    const { source, hub, db, client } = rig({ subscriberFrames: 2 });
    await startReady(hub, source);
    const stalled = hub.open({ signal: new AbortController().signal })[Symbol.asyncIterator]();
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
    for await (const item of hub.open({ cursor: begin.value.cursor, signal: AbortSignal.timeout(60_000) })) {
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
      for await (const item of hub.open({ signal: controller.signal })) frames.push(item);
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
    expect(changes.map(change => change.cursor.split('.')[1])).toEqual(['1', '2', '3', '4', '5']);
  });

  it('a frame carries the txids of its commits once each, on the last frame of a batch; replay keeps them; 256 commits flush at once', async () => {
    // Why: a client awaits its own write by txid (awaitTxId, M3); a dropped or early txid would
    // resolve before the queries it touched were invalidated, or never.
    const { source, hub } = rig();
    await startReady(hub, source);
    const feed = hub.open({ signal: new AbortController().signal })[Symbol.asyncIterator]();
    const { value: begin } = await feed.next();
    source.emit({ kind: 'change', tags: [tag('posts')], txid: '9007199254740993' });
    source.emit({ kind: 'change', tags: [tag('users')], txid: '9007199254740993' });
    source.emit({ kind: 'change', tags: [tag('posts')], txid: '12' });
    await flush();
    const { value: first } = await feed.next();
    expect(first).toMatchObject({
      kind: 'change',
      tags: [tag('posts'), tag('users')],
      txids: ['9007199254740993', '12'],
    });

    // 300 tables in one transaction: two frames, the txid on the second.
    for (let index = 0; index < 300; index += 1) {
      source.emit({ kind: 'change', tags: [tag(`t${index}`)], txid: '13' });
    }
    await flush();
    const { value: head } = await feed.next();
    const { value: tail } = await feed.next();
    expect([txidsOf(head), txidsOf(tail)]).toEqual([[], ['13']]);

    // 256 distinct transactions in one window: flushed without waiting for the timer.
    for (let index = 0; index < 256; index += 1) {
      source.emit({ kind: 'change', tags: [tag('posts')], txid: String(100 + index) });
    }
    await settle();
    const { value: storm } = await feed.next();
    expect(txidsOf(storm)).toHaveLength(256);

    // Replay from before the first frame: the ring kept its txids.
    const cursor = begin?.kind === 'begin' ? { cursor: begin.cursor } : {};
    const replay = hub.open({ ...cursor, signal: new AbortController().signal });
    const replayed = replay[Symbol.asyncIterator]();
    const { value: resumed } = await replayed.next();
    expect(resumed).toMatchObject({ kind: 'begin', mode: 'resume' });
    const { value: again } = await replayed.next();
    expect(again).toEqual(first);
    await hub.stop();
  });

  it('stop ends blocked streams with bye and refuses new ones; an aborted stream detaches', async () => {
    const { source, hub, client } = rig();
    await startReady(hub, source);
    const a = client();
    a.connect();
    const aborted = new AbortController();
    hub.open({ signal: aborted.signal });
    expect(hub.connections()).toBe(2);
    aborted.abort();
    expect(hub.connections()).toBe(1);
    await settle();
    await hub.stop();
    await settle();
    expect(a.log).toEqual(['reset', 'bye']);
    expect(a.connected()).toBe(false);
    expect(hub.status()).toBe('stopped');
    expect(() => hub.open({ signal: new AbortController().signal })).toThrow(
      expect.objectContaining({ code: LIVE_ERROR_CODES.source }),
    );
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
    const hub = createLiveHub({ source, limits: { replayFrames: 2 } });
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
      client.connect();
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
    b.connect();
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
    a.connect();
    b.connect();
    await expect.poll(fresh).toEqual([]);
    expect([a.log.at(-1), b.log.at(-1)]).toEqual(['reset', 'reset']);

    // Evicted cursor: B is away for three separate frames; the ring keeps two.
    await b.disconnect();
    for (const id of ['p5', 'p6', 'p7']) {
      const before = changesOf(a);
      await pglite.query(`insert into posts values ('${id}', '${id}', 'u1')`);
      await expect.poll(() => changesOf(a)).toBe(before + 1);
    }
    b.connect();
    await expect.poll(fresh).toEqual([]);
    expect(b.log.at(-1)).toBe('reset');

    await hub.stop();
    await unlisten();
    await pglite.close();
  });
});
