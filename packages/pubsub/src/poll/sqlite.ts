/** The poll backend's queries on SQLite: plain Drizzle, one function per statement. */
import type { AnyRelations } from 'drizzle-orm';
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core';
import { and, asc, gt, inArray, lt, max, sql } from 'drizzle-orm';

import { sqliteNowMs } from '@arki/db/sqlite';

import type { PollQueries } from './engine.js';
import type { PubsubTable } from './table.js';
import { POLL_BATCH } from './table.js';

/** Any async Drizzle SQLite database or transaction; libSQL (`createLibsqlDb`) is the one `@arki/db` supports. */
export type SqlitePollDb = SQLiteAsyncDatabase<'async', unknown, AnyRelations>;

/** The poll queries bound to one SQLite database and table. */
export function sqlitePollQueries(
  db: SqlitePollDb,
  table: PubsubTable<'sqlite'>,
  retainMs: number,
): PollQueries<SqlitePollDb> {
  const insert = async (handle: SqlitePollDb, channel: string, payload: string): Promise<void> => {
    await handle.insert(table).values({ channel, payload });
    await handle.delete(table).where(lt(table.createdAt, sql`${sqliteNowMs} - ${retainMs}`));
  };
  return {
    publish: (channel, payload) => insert(db, channel, payload),
    publishIn: insert,
    async newestId() {
      const [row] = await db.select({ id: max(table.id) }).from(table);
      return row?.id ?? 0;
    },
    read: (after, channels) =>
      db
        .select({ id: table.id, channel: table.channel, payload: table.payload })
        .from(table)
        .where(and(gt(table.id, after), inArray(table.channel, channels)))
        .orderBy(asc(table.id))
        .limit(POLL_BATCH),
  };
}
