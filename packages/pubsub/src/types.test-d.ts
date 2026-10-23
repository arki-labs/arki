/** The transaction capability is in the types: only backends that can join a transaction have `publishIn`. */
import type { EmptyRelations } from 'drizzle-orm';
import type { LibSQLDatabase, LibSQLRunResult } from 'drizzle-orm/libsql';
import type { PgAsyncTransaction } from 'drizzle-orm/pg-core';
import type { PgliteDatabase, PgliteQueryResultHKT } from 'drizzle-orm/pglite';
import type { SQLiteAsyncTransaction } from 'drizzle-orm/sqlite-core';
import { expectTypeOf, test } from 'vitest';

import { pgColumns } from '@arki/db/pg';
import { sqliteColumns } from '@arki/db/sqlite';

import type { PubSub, Unsubscribe } from './index.js';
import { memoryPubSub } from './memory.js';
import { pollPubSub, pubsubTable } from './poll/index.js';

declare const pgDb: PgliteDatabase;
declare const sqliteDb: LibSQLDatabase;
const pgTable = pubsubTable(pgColumns());
const sqliteTable = pubsubTable(sqliteColumns());

test('memory has no publishIn', () => {
  const pubsub = memoryPubSub();
  expectTypeOf(pubsub).toEqualTypeOf<PubSub>();
  // @ts-expect-error -- memory cannot join a database transaction
  void pubsub.publishIn;
});

test("subscribe fits @arki/journal's WakeListener with no adapter", () => {
  const pubsub = memoryPubSub();
  // journal: `type WakeListener = (onMessage: (payload: string) => void) => Unlisten | Promise<Unlisten>`,
  // `type Unlisten = () => void | Promise<void>`.
  type Unlisten = () => void | Promise<void>;
  type WakeListener = (onMessage: (payload: string) => void) => Unlisten | Promise<Unlisten>;
  const listen = (onMessage: (payload: string) => void) => pubsub.subscribe('wake', onMessage);
  expectTypeOf(listen).toExtend<WakeListener>();
  expectTypeOf(listen).returns.resolves.toEqualTypeOf<Unsubscribe>();
});

test("pollPubSub's publishIn takes the database's own transaction type, inferred", () => {
  const onPg = pollPubSub({ db: pgDb, table: pgTable });
  expectTypeOf<Parameters<typeof onPg.publishIn>[0]>().toEqualTypeOf<
    PgAsyncTransaction<PgliteQueryResultHKT, EmptyRelations>
  >();
  void pgDb.transaction(tx => onPg.publishIn(tx, 'orders', 'ord_1'));

  const onSqlite = pollPubSub({ db: sqliteDb, table: sqliteTable });
  expectTypeOf<Parameters<typeof onSqlite.publishIn>[0]>().toEqualTypeOf<
    SQLiteAsyncTransaction<'async', LibSQLRunResult, EmptyRelations>
  >();
  void sqliteDb.transaction(tx => onSqlite.publishIn(tx, 'orders', 'ord_1'));

  // @ts-expect-error -- a SQLite transaction cannot publish on a Postgres pubsub
  void sqliteDb.transaction(tx => onPg.publishIn(tx, 'orders', 'ord_1'));
  // @ts-expect-error -- the table must be built with the database's dialect
  void pollPubSub({ db: pgDb, table: sqliteTable });
  // @ts-expect-error -- the table must be built with the database's dialect
  void pollPubSub({ db: sqliteDb, table: pgTable });
});
