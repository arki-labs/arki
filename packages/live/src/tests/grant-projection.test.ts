/**
 * The grant applies before a stream's own batch window, queue and frame split
 * (scoped-hints plan, D3).
 *
 * Why these tests exist: the hub used to batch and queue every frame for every
 * stream, and the endpoint dropped hidden tables only on the way out. So
 * writes a client may not see still filled its queue (a slow client got `bye`
 * from them), opened or shortened its batch window (its frames came earlier),
 * and counted toward the 256-transaction early flush. Each of those tells a
 * client that hidden tables are being written. Here one visible history runs
 * twice, once quiet and once with heavy hidden traffic, on a fake clock: every
 * client must observe exactly the same thing both times.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveEvent, LiveManifest, TableTag } from '../index.js';
import type { SseReader } from './sse-reader.js';
import { liveEndpoint } from '../http.js';
import { createLiveHub } from '../index.js';
import { fakeSource } from '../testing.js';
import { cryptoBarrier } from './crypto-barrier.js';
import { RECEIPTS } from './fixtures.js';
import { sseReader } from './sse-reader.js';

const tag = (table: string): TableTag => ({ schema: 'public', table });
const POSTS = tag('posts');
const USERS = tag('users');
const SECRETS = tag('secrets');
const manifest: LiveManifest = [
  { path: ['posts', 'list'], reads: [POSTS] },
  { path: ['users', 'list'], reads: [USERS] },
  { path: ['secrets', 'list'], reads: [SECRETS] },
];
const BATCH_MS = 20;
const SUBSCRIBER_FRAMES = 4;

/** What a client can observe of one frame: when it could read it, and everything but the (random) cursor. */
type Seen = { readonly at: number; readonly kind: string; readonly tables?: string[]; readonly txids?: string[] };

function seen(frame: LiveEvent): Seen {
  const at = Date.now();
  if (frame.kind !== 'change') return { at, kind: frame.kind };
  return { at, kind: frame.kind, tables: frame.tags.map(each => each.table), txids: frame.txids };
}

/** Reads a stream for as long as it is not paused; a read already waiting still completes. */
function pump(reader: SseReader): { readonly frames: Seen[]; pause(): void; resume(): void } {
  const frames: Seen[] = [];
  let paused = false;
  async function loop(): Promise<void> {
    while (!paused) {
      const frame = await reader.next();
      if (frame === undefined) return;
      frames.push(seen(frame));
    }
  }
  void loop();
  return {
    frames,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      void loop();
    },
  };
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

/**
 * One visible history, as seen by X (grant: posts) and Y (grant: users), with or without hidden
 * traffic: writes to `secrets`, which neither may read. Visible commits have fixed txids, so their
 * receipts are the same in both runs. Times are ms from the start.
 */
async function run(hidden: boolean): Promise<{ readonly x: Seen[]; readonly y: Seen[] }> {
  const source = fakeSource();
  const hub = createLiveHub({
    source,
    limits: { batchMs: BATCH_MS, subscriberFrames: SUBSCRIBER_FRAMES },
    receipts: RECEIPTS,
  });
  await hub.start();
  source.emit({ kind: 'ready' });
  const endpoint = liveEndpoint({
    hub,
    manifest,
    authorize: request => Promise.resolve({ tables: [request.headers.get('x-table') === 'users' ? USERS : POSTS] }),
  });
  const open = async (table: string): Promise<SseReader> =>
    sseReader(await endpoint.fetch(new Request('http://live.test/api/live', { headers: { 'x-table': table } })));
  const start = Date.now();
  const clock = async (until: number): Promise<void> => {
    while (Date.now() - start < until) {
      vi.advanceTimersByTime(1);
      await barrier.settle();
    }
  };
  const visible = (table: TableTag, txid: number): void =>
    source.emit({ kind: 'change', tags: [table], txid: String(txid) });
  let hiddenTxid = 0;
  const secret = (): void => {
    hiddenTxid += 1;
    if (hidden) source.emit({ kind: 'change', tags: [SECRETS], txid: String(hiddenTxid) });
  };

  const readerX = await open('posts');
  const readerY = await open('users');
  const x = pump(readerX);
  const y = pump(readerY);
  await barrier.settle();

  // A hidden write opens a window; visible writes land inside it.
  await clock(10);
  secret();
  await clock(25);
  visible(POSTS, 1001);
  visible(USERS, 1002);

  // A visible write opens a window; 300 hidden transactions land inside it.
  await clock(100);
  visible(POSTS, 1003);
  await clock(105);
  visible(USERS, 1007);
  for (let index = 0; index < 300; index += 1) secret();

  // X stops reading: one frame waits in its response, one in its queue. Ten hidden windows pass.
  await clock(190);
  x.pause();
  await clock(200);
  visible(POSTS, 1004); // read by the read X had already started
  await clock(250);
  visible(POSTS, 1005); // waits in X's response
  for (let at = 300; at < 600; at += 30) {
    await clock(at);
    secret();
  }
  await clock(600);
  visible(POSTS, 1006); // waits in X's queue
  await clock(700);
  x.resume();
  await barrier.settle();
  await clock(800);

  for (const frames of [x.frames, y.frames]) {
    for (const [index, frame] of frames.entries()) frames[index] = { ...frame, at: frame.at - start };
  }
  await Promise.all([readerX.cancel(), readerY.cancel()]);
  await hub.stop();
  return { x: x.frames, y: y.frames };
}

const receipt = (txid: number): Promise<string> => RECEIPTS.of(String(txid));

describe('hidden traffic changes nothing a stream can observe', () => {
  it('many hidden frames for a slow client do not cause its bye, nor change its frame count or flush timing', async () => {
    const quiet = await run(false);
    const busy = await run(true);
    expect(busy.x).toEqual(quiet.x);
    expect(busy.x).toEqual([
      { at: 0, kind: 'hello' },
      // Its window opened by its own write at 25, not by the hidden one at 10.
      { at: 25 + BATCH_MS, kind: 'change', tables: ['posts'], txids: [await receipt(1001)] },
      // 300 hidden transactions inside its window do not close it early.
      { at: 100 + BATCH_MS, kind: 'change', tables: ['posts'], txids: [await receipt(1003)] },
      { at: 200 + BATCH_MS, kind: 'change', tables: ['posts'], txids: [await receipt(1004)] },
      // Ten hidden windows while it was not reading: no bye, both waiting frames arrive.
      { at: 700, kind: 'change', tables: ['posts'], txids: [await receipt(1005)] },
      { at: 700, kind: 'change', tables: ['posts'], txids: [await receipt(1006)] },
    ]);
  });

  it('two clients with different grants observe the same timing and queue behaviour whatever the hidden volume', async () => {
    const quiet = await run(false);
    const busy = await run(true);
    // For each client the other's table is hidden too: neither run may differ for either client.
    expect(busy).toEqual(quiet);
    expect(busy.y).toEqual([
      { at: 0, kind: 'hello' },
      { at: 25 + BATCH_MS, kind: 'change', tables: ['users'], txids: [await receipt(1002)] },
      { at: 105 + BATCH_MS, kind: 'change', tables: ['users'], txids: [await receipt(1007)] },
    ]);
  });
});
