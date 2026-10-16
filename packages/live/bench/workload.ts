// One workload, five ways to keep clients fresh. Every count here is deterministic: it comes from
// a seeded commit log and virtual time, never from a clock.
//
// The app: tenants, each with one open tab (its own `QueryClient`) watching six queries:
// `posts.list` (reads posts, users), three `posts.get` (posts, likes), `comments.list` (comments,
// users) and `users.me` (users). `likes` is the hot table: half of all commits. Hints name tables,
// not rows or tenants, so a write by one tenant refetches every tenant's queries on that table.
//
// The strategies, over the same commits:
//
// - `live` (Lane A): the real hub batches the commits into frames (window = batchMs, 20 ms by
//   default); each frame invalidates, in every client, the oRPC paths that read one of its tables
//   (`affectedPaths`, then `invalidateQueries({ queryKey: [path] })`, the calls `LiveProvider` makes).
// - `collection` (Lane B): the same frames and the same invalidation, but each query feeds a
//   TanStack DB query collection (`queryCollectionOptions`) instead of a `QueryObserver`.
// - `invalidate-all`: the same frames, but every frame invalidates every query.
// - `poll-1s`, `poll-5s`: no hints; TanStack Query `refetchInterval`.
//
// Time is virtual: TanStack Query's own timers go through `timeoutManager.setTimeoutProvider`, and
// `environmentManager.setIsServer(() => false)` lets `refetchInterval` run outside a browser (both
// are public TanStack APIs for this). Origin queries answer at once, so staleness counts only how
// long a strategy waits before it asks. The hub runs on real time with a 1 ms window, but its
// frames are deterministic: each window's commits are emitted together before its timer fires.
//
// Not here: an Electric collection (TanStack DB's row-sync lane). It needs Postgres with
// `wal_level=logical` and the Electric sync service, which this repo cannot start without new
// services, so it is left out rather than faked.
import type { QueryKey, TimeoutProvider } from '@tanstack/react-query';
import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { environmentManager, QueryClient, QueryObserver, timeoutManager } from '@tanstack/react-query';

import type { LiveManifest, TableTag } from '@arki/live';
import { affectedPaths, createLiveHub, liveReceipts } from '@arki/live';
import { fakeSource } from '@arki/live/testing';

export type Strategy = 'live' | 'collection' | 'invalidate-all' | 'poll-1s' | 'poll-5s';

export type Workload = {
  readonly id: string;
  readonly tenants: number;
  readonly seconds: number;
  /** Commits per tenant per second. */
  readonly rate: number;
  readonly seed: number;
};

export const workloads: readonly Workload[] = [
  { id: 'tenants-20', tenants: 20, seconds: 30, rate: 0.5, seed: 24_301 },
  { id: 'tenants-200', tenants: 200, seconds: 30, rate: 0.5, seed: 24_301 },
];

/** The hub's default batch window, in virtual ms. */
const BATCH_MS = 20;

type Table = 'posts' | 'comments' | 'users' | 'likes';
const tag = (table: Table): TableTag => ({ schema: 'public', table });

const MANIFEST: LiveManifest = [
  { path: ['posts', 'list'], reads: [tag('posts'), tag('users')] },
  { path: ['posts', 'get'], reads: [tag('posts'), tag('likes')] },
  { path: ['comments', 'list'], reads: [tag('comments'), tag('users')] },
  { path: ['users', 'me'], reads: [tag('users')] },
];

/** Row counts per tenant. */
const ROWS: Readonly<Record<Table, number>> = { posts: 5, comments: 5, users: 2, likes: 5 };
/** Share of commits per table: `likes` is hot. */
const WEIGHTS: readonly (readonly [Table, number])[] = [
  ['likes', 0.5],
  ['posts', 0.2],
  ['comments', 0.2],
  ['users', 0.1],
];

type Row = { readonly id: string; readonly value: string };
type Procedure = 'posts.list' | 'posts.get' | 'comments.list' | 'users.me';
type Query = { readonly procedure: Procedure; readonly input: string; readonly reads: readonly Table[] };
type Commit = { readonly at: number; readonly table: Table; readonly row: string };
type Frame = { readonly at: number; readonly tags: readonly TableTag[] };

