/**
 * Type-level proof for the design (spec section 12, item 1): the `.create` /
 * `.on` chain and the Drizzle table and transaction types compose without a
 * cast. `tsc` checks this file; the single runtime test keeps Vitest happy.
 */
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { RootCommandRunner, WriteResult } from './api.js';
import type { AccountId, order } from './test-support.js';
import type {
  AnyEntity,
  DbHandle,
  EntityId,
  EntityTable,
  EventsOf,
  PendingOf,
  ProjectionHandlers,
  Recorded,
  RecordedOf,
  ReducerRow,
  ReducerValues,
  RootDb,
  Row,
  ServicesFor,
} from './types.js';
import { need } from './handlers.js';
import { initJournal } from './journal.js';
import {
  j,
  meta,
  OrderNoted,
  OrderPaid,
  OrderPlaced,
  profile,
  ProfileMoved,
  ProfileOpened,
  profiles,
  tables,
} from './test-support.js';

// --- Chain inference --------------------------------------------------------

type Meta = { actorId: string };
type OrderEvents = EventsOf<typeof order>;
expectTypeOf<OrderEvents['type']>().toEqualTypeOf<'OrderPlaced' | 'OrderPaid' | 'OrderNoted' | 'OrderCancelled'>();
expectTypeOf<keyof ProjectionHandlers<typeof order, Meta>>().toEqualTypeOf<
  'OrderPlaced' | 'OrderPaid' | 'OrderNoted' | 'OrderCancelled'
>();
expectTypeOf<RecordedOf<typeof OrderPaid, Meta>['data']>().toEqualTypeOf<{ amount: number }>();
expectTypeOf<RecordedOf<typeof OrderPaid, Meta>['meta']>().toEqualTypeOf<Meta>();
expectTypeOf<PendingOf<typeof OrderPlaced>['data']>().toEqualTypeOf<{ customerId: string; total: number }>();
// `events` may only return declared events: Unrelated is not in the union.
expectTypeOf<PendingOf<OrderEvents>['type']>().toEqualTypeOf<
  'OrderPlaced' | 'OrderPaid' | 'OrderNoted' | 'OrderCancelled'
>();

type OrderId = `ord_${string}`;

const orders = pgTable('orders', {
  id: varchar('id', { length: 256 }).primaryKey().$type<OrderId>(),
  total: integer('total').notNull(),
  status: varchar('status', { enum: ['placed', 'paid'] }).notNull(),
  version: integer('version').notNull().default(0),
});

// --- Table constraint -------------------------------------------------------

// A real table fits the structural constraint.
const asEntityTable: EntityTable = orders;
void asEntityTable;

// Row and ReducerValues are inferred from the table.
expectTypeOf<Row<typeof orders>>().toEqualTypeOf<typeof orders.$inferSelect>();
expectTypeOf<ReducerValues<typeof orders>>().toEqualTypeOf<{ total: number; status: 'placed' | 'paid' }>();
expectTypeOf<EntityId<typeof orders>>().toEqualTypeOf<OrderId>();

// The key option must be one property name. A union would make `ReducerValues` omit several
// required columns, so a `.create` could return `{}` and an `.on` could read a column
// that was never set.
const twoKeys = pgTable('two_keys', {
  accountId: varchar('account_id').notNull().unique(),
  other: varchar('other').notNull().unique(),
  version: integer('version').notNull().default(0),
});
expectTypeOf<ReducerValues<typeof twoKeys, 'accountId'>>().toEqualTypeOf<{ other: string }>();
const oneKey = (key: 'accountId') => j.entity('one-key', twoKeys, { key });
void oneKey;
// @ts-expect-error -- a union of key names is not one key
const unionKey = (key: 'accountId' | 'other') => j.entity('union-key', twoKeys, { key });
void unionKey;

// A table without `version` is rejected.
const noVersion = pgTable('no_version', { id: varchar('id').primaryKey() });
// @ts-expect-error -- `version` column is missing
const rejected: EntityTable = noVersion;
void rejected;

// --- Reducer shapes ---------------------------------------------------------

// An `.on` reducer sees the reducer-shaped state (insert shape plus id and version),
// never a full select row, because replay has no database defaults. It returns a patch.
const typed = j
  .entity('typed', orders)
  .create(OrderPlaced, e => ({ total: e.data.total, status: 'placed' }))
  .on(OrderPaid, row => {
    expectTypeOf(row).toMatchTypeOf<ReducerRow<typeof orders>>();
    expectTypeOf(row.id).toEqualTypeOf<OrderId>();
    return { status: 'paid' };
  });
