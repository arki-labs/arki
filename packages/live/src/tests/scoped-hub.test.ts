/**
 * The hub with scoped tables: each stream projects every envelope through
 * its view by (table, key) before its own batch window, queue and split
 * (scoped-hints plan § 2.3, tests T6–T9).
 *
 * Why these tests exist: on a scoped table every tenant writes the same
 * table. If the hub kept only granted *tables*, a write of tenant B would
 * still reach tenant A's stream: open its window, fill its queue (a slow
 * client gets `bye`), name B's receipt or B's key. Each case here is one way
 * B's activity could become visible to A, and one way a split or a resume
 * could lose a key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveFeed, LiveLimits, LiveView, TableTag } from '../index.js';
import { createLiveHub } from '../index.js';
import { fakeSource } from '../testing.js';
import { cryptoBarrier } from './crypto-barrier.js';
import { RECEIPTS } from './fixtures.js';

const tag = (table: string): TableTag => ({ schema: 'public', table });
const POSTS = tag('posts');
const LIKES = tag('likes');
const BATCH_MS = 20;

/** A view of the `org` dimension on posts and likes. */
const org = (keys: readonly string[] | 'all'): LiveView => ({
  scopes: [POSTS, LIKES].map(table => ({ tag: table, name: 'org', keys })),
});

/** What a client can observe of one item: when it arrived, and everything but the random cursor (only its length). */
type Seen = {
  readonly at: number;
  readonly kind: string;
  readonly mode?: string;
  readonly tags?: readonly string[];
  readonly txids?: readonly string[];
  readonly cursor?: number;
};

function seen(item: LiveFeed, at: number): Seen {
  switch (item.kind) {
    case 'begin': {
      return { at, kind: item.kind, mode: item.mode, cursor: item.cursor.length };
    }
    case 'change': {
      const tags = item.tags.map(each =>
        each.scope ? `${each.table}:${each.scope.name}:${each.scope.keys.join(',')}` : each.table,
      );
      // Receipts carry no order: compare them as a set.
      return { at, kind: item.kind, tags, txids: item.txids.toSorted(), cursor: item.cursor.length };
    }
    default: {
      return { at, kind: item.kind };
    }
  }
}

let barrier: ReturnType<typeof cryptoBarrier>;
beforeEach(() => {
  barrier = cryptoBarrier();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  barrier.restore();
});

async function rig(limits?: LiveLimits) {
  const source = fakeSource();
  const hub = createLiveHub({ source, limits: { batchMs: BATCH_MS, ...limits }, receipts: RECEIPTS });
  await hub.start();
  source.emit({ kind: 'ready' });
  const start = Date.now();
  const clock = async (until: number): Promise<void> => {
    while (Date.now() - start < until) {
      vi.advanceTimersByTime(1);
      await barrier.settle();
    }
  };
  /** Reads a stream while not paused, keeping each item with its time; a read already waiting still completes. */
  const pump = async (view: LiveView, cursor?: string) => {
    const abort = new AbortController();
    const feed = await hub.open({ ...(cursor === undefined ? {} : { cursor }), view, signal: abort.signal });
    const iterator = feed[Symbol.asyncIterator]();
    const items: { readonly at: number; readonly item: LiveFeed }[] = [];
    let paused = false;
    const loop = async (): Promise<void> => {
      while (!paused) {
        const next = await iterator.next();
        if (next.done) return;
        items.push({ at: Date.now() - start, item: next.value });
      }
    };
    void loop();
    await barrier.settle();
    return {
      items,
      seen: () => items.map(({ at, item }) => seen(item, at)),
      changes: () => items.flatMap(({ item }) => (item.kind === 'change' ? [item] : [])),
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
        void loop();
      },
      abort: () => abort.abort(),
    };
  };
  const write = (txid: number, ...tags: readonly (TableTag & { readonly keys?: readonly string[] })[]): void =>
    source.emit({ kind: 'change', tags, txid: String(txid) });
  return { source, hub, clock, pump, write };
}

