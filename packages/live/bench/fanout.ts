// Fan-out fixtures: one hub, N open streams, and a commit hint that must reach every one of them.
//
// Two paths per stream count, both real code end to end:
//
// - `hub`: the hub's own feed (`hub.open`). The cost of batching, the replay ring, one shared
//   AES-GCM cursor seal per frame (real WebCrypto) and waking N async iterators.
// - `endpoint`: the same hub behind `liveEndpoint(...).fetch`, read by `createLiveClient`. Adds the
//   grant filter (a per-tag check on every frame), SSE encoding by `@arki/http`, and the client's
//   SSE framing and frame validation. In process: no sockets.
//
// Streams open on the first call (the contract check), never inside a timed call. `arki-bench list`
// and `check` import this file and exit, so nothing may hold a timer before a group runs.
//
// The replay cap. The hub keeps frames for `replayMs` and treats `replayFrames` as an overload cap:
// reaching it starts a new epoch, and every stream ends with `gap`. Frames per second are at most
// 1000 / batchMs, plus commits per second / 256 in a window that holds more than 256 transactions,
// times ceil(tables per window / 256). So choose the cap ≥ replayMs / 1000 × that rate. Here every
// call is one commit of one table, batchMs is 1 and replayMs is 10 s: at most 1000 frames per
// second, so the ring holds at most 10 000 frames, under the default cap. Hitting it would end the
// streams with `gap`, and the call would throw instead of returning a wrong count.
import type { LiveCursor, LiveEvent, LiveFeed, LiveManifest, LiveSourceEvent, TableTag } from '@arki/live';
import { createLiveClient, createLiveHub } from '@arki/live';
import { liveEndpoint } from '@arki/live/http';
import { fakeSource } from '@arki/live/testing';

/** One commit hint: the table it wrote and its transaction id. */
export type Commit = { readonly table: string; readonly txid: string };

/** What one stream got for one commit, with the opaque cursor reduced to "is a non-empty string". */
export type Delivered = {
  readonly kind: string;
  readonly tags: readonly TableTag[];
  readonly txids: readonly string[];
  readonly cursor: boolean;
};

const tag = (table: string): TableTag => ({ schema: 'public', table });

export const TABLES = ['posts', 'comments', 'users'] as const;

const MANIFEST: LiveManifest = [
  { path: ['posts', 'list'], reads: [tag('posts'), tag('users')] },
  { path: ['comments', 'list'], reads: [tag('comments'), tag('users')] },
];

/** The grant lists every table, so the filter runs on each tag and drops none: both paths deliver the same frame. */
const GRANT = { tables: TABLES.map(table => tag(table)) };

/** The smallest batch window the hub allows, so the timer adds as little as it can to every row. */
const FANOUT_LIMITS = { batchMs: 1, replayMs: 10_000 } as const;

/** The stream outlives any run: no `bye` from max age while timing. */
const MAX_AGE_MS = 86_400_000;

export const commits: readonly Commit[] = [
  { table: 'posts', txid: '101' },
  { table: 'comments', txid: '102' },
  { table: 'users', txid: '103' },
];

/** The frame every stream must get for `commit`. */
export function expectedFrame(commit: Commit): Delivered {
  return { kind: 'change', tags: [tag(commit.table)], txids: [commit.txid], cursor: true };
}

function delivered(frame: LiveFeed | LiveEvent | undefined): Delivered {
  if (frame?.kind !== 'change') return { kind: frame?.kind ?? 'ended', tags: [], txids: [], cursor: false };
  return { kind: frame.kind, tags: frame.tags, txids: frame.txids, cursor: frame.cursor.length > 0 };
}

function changeEvent(commit: Commit): LiveSourceEvent {
  return { kind: 'change', tags: [tag(commit.table)], txid: commit.txid };
}