void typed;

// --- Change 1: the key column is named, and its type flows everywhere -------

// `profiles` has no `id`. Its key is `accountId`, a branded string.
expectTypeOf<(typeof profile)['key']>().toEqualTypeOf<'accountId'>();
expectTypeOf<EntityId<typeof profiles, 'accountId'>>().toEqualTypeOf<AccountId>();
// ReducerValues omits the key column and `version`.
expectTypeOf<ReducerValues<typeof profiles, 'accountId'>>().toEqualTypeOf<{ nick: string; moveCount?: number }>();
// Recorded events carry the branded id, in `write` results and in handlers.
type ProfileWrite = WriteResult<typeof profiles, EventsOf<typeof profile>, Meta, 'accountId'>;
expectTypeOf<ProfileWrite['events'][number]['entityId']>().toEqualTypeOf<AccountId>();
expectTypeOf<ProfileWrite['row']>().toEqualTypeOf<Row<typeof profiles> | null>();
// Both rejected at the type level; both also throw at runtime, so they stay uncalled.
function badKeys() {
  // A table without `id` must name its key.
  // @ts-expect-error -- `profiles` has no `id` column
  j.entity('bare', profiles);
  // The named column must be a non-null string column of the table.
  // @ts-expect-error -- `moveCount` is an integer column
  j.entity('numeric-key', profiles, { key: 'moveCount' });
  // @ts-expect-error -- not a column of `profiles`
  j.entity('no-such-key', profiles, { key: 'nope' });
}
void badKeys;
// Reducers see the key under its own name, and the event's entity id with the column's type.
const keyed = j
  .entity('keyed', profiles, { key: 'accountId' })
  .create(ProfileOpened, e => {
    expectTypeOf(e.entityId).toEqualTypeOf<AccountId>();
    return { nick: e.data.nick, moveCount: 0 };
  })
  .on(ProfileMoved, (row, e) => {
    expectTypeOf(row.accountId).toEqualTypeOf<AccountId>();
    expectTypeOf(e.entityId).toEqualTypeOf<AccountId>();
    // Every create sets `moveCount`, so it is required here.
    expectTypeOf(row.moveCount).toEqualTypeOf<number>();
    return { moveCount: row.moveCount + 1 };
  });
void keyed;
// A create that sets a column on one branch only does not promise it: the `.on` row keeps it optional.
const conditional = j
  .entity('conditional', profiles, { key: 'accountId' })
  .create(ProfileOpened, e => (e.data.nick === 'counted' ? { nick: e.data.nick, moveCount: 1 } : { nick: e.data.nick }))
  .on(ProfileMoved, row => {
    expectTypeOf(row.nick).toEqualTypeOf<string>();
    expectTypeOf(row.moveCount).toEqualTypeOf<number | undefined>();
    return {};
  });
void conditional;
// After the first `.on`, `.create` is gone: a later create could leave out a column the `.on` was promised.
function createAfterOn() {
  const sealed = j.entity('sealed', profiles, { key: 'accountId' }).on(ProfileMoved, () => ({}));
  // @ts-expect-error -- `.create` is not available after `.on`
  sealed.create(ProfileOpened, e => ({ nick: e.data.nick }));
}
void createAfterOn;
const keyedProjection = j.projection('keyed-ids', profile, {
  ProfileOpened: (_tx, e) => {
    expectTypeOf(e.entityId).toEqualTypeOf<AccountId>();
  },
});
void keyedProjection;
async function keyedIds(db: DbHandle) {
  const journal = j.compose({});
  await journal.write(db, profile, 'acc_1', { meta, events: () => [] });
  await journal.replay(db, profile, 'acc_1');
  // @ts-expect-error -- the id must be an AccountId, not any string
  await journal.write(db, profile, 'ord_1', { meta, events: () => [] });
}
void keyedIds;

// --- Change 2: events gets the transaction; the app names its transaction type

type AppTx = Parameters<Parameters<PgliteDatabase['transaction']>[0]>[0];
const jt = initJournal.tx<AppTx>().create({ tables, meta: z.object({ actorId: z.string() }) });
const txOrder = jt
  .entity('tx-order', orders)
  .create(OrderPlaced, e => ({ total: e.data.total, status: 'placed' }))
  .on(OrderPaid, () => ({ status: 'paid' }));
