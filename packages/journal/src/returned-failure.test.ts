/**
 * A rule that says no can return a failure (`@arki/failure`) instead of throwing a
 * `CommandError`. These tests pin why that is safe: the command's transaction rolls
 * back exactly as for a throw, so a refusal never leaves half a change behind, and
 * the caller gets the very failure the rule made, with a type inferred from the
 * handler. Real PGlite: the rows are checked, not mocks.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Failure } from '@arki/failure';
import { defineFailure, isFailure, orThrow } from '@arki/failure';

import type { AccountId, OrderId } from './test-support.js';
import { CommandConflict, CommandForbidden, CommandInvalid, CommandNotFound, isJournalError } from './errors.js';
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

const mail = j.effect('refusal-mail', order, {
  OrderPaid: () => {
    /* never drained here: the job row is what these tests look for */
  },
});

const orderIdSchema = z.templateLiteral(['ord_', z.string()]);
const accountIdSchema = z.templateLiteral(['acc_', z.string()]);
const ids = z.object({ orderId: orderIdSchema, accountId: accountIdSchema });

/** Every failure a handler made, so a test can check `run` returns that same instance. */
const made: Failure[] = [];
const keep = <F extends Failure>(failure: F): F => {
  made.push(failure);
  return failure;
};

/** Opens a profile, places and pays an order (a job row), then refuses when the nick is taken. */
const signUp = j.command('signUp', ids.extend({ nick: z.string().min(1) }), async (input, { write }) => {
  await write(profile, input.accountId, () => [ProfileOpened({ nick: input.nick })]);
  await write(order, input.orderId, () => [
    OrderPlaced({ customerId: input.accountId, total: 1 }),
    OrderPaid({ amount: 1 }),
  ]);
  if (input.nick === 'taken') return keep(CommandConflict({ detail: 'That nick is taken' }));
  return { nick: input.nick };
});

/** Opens the payer's profile first, then pays: the `events` function refuses a missing or paid order. */
const payOrder = j.command('payOrder', ids, async (input, { write }) => {
  await write(profile, input.accountId, () => [ProfileOpened({ nick: 'payer' })]);
  const paid = await write(order, input.orderId, row => {
    if (!row) return keep(CommandNotFound({ detail: 'Order not found' }));
    if (row.status !== 'placed') return keep(CommandConflict({ detail: `Order is already ${row.status}` }));
    return [OrderPaid({ amount: 1 })];
  });
  if (isFailure(paid)) return paid;
  return { version: paid.row?.version ?? 0 };
});

const placeOrder = j.command('placeOrder', z.object({ orderId: orderIdSchema }), (input, { write }) =>
  write(order, input.orderId, () => [OrderPlaced({ customerId: 'c', total: 1 })]),
);

const rowsOf = (id: OrderId) => db.select().from(orders).where(eq(orders.id, id));
const profileOf = (id: AccountId) => db.select().from(profiles).where(eq(profiles.accountId, id));
const eventsOf = (id: string) => db.select().from(tables.events).where(eq(tables.events.entityId, id));
const typesOf = async (id: string) => {
  const events = await eventsOf(id);
  return events.map(e => e.type);
};
const jobsOf = async (id: string) => {
  const events = await eventsOf(id);
  const seqs = new Set(events.map(e => e.seq));
  const jobs = await db.select().from(tables.jobs);
  return jobs.filter(job => job.eventSeq !== null && seqs.has(job.eventSeq));
};
const receiptOf = (key: string) => db.select().from(tables.receipts).where(eq(tables.receipts.key, key));

beforeAll(async () => {
  ({ db, client } = await openDb());
  journal = j.compose({ tables, effects: [mail] });
});

afterAll(async () => {
  await client.close();
});

describe('a failure the handler returns', () => {
  it('rolls back every write of the command: a rule that says no never leaves half a change behind', async () => {
    const id = orderId(++next);
    const acc = accountId(++next);

    const result = await journal.run(db, signUp, { orderId: id, accountId: acc, nick: 'taken' }, meta);

    expect(result, 'run returns the failure the handler made, not a copy').toBe(made.at(-1));
    expect(result).toMatchObject({ code: 'journal.conflict', status: 409, message: 'That nick is taken' });
    expect(await profileOf(acc), 'the first write is undone').toEqual([]);
    expect(await rowsOf(id), 'the second write is undone').toEqual([]);
    expect(await eventsOf(id)).toEqual([]);
    expect(await eventsOf(acc)).toEqual([]);
    expect(await jobsOf(id), 'no effect runs for events that never happened').toEqual([]);
  });

  it('a success still commits, so the rollback above is the refusal and not the command', async () => {
    const id = orderId(++next);
    const acc = accountId(++next);

    expect(await journal.run(db, signUp, { orderId: id, accountId: acc, nick: 'free' }, meta)).toEqual({
      nick: 'free',
    });
    expect(await profileOf(acc)).toHaveLength(1);
    expect(await rowsOf(id)).toHaveLength(1);
    expect(await jobsOf(id)).toHaveLength(1);
  });

  it('types the result from the handler: the caller sees the refusal it has to handle, with no type written by hand', async () => {
    const result = await journal.run(
      db,
      signUp,
      { orderId: orderId(++next), accountId: accountId(++next), nick: 'x' },
      meta,
    );
    expectTypeOf(result).toEqualTypeOf<{ nick: string } | CommandConflict>();
    const _pay = () => journal.run(db, payOrder, { orderId: orderId(1), accountId: accountId(1) }, meta);
    expectTypeOf<Awaited<ReturnType<typeof _pay>>>().toEqualTypeOf<
      { version: number } | CommandNotFound | CommandConflict
    >();
  });

  it("rolls back for the app's own failure too, not only the journal's four", async () => {
    const NickBanned = defineFailure('profile.nick_banned', { status: 422 });
    const open = j.command('openBanned', z.object({ accountId: accountIdSchema }), async (input, { write }) => {
      await write(profile, input.accountId, () => [ProfileOpened({ nick: 'banned' })]);
      return NickBanned();
    });
    const acc = accountId(++next);

    const result = await journal.run(db, open, { accountId: acc }, meta);

    expect(NickBanned.is(result)).toBe(true);
    expect(await profileOf(acc)).toEqual([]);
  });

  it("inside the caller's transaction, rolls back only the command: the caller's own work stays", async () => {
    // Why: a procedure that owns the transaction stays in charge of the commit. A refusal
    // is an answer it branches on, not a reason to lose what it did before.
    const before = accountId(++next);
    const id = orderId(++next);
    const acc = accountId(++next);

    const result = await db.transaction(async tx => {
      await journal.write(tx, profile, before, { meta, events: () => [ProfileOpened({ nick: 'caller' })] });
      return journal.run(tx, signUp, { orderId: id, accountId: acc, nick: 'taken' }, meta);
    });

    expect(CommandConflict.is(result)).toBe(true);
    expect(await profileOf(before)).toHaveLength(1);
    expect(await profileOf(acc)).toEqual([]);
    expect(await rowsOf(id)).toEqual([]);
  });
});

