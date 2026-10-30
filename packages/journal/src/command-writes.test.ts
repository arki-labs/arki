/**
 * The `writes` list at runtime. The types refuse an undeclared event; these tests are for the handler
 * that got past them (a cast, a helper built on `unknown`, plain JavaScript): the event map reads `writes`
 * before boot, so a list that lies about what a command does would be believed everywhere.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findCause, isFailure } from '@arki/failure';

import { JournalError } from './errors.js';
import { j, meta, openDb, order, orderId, OrderNoted, OrderPaid, OrderPlaced, orders, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let journal: ReturnType<typeof j.compose>;
let next = 0;

const input = z.object({ id: z.templateLiteral(['ord_', z.string()]) });
const placed = OrderPlaced({ customerId: 'c', total: 1 });
const noted = OrderNoted({ note: 'never kept' });

beforeAll(async () => {
  ({ db, client } = await openDb());
  journal = j.compose({});
});
afterAll(async () => {
  await client.close();
});

/** The JournalError a failed run carries as its private cause. */
async function causeOf(call: Promise<unknown>) {
  const result = await call;
  const error = findCause(result, JournalError);
  if (error === undefined) throw new Error(`expected a JournalError cause, got ${String(result)}`);
  return error;
}
const stored = async (id: `ord_${string}`) => ({
  rows: await db.select().from(orders).where(eq(orders.id, id)),
  events: await db.select().from(tables.events).where(eq(tables.events.entityId, id)),
});

describe('a command that writes an event it did not declare', () => {
  it('fails with BAD_DEFINITION naming the command and the event, and nothing commits', async () => {
    const id = orderId(++next);
    const sneaky = j.command('sneakyNote', input, { writes: [OrderPlaced] }, async (args, { write }) => {
      const first = await write(order, args.id, () => [placed]);
      if (isFailure(first)) return first;
      // @ts-expect-error the point of the test: this handler gets past the types.
      return write(order, args.id, () => [noted]);
    });

    const error = await causeOf(journal.run(db, sneaky, { id }, meta));

    expect(error.code).toBe('BAD_DEFINITION');
    expect(error.message).toContain('"sneakyNote"');
    expect(error.message).toContain('"OrderNoted"');
    expect(await stored(id), 'the declared write before it rolls back too').toEqual({ rows: [], events: [] });
  });

  it('refuses one undeclared event in a list of declared ones', async () => {
    const id = orderId(++next);
    const mixed = j.command('mixedList', input, { writes: [OrderPlaced] }, (args, { write }) =>
      // @ts-expect-error the point of the test: this handler gets past the types.
      write(order, args.id, () => [placed, noted]),
    );

    const error = await causeOf(journal.run(db, mixed, { id }, meta));

    expect(error.code).toBe('BAD_DEFINITION');
    expect(await stored(id)).toEqual({ rows: [], events: [] });
  });

  // Why: a catch around `write` must not turn a command that lied about its events into a commit.
  it('commits nothing even when the handler catches the error and returns a success', async () => {
    const id = orderId(++next);
    const swallowed = j.command('swallowsRefusal', input, { writes: [OrderPlaced] }, async (args, { write }) => {
      const first = await write(order, args.id, () => [placed]);
      if (isFailure(first)) return first;
      try {
        // @ts-expect-error the point of the test: this handler gets past the types.
        // eslint-disable-next-line failure/must-use -- the throw is what this handler catches; a failure is not expected
        await write(order, args.id, () => [noted]);
      } catch {
        return 'carried on';
      }
      return 'never here';
    });

    const error = await causeOf(journal.run(db, swallowed, { id }, meta));

    expect(error.code).toBe('BAD_DEFINITION');
    expect(await stored(id)).toEqual({ rows: [], events: [] });
  });

  // Why: `writes` lists definitions, not type names. Two entities may each own an event of one name.
  it('compares the definition, not the event type', async () => {
    const id = orderId(++next);
    const SameName = j.event('OrderPlaced', z.object({ customerId: z.string(), total: z.number() }));
    const twin = j.command('twinEvent', input, { writes: [SameName] }, (args, { write }) =>
      write(order, args.id, () => [placed]),
    );

    const error = await causeOf(journal.run(db, twin, { id }, meta));

    expect(error.code).toBe('BAD_DEFINITION');
    expect(await stored(id)).toEqual({ rows: [], events: [] });
  });
});

describe('a command that keeps to its list', () => {
  it('commits every declared event', async () => {
    const id = orderId(++next);
    const place = j.command('placeAndPay', input, { writes: [OrderPlaced, OrderPaid] }, (args, { write }) =>
      write(order, args.id, () => [placed, OrderPaid({ amount: 1 })]),
    );

    const result = await journal.run(db, place, { id }, meta);

    expect(isFailure(result)).toBe(false);
    const { events } = await stored(id);
    expect(events.map(event => event.type)).toEqual(['OrderPlaced', 'OrderPaid']);
  });

  it('with writes: [] runs a child, whose list is its own', async () => {
    const id = orderId(++next);
    const child = j.command('placeChild', input, { writes: [OrderPlaced] }, (args, { write }) =>
      write(order, args.id, () => [placed]),
    );
    const parent = j.command('onlyRuns', input, { writes: [] }, (args, { run }) => run(child, args));

    const result = await journal.run(db, parent, { id }, meta);

    expect(isFailure(result)).toBe(false);
    const { rows } = await stored(id);
    expect(rows).toHaveLength(1);
  });

  it('exposes writes on the command value before any journal exists', () => {
    const declared = j.command('declared', input, { writes: [OrderPlaced, OrderPaid] }, () => 1);

    expect(declared.writes).toEqual([OrderPlaced, OrderPaid]);
  });
});
