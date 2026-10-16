/**
 * `snapshot()` + `liveRead()` against real Postgres (testcontainers), with
 * separate pools for the handler, the writer and the listener (plan M0.3, § 8
 * `snapshot-stability`).
 *
 * Why these tests exist: the lesson's named guarantee is "one Postgres
 * snapshot per query". PGlite has one connection, so a concurrent commit
 * between two reads only exists here. The control procedure without
 * `liveRead` sees the commit between its reads, which proves the scenario
 * would catch a broken snapshot. The trigger tests check the premise of every
 * hint: it fires at commit only, once per table per transaction, and a read
 * started the moment the hint arrives already sees the commit.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { oc } from '@orpc/contract';
import { call, implement } from '@orpc/server';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { LiveMeta, TableTag } from '../index.js';
import { live, snapshot } from '../drizzle/index.js';
import { LIVE_ERROR_CODES } from '../index.js';
import { liveRead } from '../orpc/index.js';
import { CHANNEL, parsePayload, TABLES_SQL, TRIGGERS_SQL } from './fixtures.js';

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  authorId: text('author_id').notNull(),
});

type Db = NodePgDatabase;
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

const postReader = (db: Db | Transaction) => ({
  total: async () => {
    const result = await db.execute<{ n: number }>(sql`select count(*)::int as n from posts`);
    return result.rows[0]?.n ?? -1;
  },
  has: async (id: string) => {
    const result = await db.execute(sql`select 1 from posts where id = ${id}`);
    return result.rows.length === 1;
  },
});

/** The handler pauses between its two reads; `between` commits from another connection meanwhile. */
type Ctx = { readonly db: Db; readonly between: () => Promise<void> };

const contract = oc.$meta<LiveMeta>({});
const Totals = z.object({ before: z.int(), after: z.int() });
const statsContract = contract.router({
  live: contract.meta(live({ reads: [posts] })).output(Totals),
  plain: contract.meta(live({ reads: [posts] })).output(Totals),
  undeclared: contract.output(Totals),
});
const impl = implement(statsContract).$context<Ctx>();
const inSnapshot = liveRead((context: Ctx) => snapshot(context.db, postReader));
const router = {
  live: impl.live.use(inSnapshot).handler(async ({ context }) => {
    const before = await context.liveRead.total();
    await context.between();
    return { before, after: await context.liveRead.total() };
  }),
  plain: impl.plain.handler(async ({ context }) => {
    const reader = postReader(context.db);
    const before = await reader.total();
    await context.between();
    return { before, after: await reader.total() };
  }),
  undeclared: impl.undeclared.use(inSnapshot).handler(() => ({ before: 0, after: 0 })),
};

/** Every string `code` on the error and its causes, outermost first (oRPC and Drizzle both wrap). */
function codes(error: unknown): readonly string[] {
  const found: string[] = [];
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ('code' in cause && typeof cause.code === 'string') found.push(cause.code);
  }
  return found;
}