const receipt = (txid: number): Promise<string> => RECEIPTS.of(String(txid));
const keys = (count: number, prefix = 'k'): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

/** Tenant A reads slowly; tenant B writes 10 000 transactions to the same table. Times are ms from the start. */
async function run(hidden: boolean) {
  const { hub, clock, pump, write } = await rig({ subscriberFrames: 4 });
  const a = await pump(org(['A']));
  let hiddenTxid = 100_000;
  const flood = (count: number): void => {
    for (let index = 0; index < count; index += 1) if (hidden) write((hiddenTxid += 1), { ...POSTS, keys: ['B'] });
  };
  await clock(10);
  flood(5000); // opens no window of A's
  await clock(25);
  write(1001, { ...POSTS, keys: ['A'] });
  await clock(60);
  a.pause();
  await clock(70);
  write(1002, { ...POSTS, keys: ['A'] }); // read by the read A had already started
  flood(5000); // while A does not read: many hidden windows' worth, no bye
  await clock(150);
  write(1003, { ...POSTS, keys: ['A'] }); // waits in A's queue
  await clock(300);
  a.resume();
  await clock(400);
  const last = a.changes().at(-1);
  a.abort();
  // The resume decision for A's last cursor does not depend on the flood either.
  const again = await pump(org(['A']), last?.cursor);
  await clock(450);
  const result = { live: a.seen(), resumed: again.seen(), ring: hub.connections() };
  again.abort();
  await hub.stop();
  return result;
}

describe('T6: a hidden-key flood changes nothing a stream can observe', () => {
  it('the same frames, keys, receipts, times, cursor lengths and resume decision, and no bye', async () => {
    const quiet = await run(false);
    const busy = await run(true);
    expect(busy).toEqual(quiet);
    expect(busy.live).toEqual([
      { at: 0, kind: 'begin', mode: 'reset', cursor: 75 },
      { at: 25 + BATCH_MS, kind: 'change', tags: ['posts:org:A'], txids: [await receipt(1001)], cursor: 75 },
      { at: 70 + BATCH_MS, kind: 'change', tags: ['posts:org:A'], txids: [await receipt(1002)], cursor: 75 },
      // Queued while A did not read; delivered once it reads again.
      { at: 301, kind: 'change', tags: ['posts:org:A'], txids: [await receipt(1003)], cursor: 75 },
    ]);
    expect(busy.resumed).toEqual([{ at: 400, kind: 'begin', mode: 'resume', cursor: 75 }]);
  });
});

describe('T7: a frame carries only granted keys, and the receipts of the transactions that wrote them', () => {
  it('org [A] gets A only; org [C] gets nothing; all gets both; a keyless change of a keyed table shows only to all', async () => {
    const { hub, clock, pump, write } = await rig();
    const [a, c, all] = [await pump(org(['A'])), await pump(org(['C'])), await pump(org('all'))];
    write(1, { ...POSTS, keys: ['A', 'B'] });
    write(2, { ...POSTS, keys: ['B'] });
    write(3, POSTS);
    await clock(BATCH_MS + 5);
    expect(a.seen().slice(1)).toEqual([
      { at: BATCH_MS, kind: 'change', tags: ['posts:org:A'], txids: [await receipt(1)], cursor: 75 },
    ]);
    expect(c.seen().slice(1)).toEqual([]);
    const receipts = await Promise.all([1, 2, 3].map(async txid => receipt(txid)));
    const all3 = receipts.toSorted();
    expect(all.seen().slice(1)).toEqual([{ at: BATCH_MS, kind: 'change', tags: ['posts'], txids: all3, cursor: 75 }]);
    await hub.stop();
  });

  it('a keyed change of a table the view has no keys for is hidden, even with every table granted', async () => {
    const { hub, clock, pump, write } = await rig();
    const unscoped = await pump({});
    write(1, { ...POSTS, keys: ['A'] });
    write(2, LIKES);
    await clock(BATCH_MS + 5);
    expect(unscoped.seen().slice(1)).toEqual([
      { at: BATCH_MS, kind: 'change', tags: ['likes'], txids: [await receipt(2)], cursor: 75 },
    ]);
    await hub.stop();
  });
});

