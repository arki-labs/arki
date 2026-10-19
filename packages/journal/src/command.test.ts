/**
 * Commands: `j.command` defines one, `journal.run` runs it. These tests pin
 * what every trigger path (procedure, job, schedule, webhook, script, test)
 * relies on: input is parsed before anything runs, meta is parsed once and
 * inherited by every write, and all writes of one command live or die together.
 * The type-level block proves the inference without a cast; `tsc` checks it.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { InvalidInput, orThrow } from '@arki/failure';

import type { OrderId } from './test-support.js';
import type { DbHandle, Row } from './types.js';
import { CommandForbidden } from './errors.js';
import { initJournal } from './journal.js';
import {
  accountId,
  customerOrderCounts,
  j,
  meta,
  openDb,
  order,
  orderId,
  OrderNoted,
  OrderPaid,
  OrderPlaced,
  orders,
  profile,
  ProfileOpened,
  profiles,
  tables,
} from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let journal: ReturnType<typeof j.compose>;
let next = 0;

const customerStats = j.projection('customer-stats', order, {
  OrderPlaced: (tx, e) =>
    tx
      .insert(customerOrderCounts)
      .values({ customerId: e.data.customerId, placed: 1 })
      .onConflictDoUpdate({
        target: customerOrderCounts.customerId,
        set: { placed: sql`${customerOrderCounts.placed} + 1` },
      }),
});
const mail = j.effect('order-mail', order, {
  OrderPaid: () => {
    /* never drained here: the job row is what these tests compare */
  },
});

const orderIdSchema = z.templateLiteral(['ord_', z.string()]);
const accountIdSchema = z.templateLiteral(['acc_', z.string()]);

const placeOrder = j.command(
  'placeOrder',
  z.object({ orderId: orderIdSchema, customerId: z.string().min(1), total: z.int().positive() }),
  (input, { write }) =>
    write(order, input.orderId, row =>
      row ? [] : [OrderPlaced({ customerId: input.customerId, total: input.total })],
    ),
);

const payOrder = j.command(
  'payOrder',
  z.object({ orderId: orderIdSchema, amount: z.int().positive() }),
  (input, { write }) =>
    write(order, input.orderId, (row, { tx }) => {
      expectTypeOf(row).toEqualTypeOf<Row<typeof orders> | null>();
      expectTypeOf(tx).toEqualTypeOf<DbHandle>();
      if (!row) throw new Error('order not found');
      if (row.status !== 'placed') throw new Error(`order is ${row.status}`);
      return [OrderPaid({ amount: input.amount })];
    }),
);

/** The bound callback reads related rows through `tx` and sees the locked row. */
const inspectOrder = j.command('inspectOrder', z.object({ orderId: orderIdSchema }), (input, { write }) =>
  write(order, input.orderId, async (row, { tx }) => {
    const same = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, input.orderId));
    return row === null ? [] : [OrderNoted({ note: `row v${row.version}, tx saw ${same.length}` })];
  }),
);

/** Two entities in one command. The second write fails on purpose when `nick` is 'boom'. */
const openBoth = j.command(
  'openBoth',
  z.object({ orderId: orderIdSchema, accountId: accountIdSchema, nick: z.string().min(1) }),
  async (input, { write }) => {
    orThrow(await write(order, input.orderId, () => [OrderPlaced({ customerId: 'both', total: 1 })]));
    return write(profile, input.accountId, () => {
      if (input.nick === 'boom') throw new Error('second write boom');
      return [ProfileOpened({ nick: input.nick })];
    });
  },
);

/** No entity: a plain query through `tx`, returning a number. */
const countOrders = j.command('countOrders', z.object({ customerId: z.string() }), async (input, { tx }) => {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.customerId, input.customerId));
  return rows[0]?.n ?? 0;
});

/**
 * A child that notes the parent's order, then places and pays a second order
 * (a projection row and a job row), then fails when the note is 'boom'. The
 * failure comes after its writes on purpose.
 */
const noteOrder = j.command(
  'noteOrder',
  z.object({ orderId: orderIdSchema, childOrderId: orderIdSchema, note: z.string().min(1) }),
  async (input, { write }) => {
    orThrow(await write(order, input.orderId, () => [OrderNoted({ note: input.note })]));
    orThrow(
      await write(order, input.childOrderId, () => [
        OrderPlaced({ customerId: `child-of-${input.orderId}`, total: 1 }),
        OrderPaid({ amount: 1 }),
      ]),
    );
    if (input.note === 'boom') throw new Error('child boom');
  },
);

