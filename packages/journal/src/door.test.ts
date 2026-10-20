/**
 * The command door: `journal.bind(source, meta)` fixes where commands run and
 * who runs them. An app builds its request context and its jobs on it instead
 * of writing its own runner. These tests pin what such an app relies on: an
 * error its code throws arrives untouched and writes nothing, and a bound
 * runner behaves exactly like `journal.run` with the same `source` and `meta`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import { TransactionDefect } from '@arki/db/transaction';
import { InvalidInput, orThrow } from '@arki/failure';

import type { CommandRunner } from './api.js';
import type { OrderId } from './test-support.js';
import type { DbHandle } from './types.js';
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
const journal = j.compose({ effects: [notify] });

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

describe('an error thrown by app code', () => {
  it('returns a typed defect with the private original cause and commits nothing', async () => {
    const id = orderId(next++);
    const thrown = new Error('the app gave up');
    // The first write succeeds. The app then throws inside the second write's
    // savepoint, so the error crosses a savepoint and the command's transaction.
    const placeThenThrow = j.command('placeThenThrow', z.object({ id: orderIdSchema }), async (input, { write }) => {
      orThrow(await write(order, input.id, () => [OrderPlaced({ customerId: 'c', total: 1 })]));
      orThrow(
        await write(order, input.id, () => {
          throw thrown;
        }),
      );
    });

    const error: unknown = await journal.run(db, placeThenThrow, { id }, meta).catch((error_: unknown) => error_);

    expect(TransactionDefect.is(error)).toBe(true);
    if (TransactionDefect.is(error)) expect(error.cause).toBe(thrown);
    expect(await rowsOf(id)).toHaveLength(0);
    expect(await eventsOf(id)).toHaveLength(0);
  });
});

describe('journal.bind', () => {
  it('on the root database runs the command, commits it and wakes the worker when a job was queued, so a request door needs no code of its own', async () => {
    const id = orderId(next++);
    const wake = vi.spyOn(journal, 'wake');
    const run = journal.bind(db, { actorId: 'usr_door' });

    const result = orThrow(await run(placeOrder, { id }));

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

    orThrow(await run(placeOrder, { id: first }));
    orThrow(await run(placeOrder, { id: second }));

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
        orThrow(await run(placeOrder, { id }));
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

    await expect(run(placeOrder, { id })).resolves.toMatchObject({ code: InvalidInput.code });
    expect(await rowsOf(id)).toHaveLength(0);
  });

  it('gives each command its own parsed meta, so a default in the meta schema is not frozen at bind time', async () => {
    let requests = 0;
    const jd = initJournal({
      tables,
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
    const run = jd.compose({}).bind(db, { actorId: 'usr_door' });

    const first = orThrow(await run(touch, { id }));
    const second = orThrow(await run(touch, { id }));

    expect(first.events[0]?.meta.requestId).toBe('req_1');
    expect(second.events[0]?.meta.requestId).toBe('req_2');
  });

  it('is typed as a command runner, so it can be handed to code that expects a command context `run`', () => {
    const run = journal.bind(db, meta);

    expectTypeOf(run).toEqualTypeOf<CommandRunner<{ actorId: string }, DbHandle>>();
    expect(typeof run).toBe('function');

    // Type-level only: never called.
    const typeChecks = async () => {
      const written = orThrow(await writes(run));
      expectTypeOf(written.row).toEqualTypeOf<typeof orders.$inferSelect | null>();

      const noteOrder = j.command('noteOrder', z.object({ id: orderIdSchema }), (input, { write }) =>
        write(order, input.id, () => [OrderNoted({ note: 'seen' })]),
      );
      // @ts-expect-error -- the input is checked against the command's schema
      orThrow(await run(noteOrder, { id: 7 }));

      const other = initJournal({ tables, meta: z.object({ tenantId: z.string() }) });
      const otherCommand = other.command('otherCommand', z.object({}), (_input, { meta: otherMeta }) => otherMeta);
      // @ts-expect-error -- a command of a journal with another meta shape would read a `tenantId` this door never gives
      orThrow(await run(otherCommand, {}));
    };
    expectTypeOf(typeChecks).toBeFunction();
  });
});
