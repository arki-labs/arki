/**
 * The generated triggers, `verifyLiveTriggers` and `touch` on PGlite (a real
 * Postgres 17 in WASM, one connection).
 *
 * Why these tests exist: every hint the hub sends rests on these triggers
 * firing at commit, only at commit, for every way a table can change. Each
 * case here is a way a write could slip past them: a rollback that must stay
 * silent, a TRUNCATE, a write straight into a partition leaf, a disabled or
 * altered trigger. `verifyLiveTriggers` must name each hole, because boot
 * fails on it instead of serving stale pages.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TableTag } from '../types.js';
import { CHANNEL, parsePayload, POSTS, TABLES_SQL, TRIGGERS_SQL, USERS } from '../tests/fixtures.js';
import { liveMigration, touch, verifyLiveTriggers } from './index.js';

const EVENTS: TableTag = { schema: 'public', table: 'events' };
const EVENTS_2025: TableTag = { schema: 'public', table: 'events_2025' };
const EVENTS_2026: TableTag = { schema: 'public', table: 'events_2026' };
const HOSTILE: TableTag = { schema: 'we"ird', table: `it's"; drop table posts; --` };

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let hints: TableTag[] = [];
let sentinels = 0;

/**
 * Every hint since the last call. A unique sentinel is published last: PGlite
 * delivers in commit order, so once it arrives every earlier hint has too.
 */
async function settle(): Promise<readonly TableTag[]> {
  sentinels += 1;
  const sentinel = { schema: 'test', table: `sentinel_${sentinels}` };
  await touch(db, 'blog', sentinel);
  await expect.poll(() => hints.some(tag => tag.table === sentinel.table)).toBe(true);
  const since = hints.filter(tag => tag.schema !== 'test');
  hints = [];
  return since;
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client });
  await client.exec(`
    ${TABLES_SQL}
    CREATE TABLE events (id int NOT NULL, at date NOT NULL) PARTITION BY RANGE (at);
    CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
    CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
    CREATE TABLE plain (id int);
    CREATE VIEW post_titles AS SELECT title FROM posts;
    CREATE SCHEMA "we""ird";
    CREATE TABLE "we""ird"."it's""; drop table posts; --" (id int);
    ${TRIGGERS_SQL}
    ${liveMigration({ app: 'blog', tables: [EVENTS, HOSTILE] }).up}
  `);
  await client.listen(CHANNEL, payload => {
    hints.push(parsePayload(payload));
  });
});

beforeEach(async () => {
  await settle();
});

afterAll(async () => {
  await client.close();
});

describe('the generated triggers', () => {
  it('publish at commit only: nothing for a rollback or a rolled-back savepoint, one hint per table per transaction', async () => {
    await client.exec(`begin; insert into posts values ('p1', 'One', 'u1'); update users set name = 'x'; rollback;`);
    expect(await settle()).toEqual([]);

    await client.exec(`
      begin;
      savepoint s; insert into posts values ('p1', 'One', 'u1'); rollback to savepoint s;
      insert into users values ('u1', 'Ada');
      commit;`);
    expect(await settle()).toEqual([USERS]);

    await client.exec(`
      begin;
      insert into posts values ('p2', 'Two', 'u1'); insert into posts values ('p3', 'Three', 'u1');
      update users set name = 'Grace';
      commit;`);
    expect(await settle()).toEqual([POSTS, USERS]);
  });

  it('publish for TRUNCATE and for an UPDATE that matched no row (a harmless false positive)', async () => {
    await client.exec(`truncate users`);
    expect(await settle()).toEqual([USERS]);
    await client.exec(`update posts set title = 'none' where id = 'missing'`);
    expect(await settle()).toEqual([POSTS]);
  });

  it('a write straight into a partition leaf is missed until the leaf has its own trigger, which publishes the root', async () => {
    await client.exec(`insert into events values (1, '2026-05-01')`);
    expect(await settle()).toEqual([EVENTS]); // through the root: the root's trigger fires
    await client.exec(`insert into events_2026 values (2, '2026-05-02')`);
    expect(await settle()).toEqual([]); // the premise: the root's statement trigger does not see it

    const problems = await verifyLiveTriggers(db, { app: 'blog', tables: [EVENTS] });
    expect(problems).toEqual([
      { tag: EVENTS_2025, problem: 'partition-leaf-uncovered' },
      { tag: EVENTS_2026, problem: 'partition-leaf-uncovered' },
    ]);

    const leaves = liveMigration({
      app: 'blog',
      tables: [],
      leaves: [
        { leaf: EVENTS_2025, root: EVENTS },
        { leaf: EVENTS_2026, root: EVENTS },
      ],
    });
    await client.exec(leaves.up);
    try {
      await client.exec(`insert into events_2026 values (3, '2026-05-03')`);
      expect(await settle()).toEqual([EVENTS]);
      expect(await verifyLiveTriggers(db, { app: 'blog', tables: [EVENTS] })).toEqual([]);
    } finally {
      await client.exec(leaves.down);
    }
  });

  it('a hostile table name stays a name: the trigger fires with the exact tag and nothing else ran', async () => {
    await client.exec(`insert into "we""ird"."it's""; drop table posts; --" values (1)`);
    expect(await settle()).toEqual([HOSTILE]);
    const posts = await client.query(`select to_regclass('public.posts') is not null as here`);
    expect(posts.rows).toEqual([{ here: true }]);
  });
});