/** A parent that writes first, then runs the child. `catchChild` says whether it swallows a child failure. */
const placeThenNote = j.command(
  'placeThenNote',
  z.object({
    orderId: orderIdSchema,
    childOrderId: orderIdSchema,
    note: z.string().min(1),
    catchChild: z.boolean(),
  }),
  async (input, { write, run }) => {
    orThrow(await write(order, input.orderId, () => [OrderPlaced({ customerId: 'nested', total: 1 })]));
    const child = run(noteOrder, { orderId: input.orderId, childOrderId: input.childOrderId, note: input.note });
    if (input.catchChild) orThrow(await child.catch(() => 'child rolled back'));
    else orThrow(await child);
    return 'done' as const;
  },
);

/** A grandparent: a child inside a child, each on its own savepoint. */
const placeViaChildren = j.command(
  'placeViaChildren',
  z.object({ orderId: orderIdSchema, childOrderId: orderIdSchema }),
  (input, { run }) => run(placeThenNote, { ...input, note: 'deep', catchChild: false }),
);

const twoIds = z.object({ a: orderIdSchema, b: orderIdSchema });
const placeBoth = (a: OrderId, b: OrderId, run: HandlerArgs<typeof placeOrder>[1]['run']) => [
  run(placeOrder, { orderId: a, customerId: 'pair', total: 1 }),
  run(placeOrder, { orderId: b, customerId: 'pair', total: 1 }),
];
/** Two children started without awaiting each in turn. */
const twoAtOnce = j.command('twoAtOnce', twoIds, async (input, { run }) => {
  const results = await Promise.all(placeBoth(input.a, input.b, run));
  for (const result of results) orThrow(result);
});
const placePair = () => [OrderPlaced({ customerId: 'pair', total: 1 })];
/** Two writes started without awaiting each in turn. */
const twoWritesAtOnce = j.command('twoWritesAtOnce', twoIds, async (input, { write }) => {
  const results = await Promise.all([write(order, input.a, placePair), write(order, input.b, placePair)]);
  for (const result of results) orThrow(result);
});
/** Starts a write, does not await it, and throws. The write is still running when the handler leaves. */
const throwsWithWriteRunning = j.command('throwsWithWriteRunning', twoIds, (input, { write }) => {
  void write(order, input.a, placePair).then(result => orThrow(result));
  throw new Error('handler boom');
});
/** Starts a write, does not await it, and returns. */
const returnsWithWriteRunning = j.command('returnsWithWriteRunning', twoIds, (input, { write }) => {
  void write(order, input.a, placePair).then(result => orThrow(result));
  return Promise.resolve();
});
/** The same two children, awaited one at a time. */
const twoInTurn = j.command('twoInTurn', twoIds, async (input, { run }) => {
  orThrow(await run(placeOrder, { orderId: input.a, customerId: 'pair', total: 1 }));
  orThrow(await run(placeOrder, { orderId: input.b, customerId: 'pair', total: 1 }));
});

// --- Types ------------------------------------------------------------------
// The handler's input is the schema output; `run` takes the schema input.
type HandlerArgs<C> = C extends { readonly handler: (...args: infer Args) => unknown } ? Args : never;
const dated = j.command('dated', z.object({ at: z.string().transform(s => new Date(s)) }), input => {
  expectTypeOf(input.at).toEqualTypeOf<Date>();
  return input.at.getTime();
});
expectTypeOf(dated.name).toEqualTypeOf<string>();
expectTypeOf(dated.input).toEqualTypeOf<z.ZodObject<{ at: z.ZodPipe<z.ZodString, z.ZodTransform<Date, string>> }>>();
expectTypeOf<HandlerArgs<typeof placeOrder>[0]>().toEqualTypeOf<{
  orderId: OrderId;
  customerId: string;
  total: number;
}>();
expectTypeOf<HandlerArgs<typeof placeOrder>[1]['tx']>().toEqualTypeOf<DbHandle>();
expectTypeOf<HandlerArgs<typeof placeOrder>[1]['meta']>().toEqualTypeOf<{ actorId: string }>();

const foreignEvents = () => [ProfileOpened({ nick: 'a' })];
const otherJ = initJournal({ tables, meta: z.object({ tenant: z.string() }) });
const foreignCommand = otherJ.command('foreign', z.object({}), () => 1);
function typeChecks(): void {
  void journal.run(db, dated, { at: '2026-01-01' }, meta).then(result => orThrow(result));
  // @ts-expect-error `run` takes the schema input, not the output.
  void journal.run(db, dated, { at: new Date() }, meta).then(result => orThrow(result));
  // @ts-expect-error wrong input to `run`.
  void journal.run(db, placeOrder, { orderId: 'ord_1', customerId: 1, total: 1 }, meta).then(result => orThrow(result));
  // @ts-expect-error meta must match the journal's meta schema.
  void journal.run(db, countOrders, { customerId: 'c' }, { actorId: 1 }).then(result => orThrow(result));
  // @ts-expect-error a command defined for another meta schema cannot run on this journal.
  void journal.run(db, foreignCommand, {}, meta).then(result => orThrow(result));
  void j.command('nested', z.object({}), (_input, { run }) =>
    run(placeOrder, { orderId: 'ord_1', customerId: 'c', total: 1 }),
  );
  // @ts-expect-error the child's input is checked too.
  void j.command('nested-bad', z.object({}), (_input, { run }) => run(placeOrder, { orderId: 'ord_1' }));
  // @ts-expect-error an event the entity does not declare.
  void j.command('bad-event', z.object({}), (_input, { write }) => write(order, orderId(1), foreignEvents));
  // @ts-expect-error the id must be the entity's key type.
  void j.command('bad-id', z.object({}), (_input, { write }) => write(order, accountId(1), () => []));
}
void typeChecks;

