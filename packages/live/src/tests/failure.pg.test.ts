/**
 * The failure matrix (plan § 8) on real Postgres 16 and 18 (testcontainers),
 * with the writer, the reader and each listener on pools of their own, the way
 * production runs. One test per named scenario. `write-paths` and
 * `snapshot-stability` live next to the code they prove
 * (`pg/source.pg.test.ts`, `tests/snapshot.pg.test.ts`), and so does `pool-exhaustion`
 * ("the hub is ready only after LISTEN succeeds", `pg/source.pg.test.ts`); `revoked-session` and
 * the account switch need React (`tests/session.pg.test.ts`).
 *
 * Why this suite exists: a live query is only as good as its worst moment. A
 * commit that lands while a client connects, replays or refetches; a
 * listener that dies; a client that moves to another server; a hub that
 * restarts or is overloaded — in each, a client must either receive the hint
 * or reset. Never stay stale in silence.
 *
 * Barriers, not sleeps: a held pool client keeps `LISTEN` from running, a
 * role without LOGIN keeps the listener from coming back, a gated read holds
 * a refetch after its SELECT, an open transaction holds a commit. Waits are on
 * conditions (`expect.poll`, a frame on a watching stream), never on time.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { oc } from '@orpc/contract';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineApp, DotLifecycleError } from '@arki/dot';
import { plugin } from '@arki/dot/plugin';

import type { LiveFeed, LiveHub, LiveLimits, LiveManifest, LiveMeta, TableTag } from '../index.js';
import type { LiveQuery, ScriptedClient } from './scripted-client.js';
import { debugHub } from '../debug.js';
import { liveQueries } from '../dot.js';
import { liveEndpoint } from '../http.js';
import { createLiveHub, live, LIVE_ERROR_CODES } from '../index.js';
import { liveMigration, pgSource, touch, verifyLiveTriggers } from '../pg/index.js';
import { RECEIPTS } from './fixtures.js';
import { scriptedClient } from './scripted-client.js';
import { sseReader } from './sse-reader.js';

const tag = (table: string): TableTag => ({ schema: 'public', table });
const POSTS = tag('posts');
const USERS = tag('users');
/** A view: no trigger can see it, so writers `touch` it. */
const POST_TITLES = tag('post_titles');
/** Declared by a procedure, but its migration was never run. */
const ARCHIVE = tag('archive');

const manifest: LiveManifest = [
  { path: ['posts', 'list'], reads: [POSTS] },
  { path: ['users', 'list'], reads: [USERS] },
  { path: ['posts', 'titles'], reads: [POST_TITLES] },
];
const LISTENER_ROLE = 'live_listener';