/** mulberry32: a small seeded generator, so every run makes the same commit log. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 1_831_565_813) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function commitLog(workload: Workload): readonly Commit[] {
  const random = seeded(workload.seed);
  const count = Math.round(workload.tenants * workload.rate * workload.seconds);
  const commits: Commit[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = Math.floor(random() * workload.seconds * 1000);
    let pick = random();
    let table: Table = 'likes';
    for (const [name, weight] of WEIGHTS) {
      table = name;
      if (pick < weight) break;
      pick -= weight;
    }
    const tenant = Math.floor(random() * workload.tenants);
    commits.push({ at, table, row: `t${tenant}.${table}${Math.floor(random() * ROWS[table])}` });
  }
  return commits.toSorted((a, b) => a.at - b.at);
}

function queriesOf(tenant: number): readonly Query[] {
  const t = `t${tenant}`;
  return [
    { procedure: 'posts.list', input: t, reads: ['posts', 'users'] },
    { procedure: 'posts.get', input: `${t}.posts0`, reads: ['posts', 'likes'] },
    { procedure: 'posts.get', input: `${t}.posts1`, reads: ['posts', 'likes'] },
    { procedure: 'posts.get', input: `${t}.posts2`, reads: ['posts', 'likes'] },
    { procedure: 'comments.list', input: t, reads: ['comments', 'users'] },
    { procedure: 'users.me', input: `${t}.users0`, reads: ['users'] },
  ];
}

/** The origin: row versions, and what each procedure returns from them. */
function database() {
  const versions = new Map<string, number>();
  const version = (row: string): number => versions.get(row) ?? 0;
  const rowsOf = (tenant: string, table: Table): Row[] =>
    Array.from({ length: ROWS[table] }, (_, index) => {
      const id = `${tenant}.${table}${index}`;
      return { id, value: String(version(id)) };
    });
  function answer(query: Query): Row[] {
    switch (query.procedure) {
      case 'posts.list': {
        const author = version(`${query.input}.users0`);
        return rowsOf(query.input, 'posts').map(row => ({ id: row.id, value: `${row.value}/${author}` }));
      }
      case 'posts.get': {
        const likes = version(query.input.replace('.posts', '.likes'));
        return [{ id: query.input, value: `${version(query.input)}/${likes}` }];
      }
      case 'comments.list': {
        const author = version(`${query.input}.users1`);
        return rowsOf(query.input, 'comments').map(row => ({ id: row.id, value: `${row.value}/${author}` }));
      }
      case 'users.me': {
        return [{ id: query.input, value: String(version(query.input)) }];
      }
    }
  }
  return {
    answer,
    write(row: string): void {
      versions.set(row, version(row) + 1);
    },
  };
}

// ---- Virtual time for TanStack Query.

type Timer = { due: number; readonly every: number | undefined; readonly callback: () => void };

function virtualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, Timer>();
  const add = (callback: () => void, delay: number, every: number | undefined): number => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { due: now + Math.max(0, delay), every, callback });
    return id;
  };
  const remove = (id: number | undefined): void => {
    if (id !== undefined) timers.delete(id);
  };
  const provider: TimeoutProvider<number> = {
    setTimeout: (callback, delay) => add(callback, delay, undefined),
    clearTimeout: remove,
    setInterval: (callback, delay) => add(callback, delay, Math.max(1, delay)),
    clearInterval: remove,
  };
  return {
    provider,
    now: () => now,
    reset(): void {
      timers.clear();
      now = 0;
    },
    /** Runs every timer due by `until`, one instant at a time, settling after each instant. */
    async advanceTo(until: number, settle: () => Promise<void>): Promise<void> {
      for (;;) {
        let next = Number.POSITIVE_INFINITY;
        for (const timer of timers.values()) next = Math.min(next, timer.due);
        if (next > until) break;
        now = next;
        for (const [id, timer] of timers.entries()) {
          if (timer.due !== next || !timers.has(id)) continue;
          if (timer.every === undefined) timers.delete(id);
          else timer.due += timer.every;
          timer.callback();
        }
        await settle();
      }
      now = until;
    },
  };
}

let clock: ReturnType<typeof virtualClock> | undefined;

/** Installs virtual time into TanStack Query once per process (nothing else in this suite uses TanStack timers). */
function tanstackClock(): ReturnType<typeof virtualClock> {
  if (clock === undefined) {
    clock = virtualClock();
    timeoutManager.setTimeoutProvider(clock.provider);
    environmentManager.setIsServer(() => false);
  }
  return clock;
}