describe('a failure an events function returns', () => {
  it('comes back from write; returned by the handler, it rolls back the writes before it too', async () => {
    const id = orderId(++next);
    const acc = accountId(++next);

    const missing = await journal.run(db, payOrder, { orderId: id, accountId: acc }, meta);

    expect(missing).toBe(made.at(-1));
    expect(missing).toMatchObject({ code: 'journal.not_found', status: 404, message: 'Order not found' });
    expect(await profileOf(acc), "the payer's profile, written first, is undone").toEqual([]);
  });

  it('refuses on the current state: paying twice leaves one payment and no second job', async () => {
    const id = orderId(++next);
    await journal.run(db, placeOrder, { orderId: id }, meta);
    expect(await journal.run(db, payOrder, { orderId: id, accountId: accountId(++next) }, meta)).toEqual({
      version: 2,
    });
    const acc = accountId(++next);

    const again = await journal.run(db, payOrder, { orderId: id, accountId: acc }, meta);

    expect(again).toMatchObject({ code: 'journal.conflict', message: 'Order is already paid' });
    expect(await typesOf(id)).toEqual(['OrderPlaced', 'OrderPaid']);
    expect(await jobsOf(id)).toHaveLength(1);
    expect(await profileOf(acc)).toEqual([]);
  });

  it('rolls its own savepoint back, so a row it wrote through tx is gone, and the handler may answer with another refusal', async () => {
    // Why: `events` may read and write through its `tx`. A no from it must undo that work,
    // as a throw would. The handler may turn it into its own refusal: the command fails either way.
    const id = orderId(++next);
    const customer = `refusing-${next}`;
    const tryNote = j.command('tryNote', z.object({ orderId: orderIdSchema }), async (input, { write }) => {
      const noted = await write(order, input.orderId, async (_row, { tx }) => {
        await tx.insert(customerOrderCounts).values({ customerId: customer, placed: 1 });
        return CommandConflict({ detail: 'Not now' });
      });
      await write(order, input.orderId, () => [OrderPlaced({ customerId: 'fallback', total: 1 })]);
      return isFailure(noted) ? CommandInvalid({ detail: 'Try a note later' }) : 'noted';
    });

    const result = await journal.run(db, tryNote, { orderId: id }, meta);

    expect(result).toMatchObject({ code: 'journal.invalid', message: 'Try a note later' });
    expect(await db.select().from(customerOrderCounts).where(eq(customerOrderCounts.customerId, customer))).toEqual([]);
    expect(await typesOf(id), 'the fallback write is undone with the rest').toEqual([]);
  });

  it('journal.write outside a command returns it and writes nothing', async () => {
    const id = orderId(++next);

    const written = await journal.write(db, order, id, {
      meta,
      events: row => (row ? [OrderNoted({ note: 'x' })] : CommandNotFound({ detail: 'Order not found' })),
    });

    expectTypeOf(written).toExtend<CommandNotFound | { readonly row: unknown }>();
    expect(CommandNotFound.is(written)).toBe(true);
    expect(await eventsOf(id)).toEqual([]);
  });
});

describe('a failure authorize returns', () => {
  /** Notes an order. Only `usr_owner` and `usr_test` may. */
  const allowed = new Set(['usr_owner', 'usr_test']);
  let runs = 0;
  const approve = j.command(
    'approveRefusing',
    z.object({ orderId: orderIdSchema }),
    async (input, { write }) => {
      runs += 1;
      const { row } = await write(order, input.orderId, () => [OrderNoted({ note: 'approved' })]);
      return { version: row?.version ?? 0 };
    },
    {
      authorize: (_input, { meta: who }) =>
        allowed.has(who.actorId) ? undefined : CommandForbidden({ detail: 'Not allowed to approve' }),
    },
  );

  it('stops the command before the handler, and the caller gets it typed', async () => {
    const id = orderId(++next);
    await journal.run(db, placeOrder, { orderId: id }, meta);
    const before = runs;

    const refused = await journal.run(db, approve, { orderId: id }, { actorId: 'usr_intruder' });

    expectTypeOf(refused).toEqualTypeOf<{ version: number } | CommandForbidden>();
    expect(refused).toMatchObject({ code: 'journal.forbidden', status: 403, message: 'Not allowed to approve' });
    expect(runs, 'the handler never ran').toBe(before);
    expect(await typesOf(id)).toEqual(['OrderPlaced']);
  });

  it('refuses a replay too: a receipt proves the command ran, not that this caller may have its result', async () => {
    const id = orderId(++next);
    await journal.run(db, placeOrder, { orderId: id }, meta);
    const key = `k_refused_${next}`;
    const owner = { actorId: 'usr_owner' };
    expect(await journal.run(db, approve, { orderId: id }, owner, { idempotencyKey: key })).toEqual({ version: 2 });

    const replayed = await journal.run(
      db,
      approve,
      { orderId: id },
      { actorId: 'usr_intruder' },
      { idempotencyKey: key },
    );

    expect(CommandForbidden.is(replayed)).toBe(true);
    expect(await receiptOf(key), 'the refusal leaves the receipt as it was').toMatchObject([
      { result: { value: { version: 2 } } },
    ]);
  });
});