describe('T8: projection keeps (table, key) pairs', () => {
  it('(posts, A) and (likes, B) in one window: org [A] gets posts [A] only, not likes', async () => {
    const { hub, clock, pump, write } = await rig();
    const a = await pump(org(['A']));
    write(1, { ...POSTS, keys: ['A'] });
    write(2, { ...LIKES, keys: ['B'] });
    await clock(BATCH_MS + 5);
    expect(a.seen().slice(1)).toEqual([
      { at: BATCH_MS, kind: 'change', tags: ['posts:org:A'], txids: [await receipt(1)], cursor: 75 },
    ]);
    await hub.stop();
  });
});

describe('T9: a big projection splits at 1024 keys, and a disconnect mid-split replays the whole window', () => {
  it('3000 keys in three frames; resuming from the first part replays all three', async () => {
    const { hub, clock, pump, write } = await rig();
    const changed = keys(3000);
    const admin = await pump(org('all'));
    write(7, { ...POSTS, keys: changed });
    await clock(BATCH_MS + 5);
    const parts = admin.changes();
    expect(parts.map(part => part.tags.map(each => each.scope?.keys.length))).toEqual([[1024], [1024], [952]]);
    expect(parts.flatMap(part => part.tags.flatMap(each => each.scope?.keys ?? []))).toEqual(changed);
    for (const part of parts) expect(part.txids).toEqual([await receipt(7)]);
    admin.abort();

    const resumed = await pump(org('all'), parts[0]?.cursor);
    await clock(BATCH_MS + 10);
    expect(resumed.items[0]?.item).toMatchObject({ kind: 'begin', mode: 'resume' });
    expect(resumed.changes().flatMap(part => part.tags.flatMap(each => each.scope?.keys ?? []))).toEqual(changed);
    await hub.stop();
  });
});

describe('envelopes: one per transaction while it is open', () => {
  it('changes of one transaction join one envelope until a position at it is handed out; a later one is a new envelope a resume replays', async () => {
    const { hub, clock, pump, write } = await rig();
    const a = await pump(org(['A', 'B']));
    write(5, { ...POSTS, keys: ['A'] });
    write(5, { ...POSTS, keys: ['B'] }, { ...POSTS, keys: ['A'] });
    await clock(BATCH_MS + 5);
    expect(a.seen().slice(1)).toEqual([
      { at: BATCH_MS, kind: 'change', tags: ['posts:org:A,B'], txids: [await receipt(5)], cursor: 75 },
    ]);
    // The frame above handed out envelope 1's position: a late change of txid 5 is envelope 2.
    const sealed = a.changes()[0]?.cursor;
    write(5, { ...LIKES, keys: ['A'] });
    await clock(2 * BATCH_MS + 10);
    expect(a.changes()[1]?.tags).toEqual([{ ...LIKES, scope: { name: 'org', keys: ['A'] } }]);
    a.abort();
    const resumed = await pump(org(['A', 'B']), sealed);
    await clock(3 * BATCH_MS + 10);
    expect(resumed.changes().map(change => change.tags)).toEqual([[{ ...LIKES, scope: { name: 'org', keys: ['A'] } }]]);
    await hub.stop();
  });

  it('the ring caps estimated bytes too: reaching the cap is an overload, every stream ends with gap', async () => {
    const { hub, clock, pump, write } = await rig({ replayBytes: 4096 });
    const a = await pump(org('all'));
    write(1, { ...POSTS, keys: keys(10) });
    await clock(BATCH_MS + 5);
    expect(a.changes()).toHaveLength(1);
    write(2, { ...POSTS, keys: keys(200, 'long-key-') });
    await clock(2 * BATCH_MS + 10);
    expect(a.items.at(-1)?.item).toEqual({ kind: 'gap' });
    const after = await pump(org('all'), a.changes()[0]?.cursor);
    expect(after.items[0]?.item).toMatchObject({ kind: 'begin', mode: 'reset' });
    await hub.stop();
  });
});