/** Frames as a client hands them over, one `next()` at a time. */
function eventQueue(): { push(event: LiveEvent): void; next(): Promise<LiveEvent> } {
  const queued: LiveEvent[] = [];
  let waiting: ((event: LiveEvent) => void) | undefined;
  return {
    push(event) {
      const resolve = waiting;
      waiting = undefined;
      if (resolve) resolve(event);
      else queued.push(event);
    },
    next() {
      const event = queued.shift();
      if (event) return Promise.resolve(event);
      return new Promise(resolve => {
        waiting = resolve;
      });
    },
  };
}

async function readyHub(limits: { readonly batchMs: number; readonly replayMs: number }) {
  const source = fakeSource();
  const hub = createLiveHub({ source, limits });
  await hub.start();
  source.emit({ kind: 'ready' });
  return { source, hub };
}

/** Commits one hint, then waits until every stream has its next frame. Resolves with the frames in stream order. */
export type Fanout = { readonly streams: number; commit(commit: Commit): Promise<readonly Delivered[]> };

/** Per-stream arrival time of one commit's frame, in ms after the hint. */
export type TimedFanout = Fanout & { timedCommit(commit: Commit): Promise<readonly number[]> };

async function hubFanout(streams: number): Promise<TimedFanout> {
  const { source, hub } = await readyHub(FANOUT_LIMITS);
  const iterators: AsyncIterator<LiveFeed>[] = [];
  for (let index = 0; index < streams; index += 1) {
    const feed = await hub.open({ signal: new AbortController().signal });
    const iterator = feed[Symbol.asyncIterator]();
    const begin = await iterator.next();
    if (begin.done || begin.value.kind !== 'begin') throw new Error(`stream ${index} did not begin`);
    iterators.push(iterator);
  }
  return {
    streams,
    async commit(commit) {
      const frames = iterators.map(iterator => iterator.next());
      source.emit(changeEvent(commit));
      const results = await Promise.all(frames);
      return results.map(result => delivered(result.done ? undefined : result.value));
    },
    async timedCommit(commit) {
      const start = performance.now();
      const arrivals = iterators.map(iterator => iterator.next().then(() => performance.now() - start));
      source.emit(changeEvent(commit));
      return Promise.all(arrivals);
    },
  };
}

async function endpointFanout(streams: number): Promise<TimedFanout> {
  const { source, hub } = await readyHub(FANOUT_LIMITS);
  const endpoint = liveEndpoint({
    hub,
    manifest: MANIFEST,
    authorize: () => Promise.resolve(GRANT),
    maxAgeMs: MAX_AGE_MS,
  });
  const queues = Array.from({ length: streams }, () => eventQueue());
  for (const queue of queues) {
    createLiveClient({
      url: 'http://live.bench/api/live',
      fetch: (input, init) => endpoint.fetch(new Request(input, init)),
      onEvent: event => queue.push(event),
    }).start();
  }
  for (const [index, queue] of queues.entries()) {
    const hello = await queue.next();
    if (hello.kind !== 'hello') throw new Error(`client ${index} got ${hello.kind} before hello`);
  }
  return {
    streams,
    async commit(commit) {
      const frames = queues.map(queue => queue.next());
      source.emit(changeEvent(commit));
      const events = await Promise.all(frames);
      return events.map(frame => delivered(frame));
    },
    async timedCommit(commit) {
      const start = performance.now();
      const arrivals = queues.map(queue => queue.next().then(() => performance.now() - start));
      source.emit(changeEvent(commit));
      return Promise.all(arrivals);
    },
  };
}

const fanouts = new Map<string, Promise<TimedFanout>>();

/** The fixture of one path and stream count, opened once per process. */
export function fanout(path: 'hub' | 'endpoint', streams: number): Promise<TimedFanout> {
  const key = `${path}:${streams}`;
  let made = fanouts.get(key);
  if (made === undefined) {
    made = path === 'hub' ? hubFanout(streams) : endpointFanout(streams);
    fanouts.set(key, made);
  }
  return made;
}

// ---- Reconnect storm: N clients come back at once with the same cursor and replay what they missed.

/** Frames committed after the storm's cursor, each its own frame. */
export const MISSED_TABLES: readonly string[] = Array.from(
  { length: 16 },
  (_, index) => TABLES[index % TABLES.length] ?? 'posts',
);