describe('a failure and an idempotency key', () => {
  it('is not stored: the key is free again, so a repeat after the state changed runs the command', async () => {
    // Why: a stored refusal would answer "already paid" or "not found" forever, even after
    // the order exists. Only a success is worth replaying.
    const id = orderId(++next);
    const key = `k_not_found_${next}`;
    const input = { orderId: id, accountId: accountId(++next) };

    expect(CommandNotFound.is(await journal.run(db, payOrder, input, meta, { idempotencyKey: key }))).toBe(true);
    expect(await receiptOf(key)).toEqual([]);

    await journal.run(db, placeOrder, { orderId: id }, meta);
    expect(await journal.run(db, payOrder, input, meta, { idempotencyKey: key })).toEqual({ version: 2 });
    expect(await receiptOf(key)).toHaveLength(1);
  });
});

/** Places its own order, then runs `signUp` as a child. `returnChild` says whether it passes a refusal on. */
const parent = j.command(
  'parentOfSignUp',
  ids.extend({ parentOrderId: orderIdSchema, returnChild: z.boolean() }),
  async (input, { write, run }) => {
    await write(order, input.parentOrderId, () => [OrderPlaced({ customerId: 'parent', total: 1 })]);
    const child = await run(signUp, { orderId: input.orderId, accountId: input.accountId, nick: 'taken' });
    if (isFailure(child) && input.returnChild) return child;
    return 'went on';
  },
);

describe('a failure a child command returns', () => {
  it('passed on by the parent, it rolls back the parent too', async () => {
    const parentId = orderId(++next);
    const id = orderId(++next);
    const acc = accountId(++next);

    const result = await journal.run(
      db,
      parent,
      { parentOrderId: parentId, orderId: id, accountId: acc, returnChild: true },
      meta,
    );

    expect(CommandConflict.is(result)).toBe(true);
    expect(await rowsOf(parentId)).toEqual([]);
    expect(await profileOf(acc)).toEqual([]);
  });
});

/** The `JournalError` a call rejects with. */
async function misuseOf(call: Promise<unknown>) {
  const error = await call.then(
    () => 'resolved',
    (error: unknown) => error,
  );
  if (!isJournalError(error)) throw new Error(`expected a JournalError, got ${String(error)}`);
  return error;
}

describe('a command that ignores a failure it was handed', () => {
  // Why: an ignored refusal must never commit the rest of the command. Once a write's `events`
  // or a child command returned a failure, the command must end with a failure; a success is a
  // missing `if (isFailure(x)) return x;`, so the run throws and nothing commits.
  it('throws IGNORED_FAILURE when the handler goes on after a write said no, and commits nothing', async () => {
    const id = orderId(++next);
    const acc = accountId(++next);
    const payAnyway = j.command('payAnyway', ids, async (input, { write }) => {
      await write(profile, input.accountId, () => [ProfileOpened({ nick: 'payer' })]);
      // eslint-disable-next-line failure/must-use -- the test proves an ignored write refusal dooms the command
      await write(order, input.orderId, row =>
        row ? [OrderPaid({ amount: 1 })] : CommandNotFound({ detail: 'No order' }),
      );
      return 'paid';
    });

    const error = await misuseOf(journal.run(db, payAnyway, { orderId: id, accountId: acc }, meta));

    expect(error.code).toBe('IGNORED_FAILURE');
    expect(error.kind).toBe('command');
    expect(error.entityId).toBe('payAnyway');
    expect(error.message, 'names the write and the code, so the missing check can be found').toContain(
      `the write to order ${id} returned the failure "journal.not_found"`,
    );
    expect(await profileOf(acc), 'the write before the refusal does not commit').toEqual([]);
  });

  it("throws when the parent goes on after a child said no: the parent's own write is undone too", async () => {
    const parentId = orderId(++next);
    const id = orderId(++next);
    const acc = accountId(++next);

    const error = await misuseOf(
      journal.run(db, parent, { parentOrderId: parentId, orderId: id, accountId: acc, returnChild: false }, meta),
    );

    expect(error.code).toBe('IGNORED_FAILURE');
    expect(error.message).toContain('the child command "signUp" returned the failure "journal.conflict"');
    expect(await rowsOf(parentId)).toEqual([]);
    expect(await profileOf(acc)).toEqual([]);
    expect(await rowsOf(id)).toEqual([]);
  });

  it('a doomed child thrown from deep inside rolls back every level, like any throw', async () => {
    const parentId = orderId(++next);
    const id = orderId(++next);
    const acc = accountId(++next);
    const grandparentId = orderId(++next);
    const grandparent = j.command(
      'grandparentOfSignUp',
      ids.extend({ parentOrderId: orderIdSchema, own: orderIdSchema }),
      async (input, { write, run }) => {
        await write(order, input.own, () => [OrderPlaced({ customerId: 'grandparent', total: 1 })]);
        return run(parent, { ...input, returnChild: false });
      },
    );

    const error = await misuseOf(
      journal.run(db, grandparent, { own: grandparentId, parentOrderId: parentId, orderId: id, accountId: acc }, meta),
    );

    expect(error.entityId, 'the command that ignored it is named').toBe('parentOfSignUp');
    expect(await rowsOf(grandparentId)).toEqual([]);
    expect(await rowsOf(parentId)).toEqual([]);
  });

  it('a different refusal is fine: the command fails either way, and nothing commits', async () => {
    const parentId = orderId(++next);
    const acc = accountId(++next);
    const translate = j.command(
      'translateRefusal',
      ids.extend({ parentOrderId: orderIdSchema }),
      async (input, { write, run }) => {
        await write(order, input.parentOrderId, () => [OrderPlaced({ customerId: 'translator', total: 1 })]);
        const child = await run(signUp, { orderId: input.orderId, accountId: input.accountId, nick: 'taken' });
        return isFailure(child) ? CommandInvalid({ detail: 'Pick another nick' }) : child;
      },
    );

    const result = await journal.run(
      db,
      translate,
      { parentOrderId: parentId, orderId: orderId(++next), accountId: acc },
      meta,
    );

    expect(CommandInvalid.is(result)).toBe(true);
    expect(await rowsOf(parentId)).toEqual([]);
  });
});