const txProjection = jt.projection('tx-typed', txOrder, {
  OrderPlaced: tx => {
    expectTypeOf(tx).toEqualTypeOf<AppTx>();
  },
});
async function typedTx(db: PgliteDatabase, tx: AppTx) {
  const journal = jt.compose({ projections: [txProjection] });
  await journal.write(tx, txOrder, 'ord_1', {
    meta: { actorId: 'a' },
    events: (row, ctx) => {
      expectTypeOf(row).toEqualTypeOf<Row<typeof orders> | null>();
      expectTypeOf(ctx.tx).toEqualTypeOf<AppTx>();
      return [];
    },
  });
  // `rerun` opens app transactions from the root database.
  await journal.rerun(db, txProjection);
  // @ts-expect-error -- the root database is not the app's transaction type
  await journal.write(db, txOrder, 'ord_1', { meta: { actorId: 'a' }, events: () => [] });
  // A plain `initJournal` keeps the structural `DbHandle`, so a one-argument `events` still fits.
  const plain = j.compose({});
  await plain.write(db, typed, 'ord_1', { meta, events: () => [] });
}
void typedTx;

// --- Change 3: one event may have both a create and an on reducer ----------

const dual = j
  .entity('dual', orders)
  .create(OrderNoted, () => ({ total: 1, status: 'placed' }))
  .on(OrderNoted, () => ({ status: 'paid' }));
expectTypeOf<EventsOf<typeof dual>['type']>().toEqualTypeOf<'OrderNoted'>();
void dual;

// --- Change 4: columns every create reducer sets are required in `.on` -----

const withNote = pgTable('with_note', {
  id: varchar('id', { length: 256 }).primaryKey().$type<OrderId>(),
  total: integer('total').notNull(),
  note: varchar('note', { length: 256 }).notNull().default('none'),
  version: integer('version').notNull().default(0),
});
// Set by the create reducer: required.
const noteSet = j
  .entity('note-set', withNote)
  .create(OrderPlaced, e => ({ total: e.data.total, note: 'none' }))
  .on(OrderPaid, row => {
    expectTypeOf(row.note).toEqualTypeOf<string>();
    expectTypeOf(row.total).toEqualTypeOf<number>();
    return {};
  });
void noteSet;
// Left to the database default: still optional.
const noteDefault = j
  .entity('note-default', withNote)
  .create(OrderPlaced, e => ({ total: e.data.total }))
  .on(OrderPaid, row => {
    expectTypeOf(row.note).toEqualTypeOf<string | undefined>();
    return {};
  });
void noteDefault;
// Two create reducers: only the keys both set are required.
const noteMixed = j
  .entity('note-mixed', withNote)
  .create(OrderPlaced, e => ({ total: e.data.total, note: 'placed' }))
  .create(OrderNoted, () => ({ total: 0 }))
  .on(OrderPaid, row => {
    expectTypeOf(row.note).toEqualTypeOf<string | undefined>();
    expectTypeOf(row.total).toEqualTypeOf<number>();
    return {};
  });
void noteMixed;
// A value that may be `undefined` is stripped at runtime, so it is not required.
const noteMaybe = j
  .entity('note-maybe', withNote)
  .create(OrderPlaced, e => ({ total: e.data.total, note: e.data.total > 1 ? 'big' : undefined }))
  .on(OrderPaid, row => {
    expectTypeOf(row.note).toEqualTypeOf<string | undefined>();
    return {};
  });
void noteMaybe;
// `.on` declared before any `.create` sees the plain insert shape, and no `.create` can follow it.
const onFirst = j.entity('on-first', withNote).on(OrderPaid, row => {
  expectTypeOf(row.note).toEqualTypeOf<string | undefined>();
  return {};
});
expectTypeOf(onFirst).not.toHaveProperty('create');

// --- DbHandle constraint ----------------------------------------------------------

// A PGlite database and its transaction both fit `DbHandle`, with no relations.
// Only the database fits `RootDb`: `drain` and `worker` must not run inside a transaction.
// --- The app names its root database type: effects get it, drain and worker need it

const jd = initJournal
  .tx<AppTx>()
  .db<PgliteDatabase>()
  .create({ tables, meta: z.object({ actorId: z.string() }) });
const dbOrder = jd
  .entity('db-order', orders)
  .create(OrderPlaced, e => ({ total: e.data.total, status: 'placed' }))
  .on(OrderPaid, () => ({ status: 'paid' }));