describe('verifyLiveTriggers', () => {
  it('finds nothing wrong with the tables the migration covers', async () => {
    expect(await verifyLiveTriggers(db, { app: 'blog', tables: [POSTS, USERS, HOSTILE] })).toEqual([]);
  });

  it('names a missing table, a view, and a table with no trigger', async () => {
    const problems = await verifyLiveTriggers(db, {
      app: 'blog',
      tables: [
        { schema: 'public', table: 'nope' },
        { schema: 'nowhere', table: 'posts' },
        { schema: 'public', table: 'post_titles' },
        { schema: 'public', table: 'plain' },
      ],
    });
    expect(problems).toEqual([
      { tag: { schema: 'public', table: 'nope' }, problem: 'missing-table' },
      { tag: { schema: 'nowhere', table: 'posts' }, problem: 'missing-table' },
      { tag: { schema: 'public', table: 'post_titles' }, problem: 'missing-table' },
      { tag: { schema: 'public', table: 'plain' }, problem: 'missing-trigger' },
    ]);
    // Another app's triggers do not count for this one.
    expect(await verifyLiveTriggers(db, { app: 'shop', tables: [POSTS] })).toEqual([
      { tag: POSTS, problem: 'missing-trigger' },
    ]);
  });

  it('a disabled trigger, or one that fires only on a replica, is disabled, and publishes nothing', async () => {
    for (const mode of ['DISABLE', 'ENABLE REPLICA']) {
      await client.exec(`alter table users ${mode} trigger arki_live_blog`);
      try {
        expect(await verifyLiveTriggers(db, { app: 'blog', tables: [USERS] })).toEqual([
          { tag: USERS, problem: 'disabled' },
        ]);
        await client.exec(`insert into users values ('u9', 'Off')`);
        expect(await settle()).toEqual([]);
      } finally {
        await client.exec(`delete from users; alter table users enable trigger arki_live_blog`);
      }
    }
    expect(await verifyLiveTriggers(db, { app: 'blog', tables: [USERS] })).toEqual([]);
  });

  it('a trigger of the right name but the wrong function, events or arguments is named as such', async () => {
    const cases: readonly { readonly create: string; readonly problem: string }[] = [
      {
        create: `create function other() returns trigger language plpgsql as $$ begin return null; end $$;
          create trigger arki_live_blog after insert or update or delete or truncate on plain
          for each statement execute function other()`,
        problem: 'wrong-function',
      },
      {
        create: `create trigger arki_live_blog after insert on plain
          for each statement execute function arki_live.notify_table_v1('${CHANNEL}', 'public', 'plain')`,
        problem: 'wrong-events',
      },
      {
        create: `create trigger arki_live_blog after insert or update or delete on plain
          for each row execute function arki_live.notify_table_v1('${CHANNEL}', 'public', 'plain')`,
        problem: 'wrong-events',
      },
      {
        create: `create trigger arki_live_blog after insert or update or delete or truncate on plain
          for each statement execute function arki_live.notify_table_v1('${CHANNEL}', 'public', 'posts')`,
        problem: 'wrong-args',
      },
      {
        create: `create trigger arki_live_blog after insert or update or delete or truncate on plain
          for each statement execute function arki_live.notify_table_v1('arki_live_shop_v1', 'public', 'plain')`,
        problem: 'wrong-args',
      },
    ];
    const plain = { schema: 'public', table: 'plain' };
    for (const { create, problem } of cases) {
      await client.exec(create);
      try {
        expect(await verifyLiveTriggers(db, { app: 'blog', tables: [plain] })).toEqual([{ tag: plain, problem }]);
      } finally {
        await client.exec(`drop trigger arki_live_blog on plain; drop function if exists other()`);
      }
    }
  });

  it('down drops this app’s triggers, which verify then reports', async () => {
    const own = liveMigration({ app: 'blog', tables: [POSTS] });
    await client.exec(own.down);
    try {
      expect(await verifyLiveTriggers(db, { app: 'blog', tables: [POSTS] })).toEqual([
        { tag: POSTS, problem: 'missing-trigger' },
      ]);
    } finally {
      await client.exec(own.up);
    }
    expect(await verifyLiveTriggers(db, { app: 'blog', tables: [POSTS] })).toEqual([]);
  });
});

describe('touch', () => {
  const stats: TableTag = { schema: 'public', table: 'post_stats' };

  it('publishes at commit, nothing on rollback, and collapses with the trigger for the same table', async () => {
    await db
      .transaction(async tx => {
        await touch(tx, 'blog', stats);
        tx.rollback();
      })
      .catch(() => null);
    expect(await settle()).toEqual([]);

    await db.transaction(async tx => {
      await touch(tx, 'blog', stats, POSTS);
      await tx.execute(sql`insert into posts values ('t1', 'Touched', 'u1')`);
      await touch(tx, 'blog', POSTS);
    });
    expect(await settle()).toEqual([stats, POSTS]);
  });
});

describe('the generated SQL as a Drizzle custom migration', () => {
  it('runs through Drizzle’s migrator on PGlite, which sends each statement separately', async () => {
    // Why: the plan says to paste `up` into `drizzle-kit generate --custom`; PGlite refuses several
    // commands in one prepared statement, so `up` must split on Drizzle's breakpoints.
    const folder = mkdtempSync(path.join(tmpdir(), 'arki-live-migrations-'));
    const fresh = new PGlite();
    try {
      mkdirSync(path.join(folder, '20261016000000_tables'));
      writeFileSync(
        path.join(folder, '20261016000000_tables', 'migration.sql'),
        TABLES_SQL.replaceAll(';\n', ';\n--> statement-breakpoint\n'),
      );
      mkdirSync(path.join(folder, '20261016000001_live'));
      writeFileSync(path.join(folder, '20261016000001_live', 'migration.sql'), TRIGGERS_SQL);
      const freshDb = drizzle({ client: fresh });
      await migrate(freshDb, { migrationsFolder: folder });
      expect(await verifyLiveTriggers(freshDb, { app: 'blog', tables: [POSTS, USERS] })).toEqual([]);
    } finally {
      await fresh.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
