/** The transaction capability is in the types: only backends that can join a transaction have `publishIn`. */
import type { AnyRelations, EmptyRelations } from 'drizzle-orm';
import type { LibSQLDatabase, LibSQLRunResult } from 'drizzle-orm/libsql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgAsyncTransaction, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { SQLiteAsyncTransaction } from 'drizzle-orm/sqlite-core';
import { Redis } from 'ioredis';
import pg from 'pg';
import { expectTypeOf, test } from 'vitest';

import type { PubSub, Unsubscribe } from './index.js';
import { memoryPubSub } from './memory.js';
import { pgPubSub } from './pg/index.js';
import { redisPubSub } from './redis/index.js';
import { sqlitePubSub } from './sqlite/index.js';

declare const pgDb: PgliteDatabase;
declare const sqliteDb: LibSQLDatabase;
declare const nodePgDb: NodePgDatabase;

test('redis has no publishIn', () => {
  const pubsub = redisPubSub({ client: new Redis() });
  expectTypeOf(pubsub).toEqualTypeOf<PubSub>();
  // @ts-expect-error -- Redis cannot join a database transaction
  void pubsub.publishIn;
});

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

test("sqlitePubSub's publishIn takes the database's own transaction type, inferred", () => {
  const pubsub = sqlitePubSub({ db: sqliteDb });
  expectTypeOf<Parameters<typeof pubsub.publishIn>[0]>().toEqualTypeOf<
    SQLiteAsyncTransaction<'async', LibSQLRunResult, EmptyRelations>
  >();
  void sqliteDb.transaction(tx => pubsub.publishIn(tx, 'orders', 'ord_1'));
  // @ts-expect-error -- a Postgres transaction cannot write the SQLite table
  void pgDb.transaction(tx => pubsub.publishIn(tx, 'orders', 'ord_1'));
  // @ts-expect-error -- a Postgres database is not a SQLite one
  void sqlitePubSub({ db: pgDb });
});

test("pgPubSub's publishIn takes any Drizzle Postgres transaction, never a database or a SQLite one", () => {
  const pubsub = pgPubSub({ pool: new pg.Pool() });
  expectTypeOf<Parameters<typeof pubsub.publishIn>[0]>().toEqualTypeOf<
    PgAsyncTransaction<PgQueryResultHKT, AnyRelations>
  >();
  void pgDb.transaction(tx => pubsub.publishIn(tx, 'orders', 'ord_1'));
  void nodePgDb.transaction(tx => pubsub.publishIn(tx, 'orders', 'ord_1'));
  // @ts-expect-error -- a root database sends at once; only a transaction defers to commit
  void pubsub.publishIn(pgDb, 'orders', 'ord_1');
  // @ts-expect-error -- a SQLite transaction cannot run pg_notify
  void sqliteDb.transaction(tx => pubsub.publishIn(tx, 'orders', 'ord_1'));
});