// --- Runtime ----------------------------------------------------------------
beforeAll(async () => {
  ({ db, client } = await openDb());
  journal = j.compose({ projections: [customerStats], effects: [mail] });
});

afterAll(async () => {
  await client.close();
});

const rowsOf = (id: OrderId) => db.select().from(orders).where(eq(orders.id, id));
const eventsOf = (id: string) =>
  db.select().from(tables.events).where(eq(tables.events.entityId, id)).orderBy(tables.events.version);
const shape = (events: { type: string; data: unknown; meta: unknown; version: number }[]) =>
  events.map(e => ({ type: e.type, data: e.data, meta: e.meta, version: e.version }));
/** What a `noteOrder` child leaves behind for its second order: row, events, projection row, job rows. */
const childTraces = async (parentId: OrderId, childId: OrderId) => {
  const events = await eventsOf(childId);
  const counts = await db
    .select()
    .from(customerOrderCounts)
    .where(eq(customerOrderCounts.customerId, `child-of-${parentId}`));
  const jobs =
    events.length === 0
      ? []
      : await db
          .select()
          .from(tables.jobs)
          .where(
            inArray(
              tables.jobs.eventSeq,
              events.map(e => e.seq),
            ),
          );
  const rows = await rowsOf(childId);
  return { rows: rows.length, events: events.length, counts: counts.length, jobs: jobs.length };
};