const dbEffect = jd.effect('db-typed', dbOrder, {
  OrderPaid: (_e, ctx) => {
    expectTypeOf(ctx.db).toEqualTypeOf<PgliteDatabase>();
    // The app type has what the structural `RootDb` lacks, such as the relational `query`.
    expectTypeOf(ctx.db.query).toEqualTypeOf<PgliteDatabase['query']>();
  },
});
// Either order names the same two types.
const jdSwapped = initJournal
  .db<PgliteDatabase>()
  .tx<AppTx>()
  .create({ tables, meta: z.object({ actorId: z.string() }) });
expectTypeOf(jdSwapped).toEqualTypeOf<typeof jd>();
// Without `.db<…>()` an effect sees the library's `RootDb`.
const plainEffect = jt.effect('plain-db', txOrder, {
  OrderPaid: (_e, ctx) => {
    expectTypeOf(ctx.db).toEqualTypeOf<RootDb>();
  },
});
async function typedDb(db: PgliteDatabase, tx: AppTx, structural: RootDb) {
  const journal = jd.compose({ effects: [dbEffect] });
  await journal.drain(db);
  journal.worker(db);
  // @ts-expect-error -- a transaction is not the root database
  await journal.drain(tx);
  // @ts-expect-error -- a transaction is not the root database
  journal.worker(tx);
  // @ts-expect-error -- the structural `RootDb` is not the app's database type: `ctx.db.query` would be missing
  await journal.drain(structural);
  // @ts-expect-error -- the structural `RootDb` is not the app's database type
  journal.worker(structural);
  // A journal without `.db<…>()` takes any root database that opens its transaction type.
  const plain = jt.compose({ effects: [plainEffect] });
  await plain.drain(db);
  // @ts-expect-error -- the structural `RootDb` opens `DbHandle` transactions: a command run by an effect needs an `AppTx`
  await plain.drain(structural);
  // Without `.tx<…>()` too, every root database fits.
  await j.compose({}).drain(structural);
}
void typedDb;

// --- An effect's `run` takes the commands `journal.run` takes, and no others

const dbPay = jd.command('pay', z.object({ id: z.string() }), (input, { tx }) => {
  expectTypeOf(tx).toEqualTypeOf<AppTx>();
  return input.id.length;
});
// Written for the structural transaction: any journal with this meta can run it.
const plainPay = j.command('pay', z.object({ id: z.string() }), input => input.id.length);
const tenants = initJournal({ tables, meta: z.object({ tenantId: z.string() }) });
const tenantPay = tenants.command('pay', z.object({ id: z.string() }), input => input.id.length);

const dbRuns = jd.effect('db-runs', dbOrder, {
  OrderPaid: async (e, { run }) => {
    expectTypeOf(run).toEqualTypeOf<RootCommandRunner<z.ZodObject<{ actorId: z.ZodString }>, AppTx>>();
    expectTypeOf(await run(dbPay, { id: e.entityId }, { actorId: 'system' })).toEqualTypeOf<number>();
    await run(plainPay, { id: e.entityId }, { actorId: 'system' });
    // @ts-expect-error -- `meta` is required: the library never invents an actor
    await run(dbPay, { id: e.entityId });
    // @ts-expect-error -- not the meta of this journal
    await run(dbPay, { id: e.entityId }, { tenantId: 't' });
    // @ts-expect-error -- the input is checked against the command's schema
    await run(dbPay, { id: 1 }, { actorId: 'system' });
    // @ts-expect-error -- a command for another meta shape: its handler would read `meta.tenantId`
    await run(tenantPay, { id: e.entityId }, { actorId: 'system' });
  },
});
const plainRuns = j.effect('plain-runs', typed, {
  OrderPaid: async (e, { run }) => {
    await run(plainPay, { id: e.entityId }, meta);
    // @ts-expect-error -- a command for the app's transaction type: this journal would hand it a plain `DbHandle`
    await run(dbPay, { id: e.entityId }, meta);
  },
});
// The same journal that types `run` composes these effects.
void jd.compose({ effects: [dbRuns] });
void j.compose({ effects: [plainRuns] });

// --- An effect's needs reach its handlers, and `compose` asks for a service for each one