describe("an effect that ignores its command's failure", () => {
  // Why: the job must not count as done when a command it ran said no. Each command rolled back on
  // its own; what is left is the job's outcome. It ends dead after one try with that refusal, not
  // thrown and retried, because a retry would run again the commands that did commit.
  let effectDb: PgliteDatabase;
  let effectClient: PGlite;
  const refuse = j.command('alwaysRefuse', z.object({}), () => CommandConflict({ detail: 'No' }));
  const ignores = j.effect('relay-ignores', order, {
    OrderNoted: async (_event, { run }) => {
      // eslint-disable-next-line failure/must-use -- ignored on purpose: the test proves the job then ends dead
      await run(refuse, {}, meta);
    },
  });
  const passes = j.effect('relay-passes', order, {
    OrderNoted: async (event, { run }) => {
      await run(placeOrder, { orderId: `${event.entityId}_copy` }, meta);
    },
  });
  const relays = j.compose({ tables, effects: [ignores, passes] });

  beforeAll(async () => {
    ({ db: effectDb, client: effectClient } = await openDb());
  });

  afterAll(async () => {
    await effectClient.close();
  });

  it('fails the job with the refusal, while an effect whose commands succeeded is done', async () => {
    const id = orderId(++next);
    await relays.run(effectDb, placeOrder, { orderId: id }, meta);
    await relays.write(effectDb, order, id, { meta, events: () => [OrderNoted({ note: 'relay' })] });

    await relays.drain(effectDb);

    const { jobs: dead } = await relays.jobs(effectDb, { status: 'dead' });
    expect(dead.map(job => job.effect)).toEqual(['relay-ignores']);
    expect(dead[0]?.attempts, 'dead after one try, not retried').toBe(1);
    expect(dead[0]?.lastError).toContain('journal.conflict');
    expect((await relays.jobs(effectDb, { effect: 'relay-passes' })).jobs, 'the other job is done').toEqual([]);
  });
});

/** The error a synchronous call throws, so a test can read its code. */
function thrownBy(call: () => void): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** One order line for `placeWithBackorder`: 3 wanted, 1 in stock. `acceptIt: false` forgets the `accept` call. */
const lineFor = (acceptIt: boolean) => ({
  orderId: orderId(++next),
  reservationId: orderId(++next),
  backorderId: orderId(++next),
  sku: `sku_${next}`,
  qty: 3,
  inStock: 1,
  acceptIt,
});

/** Input for the three-level test: none in stock, so the grandchild refuses. */
const levels = (passUp: boolean) => ({
  topOrderId: orderId(++next),
  childOrderId: orderId(++next),
  reservationId: orderId(++next),
  sku: 'x',
  qty: 2,
  inStock: 0,
  passUp,
});

/** Made by an unrelated helper: never returned by a write or run of the command. */
const helperRefusal = () => CommandNotFound({ detail: 'No order' });