/** Subscribers only keep queries active: the counts are taken in `queryFn`. */
function ignore(): void {
  // Nothing to do.
}

const macrotask = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

// ---- Frames from the real hub.

const frameLogs = new Map<string, Promise<readonly Frame[]>>();

/** Each window: the commits from its first one until `BATCH_MS` later, emitted together, and the hub's frame for them. */
async function framesOf(workload: Workload, commits: readonly Commit[]): Promise<readonly Frame[]> {
  const source = fakeSource();
  // With receipts, as in production: each frame names its window's transactions.
  const receipts = liveReceipts({ app: 'bench', secret: 'bench-only-secret-of-32-characters-01' });
  const hub = createLiveHub({ source, limits: { batchMs: 1 }, receipts });
  await hub.start();
  source.emit({ kind: 'ready' });
  const detach = new AbortController();
  const opened = await hub.open({ signal: detach.signal });
  const feed = opened[Symbol.asyncIterator]();
  await feed.next();
  const frames: Frame[] = [];
  let index = 0;
  while (index < commits.length) {
    const start = commits[index]?.at ?? 0;
    const window: Commit[] = [];
    while (index < commits.length && (commits[index]?.at ?? 0) < start + BATCH_MS) {
      const commit = commits[index];
      if (commit) window.push(commit);
      index += 1;
    }
    const next = feed.next();
    for (const [offset, commit] of window.entries()) {
      source.emit({ kind: 'change', tags: [tag(commit.table)], txid: String(index - window.length + offset + 1) });
    }
    const frame = await next;
    if (frame.done || frame.value.kind !== 'change' || frame.value.txids.length !== window.length) {
      throw new Error(`${workload.id}: the hub split or lost the window starting at ${start} ms`);
    }
    frames.push({ at: start + BATCH_MS, tags: frame.value.tags });
  }
  detach.abort();
  await hub.stop();
  return frames;
}

function frameLog(workload: Workload, commits: readonly Commit[]): Promise<readonly Frame[]> {
  let log = frameLogs.get(workload.id);
  if (log === undefined) {
    log = framesOf(workload, commits);
    frameLogs.set(workload.id, log);
  }
  return log;
}

// ---- One simulation.

export type Outcome = {
  readonly commits: number;
  /** Origin queries after the first load. */
  readonly fetches: number;
  /** Origin queries whose answer equalled the client's previous one. */
  readonly wasted: number;
  /** For every change to a watched result: ms until the client asked again (cut at the end of the run). */
  readonly staleness: readonly number[];
};

type Tracker = { served: string | undefined; pendingSince: number | undefined; truth: string };

