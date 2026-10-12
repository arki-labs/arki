/**
 * What a `JournalError` tells the reader: the code, and the detail the throw
 * site adds (event type, version, expected row version, first stored version).
 * An agent fixes the write from that detail, so it must not go missing.
 * Only the code and the key detail are checked, never a whole sentence.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JournalError } from './errors.js';
import type { OrderId } from './test-support.js';
import type { DbHandle } from './types.js';
import { isJournalError } from './errors.js';
import { j, meta, openDb, order, orderId, OrderPaid, OrderPlaced, orders, tables, Unrelated } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 1000;

const journal = j.compose({ tables });

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

const place = (id: OrderId) =>
  db.transaction(tx =>
    journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c1', total: 5 })] }),
  );
const pay = (id: OrderId) =>
  db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 5 })] }));

/** The `JournalError` a refused call rejects with. */
async function refusal(call: Promise<unknown>): Promise<JournalError> {
  try {
    await call;
  } catch (error) {
    if (isJournalError(error)) return error;
    throw error;
  }
  throw new Error('expected a JournalError, but the call succeeded');
}

const rowVersion = async (id: OrderId) => {
  const rows = await db.select({ version: orders.version }).from(orders).where(eq(orders.id, id));
  return rows[0]?.version;
};
const historyLength = async (id: OrderId) => {
  const rows = await db.select().from(tables.events).where(eq(tables.events.entityId, id));
  return rows.length;
};

describe('JournalError detail', () => {
  it('NO_ROW names the event and the version it would have had, so the reader knows which event lacks `.create`', async () => {
    const error = await refusal(pay(orderId(++next)));
    expect(error.code).toBe('NO_ROW');
    expect(error.message).toMatch(/"OrderPaid" at version 1\b/);
  });

  it('ROW_EXISTS names the event and its version, so the reader knows which event lacks `.on`', async () => {
    const id = orderId(++next);
    await place(id);
    const error = await refusal(place(id));
    expect(error.code).toBe('ROW_EXISTS');
    expect(error.message).toMatch(/"OrderPlaced" at version 2\b/);
  });

  it('UNKNOWN_EVENT names the event the entity does not declare', async () => {
    const id = orderId(++next);
    const error = await refusal(
      db.transaction(tx =>
        journal.write(tx, order, id, {
          meta,
          // @ts-expect-error -- Unrelated is not declared on `order`; the runtime check is what the log relies on.
          events: () => [Unrelated({})],
        }),
      ),
    );
    expect(error.code).toBe('UNKNOWN_EVENT');
    expect(error.message).toMatch(/"Unrelated" at version 1\b/);
  });

  it.each([
    {
      change: 'changes the row version',
      direct: (tx: DbHandle, id: OrderId) => tx.update(orders).set({ version: 7 }).where(eq(orders.id, id)),
    },
    { change: 'deletes the row', direct: (tx: DbHandle, id: OrderId) => tx.delete(orders).where(eq(orders.id, id)) },
  ])(
    'VERSION_MISMATCH names the expected row version when a direct statement inside `events` $change, and the write rolls back',
    async ({ direct }) => {
      // Why: the message tells the reader to look for exactly this cause. This test proves the cause is real.
      const id = orderId(++next);
      await place(id);
      const error = await refusal(
        db.transaction(tx =>
          journal.write(tx, order, id, {
            meta,
            events: async (_row, { tx: inner }) => {
              await direct(inner, id);
              return [OrderPaid({ amount: 5 })];
            },
          }),
        ),
      );
      expect(error.code).toBe('VERSION_MISMATCH');
      expect(error.message).toContain('expected row version 1');
      expect(await rowVersion(id)).toBe(1);
      expect(await historyLength(id)).toBe(1);
    },
  );

  it('NO_HISTORY says the log is empty for a row that existed before the journal', async () => {
    const id = orderId(++next);
    await db.insert(orders).values({ id, customerId: 'legacy', total: 7, status: 'placed' });
    const error = await refusal(journal.replay(db, order, id));
    expect(error.code).toBe('NO_HISTORY');
    expect(error.message).toContain('holds no event');
  });

  it('NO_HISTORY names the first stored version when the history does not start at 1', async () => {
    const id = orderId(++next);
    await db.insert(orders).values({ id, customerId: 'legacy', total: 7, status: 'placed' });
    await pay(id);
    const error = await refusal(journal.replay(db, order, id));
    expect(error.code).toBe('NO_HISTORY');
    expect(error.message).toContain('first stored version is 2');
  });

  it('REPLAY_FAILED names the stored event and its version when its data no longer fits the schema', async () => {
    const id = orderId(++next);
    await place(id);
    await db
      .update(tables.events)
      .set({ data: { customerId: '', total: -1 } })
      .where(eq(tables.events.entityId, id));
    const error = await refusal(journal.replay(db, order, id));
    expect(error.code).toBe('REPLAY_FAILED');
    expect(error.message).toMatch(/"OrderPlaced" at version 1\b/);
  });
});