type Mailer = { send(to: string): Promise<void> };
type Clock = { now(): Date };
const needsMail = jd.effect(
  'needs-mail',
  dbOrder,
  { mailer: need<Mailer>() },
  {
    OrderPaid: (_e, ctx) => {
      expectTypeOf(ctx.mailer).toEqualTypeOf<Mailer>();
      // The built-in context is still there, typed as before.
      expectTypeOf(ctx.db).toEqualTypeOf<PgliteDatabase>();
      expectTypeOf(ctx.jobId).toEqualTypeOf<string>();
      expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
      expectTypeOf(ctx.run).toEqualTypeOf<RootCommandRunner<z.ZodObject<{ actorId: z.ZodString }>, AppTx>>();
      // @ts-expect-error -- `clock` is not a need of this effect, so its handlers must not see one
      void ctx.clock;
    },
  },
);
const needsClock = jd.effect(
  'needs-clock',
  dbOrder,
  { clock: need<Clock>() },
  { OrderPaid: (_e, { clock }) => clock.now() },
);
function needsFit(mailer: Mailer, clock: Clock) {
  // One `services` object covers every effect in the list. Effects without needs sit next to them.
  void jd.compose({ effects: [dbRuns, needsMail, needsClock], services: { mailer, clock } });
  // @ts-expect-error -- `needsClock` needs `clock`: every need of every listed effect must be given
  void jd.compose({ effects: [needsMail, needsClock], services: { mailer } });
  // @ts-expect-error -- an effect in the list has a need, so `services` is required
  void jd.compose({ effects: [needsMail] });
  // @ts-expect-error -- an effect without needs next to it must not hide the need
  void jd.compose({ effects: [dbRuns, needsMail] });
  // @ts-expect-error -- a service must have the type its need names
  void jd.compose({ effects: [needsMail], services: { mailer: clock } });
  // @ts-expect-error -- an effect is typed for its own journal: this one reads `ctx.db` as a `PgliteDatabase` with `AppTx` commands
  void tenants.compose({ effects: [needsMail], services: { mailer } });
}
void needsFit;
type Both = ServicesFor<[typeof needsMail, typeof dbRuns, typeof needsClock]>;
expectTypeOf<Both['mailer']>().toEqualTypeOf<Mailer>();
expectTypeOf<Both['clock']>().toEqualTypeOf<Clock>();
// No effect needs anything: there is nothing to ask for.
expectTypeOf<ServicesFor<[typeof dbRuns]>>().toBeUnknown();

async function dbFits() {
  const db = drizzle({ client: new PGlite('memory://') });
  const asDb: DbHandle = db;
  const asRoot: RootDb = db;
  void asRoot;
  const journal = j.compose({});
  await asDb.transaction(tx => {
    const inner: DbHandle = tx;
    void inner;
    return Promise.resolve();
  });
  await db.transaction(tx => {
    const inner: DbHandle = tx;
    void inner;
    // @ts-expect-error -- a transaction is not the root database
    return journal.drain(tx);
  });
}
void dbFits;

// --- Statements against the erased table type -----------------------------

// The journal runs its statements against `EntityTable` and the entity's key
// column. Extra runtime columns flow through the spread; the type only promises `version`.
async function statements(db: DbHandle, entity: Pick<AnyEntity, 'table' | 'keyColumn'>, id: string, patch: object) {
  const loaded = await db.select().from(entity.table).where(eq(entity.keyColumn, id)).for('update');
  expectTypeOf(loaded[0]).toEqualTypeOf<{ version: number } | undefined>();
  const inserted = await db
    .insert(entity.table)
    .values({ ...patch, version: 1 })
    .returning();
  expectTypeOf(inserted[0]).toEqualTypeOf<{ version: number } | undefined>();
  await db
    .update(entity.table)
    .set({ ...patch, version: 2 })
    .where(eq(entity.keyColumn, id))
    .returning();
  await db.delete(entity.table).where(eq(entity.keyColumn, id));
}
void statements;

// --- Zod data flows into Recorded -----------------------------------------

type PaidSchema = z.ZodObject<{ amount: z.ZodInt }>;
expectTypeOf<Recorded<'OrderPaid', z.output<PaidSchema>, { actorId: string }>['data']>().toEqualTypeOf<{
  amount: number;
}>();

it('calling an event definition validates and returns a pending event', () => {
  expectTypeOf(orders).toMatchTypeOf<EntityTable>();
  const paid = OrderPaid({ amount: 5 });
  expectTypeOf(paid.data).toEqualTypeOf<{ amount: number }>();
  expect(paid).toEqual({ type: 'OrderPaid', data: { amount: 5 } });
  expect(() => OrderPaid({ amount: -1 })).toThrow();
});