async function simulate(workload: Workload, strategy: Strategy): Promise<Outcome> {
  const time = tanstackClock();
  time.reset();
  const commits = commitLog(workload);
  const frames = strategy.startsWith('poll') ? [] : await frameLog(workload, commits);
  const db = database();
  const end = workload.seconds * 1000 + 1000;
  const interval = strategy === 'poll-1s' ? 1000 : strategy === 'poll-5s' ? 5000 : false;

  let counting = false;
  let fetches = 0;
  let wasted = 0;
  const staleness: number[] = [];
  const trackers = new Map<string, Tracker>();
  const watched: { readonly query: Query; readonly tracker: Tracker }[] = [];
  const clients: QueryClient[] = [];
  const releases: (() => unknown)[] = [];
  const collections: { readonly query: Query; readonly rows: () => readonly Row[] }[] = [];

  function queryFn(query: Query): Row[] {
    const rows = db.answer(query);
    const text = JSON.stringify(rows);
    const tracker = trackers.get(`${query.procedure}:${query.input}`);
    if (tracker === undefined) throw new Error(`untracked query ${query.procedure}(${query.input})`);
    if (counting) {
      fetches += 1;
      if (text === tracker.served) wasted += 1;
    }
    if (tracker.pendingSince !== undefined) staleness.push(time.now() - tracker.pendingSince);
    tracker.pendingSince = undefined;
    tracker.served = text;
    return rows;
  }

  for (let tenant = 0; tenant < workload.tenants; tenant += 1) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(queryClient);
    for (const query of queriesOf(tenant)) {
      const tracker: Tracker = { served: undefined, pendingSince: undefined, truth: JSON.stringify(db.answer(query)) };
      trackers.set(`${query.procedure}:${query.input}`, tracker);
      watched.push({ query, tracker });
      const queryKey: QueryKey = [query.procedure.split('.'), { input: query.input }];
      if (strategy === 'collection') {
        const collection = createCollection(
          queryCollectionOptions({
            id: `${query.procedure}:${query.input}`,
            queryKey,
            queryFn: () => Promise.resolve(queryFn(query)),
            queryClient,
            getKey: (row: Row) => row.id,
          }),
        );
        const subscription = collection.subscribeChanges(ignore);
        releases.push(
          () => subscription.unsubscribe(),
          () => collection.cleanup(),
        );
        collections.push({ query, rows: () => collection.toArray });
      } else {
        const observer = new QueryObserver(queryClient, {
          queryKey,
          queryFn: () => Promise.resolve(queryFn(query)),
          refetchInterval: interval,
        });
        releases.push(observer.subscribe(ignore));
      }
    }
  }

  async function settle(): Promise<void> {
    for (let round = 0; round < 1000; round += 1) {
      await macrotask();
      if (clients.every(queryClient => queryClient.isFetching() === 0)) return;
    }
    throw new Error(`${workload.id}/${strategy}: fetches did not settle`);
  }

  await settle();
  counting = true;

  function apply(frame: Frame): void {
    for (const queryClient of clients) {
      if (strategy === 'invalidate-all') {
        void queryClient.invalidateQueries();
        continue;
      }
      for (const path of affectedPaths(MANIFEST, frame.tags)) void queryClient.invalidateQueries({ queryKey: [path] });
    }
  }

  function write(commit: Commit): void {
    db.write(commit.row);
    for (const { query, tracker } of watched) {
      if (!query.reads.includes(commit.table)) continue;
      const truth = JSON.stringify(db.answer(query));
      if (truth !== tracker.truth) tracker.pendingSince ??= commit.at;
      tracker.truth = truth;
    }
  }

  // Frames before commits at the same ms: a commit exactly at a window's end opens the next window.
  let commitAt = 0;
  let frameAt = 0;
  while (commitAt < commits.length || frameAt < frames.length) {
    const commit = commits[commitAt];
    const frame = frames[frameAt];
    if (frame && (!commit || frame.at <= commit.at)) {
      await time.advanceTo(frame.at, settle);
      apply(frame);
      await settle();
      frameAt += 1;
    } else if (commit) {
      await time.advanceTo(commit.at, settle);
      write(commit);
      commitAt += 1;
    }
  }
  await time.advanceTo(end, settle);
  await settle();

  for (const { query, tracker } of watched) {
    if (tracker.pendingSince === undefined) continue;
    if (!strategy.startsWith('poll')) {
      throw new Error(`${workload.id}/${strategy}: ${query.procedure}(${query.input}) is stale after the last frame`);
    }
    staleness.push(end - tracker.pendingSince);
  }
  // Lane B: what each collection holds must be the origin's answer, row for row.
  await macrotask();
  for (const { query, rows } of collections) {
    // Only the row's own fields: TanStack DB adds `$synced`, `$key` and other virtual ones.
    const held = JSON.stringify(
      rows()
        .map(row => ({ id: row.id, value: row.value }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    );
    if (held !== JSON.stringify(db.answer(query))) {
      throw new Error(`${workload.id}/collection: ${query.procedure}(${query.input}) holds ${held}`);
    }
  }

  for (const release of releases) await release();
  for (const queryClient of clients) queryClient.clear();
  time.reset();
  return { commits: commits.length, fetches, wasted, staleness };
}

/** Simulations share one virtual clock, so they run one at a time; each runs once per process (it is deterministic). */
let queue: Promise<unknown> = Promise.resolve();
const outcomes = new Map<string, Promise<Outcome>>();

export function outcome(workload: Workload, strategy: Strategy): Promise<Outcome> {
  const key = `${workload.id}:${strategy}`;
  let made = outcomes.get(key);
  if (made === undefined) {
    made = queue.then(() => simulate(workload, strategy));
    queue = made.then(ignore, ignore);
    outcomes.set(key, made);
  }
  return made;
}

export const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
