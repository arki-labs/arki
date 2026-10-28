/**
 * `pgSource` on real Postgres (testcontainers), with the listener's pool apart
 * from the writer's. Also the M1 demo: a journal command and a plain
 * repository update drive the same live list, with no tap.
 *
 * Why these tests exist: the source is the only thing that tells the hub when
 * hints may have been missed. `ready` before `LISTEN` would let a stream
 * resume across a commit nobody heard; a lost listener or an unreadable
 * payload that is not a gap would leave clients stale with no reset. And the
 * point of table triggers is that every write path is covered: a command, a
 * repository, raw SQL and a worker's job all commit through Postgres.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';

import type { LiveHub, LiveManifest, TableTag } from '../index.js';
import type { LiveQuery, ScriptedClient } from '../tests/scripted-client.js';
import { tableTag } from '../drizzle/index.js';
import { createLiveHub, LIVE_ERROR_CODES } from '../index.js';
import { RECEIPTS } from '../tests/fixtures.js';
import { scriptedClient } from '../tests/scripted-client.js';
import { liveChannel, liveMigration, pgSource, verifyLiveTriggers } from './index.js';

type PostId = `pst_${string}`;
const posts = pgTable('posts', {
  id: varchar('id', { length: 64 }).primaryKey().$type<PostId>(),
  title: varchar('title', { length: 256 }).notNull(),
  version: integer('version').notNull().default(0),
});
const postCounts = pgTable('post_counts', {
  id: varchar('id', { length: 16 }).primaryKey(),
  created: integer('created').notNull(),
});
const POSTS = tableTag(posts);
const COUNTS = tableTag(postCounts);
const tables = journalTables();

const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
const PostCreated = j.event('PostCreated', z.object({ title: z.string().min(1) }));
const post = j.entity('post', posts).create(PostCreated, e => ({ title: e.data.title }));
const createPost = j.command(
  'create-post',
  z.object({ id: z.templateLiteral(['pst_', z.string()]), title: z.string().min(1) }),
  (input, { write }) => write(post, input.id, () => [PostCreated({ title: input.title })]),
);
/** Runs in the worker, after the command's commit: a write no command makes. */
const countPosts = j.effect('count-posts', post, {
  PostCreated: async (_event, { db }) => {
    await db.execute(
      sql`insert into post_counts values ('all', 1) on conflict (id) do update set created = post_counts.created + 1`,
    );
  },
});
const journal = j.compose({ effects: [countPosts] });

type Db = NodePgDatabase;

/** A plain repository: no journal, no tap. */
const postRepository = (db: Db) => ({
  rename: (id: PostId, title: string) => db.update(posts).set({ title }).where(eq(posts.id, id)),
});

const manifest: LiveManifest = [
  { path: ['posts', 'list'], reads: [POSTS] },
  { path: ['posts', 'count'], reads: [COUNTS] },
];

let serial = 0;
const nextId = (): PostId => `pst_${++serial}`;

async function converged(client: ScriptedClient): Promise<void> {
  await expect.poll(() => client.stalePaths()).toEqual([]);
}

/** Collects the tags and txids of every `change` the hub sends to one raw stream, and how the stream ended. */
async function watch(hub: LiveHub): Promise<{
  tags: TableTag[];
  txids: string[];
  ended: () => string | undefined;
  stop: () => void;
}> {
  const tags: TableTag[] = [];
  const txids: string[] = [];
  const abort = new AbortController();
  let end: string | undefined;
  const feed = await hub.open({ signal: abort.signal });
  void (async () => {
    for await (const frame of feed) {
      if (frame.kind === 'change') {
        tags.push(...frame.tags);
        txids.push(...frame.txids);
      }
      if (frame.kind === 'gap' || frame.kind === 'bye') end = frame.kind;
    }
  })();
  return { tags, txids, ended: () => end, stop: () => abort.abort() };
}