describe('journal.run', () => {
  it('parses the input before anything runs: bad input writes nothing', async () => {
    // Why: jobs, webhooks and scripts rely on `run` as the one validation gate.
    const id = orderId(++next);
    await expect(journal.run(db, placeOrder, { orderId: id, customerId: '', total: 1 }, meta)).resolves.toMatchObject({
      code: InvalidInput.code,
    });
    expect(await rowsOf(id)).toEqual([]);
    expect(await eventsOf(id)).toEqual([]);
  });

  it('parses meta once and every write records that parsed meta', async () => {
    // Why: a command with several writes must not re-run meta transforms per write.
    // Only the caller's raw value (lowercase) counts: the storage round-trip check and
    // the decoding of each stored event parse the already-transformed value.
    let parses = 0;
    const loud = initJournal({
      tables,
      meta: z.object({
        actorId: z.string().transform(v => {
          if (v !== v.toUpperCase()) parses += 1;
          return v.toUpperCase();
        }),
      }),
    });
    const twice = loud.command('twice', z.object({ orderId: orderIdSchema }), async (input, { write, meta }) => {
      orThrow(await write(order, input.orderId, () => [OrderPlaced({ customerId: 'twice', total: 1 })]));
      orThrow(await write(order, input.orderId, () => [OrderPaid({ amount: 1 })]));
      return meta;
    });
    const id = orderId(++next);
    const seen = await loud.compose({}).run(db, twice, { orderId: id }, { actorId: 'usr_x' });
    expect(parses).toBe(1);
    expect(seen).toEqual({ actorId: 'USR_X' });
    const stored = await eventsOf(id);
    expect(stored.map(e => e.meta)).toEqual([{ actorId: 'USR_X' }, { actorId: 'USR_X' }]);
  });

  it('two entities: a throw in the second write leaves neither written', async () => {
    // Why: a command is one unit of work; a half-applied command is the bug this exists to prevent.
    const id = orderId(++next);
    const acc = accountId(++next);
    await expect(journal.run(db, openBoth, { orderId: id, accountId: acc, nick: 'boom' }, meta)).rejects.toThrow(
      'second write boom',
    );
    expect(await rowsOf(id)).toEqual([]);
    expect(await db.select().from(profiles).where(eq(profiles.accountId, acc))).toEqual([]);
    expect(await eventsOf(id)).toEqual([]);
    expect(await eventsOf(acc)).toEqual([]);
  });

  it('given a transaction, runs in a savepoint: the caller can still roll it back', async () => {
    // Why: a procedure that owns the transaction must stay in charge of the commit.
    const id = orderId(++next);
    await db
      .transaction(async tx => {
        orThrow(await journal.run(tx, placeOrder, { orderId: id, customerId: 'c', total: 1 }, meta));
        expect(await tx.select().from(orders).where(eq(orders.id, id))).toHaveLength(1);
        tx.rollback();
      })
      .catch(() => 'rolled back');
    expect(await rowsOf(id)).toEqual([]);
    expect(await eventsOf(id)).toEqual([]);
  });

  it('nested run: a child that succeeds leaves its projection row and job row, so the rollback tests below can fail', async () => {
    const id = orderId(++next);
    const childId = orderId(++next);
    orThrow(
      await journal.run(
        db,
        placeThenNote,
        { orderId: id, childOrderId: childId, note: 'fine', catchChild: false },
        meta,
      ),
    );
    expect(await childTraces(id, childId)).toEqual({ rows: 1, events: 2, counts: 1, jobs: 1 });
  });

  it('nested run: an uncaught child failure rolls back the parent too', async () => {
    // Why: a parent that does not handle a child's failure must not keep its own half.
    const id = orderId(++next);
    const childId = orderId(++next);
    await expect(
      journal.run(db, placeThenNote, { orderId: id, childOrderId: childId, note: 'boom', catchChild: false }, meta),
    ).rejects.toThrow('child boom');
    expect(await rowsOf(id)).toEqual([]);
    expect(await eventsOf(id)).toEqual([]);
    expect(await childTraces(id, childId)).toEqual({ rows: 0, events: 0, counts: 0, jobs: 0 });
  });

  it('nested run: a caught child failure keeps the parent write and drops the whole child', async () => {
    // Why: the child ran in its own savepoint, so its writes, its projection rows and its
    // job rows all go, even though they happened before the throw.
    const id = orderId(++next);
    const childId = orderId(++next);
    const result = await journal.run(
      db,
      placeThenNote,
      { orderId: id, childOrderId: childId, note: 'boom', catchChild: true },
      meta,
    );
    expect(result).toBe('done');
    const [row] = await rowsOf(id);
    expect(row).toMatchObject({ status: 'placed', note: 'none', version: 1 });
    const stored = await eventsOf(id);
    expect(stored.map(e => e.type)).toEqual(['OrderPlaced']);
    expect(await childTraces(id, childId)).toEqual({ rows: 0, events: 0, counts: 0, jobs: 0 });
  });

  it('nested run: a child inside a child runs on its own savepoint and commits with the rest', async () => {
    const id = orderId(++next);
    const childId = orderId(++next);
    orThrow(await journal.run(db, placeViaChildren, { orderId: id, childOrderId: childId }, meta));
    const [deep] = await rowsOf(id);
    expect(deep).toMatchObject({ note: 'deep', version: 2 });
    expect(await childTraces(id, childId)).toEqual({ rows: 1, events: 2, counts: 1, jobs: 1 });
  });

  it('two children started together are refused, and nothing from the command is committed', async () => {
    // Why: savepoints are a stack. Two open at once release each other's work, so a caught
    // failure of the second could erase what the first wrote. The second must not start.
    const a = orderId(++next);
    const b = orderId(++next);
    await expect(journal.run(db, twoAtOnce, { a, b }, meta)).rejects.toThrow(
      'journal: command "placeOrder" started on a transaction that already has a journal operation in flight; await operations on one transaction one at a time',
    );
    expect(await rowsOf(a)).toEqual([]);
    expect(await rowsOf(b)).toEqual([]);
    expect(await eventsOf(a)).toEqual([]);
    expect(await eventsOf(b)).toEqual([]);
  });

  it('two bound writes started together are refused the same way', async () => {
    const a = orderId(++next);
    const b = orderId(++next);
    await expect(journal.run(db, twoWritesAtOnce, { a, b }, meta)).rejects.toThrow(
      `journal: write to order ${b} started on a transaction that already has a journal operation in flight`,
    );
    expect(await rowsOf(a)).toEqual([]);
    expect(await rowsOf(b)).toEqual([]);
  });

  it('two low-level writes started together on one transaction are refused too', async () => {
    const a = orderId(++next);
    const b = orderId(++next);
    await expect(
      db.transaction(tx =>
        Promise.all([
          journal.write(tx, order, a, { meta, events: placePair }),
          journal.write(tx, order, b, { meta, events: placePair }),
        ]),
      ),
    ).rejects.toThrow(`journal: write to order ${b} started on a transaction`);
    expect(await rowsOf(a)).toEqual([]);
    expect(await rowsOf(b)).toEqual([]);
  });

  it('a handler that throws with a write still running: the write settles inside the transaction, then the handler error wins', async () => {
    // Why: if the transaction closed while the write ran, the write's row and event would land
    // after the rollback, outside any transaction, although the command failed.
    const a = orderId(++next);
    const b = orderId(++next);
    await expect(journal.run(db, throwsWithWriteRunning, { a, b }, meta)).rejects.toThrow('handler boom');
    expect(await rowsOf(a)).toEqual([]);
    expect(await eventsOf(a)).toEqual([]);
  });

  it('a handler that returns with a write still running fails the command and rolls back', async () => {
    // Why: "done" must mean every write of the command is in the transaction that commits.
    const a = orderId(++next);
    const b = orderId(++next);
    await expect(journal.run(db, returnsWithWriteRunning, { a, b }, meta)).rejects.toThrow(
      'journal: command "returnsWithWriteRunning" returned with 1 journal operation still running; await every write and run before the handler returns',
    );
    expect(await rowsOf(a)).toEqual([]);
    expect(await eventsOf(a)).toEqual([]);
  });

  it('a second write with bad meta waits for the first write to settle before it rejects', async () => {
    // Why: a rejection that jumps the queue makes the caller roll back while the first write
    // is still running, so that write's rows land after the rollback.
    const a = orderId(++next);
    const b = orderId(++next);
    await expect(
      db.transaction(tx =>
        Promise.all([
          journal.write(tx, order, a, { meta, events: placePair }),
          journal.write(tx, order, b, { meta: { actorId: '' }, events: placePair }),
        ]),
      ),
    ).rejects.toThrow(`journal: write to order ${b} started on a transaction`);
    expect(await rowsOf(a)).toEqual([]);
    expect(await eventsOf(a)).toEqual([]);
  });

  it('a second run with bad meta waits the same way', async () => {
    const a = orderId(++next);
    const b = orderId(++next);
    await expect(
      db.transaction(tx =>
        Promise.all([
          journal.write(tx, order, a, { meta, events: placePair }),
          journal.run(tx, placeOrder, { orderId: b, customerId: 'pair', total: 1 }, { actorId: '' }),
        ]),
      ),
    ).rejects.toThrow('journal: command "placeOrder" started on a transaction');
    expect(await rowsOf(a)).toEqual([]);
    expect(await eventsOf(a)).toEqual([]);
  });

  it('two children awaited one at a time both commit', async () => {
    const a = orderId(++next);
    const b = orderId(++next);
    orThrow(await journal.run(db, twoInTurn, { a, b }, meta));
    expect(await rowsOf(a)).toHaveLength(1);
    expect(await rowsOf(b)).toHaveLength(1);
  });

  it('a command with no entity returns its value', async () => {
    // Why: a command is the unit of validated, transactional work, even when no entity is involved.
    orThrow(await journal.run(db, placeOrder, { orderId: orderId(++next), customerId: 'counted', total: 1 }, meta));
    orThrow(await journal.run(db, placeOrder, { orderId: orderId(++next), customerId: 'counted', total: 2 }, meta));
    const count = await journal.run(db, countOrders, { customerId: 'counted' }, meta);
    expectTypeOf(orThrow(count)).toEqualTypeOf<number>();
    expect(count).toBe(2);
  });

  it("a command's write produces the same row, events, projection and job rows as journal.write", async () => {
    // Why: commands are a binding over `write`, not a second write path that could drift.
    const viaCommand = orderId(++next);
    const viaWrite = orderId(++next);
    orThrow(await journal.run(db, placeOrder, { orderId: viaCommand, customerId: 'cmp_a', total: 7 }, meta));
    const paidByCommand = orThrow(await journal.run(db, payOrder, { orderId: viaCommand, amount: 7 }, meta));
    orThrow(
      await db.transaction(tx =>
        journal.write(tx, order, viaWrite, { meta, events: () => [OrderPlaced({ customerId: 'cmp_b', total: 7 })] }),
      ),
    );
    const paidByWrite = orThrow(
      await db.transaction(tx =>
        journal.write(tx, order, viaWrite, { meta, events: () => [OrderPaid({ amount: 7 })] }),
      ),
    );

    const { id: _a, customerId: _ca, ...rowA } = paidByCommand.row ?? {};
    const { id: _b, customerId: _cb, ...rowB } = paidByWrite.row ?? {};
    expect(rowA).toEqual(rowB);
    const storedA = await eventsOf(viaCommand);
    const storedB = await eventsOf(viaWrite);
    expect(shape(storedA)).toEqual(
      shape(storedB).map(e => (e.type === 'OrderPlaced' ? { ...e, data: { customerId: 'cmp_a', total: 7 } } : e)),
    );
    const counts = await db
      .select()
      .from(customerOrderCounts)
      .where(inArray(customerOrderCounts.customerId, ['cmp_a', 'cmp_b']));
    expect(counts.map(c => c.placed)).toEqual([1, 1]);
    const jobsFor = (seqs: number[]) =>
      db.select({ effect: tables.jobs.effect }).from(tables.jobs).where(inArray(tables.jobs.eventSeq, seqs));
    expect(await jobsFor(storedA.map(e => e.seq))).toEqual([{ effect: 'order-mail' }]);
    expect(await jobsFor(storedB.map(e => e.seq))).toEqual([{ effect: 'order-mail' }]);
  });

  it('the bound write callback receives the locked row and the write transaction', async () => {
    // Why: rules read the row and related rows under the lock; the callback shape must match `journal.write`.
    const id = orderId(++next);
    const first = await journal.run(db, inspectOrder, { orderId: id }, meta);
    expect(first).toEqual({ row: null, events: [] });
    orThrow(await journal.run(db, placeOrder, { orderId: id, customerId: 'c', total: 1 }, meta));
    const second = orThrow(await journal.run(db, inspectOrder, { orderId: id }, meta));
    expect(second.row?.note).toBe('row v1, tx saw 1');
  });
});

