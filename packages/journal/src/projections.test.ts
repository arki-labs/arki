import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { OrderId } from './test-support.js';
import {
  customerOrderCounts,
  j,
  meta,
  openDb,
  order,
  orderId,
  OrderPaid,
  OrderPlaced,
  tables,
} from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 0;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

const counts = j.projection(
  'async-counts',
  order,
  {
    OrderPlaced: (tx, e) =>
      tx
        .insert(customerOrderCounts)
        .values({ customerId: e.data.customerId, placed: 1 })
        .onConflictDoUpdate({
          target: customerOrderCounts.customerId,
          set: { placed: sql`${customerOrderCounts.placed} + 1` },
        }),
  },
  { lane: 'async' },
);
let failPaid = false;
const paidLog: OrderId[] = [];
const paid = j.projection(
  'async-paid',
  order,
  {
    OrderPaid: (_tx, e) => {
      if (failPaid) throw new Error('read model down');
      paidLog.push(e.entityId);
    },
  },
  { lane: 'async' },
);
const journal = j.compose({ projections: [counts, paid] });

const place = (id: OrderId, customerId: string) =>
  db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId, total: 1 })] }));
const pay = (id: OrderId) =>
  db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] }));
const placedFor = async (customerId: string) => {
  const rows = await db.select().from(customerOrderCounts).where(eq(customerOrderCounts.customerId, customerId));
  return rows[0]?.placed ?? 0;
};
const cursorOf = async (name: string) => {
  const all = await journal.cursors(db);
  return all.find(c => c.name === name);
};

describe('async projections', () => {
  it('a write does not run them; catchUp applies them in commit order with a cursor that is global scan progress', async () => {
    // Why: a slow read model must not slow the write, and progress must be stored with the
    // handler's own writes, so a crash between the two cannot apply a batch twice or skip one.
    const customer = `cus_async_${++next}`;
    orThrow(await place(orderId(++next), customer));
    orThrow(await place(orderId(++next), customer));
    expect(await placedFor(customer), 'not applied inside the write').toBe(0);
    const before = await cursorOf('async-counts');
    expect(before?.lag).toBeGreaterThan(0);

    const first = await journal.catchUp(db, { batchSize: 1 });
    expect(first.scanned).toBe(2); // one event per projection
    expect(await placedFor(customer)).toBe(1);
    await journal.catchUp(db);
    expect(await placedFor(customer)).toBe(2);
    // The cursor advanced over every event, matching or not: lag is zero, so "caught up" is a real answer.
    const cursor = await cursorOf('async-counts');
    expect(cursor?.lag).toBe(0);
    const [top] = await db.select({ seq: sql<number>`max(seq)::int` }).from(tables.events);
    expect(cursor?.seq).toBe(top?.seq);
  });

  it('one projection failing does not hold the others, and its batch is retried next pass', async () => {
    const id = orderId(++next);
    const customer = `cus_iso_${next}`;
    orThrow(await place(id, customer));
    orThrow(await pay(id));
    failPaid = true;
    await journal.catchUp(db);
    expect(await placedFor(customer), 'the healthy projection advanced').toBe(1);
    expect(paidLog).toEqual([]);
    const stuck = await cursorOf('async-paid');
    expect(stuck?.lag, 'the failed one did not move').toBeGreaterThan(0);
    failPaid = false;
    await journal.catchUp(db);
    expect(paidLog).toEqual([id]);
    const moved = await cursorOf('async-paid');
    expect(moved?.lag).toBe(0);
  });

  it('reset clears the read model and rewinds the cursor in one transaction; catchUp rebuilds it', async () => {
    const customer = `cus_reset_${++next}`;
    orThrow(await place(orderId(++next), customer));
    await journal.catchUp(db);
    expect(await placedFor(customer)).toBe(1);
    await journal.reset(db, counts, async tx => {
      await tx.delete(customerOrderCounts).where(sql`true`);
    });
    expect(await placedFor(customer)).toBe(0);
    const rewound = await cursorOf('async-counts');
    expect(rewound?.seq).toBe(0);
    await journal.catchUp(db, { batchSize: 1000 });
    expect(await placedFor(customer)).toBe(1);
    expect(() => journal.rerun(db, counts)).toThrow(expect.objectContaining({ code: 'BAD_DEFINITION' }));
  });

  it('the worker catches up after a write wakes it, even when the write queued no job', async () => {
    const customer = `cus_worker_${++next}`;
    const worker = journal.worker(db, { pollMs: 60_000 });
    await worker.start();
    try {
      orThrow(
        await journal.run(
          db,
          j.command('placeOne', OrderPlaced.schema, (input, { write }) =>
            write(order, orderId(++next), () => [OrderPlaced(input)]),
          ),
          { customerId: customer, total: 1 },
          meta,
        ),
      );
      const until = Date.now() + 3000;
      while ((await placedFor(customer)) === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 50));
      expect(await placedFor(customer)).toBe(1);
    } finally {
      await worker.stop();
    }
  });
});
