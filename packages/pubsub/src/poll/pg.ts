/** The poll backend's queries on Postgres: plain Drizzle, one function per statement. */
import type { AnyRelations } from 'drizzle-orm';
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { and, asc, gt, inArray, lt, max, sql } from 'drizzle-orm';

import type { PollQueries } from './engine.js';
import type { PubsubTable } from './table.js';
import { POLL_BATCH } from './table.js';

/** Any Drizzle Postgres database or transaction (node-postgres, postgres.js, PGlite, …). */
export type PgPollDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

/** The poll queries bound to one Postgres database and table. */
export function pgPollQueries(db: PgPollDb, table: PubsubTable<'pg'>, retainMs: number): PollQueries<PgPollDb> {
  const insert = async (handle: PgPollDb, channel: string, payload: string): Promise<void> => {
    await handle.insert(table).values({ channel, payload });
    await handle.delete(table).where(lt(table.createdAt, sql`now() - make_interval(secs => ${retainMs / 1000})`));
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