describe('a refusal the command accepts', () => {
  // Why: a handler may meet a refusal and still have a good answer: a backorder when stock is
  // out, "already paid" for a payment that is done. `accept(result)` says so on purpose. It lifts
  // only this command's check: a refused child's savepoint stays rolled back, and every refusal
  // that is not accepted still dooms the command.
  const OutOfStock = defineFailure('stock.out', {
    status: 409,
    data: z.object({ sku: z.string(), short: z.int() }),
  });
  const line = z.object({ reservationId: orderIdSchema, sku: z.string(), qty: z.int(), inStock: z.int() });

  /** Writes the reservation (a placed and paid order, so an effect job too), then refuses when stock is short. */
  const reserveStock = j.command('reserveStock', line, async (input, { write }) => {
    if (input.qty <= 0) return CommandInvalid({ detail: 'Reserve at least one' });
    await write(order, input.reservationId, () => [
      OrderPlaced({ customerId: input.sku, total: input.qty }),
      OrderPaid({ amount: input.qty }),
    ]);
    if (input.qty > input.inStock) return keep(OutOfStock({ sku: input.sku, short: input.qty - input.inStock }));
    return { reservationId: input.reservationId };
  });

  /** Places the backorder; a second one for the same id is a conflict. */
  const placeBackorder = j.command(
    'placeBackorder',
    z.object({ backorderId: orderIdSchema, sku: z.string(), qty: z.int() }),
    async (input, { write }) => {
      const placed = await write(order, input.backorderId, row =>
        row
          ? CommandConflict({ detail: 'Already backordered' })
          : [OrderPlaced({ customerId: `backorder-${input.sku}`, total: input.qty })],
      );
      if (isFailure(placed)) return placed;
      return 'backordered' as const;
    },
  );

  const orderLine = line.extend({ orderId: orderIdSchema, backorderId: orderIdSchema, acceptIt: z.boolean() });
  let backorderRuns = 0;
  /** The backorder example of the docs. `acceptIt: false` forgets the `accept` call. */
  const placeWithBackorder = j.command('placeWithBackorder', orderLine, async (input, { write, run, accept }) => {
    await write(order, input.orderId, () => [OrderPlaced({ customerId: 'buyer', total: input.qty })]);
    const stock = await run(
      reserveStock,
      { reservationId: input.reservationId, sku: input.sku, qty: input.qty, inStock: input.inStock },
      { idempotencyKey: `res_${input.reservationId}` },
    );
    if (OutOfStock.is(stock)) {
      if (input.acceptIt) accept(stock);
      backorderRuns += 1;
      const backorder = await run(placeBackorder, {
        backorderId: input.backorderId,
        sku: stock.data.sku,
        qty: stock.data.short,
      });
      if (isFailure(backorder)) return backorder;
      return { status: 'backordered' as const };
    }
    if (isFailure(stock)) return stock;
    return { status: 'reserved' as const, reservationId: stock.reservationId };
  });

  it("backorders after an accepted child refusal: the parent and the backorder commit, the child's work does not", async () => {
    const input = lineFor(true);

    const result = await journal.run(db, placeWithBackorder, input, meta);

    expect(result).toEqual({ status: 'backordered' });
    expect(await rowsOf(input.orderId), "the parent's own write commits").toHaveLength(1);
    expect(await rowsOf(input.backorderId), 'the fallback commits').toMatchObject([{ total: 2 }]);
    expect(await rowsOf(input.reservationId), "the refused child's savepoint stays rolled back").toEqual([]);
    expect(await eventsOf(input.reservationId)).toEqual([]);
    expect(await jobsOf(input.reservationId), 'no job for the payment that never happened').toEqual([]);
    expect(await receiptOf(`res_${input.reservationId}`), 'a refused child stores no receipt').toEqual([]);
  });

  it('without accept, the same success is still IGNORED_FAILURE, the error names the fix, and nothing commits', async () => {
    const input = lineFor(false);

    const error = await misuseOf(journal.run(db, placeWithBackorder, input, meta));

    expect(error.code).toBe('IGNORED_FAILURE');
    expect(error.message).toContain('the child command "reserveStock" returned the failure "stock.out"');
    expect(error.message, 'the error teaches the way out').toContain('accept(result)');
    expect(await rowsOf(input.orderId)).toEqual([]);
    expect(await rowsOf(input.backorderId), 'the fallback is undone with the rest').toEqual([]);
  });

  it("accepts a write's own refusal: the other writes commit and the refused row is unchanged", async () => {
    const id = orderId(++next);
    const acc = accountId(++next);
    await journal.run(db, placeOrder, { orderId: id }, meta);
    await orThrow(journal.run(db, payOrder, { orderId: id, accountId: accountId(++next) }, meta));
    const ensurePaid = j.command('ensurePaid', ids, async (input, { write, accept }) => {
      await write(profile, input.accountId, () => [ProfileOpened({ nick: 'payer' })]);
      const paid = await write(order, input.orderId, row => {
        if (!row) return CommandNotFound({ detail: 'Order not found' });
        if (row.status === 'paid') return CommandConflict({ detail: 'Already paid' });
        return [OrderPaid({ amount: 1 })];
      });
      if (CommandConflict.is(paid)) {
        accept(paid);
        return { status: 'already_paid' as const };
      }
      if (isFailure(paid)) return paid;
      return { status: 'paid' as const };
    });

    const result = await journal.run(db, ensurePaid, { orderId: id, accountId: acc }, meta);

    expect(result).toEqual({ status: 'already_paid' });
    expect(await profileOf(acc), 'the write before the refusal commits').toHaveLength(1);
    expect(await typesOf(id), 'the refused write added nothing').toEqual(['OrderPlaced', 'OrderPaid']);
    expect(await rowsOf(id)).toMatchObject([{ status: 'paid', version: 2 }]);
  });

  /** A command that refuses two writes to missing orders, and accepts what `pick` chooses. */
  const twoRefusals = (name: string, pick: (first: Failure, second: Failure, accept: (f: Failure) => void) => void) =>
    j.command(name, z.object({ a: orderIdSchema, b: orderIdSchema }), async (input, { write, accept }) => {
      const first = await write(order, input.a, row =>
        row ? [OrderNoted({ note: 'a' })] : CommandNotFound({ detail: 'a' }),
      );
      const second = await write(order, input.b, row =>
        row ? [OrderNoted({ note: 'b' })] : CommandNotFound({ detail: 'b' }),
      );
      if (isFailure(first) && isFailure(second)) pick(first, second, accept);
      return 'went on';
    });

  it('accepting one of two refusals still throws IGNORED_FAILURE, naming the other', async () => {
    const a = orderId(++next);
    const b = orderId(++next);
    // eslint-disable-next-line failure/no-blind-accept -- accept() itself is under test; twoRefusals fixes the kind
    const acceptsFirst = twoRefusals('acceptsFirst', (first, _second, accept) => accept(first));

    const error = await misuseOf(journal.run(db, acceptsFirst, { a, b }, meta));

    expect(error.code).toBe('IGNORED_FAILURE');
    expect(error.message, 'the refusal still pending is named').toContain(`the write to order ${b} returned`);
  });

  it('identity decides, not the code: two refusals with the same code need two accepts', async () => {
    // eslint-disable-next-line failure/no-blind-accept -- accept() itself is under test; twoRefusals fixes the kind
    const acceptsSecond = twoRefusals('acceptsSecond', (_first, second, accept) => accept(second));
    const acceptsBoth = twoRefusals('acceptsBoth', (first, second, accept) => {
      // eslint-disable-next-line failure/no-blind-accept -- accept() itself is under test; twoRefusals fixes the kind
      accept(first);
      // eslint-disable-next-line failure/no-blind-accept -- accept() itself is under test; twoRefusals fixes the kind
      accept(second);
    });

    const error = await misuseOf(journal.run(db, acceptsSecond, { a: orderId(++next), b: orderId(++next) }, meta));

    expect(error.code).toBe('IGNORED_FAILURE');
    expect(error.message, 'the first one, never accepted, is still pending').toContain(
      'returned the failure "journal.not_found"',
    );
    expect(await journal.run(db, acceptsBoth, { a: orderId(++next), b: orderId(++next) }, meta)).toBe('went on');
  });

  it('the same object returned twice is two refusals: one accept is not enough', async () => {
    const soldOut = OutOfStock({ sku: 'shared', short: 1 });
    const twice = j.command(
      'sameRefusalTwice',
      z.object({ a: orderIdSchema, b: orderIdSchema, accepts: z.int() }),
      async (input, { write, accept }) => {
        const first = await write(order, input.a, () => soldOut);
        // eslint-disable-next-line failure/must-use -- the same refusal again; ignoring it is the point of the test
        await write(order, input.b, () => soldOut);
        if (isFailure(first)) for (let n = 0; n < input.accepts; n += 1) accept(first);
        return 'went on';
      },
    );

    const error = await misuseOf(journal.run(db, twice, { a: orderId(++next), b: orderId(++next), accepts: 1 }, meta));

    expect(error.code).toBe('IGNORED_FAILURE');
    expect(await journal.run(db, twice, { a: orderId(++next), b: orderId(++next), accepts: 2 }, meta)).toBe('went on');
  });

  /** A command that refuses one write, then calls `misuse` with what it received and its `accept`. */
  const misusing = (name: string, misuse: (received: Failure, accept: (f: Failure) => void) => void) =>
    j.command(name, z.object({ id: orderIdSchema }), async (input, { write, accept }) => {
      const received = await write(order, input.id, () => CommandNotFound({ detail: 'No order' }));
      if (isFailure(received)) misuse(received, accept);
      return received;
    });
  const invalidAccept = async (name: string, misuse: (received: Failure, accept: (f: Failure) => void) => void) => {
    const error = await misuseOf(journal.run(db, misusing(name, misuse), { id: orderId(++next) }, meta));
    expect(error.code).toBe('INVALID_ACCEPT');
    expect(error.kind).toBe('command');
    expect(error.entityId).toBe(name);
    return error.message;
  };

  it('only a refusal this command received can be accepted: hand-built, helper-made, cloned and non-failure values throw', async () => {
    const notReceived =
      'accept() was given the failure "journal.not_found", but no write or run of this command returned it';
    expect(
      await invalidAccept('acceptsHandBuilt', (_r, accept) => accept(CommandNotFound({ detail: 'No order' }))),
    ).toContain(notReceived);
    expect(await invalidAccept('acceptsHelperMade', (_r, accept) => accept(helperRefusal()))).toContain(notReceived);
    // A spread copy loses the failure brand, so it is not even a failure; the type allows it, the run does not.
    // eslint-disable-next-line failure/no-blind-accept -- a spread copy is not a failure; accepting it is the misuse
    expect(await invalidAccept('acceptsClone', (received, accept) => accept({ ...received }))).toContain(
      'accept() expects an @arki/failure value',
    );
    expect(
      await invalidAccept('acceptsNonFailure', (_r, accept) =>
        Reflect.apply(accept, undefined, [{ code: 'journal.not_found' }]),
      ),
    ).toContain('accept() expects an @arki/failure value');
  });

  it('accepting the same return twice throws "already accepted": a repeat is a copy-paste bug', async () => {
    const message = await invalidAccept('acceptsTwice', (received, accept) => {
      // eslint-disable-next-line failure/no-blind-accept -- accepting one refusal twice is the misuse under test
      accept(received);
      // eslint-disable-next-line failure/no-blind-accept -- accepting one refusal twice is the misuse under test
      accept(received);
    });

    expect(message).toContain('the failure "journal.not_found" was already accepted');
  });

  it('accept never forces a commit: returning the accepted failure, or another one, still rolls back', async () => {
    const acc = accountId(++next);
    const id = orderId(++next);
    const returns = j.command(
      'acceptsThenRefuses',
      ids.extend({ other: z.boolean() }),
      async (input, { write, accept }) => {
        await write(profile, input.accountId, () => [ProfileOpened({ nick: 'x' })]);
        const missing = await write(order, input.orderId, () => keep(CommandNotFound({ detail: 'No order' })));
        if (!isFailure(missing)) return 'paid';
        accept(missing);
        return input.other ? keep(CommandInvalid({ detail: 'Changed my mind' })) : missing;
      },
    );

    const same = await journal.run(db, returns, { orderId: id, accountId: acc, other: false }, meta);
    expect(same, 'the run returns the accepted failure itself').toBe(made.at(-1));
    expect(await profileOf(acc)).toEqual([]);

    const other = await journal.run(db, returns, { orderId: id, accountId: acc, other: true }, meta);
    expect(other).toBe(made.at(-1));
    expect(CommandInvalid.is(other)).toBe(true);
    expect(await profileOf(acc)).toEqual([]);
  });

  it('a failed recovery commits nothing: an ignored fallback refusal dooms the command, and a throw rolls it back', async () => {
    const input = lineFor(true);
    // The backorder exists already, so the fallback refuses.
    await journal.run(db, placeOrder, { orderId: input.backorderId }, meta);
    const ignoresFallback = j.command('ignoresFallback', orderLine, async (args, { write, run, accept }) => {
      await write(order, args.orderId, () => [OrderPlaced({ customerId: 'buyer', total: args.qty })]);
      const stock = await run(reserveStock, {
        reservationId: args.reservationId,
        sku: args.sku,
        qty: args.qty,
        inStock: args.inStock,
      });
      if (!OutOfStock.is(stock)) return stock;
      accept(stock);
      // eslint-disable-next-line failure/must-use -- ignored on purpose: an ignored fallback refusal dooms the command
      await run(placeBackorder, { backorderId: args.backorderId, sku: args.sku, qty: 1 });
      return 'backordered';
    });
    const throwsInFallback = j.command('throwsInFallback', orderLine, async (args, { write, run, accept }) => {
      await write(order, args.orderId, () => [OrderPlaced({ customerId: 'buyer', total: args.qty })]);
      const stock = await run(reserveStock, {
        reservationId: args.reservationId,
        sku: args.sku,
        qty: args.qty,
        inStock: args.inStock,
      });
      if (!OutOfStock.is(stock)) return stock;
      accept(stock);
      throw new Error('the backorder service is down');
    });

    const error = await misuseOf(journal.run(db, ignoresFallback, input, meta));
    expect(error.code).toBe('IGNORED_FAILURE');
    expect(error.message).toContain('the child command "placeBackorder" returned the failure "journal.conflict"');
    expect(await rowsOf(input.orderId)).toEqual([]);

    await expect(journal.run(db, throwsInFallback, input, meta)).rejects.toThrow('the backorder service is down');
    expect(await rowsOf(input.orderId), 'accept never hides a throw').toEqual([]);
  });

  it('three levels: acceptance changes only the scope that received the value', async () => {
    const childLine = line.extend({ childOrderId: orderIdSchema, passUp: z.boolean() });
    /** Writes its own row, then runs `reserveStock`; it either accepts the refusal or passes it up. */
    const reserveOrPass = j.command('reserveOrPass', childLine, async (input, { write, run, accept }) => {
      await write(order, input.childOrderId, () => [OrderPlaced({ customerId: 'child', total: 1 })]);
      const stock = await run(reserveStock, input);
      if (OutOfStock.is(stock) && !input.passUp) {
        accept(stock);
        return 'short';
      }
      return stock;
    });
    const top = j.command(
      'topOfThree',
      childLine.extend({ topOrderId: orderIdSchema }),
      async (input, { write, run, accept }) => {
        await write(order, input.topOrderId, () => [OrderPlaced({ customerId: 'top', total: 1 })]);
        const child = await run(reserveOrPass, input);
        if (OutOfStock.is(child)) {
          accept(child);
          return 'passed up and accepted';
        }
        if (isFailure(child)) return child;
        return child === 'short' ? 'accepted below' : 'reserved';
      },
    );

    const below = levels(false);
    expect(await journal.run(db, top, below, meta)).toBe('accepted below');
    expect(await rowsOf(below.topOrderId)).toHaveLength(1);
    expect(await rowsOf(below.childOrderId), 'the child accepted, so it commits').toHaveLength(1);
    expect(await rowsOf(below.reservationId), "the grandchild's savepoint stays rolled back").toEqual([]);

    const up = levels(true);
    expect(await journal.run(db, top, up, meta)).toBe('passed up and accepted');
    expect(await rowsOf(up.topOrderId), 'the parent received the same instance, so it may accept it').toHaveLength(1);
    expect(await rowsOf(up.childOrderId), 'the child returned a failure, so it rolled back').toEqual([]);
    expect(await rowsOf(up.reservationId)).toEqual([]);
  });

  it('a child cannot accept a refusal only its parent received: trackers do not leak between levels', async () => {
    const theirs: Failure[] = [];
    const meddles = j.command('meddlingChild', z.object({}), (_input, { accept }) => {
      const failure = theirs.at(-1);
      // eslint-disable-next-line failure/no-blind-accept -- accepting a parent's refusal is the misuse under test
      if (failure !== undefined) accept(failure);
      return 'meddled';
    });
    const parentOfMeddler = j.command(
      'parentOfMeddler',
      z.object({ id: orderIdSchema }),
      async (input, { write, run }) => {
        const missing = await write(order, input.id, () => CommandNotFound({ detail: 'No order' }));
        if (isFailure(missing)) theirs.push(missing);
        await run(meddles, {});
        return missing;
      },
    );

    const error = await misuseOf(journal.run(db, parentOfMeddler, { id: orderId(++next) }, meta));

    expect(error.code).toBe('INVALID_ACCEPT');
    expect(error.entityId, 'the child is the one that misused accept').toBe('meddlingChild');
  });

  it("a child's authorize refusal comes back through run, so the parent may accept it", async () => {
    const guarded = j.command('guardedChild', z.object({}), () => 'ran', {
      authorize: () => CommandForbidden({ detail: 'No' }),
    });
    const tolerant = j.command(
      'toleratesForbidden',
      z.object({ id: orderIdSchema }),
      async (input, { write, run, accept }) => {
        await write(order, input.id, () => [OrderPlaced({ customerId: 'tolerant', total: 1 })]);
        const child = await run(guarded, {});
        if (CommandForbidden.is(child)) {
          accept(child);
          return 'skipped';
        }
        return child;
      },
    );
    const id = orderId(++next);

    expect(await journal.run(db, tolerant, { id }, meta)).toBe('skipped');
    expect(await rowsOf(id)).toHaveLength(1);
  });

  it('a captured accept called after the handler finished throws: a settled command cannot change', async () => {
    const captured: { accept?: (f: Failure) => void; failure?: Failure } = {};
    const leaks = misusing('leaksAccept', (received, accept) => {
      captured.accept = accept;
      captured.failure = received;
    });

    expect(CommandNotFound.is(await journal.run(db, leaks, { id: orderId(++next) }, meta))).toBe(true);
    const late = captured.accept;
    const failure = captured.failure;
    if (late === undefined || failure === undefined) throw new Error('the handler did not run');
    const error = thrownBy(() => late(failure));

    expect(isJournalError(error, 'INVALID_ACCEPT')).toBe(true);
    expect(String(error)).toContain('accept() was called after the handler finished');
  });

  it('an idempotency key stores the accepted success as the receipt, and a repeat replays it', async () => {
    const input = lineFor(true);
    const key = `k_backorder_${next}`;
    const before = backorderRuns;

    expect(await journal.run(db, placeWithBackorder, input, meta, { idempotencyKey: key })).toEqual({
      status: 'backordered',
    });
    expect(await receiptOf(key)).toMatchObject([{ result: { value: { status: 'backordered' } } }]);

    expect(await journal.run(db, placeWithBackorder, input, meta, { idempotencyKey: key })).toEqual({
      status: 'backordered',
    });
    expect(backorderRuns - before, 'the repeat replays the receipt; the handler ran once').toBe(1);
  });
});

