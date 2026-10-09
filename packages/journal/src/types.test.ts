/**
 * Type-level proof for the design (spec section 12, item 1): the `.create` /
 * `.on` chain and the Drizzle table and transaction types compose without a
 * cast. `tsc` checks this file; the single runtime test keeps Vitest happy.
 */
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import { j, OrderPaid, OrderPlaced, tables } from './test-support.js';
import type { order } from './test-support.js';
import type {
  Db,
  EntityId,
  EntityTable,
  EventsOf,
  NewRow,
  PendingOf,
  ProjectionHandlers,
  Recorded,
  RecordedOf,
  Replayed,
  RootDb,
  Row,
} from './types.js';

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
// `decide` may only return declared events: Unrelated is not in the union.
expectTypeOf<PendingOf<OrderEvents>['type']>().toEqualTypeOf<'OrderPlaced' | 'OrderPaid' | 'OrderNoted' | 'OrderCancelled'>();

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

// Row and NewRow are inferred from the table.
expectTypeOf<Row<typeof orders>>().toEqualTypeOf<typeof orders.$inferSelect>();
expectTypeOf<NewRow<typeof orders>>().toEqualTypeOf<{ total: number; status: 'placed' | 'paid' }>();
expectTypeOf<EntityId<typeof orders>>().toEqualTypeOf<OrderId>();

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
    expectTypeOf(row).toEqualTypeOf<Replayed<typeof orders>>();
    return { status: 'paid' };
  });
void typed;

// --- Db constraint ----------------------------------------------------------

// A PGlite database and its transaction both fit `Db`, with no relations.
// Only the database fits `RootDb`: `drain` and `worker` must not run inside a transaction.
async function dbFits() {
  const db = drizzle({ client: new PGlite('memory://') });
  const asDb: Db = db;
  const asRoot: RootDb = db;
  void asRoot;
  const journal = j.create({ tables });
  await asDb.transaction(tx => {
    const inner: Db = tx;
    void inner;
    return Promise.resolve();
  });
  await db.transaction(tx => {
    const inner: Db = tx;
    void inner;
    // @ts-expect-error -- a transaction is not the root database
    return journal.drain(tx);
  });
}
void dbFits;

// --- Statements against the erased table type -----------------------------

// The journal runs its statements against `EntityTable`. Extra runtime
// columns flow through the spread; the type only promises `id` and `version`.
async function statements(db: Db, table: EntityTable, id: string, patch: object) {
  const loaded = await db.select().from(table).where(eq(table.id, id)).for('update');
  expectTypeOf(loaded[0]).toEqualTypeOf<{ id: string; version: number } | undefined>();
  const inserted = await db
    .insert(table)
    .values({ ...patch, id, version: 1 })
    .returning();
  expectTypeOf(inserted[0]).toEqualTypeOf<{ id: string; version: number } | undefined>();
  await db
    .update(table)
    .set({ ...patch, version: 2 })
    .where(eq(table.id, id))
    .returning();
  await db.delete(table).where(eq(table.id, id));
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