const stamps = async (id: OrderId) => {
  const events = await eventsOf(id);
  return events.map(e => ({
    type: e.type,
    commandId: e.commandId,
    causeSeq: e.causeSeq,
    correlationId: e.correlationId,
  }));
};

describe('expectedVersion from a command', () => {
  it("a command's write takes the client's version and refuses a stale one with CONFLICT", async () => {
    const noteAt = j.command(
      'noteAt',
      z.object({ orderId: orderIdSchema, version: z.int(), note: z.string() }),
      (input, { write }) =>
        write(order, input.orderId, () => [OrderNoted({ note: input.note })], { expectedVersion: input.version }),
    );
    const id = orderId(++next);
    orThrow(await journal.run(db, placeOrder, { orderId: id, customerId: 'c', total: 1 }, meta));
    orThrow(await journal.run(db, payOrder, { orderId: id, amount: 1 }, meta));
    await expect(journal.run(db, noteAt, { orderId: id, version: 1, note: 'stale' }, meta)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(journal.run(db, noteAt, { orderId: id, version: 2, note: 'fresh' }, meta)).resolves.toMatchObject({
      row: { note: 'fresh', version: 3 },
    });
  });
});

const receiptOf = async (key: string) => {
  const rows = await db.select().from(tables.receipts).where(eq(tables.receipts.key, key));
  return rows[0] ?? null;
};
/** Commands run with a key return plain data: a `WriteResult` holds Dates, which JSON cannot keep. */
const justNote = j.command(
  'justNote',
  z.object({ orderId: orderIdSchema, note: z.string().min(1) }),
  async (input, { write }) => {
    const { row } = orThrow(await write(order, input.orderId, () => [OrderNoted({ note: input.note })]));
    return { version: row?.version ?? 0 };
  },
);
const placePlain = j.command('placePlain', z.object({ orderId: orderIdSchema }), async (input, { write }) => {
  const { row } = orThrow(
    await write(order, input.orderId, row => (row ? [] : [OrderPlaced({ customerId: 'c', total: 1 })])),
  );
  return { version: row?.version ?? 0 };
});

describe('idempotency receipts', () => {
  it('a repeat with the same key and input returns the first result without running the handler again', async () => {
    // Why: a webhook is delivered at least once. The second delivery must answer like the first
    // and write nothing, even after other writes changed the entity in between.
    let runs = 0;
    const settle = j.command('settle', z.object({ orderId: orderIdSchema }), async (input, { write }) => {
      runs += 1;
      const { row } = orThrow(await write(order, input.orderId, row => (row ? [OrderPaid({ amount: 1 })] : [])));
      return { paidVersion: row?.version ?? 0 };
    });
    const id = orderId(++next);
    orThrow(await journal.run(db, placeOrder, { orderId: id, customerId: 'c', total: 1 }, meta));
    const key = `stripe:evt_${next}`;
    const first = await journal.run(db, settle, { orderId: id }, meta, { idempotencyKey: key });
    expect(first).toEqual({ paidVersion: 2 });
    orThrow(await journal.run(db, justNote, { orderId: id, note: 'in between' }, meta));
    const again = await journal.run(db, settle, { orderId: id }, meta, { idempotencyKey: key });
    expect(again).toEqual({ paidVersion: 2 });
    expect(runs).toBe(1);
    const events = await eventsOf(id);
    expect(events.map(e => e.type)).toEqual(['OrderPlaced', 'OrderPaid', 'OrderNoted']);
    expect(await receiptOf(key)).toMatchObject({
      command: 'settle',
      input: { orderId: id },
      result: { value: { paidVersion: 2 } },
    });
  });

  it('the same key with another input or another command is CONFLICT; a result that cannot be stored fails the first run', async () => {
    const id = orderId(++next);
    orThrow(await journal.run(db, placeOrder, { orderId: id, customerId: 'c', total: 1 }, meta));
    const key = `k_${next}`;
    orThrow(await journal.run(db, justNote, { orderId: id, note: 'one' }, meta, { idempotencyKey: key }));
    await expect(
      journal.run(db, justNote, { orderId: id, note: 'two' }, meta, { idempotencyKey: key }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(journal.run(db, inspectOrder, { orderId: id }, meta, { idempotencyKey: key })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // A Date does not survive JSON, so the replay could not return what the first call returned.
    const datedResult = j.command('datedResult', z.object({ orderId: orderIdSchema }), async (input, { write }) => {
      orThrow(await write(order, input.orderId, () => [OrderNoted({ note: 'dated' })]));
      return { at: new Date() };
    });
    const unstable = `k_unstable_${next}`;
    await expect(
      journal.run(db, datedResult, { orderId: id }, meta, { idempotencyKey: unstable }),
    ).rejects.toMatchObject({
      code: 'UNSTABLE_SCHEMA',
    });
    expect(await receiptOf(unstable), 'rolled back with the write').toBeNull();
    const events = await eventsOf(id);
    expect(events.map(e => e.type)).toEqual(['OrderPlaced', 'OrderNoted']);
  });

  it('a command that returns nothing replays as nothing; hooks see the replay; a key cannot be reused inside its own run', async () => {
    const hooked = j.compose({});
    const seen: (string | null)[] = [];
    hooked.hooks.command.around(async (ctx, next) => {
      seen.push(ctx.idempotencyKey);
      await next();
    });
    const nothing = j.command('nothing', z.object({}), () => {
      /* returns nothing */
    });
    const key = `k_nothing_${next}`;
    expect(await hooked.run(db, nothing, {}, meta, { idempotencyKey: key })).toBeUndefined();
    expect(await hooked.run(db, nothing, {}, meta, { idempotencyKey: key })).toBeUndefined();
    expect(seen).toEqual([key, key]);
    expect(await receiptOf(key)).toMatchObject({ result: {} });

    const nested = j.command('nestedKey', z.object({}), (_input, { run }) =>
      run(nothing, {}, { idempotencyKey: `k_nested_${next}` }),
    );
    await expect(hooked.run(db, nested, {}, meta, { idempotencyKey: `k_nested_${next}` })).rejects.toThrow(
      'has not finished',
    );
    expect(await receiptOf(`k_nested_${next}`), 'the whole run rolled back').toBeNull();
  });

  it('a bound runner takes a key per call, and pruneReceipts drops old ones', async () => {
    const id = orderId(++next);
    const runAs = journal.bind(db, meta);
    expect(await runAs(placePlain, { orderId: id }, { idempotencyKey: `k_bound_${next}` })).toEqual({ version: 1 });
    expect(await runAs(placePlain, { orderId: id }, { idempotencyKey: `k_bound_${next}` })).toEqual({ version: 1 });
    expect(await receiptOf(`k_bound_${next}`)).not.toBeNull();
    expect(await journal.pruneReceipts(db, { before: new Date(Date.now() - 60_000) })).toBe(0);
    const pruned = await journal.pruneReceipts(db, { before: new Date(Date.now() + 60_000) });
    expect(pruned).toBeGreaterThan(0);
    expect(await receiptOf(`k_bound_${next}`)).toBeNull();
  });
});

describe('authorize', () => {
  it('a replayed receipt is authorized again: a caller who may not run the command gets no stored result', async () => {
    // Why: a receipt proves the command ran once, not that this caller may see or repeat it.
    // A check inside the handler does not run on a replay, so it lives in `authorize`.
    const allowed = new Set(['usr_owner', 'usr_test']);
    const checked: string[] = [];
    let runs = 0;
    const approve = j.command(
      'approveOrder',
      z.object({ orderId: orderIdSchema }),
      async (input, { write }) => {
        runs += 1;
        const { row } = orThrow(await write(order, input.orderId, () => [OrderNoted({ note: 'approved' })]));
        return { version: row?.version ?? 0 };
      },
      {
        authorize: (_input, { meta: who }) => {
          checked.push(who.actorId);
          return allowed.has(who.actorId) ? undefined : CommandForbidden({ detail: 'Not allowed to approve' });
        },
      },
    );
    const id = orderId(++next);
    orThrow(await journal.run(db, placeOrder, { orderId: id, customerId: 'c', total: 1 }, meta));
    const key = `k_authorize_${next}`;
    const owner = { actorId: 'usr_owner' };
    expect(await journal.run(db, approve, { orderId: id }, owner, { idempotencyKey: key })).toEqual({ version: 2 });
    expect(await journal.run(db, approve, { orderId: id }, owner, { idempotencyKey: key })).toEqual({ version: 2 });

    // The same key from a caller without the permission, and from the owner after it was revoked.
    expect(
      await journal.run(db, approve, { orderId: id }, { actorId: 'usr_intruder' }, { idempotencyKey: key }),
    ).toMatchObject({ code: 'journal.forbidden', status: 403 });
    allowed.delete('usr_owner');
    expect(await journal.run(db, approve, { orderId: id }, owner, { idempotencyKey: key })).toMatchObject({
      code: 'journal.forbidden',
      status: 403,
    });

    expect(runs, 'the handler ran once; every other call was a replay or a refusal').toBe(1);
    expect(checked).toEqual(['usr_owner', 'usr_owner', 'usr_intruder', 'usr_owner']);
    expect(await receiptOf(key), 'a refused replay leaves the receipt as it was').toMatchObject({
      result: { value: { version: 2 } },
    });
    const events = await eventsOf(id);
    expect(events.map(e => e.type)).toEqual(['OrderPlaced', 'OrderNoted']);
  });

  it('runs before the handler on a call without a key, and a child command is authorized too', async () => {
    let runs = 0;
    const guarded = j.command(
      'guardedNote',
      z.object({ orderId: orderIdSchema }),
      async (input, { write }) => {
        runs += 1;
        orThrow(await write(order, input.orderId, () => [OrderNoted({ note: 'guarded' })]));
      },
      {
        authorize: (_input, { meta: who }) =>
          who.actorId === 'usr_test' ? undefined : CommandForbidden({ detail: 'Only the test actor' }),
      },
    );
    const parent = j.command('parentOfGuarded', z.object({ orderId: orderIdSchema }), (input, { run }) =>
      run(guarded, input),
    );
    const id = orderId(++next);
    orThrow(await journal.run(db, placeOrder, { orderId: id, customerId: 'c', total: 1 }, meta));
    expect(await journal.run(db, guarded, { orderId: id }, { actorId: 'usr_other' })).toMatchObject({
      code: 'journal.forbidden',
    });
    expect(await journal.run(db, parent, { orderId: id }, { actorId: 'usr_other' })).toMatchObject({
      code: 'journal.forbidden',
    });
    expect(runs).toBe(0);
    expect(await journal.run(db, parent, { orderId: id }, meta), 'the test actor is allowed').toBeUndefined();
    expect(runs).toBe(1);
  });
});

describe('trace', () => {
  it('a run stamps its own command id and a new correlation id on every event it writes', async () => {
    // Why: a reader of the log must be able to answer "which command wrote this?" without the app
    // threading ids by hand. The library knows, so the library stamps.
    const id = orderId(++next);
    orThrow(await journal.run(db, placeOrder, { orderId: id, customerId: 'c', total: 1 }, meta));
    const [placed] = await stamps(id);
    expect(placed?.commandId).toMatch(/^cmd_/);
    expect(placed?.correlationId).toMatch(/^cor_/);
    expect(placed?.causeSeq).toBeNull();
    orThrow(await journal.run(db, payOrder, { orderId: id, amount: 1 }, meta));
    const [, paid] = await stamps(id);
    // A second root run is a second chain with its own command.
    expect(paid?.commandId).not.toBe(placed?.commandId);
    expect(paid?.correlationId).not.toBe(placed?.correlationId);
  });

  it('a child run gets its own command id and inherits the chain; the context exposes both', async () => {
    const seen: { commandId: string; correlationId: string }[] = [];
    const outer = j.command('traceOuter', z.object({ orderId: orderIdSchema }), async (input, ctx) => {
      seen.push({ commandId: ctx.commandId, correlationId: ctx.correlationId });
      orThrow(await ctx.run(inner, input));
    });
    const inner = j.command('traceInner', z.object({ orderId: orderIdSchema }), async (input, ctx) => {
      seen.push({ commandId: ctx.commandId, correlationId: ctx.correlationId });
      orThrow(await ctx.write(order, input.orderId, () => [OrderPlaced({ customerId: 'c', total: 1 })]));
    });
    const id = orderId(++next);
    orThrow(await journal.run(db, outer, { orderId: id }, meta, { correlationId: 'req_123' }));
    const [placed] = await stamps(id);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.commandId).not.toBe(seen[1]?.commandId);
    expect(seen.map(s => s.correlationId)).toEqual(['req_123', 'req_123']);
    // The event carries the command that wrote it: the child, not the parent.
    expect(placed).toEqual({
      type: 'OrderPlaced',
      commandId: seen[1]?.commandId,
      causeSeq: null,
      correlationId: 'req_123',
    });
  });

  it('bind passes the seed on, so a request context can tie every command of one request together', async () => {
    const id = orderId(++next);
    const runAs = journal.bind(db, meta, { correlationId: 'req_bound' });
    orThrow(await runAs(placeOrder, { orderId: id, customerId: 'c', total: 1 }));
    orThrow(await runAs(payOrder, { orderId: id, amount: 1 }));
    const bound = await stamps(id);
    expect(bound.map(s => s.correlationId)).toEqual(['req_bound', 'req_bound']);
  });
});
