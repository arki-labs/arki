/**
 * The command door: `journal.bind(source, meta)` fixes where commands run and
 * who runs them, and a rule that rejects a request throws `CommandError`. An
 * app builds its request context and its jobs on these two instead of writing
 * its own runner and its own error class. These tests pin what such an app
 * relies on: the rejection arrives untouched and writes nothing, and a bound
 * runner behaves exactly like `journal.run` with the same `source` and `meta`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z, ZodError } from 'zod';

import type { CommandRunner } from './api.js';
import type { CommandErrorCode } from './errors.js';
import type { OrderId } from './test-support.js';
import type { DbHandle } from './types.js';
import { CommandError, isCommandError, isJournalError, JournalError } from './errors.js';
import { initJournal } from './journal.js';
import { j, meta, openDb, order, orderId, OrderNoted, OrderPlaced, orders, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 5000;

/** Listens to `OrderPlaced`, so placing an order queues a job. */
const notify = j.effect('order-notify', order, {
  OrderPlaced: () => {
    /* never drained here: the tests only need the job to be queued */
  },
});
const journal = j.compose({ tables, effects: [notify] });

const orderIdSchema = z.templateLiteral(['ord_', z.string()]);

const placeOrder = j.command('placeOrder', z.object({ id: orderIdSchema }), (input, { write }) =>
  write(order, input.id, () => [OrderPlaced({ customerId: 'c', total: 1 })]),
);

/** Shaped like `@arki/payments`' `writes(run)`: it takes a runner and calls commands through it. */
const writes = (runner: CommandRunner<{ actorId: string }>) => runner(placeOrder, { id: 'ord_1' });

const eventsOf = (id: OrderId) => db.select().from(tables.events).where(eq(tables.events.entityId, id));
const rowsOf = (id: OrderId) => db.select().from(orders).where(eq(orders.id, id));

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await client.close();
});

describe('CommandError', () => {
  it('reaches the caller as the same instance and commits nothing, so the app answers the client with the rule and the data stays as it was', async () => {
    const id = orderId(next++);
    const rejected = new CommandError('FORBIDDEN', 'You do not own this order');
    // The first write succeeds. The rule then rejects inside the second write's
    // savepoint, so the error crosses a savepoint and the command's transaction.
    const placeThenReject = j.command('placeThenReject', z.object({ id: orderIdSchema }), async (input, { write }) => {
      await write(order, input.id, () => [OrderPlaced({ customerId: 'c', total: 1 })]);
      await write(order, input.id, () => {
        throw rejected;
      });
    });

    const error: unknown = await journal.run(db, placeThenReject, { id }, meta).catch((error_: unknown) => error_);

    expect(error).toBe(rejected);
    expect(rejected.code).toBe('FORBIDDEN');
    expect(rejected.message).toBe('You do not own this order');
    expect(await rowsOf(id)).toHaveLength(0);
    expect(await eventsOf(id)).toHaveLength(0);
  });

  it('is not a JournalError, so a rejected rule is never mistaken for a failure of the library', () => {
    const rejected = new CommandError('NOT_FOUND', 'Order not found');

    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).not.toBeInstanceOf(JournalError);
    expect(rejected.name).toBe('CommandError');
    expect(isJournalError(rejected)).toBe(false);
  });

  it('isCommandError narrows by code, so a host can give one kind of rejection its own answer', () => {
    const rejected: unknown = new CommandError('NOT_FOUND', 'Order not found');

    expect(isCommandError(rejected)).toBe(true);
    expect(isCommandError(rejected, 'NOT_FOUND')).toBe(true);
    expect(isCommandError(rejected, 'CONFLICT')).toBe(false);
    // The journal's own CONFLICT is a different error with the same word as its code.
    expect(isCommandError(new JournalError('CONFLICT', 'order', 'ord_1'), 'CONFLICT')).toBe(false);
    expect(isCommandError(new Error('Order not found'))).toBe(false);
    expect(isCommandError({ code: 'NOT_FOUND', message: 'Order not found' })).toBe(false);

    if (isCommandError(rejected)) {
      expectTypeOf(rejected).toEqualTypeOf<CommandError>();
      expectTypeOf(rejected.code).toEqualTypeOf<CommandErrorCode>();
    }
  });
});

