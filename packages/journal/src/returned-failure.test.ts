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
import { defineFailure, isFailure } from '@arki/failure';

import type { AccountId, OrderId } from './test-support.js';
import { CommandConflict, CommandForbidden, CommandNotFound } from './errors.js';
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

  it('rolls its own savepoint back, so a row it wrote through tx is gone even when the handler goes on', async () => {
    // Why: `events` may read and write through its `tx`. A no from it must undo that work,
    // as a throw would, whatever the handler then decides.
    const id = orderId(++next);
    const customer = `refusing-${next}`;
    const tryNote = j.command('tryNote', z.object({ orderId: orderIdSchema }), async (input, { write }) => {
      const noted = await write(order, input.orderId, async (_row, { tx }) => {
        await tx.insert(customerOrderCounts).values({ customerId: customer, placed: 1 });
        return CommandConflict({ detail: 'Not now' });
      });
      // The handler chooses to go on: it places the order instead.
      await write(order, input.orderId, () => [OrderPlaced({ customerId: 'fallback', total: 1 })]);
      return isFailure(noted) ? 'fell back' : 'noted';
    });

    expect(await journal.run(db, tryNote, { orderId: id }, meta)).toBe('fell back');
    expect(await db.select().from(customerOrderCounts).where(eq(customerOrderCounts.customerId, customer))).toEqual([]);
    expect(await typesOf(id)).toEqual(['OrderPlaced']);
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

describe('a failure a child command returns', () => {
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

  it("rolls back the child's savepoint and hands the failure to the parent, which decides", async () => {
    const parentId = orderId(++next);
    const id = orderId(++next);
    const acc = accountId(++next);

    const result = await journal.run(
      db,
      parent,
      { parentOrderId: parentId, orderId: id, accountId: acc, returnChild: false },
      meta,
    );

    expect(result).toBe('went on');
    expect(await rowsOf(parentId), "the parent's own write commits").toHaveLength(1);
    expect(await profileOf(acc), "the child's writes do not").toEqual([]);
    expect(await rowsOf(id)).toEqual([]);
  });

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