describe.each(['postgres:16-alpine', 'postgres:18-alpine'])('%s', image => {
  let container: StartedPostgreSqlContainer;
  const pools: pg.Pool[] = [];
  let writer: Db;

  /** At most `max` clients, each backend named `name` so a test can kill it. */
  function newPool(name: string, max = 1): pg.Pool {
    const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max, application_name: name });
    pool.on('error', () => null);
    pools.push(pool);
    return pool;
  }
  const kill = (name: string) =>
    writer.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${name}`);

  const readRows = (text: string) => async () => {
    const result = await writer.execute(sql.raw(text));
    return JSON.stringify(result.rows);
  };
  const countQuery: LiveQuery = { path: ['posts', 'count'], read: readRows('select created from post_counts') };
  const queries: readonly LiveQuery[] = [
    { path: ['posts', 'list'], read: readRows('select id, title from posts order by id') },
    countQuery,
  ];

  async function startHub(listenerName: string): Promise<{ hub: LiveHub; pool: pg.Pool }> {
    const pool = newPool(listenerName);
    const hub = createLiveHub({
      source: pgSource({ pool, app: 'blog', retryMs: 50 }),
      limits: { batchMs: 5 },
      receipts: RECEIPTS,
    });
    await hub.start();
    return { hub, pool };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(image).start();
    writer = drizzle({ client: newPool('writer', 4) });
    const { apply } = await pushSchema({ ...tables, posts, postCounts }, writer);
    await apply();
    await writer.execute(sql.raw(liveMigration({ app: 'blog', tables: [POSTS, COUNTS] }).up));
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map(pool => pool.end()));
    await container.stop();
  });

  it('the boot check passes on the migrated tables', async () => {
    expect(await verifyLiveTriggers(writer, { app: 'blog', tables: [POSTS, COUNTS] })).toEqual([]);
  });

  it('demo — write-paths: a journal command, a plain repository, raw SQL and a worker job all reach the same live list, with no tap', async () => {
    const { hub, pool } = await startHub('listener_demo');
    const raw = await watch(hub);
    const client = scriptedClient(hub, manifest, queries);
    await client.fetchAll();
    expect(await client.connect()).toBe(true);
    const settled = async (expected: readonly TableTag[]) => {
      await expect.poll(() => raw.tags).toEqual(expected);
      raw.tags.length = 0;
      await converged(client);
    };

    try {
      const first = nextId();
      orThrow(await journal.run(writer, createPost, { id: first, title: 'From a command' }, { actorId: 'usr_1' }));
      await settled([POSTS]);

      await postRepository(writer).rename(first, 'Renamed by a repository');
      await settled([POSTS]);

      await writer.execute(sql`insert into posts (id, title) values (${nextId()}, 'Raw SQL')`);
      await settled([POSTS]);

      // The command's effect is a job; the worker runs it after commit and writes post_counts.
      const worker = journal.worker(writer, { pollMs: 25 });
      await worker.start();
      try {
        await expect.poll(() => raw.tags).toContainEqual(COUNTS);
      } finally {
        await worker.stop();
      }
      raw.tags.length = 0;
      await converged(client);
      expect(JSON.parse(await countQuery.read())).toEqual([{ created: 1 }]);
      expect(client.log.filter(entry => entry !== 'change')).toEqual(['reset']);
    } finally {
      raw.stop();
      await client.disconnect();
      await hub.stop();
    }
    expect(pool.totalCount, 'the listen client is closed on stop').toBe(0);
  });

  it('a change frame carries the receipt of the committing transaction, never its decimal id', async () => {
    // Why: a client awaits its own write by this receipt (awaitTxId, M3); it must be the commit's own.
    const { hub } = await startHub('listener_txid');
    const raw = await watch(hub);
    try {
      const committed = await writer.transaction(async tx => {
        const result = await tx.execute<{ txid: string }>(sql`select pg_current_xact_id()::text as txid`);
        await tx.execute(sql`insert into posts (id, title) values (${nextId()}, 'With a txid')`);
        await tx.execute(sql`update post_counts set created = created`);
        return result.rows[0]?.txid;
      });
      expect(committed).toMatch(/^[1-9]\d*$/);
      await expect.poll(() => raw.tags).toEqual([POSTS, COUNTS]);
      // Two tables, one transaction: one receipt.
      expect(raw.txids).toEqual([await RECEIPTS.of(committed ?? '')]);
    } finally {
      raw.stop();
      await hub.stop();
    }
  });

  it('the hub is ready only after LISTEN succeeds: while the pool has no free client, streams are refused', async () => {
    const pool = newPool('listener_late');
    const borrowed = await pool.connect();
    const hub = createLiveHub({ source: pgSource({ pool, app: 'blog' }) });
    const starting = hub.start();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(hub.status()).toBe('idle');
    await expect(hub.open({ signal: new AbortController().signal })).rejects.toMatchObject({
      code: LIVE_ERROR_CODES.source,
    });
    borrowed.release();
    await starting;
    try {
      expect(hub.status()).toBe('ready');
      const raw = await watch(hub);
      await writer.execute(sql`update posts set title = title`);
      await expect.poll(() => raw.tags).toEqual([POSTS]);
      raw.stop();
    } finally {
      await hub.stop();
    }
  });

  it('listener-gap: a killed listen backend ends every stream with gap; the reconnect is a new epoch, so clients reset', async () => {
    const { hub } = await startHub('listener_gap');
    const client = scriptedClient(hub, manifest, queries);
    try {
      await client.fetchAll();
      await client.connect();
      await expect.poll(() => client.log).toEqual(['reset']);
      const before = client.cursor();
      expect(before).toBeDefined();

      await kill('listener_gap');
      await expect.poll(() => client.log.at(-1)).toBe('gap');
      // A commit nobody hears: the listener is down, or just back.
      await writer.execute(sql`insert into posts (id, title) values (${nextId()}, 'In the gap')`);
      await expect.poll(() => hub.status()).toBe('ready');

      const back = client.log.length;
      expect(await client.connect()).toBe(true);
      // It sent its old cursor: the new epoch cannot open it, so the hub reset it. (The write's hint
      // may follow, when the listener was back before the commit.)
      await expect.poll(() => client.log[back]).toBe('reset');
      await converged(client);
    } finally {
      await client.disconnect();
      await hub.stop();
    }
  });

  it('an unreadable payload on the channel is a gap, then a new epoch: clients reset instead of missing a hint', async () => {
    const { hub } = await startHub('listener_bad');
    const client = scriptedClient(hub, manifest, queries);
    try {
      await client.fetchAll();
      await client.connect();
      await expect.poll(() => client.log).toEqual(['reset']);
      for (const payload of ['not json', JSON.stringify({ v: 2, tag: POSTS })]) {
        await writer.execute(sql`select pg_notify(${liveChannel('blog')}, ${payload})`);
        await expect.poll(() => client.log.at(-1)).toBe('gap');
        expect(hub.status()).toBe('ready');
        expect(await client.connect()).toBe(true);
        await expect.poll(() => client.log.at(-1)).toBe('reset');
      }
    } finally {
      await client.disconnect();
      await hub.stop();
    }
  });
});