const noPause = (): Promise<void> => Promise.resolve();

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe.each(['postgres:16-alpine', 'postgres:17-alpine'])('%s', image => {
  let container: StartedPostgreSqlContainer;
  const pools: pg.Pool[] = [];
  let handlerDb: Db;
  let writerDb: Db;
  let listenClient: pg.PoolClient;
  let serial = 0;

  function newPool(): pg.Pool {
    const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
    pool.on('error', () => null);
    pools.push(pool);
    return pool;
  }

  const insertPost = async (db: Db | Transaction): Promise<string> => {
    serial += 1;
    const id = `p${serial}`;
    await db.insert(posts).values({ id, title: id, authorId: 'u1' });
    return id;
  };

  let sentinels = 0;

  /**
   * Records the hints delivered from now on. `settle()` publishes a unique
   * sentinel and resolves with every hint since the last `settle()`: Postgres
   * delivers notifications in commit order, so every earlier commit's hint has
   * arrived by then. Sentinels (schema `test`) are never hints.
   */
  function recordHints(): { next(): Promise<TableTag>; settle(): Promise<readonly TableTag[]> } {
    let tags: TableTag[] = [];
    let onHint: ((tag: TableTag) => void) | undefined;
    let onSentinel: ((table: string) => void) | undefined;
    listenClient.removeAllListeners('notification');
    listenClient.on('notification', message => {
      if (message.channel !== CHANNEL || message.payload === undefined) return;
      const tag = parsePayload(message.payload);
      if (tag.schema === 'test') {
        onSentinel?.(tag.table);
        return;
      }
      tags.push(tag);
      const resolve = onHint;
      onHint = undefined;
      resolve?.(tag);
    });
    return {
      next: () =>
        new Promise<TableTag>(resolve => {
          onHint = resolve;
        }),
      async settle() {
        sentinels += 1;
        const table = `sentinel_${sentinels}`;
        const arrived = new Promise<void>(resolve => {
          onSentinel = seen => {
            if (seen === table) resolve();
          };
        });
        await writerDb.execute(
          sql`select pg_notify(${CHANNEL}, ${JSON.stringify({ v: 1, tag: { schema: 'test', table } })})`,
        );
        await arrived;
        const since = tags;
        tags = [];
        return since;
      },
    };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(image).start();
    handlerDb = drizzle({ client: newPool() });
    writerDb = drizzle({ client: newPool() });
    await writerDb.execute(sql.raw(TABLES_SQL + TRIGGERS_SQL));
    listenClient = await newPool().connect();
    await listenClient.query(`LISTEN ${CHANNEL}`);
  }, 120_000);

  beforeEach(async () => {
    await writerDb.execute(sql`delete from posts; delete from users`);
  });

  afterAll(async () => {
    listenClient.release();
    await Promise.all(pools.map(pool => pool.end()));
    await container.stop();
  });

  it('snapshot-stability: two reads in one liveRead() call see one snapshot while another connection commits', async () => {
    await insertPost(writerDb);
    const context: Ctx = { db: handlerDb, between: async () => void (await insertPost(writerDb)) };

    expect(await call(router.live, {}, { context })).toEqual({ before: 1, after: 1 });
    // The commit is real: the next query sees it.
    expect(await call(router.live, {}, { context: { ...context, between: noPause } })).toEqual({
      before: 2,
      after: 2,
    });
    // Control: without liveRead each statement gets its own snapshot (READ COMMITTED) and sees the commit.
    expect(await call(router.plain, {}, { context })).toEqual({ before: 2, after: 3 });
  });

  it('a snapshot cannot write: Postgres refuses it as a read-only transaction', async () => {
    const error = await rejection(snapshot(handlerDb, tx => tx)(tx => insertPost(tx)));
    expect(codes(error)).toContain('25006'); // read_only_sql_transaction
    expect(await postReader(writerDb).total()).toBe(0);
  });

  it('snapshot() refuses a transaction handle at run time too', async () => {
    const error = await rejection(
      writerDb.transaction(tx => {
        // @ts-expect-error -- negative fixture: the types refuse a transaction handle; this checks the run-time guard
        snapshot(tx, t => t);
        return Promise.resolve();
      }),
    );
    expect(error).toMatchObject({ code: LIVE_ERROR_CODES.config });
  });

  it('liveRead() on a procedure with no live meta fails with E001 before any read', async () => {
    const error = await rejection(call(router.undeclared, {}, { context: { db: handlerDb, between: noPause } }));
    expect(codes(error)).toContain(LIVE_ERROR_CODES.config);
  });

  it('the trigger publishes at commit only: once per table per transaction, nothing for a rollback', async () => {
    const rolledBack = recordHints();
    await rolledBack.settle(); // drain the cleanup's hints
    await writerDb
      .transaction(async tx => {
        await insertPost(tx);
        await tx.execute(sql`update users set name = 'x'`);
        tx.rollback();
      })
      .catch(() => null);
    expect(await rolledBack.settle()).toEqual([]);

    const savepoint = recordHints();
    await savepoint.settle(); // drain the cleanup's hints
    await writerDb.transaction(async tx => {
      await tx
        .transaction(async inner => {
          await insertPost(inner);
          inner.rollback();
        })
        .catch(() => null);
      await tx.execute(sql`insert into users values ('u1', 'Ada')`);
    });
    expect(await savepoint.settle()).toEqual([{ schema: 'public', table: 'users' }]);

    const collapsed = recordHints();
    await collapsed.settle(); // drain the cleanup's hints
    await writerDb.transaction(async tx => {
      for (let index = 0; index < 5; index += 1) await insertPost(tx);
      await tx.execute(sql`update users set name = 'Grace'`);
      await tx.execute(sql`update users set name = 'Ada'`);
    });
    await writerDb.execute(sql`delete from users`);
    expect(await collapsed.settle()).toEqual([
      { schema: 'public', table: 'posts' },
      { schema: 'public', table: 'users' },
      { schema: 'public', table: 'users' },
    ]);
  });

  it('a snapshot read started the moment a hint arrives already sees that commit', async () => {
    const runner = snapshot(handlerDb, postReader);
    for (let round = 0; round < 50; round += 1) {
      const id = `race${round}`;
      const hints = recordHints();
      await hints.settle(); // drain the hints of earlier writes
      const visible = hints.next().then(() => runner(reader => reader.has(id)));
      // Started now, awaited after the read: the read races the writer's own acknowledgement.
      const write = writerDb.insert(posts).values({ id, title: id, authorId: 'u1' }).execute();
      expect(await visible).toBe(true);
      await write;
    }
  });
});