type Deferred = { readonly promise: Promise<void>; resolve(): void };
const noop = (): void => undefined;
function deferred(): Deferred {
  let resolve = noop;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A raw stream on the hub that reads every frame: the test's view of what the hub sent. */
type Watcher = { readonly frames: LiveFeed[]; until(seen: (frame: LiveFeed) => boolean): Promise<void>; stop(): void };

async function watcher(hub: LiveHub): Promise<Watcher> {
  const frames: LiveFeed[] = [];
  const abort = new AbortController();
  const feed = await hub.open({ signal: abort.signal });
  void (async () => {
    for await (const frame of feed) frames.push(frame);
  })();
  return {
    frames,
    until: seen => expect.poll(() => frames.some(frame => seen(frame)), { timeout: 10_000 }).toBe(true),
    stop: () => abort.abort(),
  };
}

const hasTag = (table: TableTag) => (frame: LiveFeed) =>
  frame.kind === 'change' && frame.tags.some(each => each.table === table.table);
/** Connects and waits until the stream's first frame was handled, so the client holds a cursor of this stream. */
async function join(each: ScriptedClient, target?: LiveHub): Promise<boolean> {
  const before = each.log.length;
  const ok = await each.connect(target);
  if (ok) await expect.poll(() => each.log.length, { timeout: 10_000 }).toBeGreaterThan(before);
  return ok;
}
const converged = (each: ScriptedClient) => expect.poll(() => each.stalePaths(), { timeout: 10_000 }).toEqual([]);
const hasTxId = (receipt: string) => (frame: LiveFeed) => frame.kind === 'change' && frame.txids.includes(receipt);

describe.each(['postgres:16-alpine', 'postgres:18-alpine'])('%s', image => {
  let container: StartedPostgreSqlContainer;
  let writer: pg.Pool;
  let reader: pg.Pool;
  let listenUri: string;
  const pools: pg.Pool[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  let serial = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(image).start();
    writer = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
    reader = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
    await writer.query(`
      create table posts (id text primary key, title text not null);
      create table users (id text primary key, name text not null);
      create view post_titles as select title from posts;
      create role ${LISTENER_ROLE} login password 'listener';
    `);
    await writer.query(liveMigration({ app: 'blog', tables: [POSTS, USERS] }).up);
    const uri = new URL(container.getConnectionUri());
    uri.username = LISTENER_ROLE;
    uri.password = 'listener';
    listenUri = uri.toString();
  }, 180_000);

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  afterAll(async () => {
    await Promise.all([writer.end(), reader.end(), ...pools.map(pool => pool.end())]);
    await container.stop();
  });

  /** The listener's pool of one, as the listener role, its backend named `name` so a test can kill it. */
  function listenPool(name: string): pg.Pool {
    const pool = new pg.Pool({ connectionString: listenUri, max: 1, application_name: name });
    pool.on('error', () => null);
    pools.push(pool);
    return pool;
  }

  async function startHub(name: string, limits: LiveLimits = {}): Promise<{ hub: LiveHub; pool: pg.Pool }> {
    const pool = listenPool(name);
    const hub = createLiveHub({
      source: pgSource({ pool, app: 'blog', retryMs: 20 }),
      limits: { batchMs: 5, ...limits },
      receipts: RECEIPTS,
    });
    cleanups.push(() => hub.stop());
    await hub.start();
    await expect.poll(() => hub.status(), { timeout: 10_000 }).toBe('ready');
    return { hub, pool };
  }

  const kill = (name: string) =>
    writer.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1', [name]);

  /** Inserts a post; resolves with its transaction's receipt, as a mutation would return it. */
  const insertPost = async (title: string): Promise<string> => {
    serial += 1;
    const result = await writer.query<{ txid: string }>(
      'insert into posts values ($1, $2) returning pg_current_xact_id()::text as txid',
      [`p${serial}`, title],
    );
    return RECEIPTS.of(result.rows[0]?.txid ?? '');
  };
  const insertUser = async (name: string): Promise<void> => {
    serial += 1;
    await writer.query('insert into users values ($1, $2)', [`u${serial}`, name]);
  };

  /**
   * The live queries, with a gate: `hold()` stops every read right after its SELECT, so its result
   * is already stale. `posts.titles` (the view) is left out: only `touch` publishes it, which the
   * untracked-table test covers.
   */
  function gatedQueries() {
    let gate: Promise<void> | undefined;
    let started: (() => void) | undefined;
    const rows = (text: string) => async (): Promise<string> => {
      const result = await reader.query(text);
      started?.();
      await gate;
      return JSON.stringify(result.rows);
    };
    const queries: readonly LiveQuery[] = [
      { path: ['posts', 'list'], read: rows('select id, title from posts order by id') },
      { path: ['users', 'list'], read: rows('select id, name from users order by id') },
    ];
    return {
      queries,
      hold() {
        const release = deferred();
        const read = deferred();
        gate = release.promise;
        started = () => read.resolve();
        // A test that fails while a read is held must not leave the client's pump blocked.
        cleanups.push(() => Promise.resolve(release.resolve()));
        return {
          /** Resolves once a held read has run its SELECT. */
          read: read.promise,
          release() {
            gate = undefined;
            started = undefined;
            release.resolve();
          },
        };
      },
    };
  }

  function client(hub: LiveHub, queries = gatedQueries().queries): ScriptedClient {
    const each = scriptedClient(hub, manifest, queries);
    cleanups.push(() => each.disconnect());
    return each;
  }

  it('commit-around-listen: commits before LISTEN, during auth, during replay and during a refetch all reach the client', async () => {
    // Before LISTEN: the listener's only pool client is taken, so the hub is not ready yet.
    const pool = listenPool('around_listener');
    const held = await pool.connect();
    const hub = createLiveHub({
      source: pgSource({ pool, app: 'blog', retryMs: 20 }),
      limits: { batchMs: 5 },
      receipts: RECEIPTS,
    });
    cleanups.push(() => hub.stop());
    // `start()` settles once the first LISTEN ran, which needs the held client.
    const starting = hub.start();
    const gated = gatedQueries();
    const a = client(hub, gated.queries);
    await a.fetchAll();
    await insertPost('before listen');
    expect(await join(a)).toBe(false);
    held.release();
    await starting;
    expect(hub.status()).toBe('ready');
    expect(await join(a)).toBe(true);
    await converged(a);

    // During auth: the stream's authorize is held while a commit lands. The cursor resumes and the
    // replay carries the commit.
    const watch = await watcher(hub);
    cleanups.push(() => Promise.resolve(watch.stop()));
    const authorizing = deferred();
    const authorized = deferred();
    const endpoint = liveEndpoint({
      hub,
      manifest,
      authorize: async () => {
        authorizing.resolve();
        await authorized.promise;
        return {};
      },
    });
    await a.disconnect();
    const pending = endpoint.fetch(new Request(`http://live.test/api/live?cursor=${a.cursor() ?? ''}`));
    await authorizing.promise;
    const duringAuth = await insertPost('during auth');
    await watch.until(hasTxId(duringAuth));
    authorized.resolve();
    const stream = sseReader(await pending);
    expect(await stream.next()).toMatchObject({ kind: 'hello', mode: 'resume' });
    expect(await stream.next()).toMatchObject({ kind: 'change', tags: [POSTS], txids: [duringAuth] });
    await stream.cancel();

    // During replay: the refetch for a replayed frame is held after its SELECT; another commit lands.
    const replaying = gated.hold();
    expect(await join(a)).toBe(true);
    await replaying.read;
    const duringReplay = await insertPost('during replay');
    await watch.until(hasTxId(duringReplay));
    replaying.release();
    await converged(a);
    expect(a.log.slice(-3)).toEqual(['resume', 'change', 'change']);

    // During a refetch: a live client's refetch is held after its SELECT; the next commit lands.
    const refetching = gated.hold();
    await insertPost('starts a refetch');
    await refetching.read;
    const duringRefetch = await insertPost('during refetch');
    await watch.until(hasTxId(duringRefetch));
    refetching.release();
    await converged(a);
  });

  it('reverse-commit-order: two transactions that commit opposite to their start order both reach the client', async () => {
    const { hub } = await startHub('reverse_listener');
    const watch = await watcher(hub);
    cleanups.push(() => Promise.resolve(watch.stop()));
    const a = client(hub);
    await a.fetchAll();
    await join(a);
    const first = await writer.connect();
    const second = await writer.connect();
    try {
      await first.query('begin');
      const early = await first.query<{ txid: string }>(
        `insert into posts values ('rev1', 'started first') returning pg_current_xact_id()::text as txid`,
      );
      await second.query('begin');
      const late = await second.query<{ txid: string }>(
        `insert into posts values ('rev2', 'started second') returning pg_current_xact_id()::text as txid`,
      );
      const earlyTxId = await RECEIPTS.of(early.rows[0]?.txid ?? '');
      const lateTxId = await RECEIPTS.of(late.rows[0]?.txid ?? '');
      await second.query('commit');
      await watch.until(hasTxId(lateTxId));
      // The client refetched and sees the later transaction's row, not the earlier one's.
      await converged(a);
      await first.query('commit');
      await watch.until(hasTxId(earlyTxId));
      await converged(a);
      const order = watch.frames.flatMap(frame => (frame.kind === 'change' ? frame.txids : []));
      expect(order.indexOf(lateTxId)).toBeLessThan(order.indexOf(earlyTxId));
    } finally {
      first.release();
      second.release();
    }
  });

  it('rollback-no-hint: a rolled-back transaction publishes nothing, even after its trigger and a released savepoint ran', async () => {
    const { hub } = await startHub('rollback_listener');
    const watch = await watcher(hub);
    cleanups.push(() => Promise.resolve(watch.stop()));
    const connection = await writer.connect();
    try {
      await connection.query('begin');
      await connection.query(`insert into posts values ('rb1', 'never')`);
      await connection.query('savepoint inner_write');
      await connection.query(`insert into posts values ('rb2', 'never either')`);
      await connection.query('release savepoint inner_write');
      await connection.query('rollback');
    } finally {
      connection.release();
    }
    // A later commit on another table: once its frame is here, any hint of the rollback would be too.
    await insertUser('sentinel');
    await watch.until(hasTag(USERS));
    expect(watch.frames.some(hasTag(POSTS))).toBe(false);
  });

  it('listener-gap: a killed listen backend ends every stream with gap; a commit during the gap is covered by the reset', async () => {
    const { hub } = await startHub('gap_listener');
    const a = client(hub);
    await a.fetchAll();
    await join(a);
    // The listener cannot log in again until the test allows it: the gap lasts exactly as long as needed.
    await writer.query(`alter role ${LISTENER_ROLE} nologin`);
    try {
      await kill('gap_listener');
      await expect.poll(() => hub.status(), { timeout: 10_000 }).toBe('unavailable');
      await expect.poll(() => a.connected()).toBe(false);
      expect(a.log.at(-1)).toBe('gap');
      await insertPost('in the gap');
      expect(await join(a)).toBe(false);
    } finally {
      await writer.query(`alter role ${LISTENER_ROLE} login`);
    }
    await expect.poll(() => hub.status(), { timeout: 10_000 }).toBe('ready');
    expect(await join(a)).toBe(true);
    await converged(a);
    expect(a.log.at(-1)).toBe('reset');
  });

  it('replica-switch: a client that moves to another hub on the same database resets, then follows that hub', async () => {
    const { hub: first } = await startHub('replica_a');
    const { hub: second } = await startHub('replica_b');
    const a = client(first);
    await a.fetchAll();
    await join(a);
    await insertPost('seen on replica a');
    await converged(a);
    await a.disconnect();
    await insertPost('written between replicas');
    const moved = a.log.length;
    expect(await join(a, second)).toBe(true);
    await converged(a);
    // Its first frame on the new hub is a reset (a change may follow: that write's hint can still be in B's batch).
    expect(a.log[moved]).toBe('reset');
    await insertPost('seen on replica b');
    await converged(a);
    expect(a.log.at(-1)).toBe('change');
  });

  it('server-restart: old cursors reset on the restarted hub; a commit while it was down is covered', async () => {
    const { hub } = await startHub('restart_old');
    const a = client(hub);
    await a.fetchAll();
    await join(a);
    await insertPost('before the restart');
    await converged(a);
    await hub.stop();
    await expect.poll(() => a.connected()).toBe(false);
    expect(a.log.at(-1)).toBe('bye');
    expect(await join(a)).toBe(false);
    await insertPost('while down');
    const { hub: restarted } = await startHub('restart_new');
    expect(await join(a, restarted)).toBe(true);
    await converged(a);
    expect(a.log.at(-1)).toBe('reset');
  });

  it('cursor-expiry: a cursor exactly replayMs old resumes, one millisecond older resets; a full ring is a global overload reset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    cleanups.push(() => {
      vi.useRealTimers();
      return Promise.resolve();
    });
    const { hub } = await startHub('expiry_listener', { replayMs: 60_000, replayEnvelopes: 4 });
    const watch = await watcher(hub);
    cleanups.push(() => Promise.resolve(watch.stop()));
    const a = client(hub);
    await a.fetchAll();
    // expect.poll moves a fake clock forward while it waits, so the test notes when the cursor was taken.
    const takenAt = Date.now();
    await join(a);
    await a.disconnect();
    const cursor = a.cursor() ?? '';
    for (const title of ['one', 'two', 'three']) await watch.until(hasTxId(await insertPost(title)));
    vi.setSystemTime(takenAt + 60_000);
    await join(a);
    await converged(a);
    expect(a.log.slice(-4)).toEqual(['resume', 'change', 'change', 'change']);

    // The same cursor one millisecond older resets, whatever happened since.
    await a.disconnect();
    vi.setSystemTime(takenAt + 60_001);
    const late = new AbortController();
    const lateFeed = await hub.open({ cursor, signal: late.signal });
    const lateBegin = await lateFeed[Symbol.asyncIterator]().next();
    late.abort();
    expect(lateBegin.value).toMatchObject({ kind: 'begin', mode: 'reset' });
    vi.setSystemTime(takenAt + 180_000);
    await join(a);
    await converged(a);
    expect(a.log.at(-1)).toBe('reset');

    // The ring's cap: the frame that meets a full ring starts a new epoch for everyone.
    const warn = vi.spyOn(debugHub, 'warn');
    cleanups.push(() => Promise.resolve(warn.mockRestore()));
    const b = client(hub);
    await b.fetchAll();
    await join(b);
    // The reset's open aged the first three frames out. Four frames fill the ring; the fifth meets the cap.
    for (const title of ['four', 'five', 'six', 'seven']) await watch.until(hasTxId(await insertPost(title)));
    expect(warn).not.toHaveBeenCalled();
    await insertPost('eight');
    await expect.poll(() => [a.connected(), b.connected()], { timeout: 10_000 }).toEqual([false, false]);
    expect([a.log.at(-1), b.log.at(-1)]).toEqual(['gap', 'gap']);
    expect(warn).toHaveBeenCalledTimes(1);
    for (const each of [a, b]) {
      expect(await join(each)).toBe(true);
      await converged(each);
      expect(each.log.at(-1)).toBe('reset');
    }
  });

  it('slow-subscriber: a stream that stops reading gets bye at its bound, its queue is dropped, and its cursor resumes', async () => {
    const { hub } = await startHub('slow_listener', { subscriberFrames: 2 });
    const watch = await watcher(hub);
    cleanups.push(() => Promise.resolve(watch.stop()));
    const stalledFeed = await hub.open({ signal: new AbortController().signal });
    const stalled = stalledFeed[Symbol.asyncIterator]();
    const { value: begin } = await stalled.next();
    if (begin?.kind !== 'begin') throw new Error('expected begin');
    for (const title of ['one', 'two', 'three']) await watch.until(hasTxId(await insertPost(title)));
    const bye = await stalled.next();
    expect(bye.value).toEqual({ kind: 'bye' });
    const end = await stalled.next();
    expect(end.done).toBe(true);
    // Only the watcher is left: nothing is held for the stalled stream.
    expect(hub.connections()).toBe(1);
    const resumed: string[] = [];
    for await (const frame of await hub.open({ cursor: begin.cursor, signal: AbortSignal.timeout(10_000) })) {
      resumed.push(frame.kind === 'begin' ? frame.mode : frame.kind);
      if (resumed.length === 4) break;
    }
    expect(resumed).toEqual(['resume', 'change', 'change', 'change']);
  });

  it('untracked-table: boot fails with E002 for a declared table with no trigger; touch() publishes a view', async () => {
    const base = oc.$meta<LiveMeta>({});
    const contract = base.router({
      archive: { list: base.meta(live({ reads: [ARCHIVE] })).output(z.array(z.string())) },
    });
    await writer.query('create table if not exists archive (id text primary key)');
    expect(await verifyLiveTriggers(drizzle({ client: writer }), { app: 'blog', tables: [ARCHIVE] })).toEqual([
      { tag: ARCHIVE, problem: 'missing-trigger' },
    ]);
    const pool = listenPool('untracked_listener');
    let listened = 0;
    pool.on('acquire', () => {
      listened += 1;
    });
    const database = plugin({ name: 'db', provides: { db: () => drizzle({ client: writer }) } });
    const app = defineApp('blog')
      .use(database)
      .use(
        liveQueries({
          app: 'blog',
          needs: { db: database.provides.db },
          db: ({ db }) => db,
          pool: () => pool,
          contract,
          authorize: () => Promise.resolve({}),
        }),
      );
    const failure = await app.boot().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DotLifecycleError);
    expect(failure).toMatchObject({ cause: { code: LIVE_ERROR_CODES.triggers } });
    expect(listened).toBe(0);

    // A view has no trigger: the writer touches it in the same transaction, and it is published at commit.
    const { hub } = await startHub('touch_listener');
    const watch = await watcher(hub);
    cleanups.push(() => Promise.resolve(watch.stop()));
    const connection = await writer.connect();
    let txid: string | undefined;
    try {
      await connection.query('begin');
      const inserted = await connection.query<{ txid: string }>(
        `insert into posts values ('touched', 'through a view') returning pg_current_xact_id()::text as txid`,
      );
      txid = inserted.rows[0]?.txid;
      await touch(drizzle({ client: connection }), 'blog', POST_TITLES);
      await connection.query('commit');
    } finally {
      connection.release();
    }
    await watch.until(hasTag(POST_TITLES));
    const own = await RECEIPTS.of(txid ?? '');
    const tables = watch.frames.flatMap(frame =>
      frame.kind === 'change' && frame.txids.includes(own) ? frame.tags : [],
    );
    expect(tables.map(each => each.table).toSorted()).toEqual(['post_titles', 'posts']);
  });

  it('end-without-error: a listen connection that ends cleanly is a gap, then a new epoch, so clients reset', async () => {
    const pool = listenPool('ending_listener');
    const acquired: pg.PoolClient[] = [];
    pool.on('acquire', each => acquired.push(each));
    const hub = createLiveHub({ source: pgSource({ pool, app: 'blog', retryMs: 20 }), limits: { batchMs: 5 } });
    cleanups.push(() => hub.stop());
    await hub.start();
    await expect.poll(() => hub.status(), { timeout: 10_000 }).toBe('ready');
    const a = client(hub);
    await a.fetchAll();
    await join(a);
    const listening = acquired.at(-1);
    if (listening === undefined) throw new Error('the listener took no client');
    await listening.end();
    await expect.poll(() => a.connected(), { timeout: 10_000 }).toBe(false);
    expect(a.log.at(-1)).toBe('gap');
    await insertPost('after the end');
    await expect.poll(() => hub.status(), { timeout: 10_000 }).toBe('ready');
    const back = a.log.length;
    expect(await join(a)).toBe(true);
    await converged(a);
    // A new epoch: the first frame is a reset (the write's hint may follow, if the listener was back in time).
    expect(a.log[back]).toBe('reset');
  });
});