describe('a refusal the effect accepts', () => {
  // Why: one rule for effects. A refusal the effect accepts ends the job done; one it does not
  // accept still ends it dead after one try. Misuse is a bug: it throws, and the worker treats
  // it like any thrown error, while commands that already committed stay committed.
  let effectDb: PgliteDatabase;
  let effectClient: PGlite;
  const refuse = j.command('refuseForEffect', z.object({}), () => CommandConflict({ detail: 'Already closed' }));
  const captured: { accept?: (f: Failure) => void; failure?: Failure } = {};
  const accepts = j.effect('relay-accepts', order, {
    OrderNoted: async (_event, { run, accept }) => {
      const closed = await run(refuse, {}, meta);
      if (CommandConflict.is(closed)) {
        accept(closed);
        captured.accept = accept;
        captured.failure = closed;
        return;
      }
      return closed;
    },
  });
  const forgets = j.effect('relay-forgets', order, {
    OrderNoted: async (_event, { run }) => {
      // eslint-disable-next-line failure/must-use -- forgotten on purpose: the test proves the job then ends dead
      await run(refuse, {}, meta);
    },
  });
  const misuses = j.effect('relay-misuses', order, {
    OrderNoted: async (event, { run, accept }) => {
      await run(placeOrder, { orderId: `${event.entityId}_side` }, meta);
      accept(CommandConflict({ detail: 'never returned' }));
    },
  });
  const relays = j.compose({ tables, effects: [accepts, forgets, misuses] });

  beforeAll(async () => {
    ({ db: effectDb, client: effectClient } = await openDb());
  });

  afterAll(async () => {
    await effectClient.close();
  });

  it('an accepted refusal ends the job done; an unaccepted one dies after one try; misuse throws and is retried', async () => {
    const id = orderId(++next);
    await relays.run(effectDb, placeOrder, { orderId: id }, meta);
    await relays.write(effectDb, order, id, { meta, events: () => [OrderNoted({ note: 'relay' })] });

    await relays.drain(effectDb);

    const { jobs: accepted } = await relays.jobs(effectDb, { effect: 'relay-accepts' });
    expect(accepted, 'the accepting job is done').toEqual([]);
    const { jobs: dead } = await relays.jobs(effectDb, { status: 'dead' });
    expect(dead.map(job => job.effect)).toEqual(['relay-forgets']);
    expect(dead[0]?.attempts).toBe(1);
    const { jobs: retrying } = await relays.jobs(effectDb, { effect: 'relay-misuses' });
    expect(retrying, 'a thrown error goes to the retry policy, not straight to dead').toMatchObject([
      { attempts: 1, state: 'delayed' },
    ]);
    expect(retrying[0]?.lastError).toContain('INVALID_ACCEPT');
    expect(
      await effectDb
        .select()
        .from(orders)
        .where(eq(orders.id, `${id}_side`)),
      'the command it ran stays committed',
    ).toHaveLength(1);

    const late = captured.accept;
    const failure = captured.failure;
    if (late === undefined || failure === undefined) throw new Error('the accepting effect did not run');
    const error = thrownBy(() => late(failure));
    expect(isJournalError(error, 'INVALID_ACCEPT'), 'a late call cannot change a settled job').toBe(true);
    expect(error).toMatchObject({ kind: 'effect', entityId: 'relay-accepts' });
    expect(String(error)).toContain('accept() was called after the handler finished');
  });
});