describe('journal.bind', () => {
  it('on the root database runs the command, commits it and wakes the worker when a job was queued, so a request door needs no code of its own', async () => {
    const id = orderId(next++);
    const wake = vi.spyOn(journal, 'wake');
    const run = journal.bind(db, { actorId: 'usr_door' });

    const result = await run(placeOrder, { id });

    // The handler's result comes back, written with the bound meta.
    expect(result.row).toMatchObject({ id, status: 'placed', version: 1 });
    expect(result.events.map(event => event.meta)).toEqual([{ actorId: 'usr_door' }]);
    // Committed: the root database sees the row and its event after the call.
    expect(await rowsOf(id)).toHaveLength(1);
    expect(await eventsOf(id)).toHaveLength(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('runs every call on its own, so one bound runner serves a whole request or a whole job', async () => {
    const first = orderId(next++);
    const second = orderId(next++);
    const run = journal.bind(db, meta);

    await run(placeOrder, { id: first });
    await run(placeOrder, { id: second });

    expect(await rowsOf(first)).toHaveLength(1);
    expect(await rowsOf(second)).toHaveLength(1);
  });

  it('on a transaction joins it and does not commit or wake by itself, so the caller still decides the commit', async () => {
    const id = orderId(next++);
    const wake = vi.spyOn(journal, 'wake');
    const undo = new Error('the caller rolls back');

    const error: unknown = await db
      .transaction(async tx => {
        const run = journal.bind(tx, meta);
        await run(placeOrder, { id });
        // Inside the caller's transaction the write is there.
        expect(await tx.select().from(orders).where(eq(orders.id, id))).toHaveLength(1);
        throw undo;
      })
      .catch((error_: unknown) => error_);

    expect(error).toBe(undo);
    // The bound run did not commit on its own: the caller's rollback took it away.
    expect(await rowsOf(id)).toHaveLength(0);
    expect(await eventsOf(id)).toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();
  });

  it('parses meta on every call like journal.run, so a bad actor is refused by the call and writes nothing', async () => {
    const id = orderId(next++);
    // Binding does not throw: the request context can always be built.
    const run = journal.bind(db, { actorId: '' });

    await expect(run(placeOrder, { id })).rejects.toBeInstanceOf(ZodError);
    expect(await rowsOf(id)).toHaveLength(0);
  });

  it('gives each command its own parsed meta, so a default in the meta schema is not frozen at bind time', async () => {
    let requests = 0;
    const jd = initJournal({
      meta: z.object({ actorId: z.string(), requestId: z.string().default(() => `req_${++requests}`) }),
    });
    const Noted = jd.event('OrderNoted', z.object({ note: z.string() }));
    const Placed = jd.event('OrderPlaced', z.object({ customerId: z.string(), total: z.int() }));
    const tracedOrder = jd
      .entity('order', orders)
      .create(Placed, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))
      .on(Noted, (_row, e) => ({ note: e.data.note }));
    const touch = jd.command('touch', z.object({ id: orderIdSchema }), (input, { write }) =>
      write(tracedOrder, input.id, row => (row ? [Noted({ note: 'again' })] : [Placed({ customerId: 'c', total: 1 })])),
    );
    const id = orderId(next++);
    const run = jd.compose({ tables }).bind(db, { actorId: 'usr_door' });

    const first = await run(touch, { id });
    const second = await run(touch, { id });

    expect(first.events[0]?.meta.requestId).toBe('req_1');
    expect(second.events[0]?.meta.requestId).toBe('req_2');
  });

  it('is typed as a command runner, so it can be handed to code that expects a command context `run`', () => {
    const run = journal.bind(db, meta);

    expectTypeOf(run).toEqualTypeOf<CommandRunner<{ actorId: string }, DbHandle>>();
    expect(typeof run).toBe('function');

    // Type-level only: never called.
    const typeChecks = async () => {
      const written = await writes(run);
      expectTypeOf(written.row).toEqualTypeOf<typeof orders.$inferSelect | null>();

      const noteOrder = j.command('noteOrder', z.object({ id: orderIdSchema }), (input, { write }) =>
        write(order, input.id, () => [OrderNoted({ note: 'seen' })]),
      );
      // @ts-expect-error -- the input is checked against the command's schema
      await run(noteOrder, { id: 7 });

      const other = initJournal({ meta: z.object({ tenantId: z.string() }) });
      const otherCommand = other.command('otherCommand', z.object({}), (_input, { meta: otherMeta }) => otherMeta);
      // @ts-expect-error -- a command of a journal with another meta shape would read a `tenantId` this door never gives
      await run(otherCommand, {});
    };
    expectTypeOf(typeChecks).toBeFunction();
  });
});