/** What one resumed stream saw: its begin mode and the tables of the replayed frames, in order. */
export type Resumed = { readonly mode: string; readonly tables: readonly string[] };

export function expectedResume(): Resumed {
  return { mode: 'resume', tables: MISSED_TABLES };
}

type Storm = {
  readonly cursor: LiveCursor;
  readonly hub: ReturnType<typeof createLiveHub>;
  readonly endpoint: ReturnType<typeof liveEndpoint>;
};

async function makeStorm(): Promise<Storm> {
  // Frames must not age out while a long run times the storm.
  const { source, hub } = await readyHub({ batchMs: 1, replayMs: MAX_AGE_MS });
  const cursor = await hub.cursor();
  if (cursor === undefined) throw new Error('the storm hub is not ready');
  const watcher = new AbortController();
  const watched = await hub.open({ signal: watcher.signal });
  const feed = watched[Symbol.asyncIterator]();
  await feed.next();
  for (const [index, table] of MISSED_TABLES.entries()) {
    // One commit per window, so each is its own frame.
    const frame = feed.next();
    source.emit(changeEvent({ table, txid: String(1000 + index) }));
    await frame;
  }
  watcher.abort();
  const endpoint = liveEndpoint({
    hub,
    manifest: MANIFEST,
    authorize: () => Promise.resolve(GRANT),
    maxAgeMs: MAX_AGE_MS,
  });
  return { cursor, hub, endpoint };
}

let storm: Promise<Storm> | undefined;
const stormFixture = (): Promise<Storm> => (storm ??= makeStorm());

function tableOf(frame: LiveFeed | LiveEvent): string {
  return frame.kind === 'change' ? (frame.tags[0]?.table ?? '') : frame.kind;
}

/** `streams` hub feeds open with the storm cursor at once; each reads its begin and the replay, then detaches. */
export async function stormHub(streams: number): Promise<readonly Resumed[]> {
  const { cursor, hub } = await stormFixture();
  async function resume(): Promise<Resumed> {
    const detach = new AbortController();
    const opened = await hub.open({ cursor, signal: detach.signal });
    const feed = opened[Symbol.asyncIterator]();
    const begin = await feed.next();
    const mode = begin.done ? 'ended' : begin.value.kind === 'begin' ? begin.value.mode : begin.value.kind;
    const tables: string[] = [];
    for (const _missed of MISSED_TABLES) {
      const frame = await feed.next();
      tables.push(frame.done ? 'ended' : tableOf(frame.value));
    }
    detach.abort();
    return { mode, tables };
  }
  return Promise.all(Array.from({ length: streams }, () => resume()));
}

/** `streams` clients reconnect through the endpoint with the storm cursor at once; each stops after the replay. */
export async function stormEndpoint(streams: number): Promise<readonly Resumed[]> {
  const { cursor, endpoint } = await stormFixture();
  async function resume(): Promise<Resumed> {
    const queue = eventQueue();
    const client = createLiveClient({
      url: 'http://live.bench/api/live',
      fetch: (input, init) => endpoint.fetch(new Request(input, init)),
      cursor,
      onEvent: event => queue.push(event),
    });
    client.start();
    const hello = await queue.next();
    const mode = hello.kind === 'hello' ? hello.mode : hello.kind;
    const tables: string[] = [];
    for (const _missed of MISSED_TABLES) tables.push(tableOf(await queue.next()));
    client.stop();
    return { mode, tables };
  }
  return Promise.all(Array.from({ length: streams }, () => resume()));
}

/** Resolves once every storm stream has detached from the hub (untimed: the contract check uses it to prove no stream leaks). */
export async function stormDrained(): Promise<boolean> {
  const { hub } = await stormFixture();
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (hub.connections() === 0) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

/** The value at `fraction` of the sorted samples (nearest rank). */
export function percentile(samples: readonly number[], fraction: number): number {
  const sorted = samples.toSorted((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] ?? 0;
}
