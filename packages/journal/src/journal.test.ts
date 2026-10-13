import type { PGlite } from '@electric-sql/pglite';
import type { PgInsertValue, PgTable } from 'drizzle-orm/pg-core';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq, sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, varchar } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { DbHandle, PendingOf } from './types.js';
import { isJournalError, JournalError } from './errors.js';
import { initJournal } from './journal.js';
import {
  customerOrderCounts,
  j,
  meta,
  openDb,
  order,
  OrderCancelled,
  orderId,
  OrderNoted,
  OrderPaid,
  OrderPlaced,
  orders,
  tables,
  Unrelated,
} from './test-support.js';
import { sortedByVersion } from './write.js';

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

let failProjection = false;
const flaky = j.projection('flaky', order, {
  OrderPaid: () => {
    if (failProjection) throw new Error('projection boom');
  },
});

const mail = j.effect('order-mail', order, {
  OrderPaid: () => {
    /* delivery is the drain test's business */
  },
});

/** The notes in the order the projection saw them. */
const noted: string[] = [];
const noteLog = j.projection('note-log', order, {
  OrderNoted: (_tx, e) => {
    noted.push(e.data.note);
  },
});

beforeAll(async () => {
  ({ db, client } = await openDb());
  journal = j.compose({ tables, projections: [customerStats, flaky, noteLog], effects: [mail] });
});

afterAll(async () => {
  await client.close();
});

const place = (id: ReturnType<typeof orderId>, customerId = 'cus_1') =>
  db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId, total: 100 })] }));

const pay = (id: ReturnType<typeof orderId>) =>
  db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 100 })] }));

const cancel = (id: ReturnType<typeof orderId>) =>
  db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderCancelled({ reason: 'x' })] }));

const history = (id: string) =>
  db.select().from(tables.events).where(eq(tables.events.entityId, id)).orderBy(tables.events.version);

const versions = async (id: string) => {
  const rows = await history(id);
  return rows.map(e => e.version);
};

const countRows = async (query: PromiseLike<unknown[]>) => {
  const rows = await query;
  return rows.length;
};

const rowOf = async (id: ReturnType<typeof orderId>) => {
  const rows = await db.select().from(orders).where(eq(orders.id, id));
  return rows[0] ?? null;
};

describe('write', () => {
  it('create: the row and the event land together, and the row carries the DB default', async () => {
    const id = orderId(++next);
    const result = await place(id);
    expect(result.row).toMatchObject({ id, status: 'placed', total: 100, version: 1, note: 'none' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'OrderPlaced', version: 1, entityId: id, kind: 'order', meta });
    expect(result.events[0]?.id).toMatch(/^evt_/);
    // A bare write has no command and no cause, but it starts a chain of its own.
    expect(result.events[0]).toMatchObject({ commandId: null, causeSeq: null });
    expect(result.events[0]?.correlationId).toMatch(/^cor_/);
    expectTypeOf(result.events[0]?.type).toEqualTypeOf<
      'OrderPlaced' | 'OrderPaid' | 'OrderNoted' | 'OrderCancelled' | undefined
    >();
    expect(await rowOf(id)).toMatchObject({ status: 'placed', version: 1 });
  });

  it('update: the reducer sees the stored row and the version moves to 2', async () => {
    const id = orderId(++next);
    await place(id);
    const result = await pay(id);
    expect(result.row).toMatchObject({ status: 'paid', version: 2, customerId: 'cus_1' });
    expect(await versions(id)).toEqual([1, 2]);
  });

  it('delete: a null reducer removes the row but the events stay', async () => {
    const id = orderId(++next);
    await place(id);
    const result = await cancel(id);
    expect(result.row).toBeNull();
    expect(await rowOf(id)).toBeNull();
    expect(await history(id)).toHaveLength(2);
  });

  it('several events in one write produce one row save at the final version', async () => {
    const id = orderId(++next);
    const result = await db.transaction(tx =>
      journal.write(tx, order, id, {
        meta,
        events: () => [OrderPlaced({ customerId: 'cus_2', total: 5 }), OrderPaid({ amount: 5 })],
      }),
    );
    expect(result.row).toMatchObject({ status: 'paid', version: 2 });
    expect(result.events.map(e => e.version)).toEqual([1, 2]);
  });

  it('events returning [] writes nothing and returns the current row', async () => {
    const id = orderId(++next);
    await place(id);
    const result = await db.transaction(tx =>
      journal.write(tx, order, id, { meta, events: row => (row?.status === 'placed' ? [] : []) }),
    );
    expect(result.events).toEqual([]);
    expect(result.row).toMatchObject({ version: 1 });
    expect(await countRows(history(id))).toBe(1);
  });

  it('rejects an event the entity does not declare, before anything is written', async () => {
    const id = orderId(++next);
    await expect(
      db.transaction(tx =>
        journal.write(tx, order, id, {
          meta,
          // The type system blocks this; the runtime check is what the log relies on.
          // @ts-expect-error -- Unrelated is not declared on `order`
          events: () => [Unrelated({})],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_EVENT' });
    expect(await history(id)).toHaveLength(0);
  });

  it('rejects a create on an existing row and an update on a missing row', async () => {
    const id = orderId(++next);
    await place(id);
    await expect(place(id)).rejects.toMatchObject({ code: 'ROW_EXISTS' });
    await expect(pay(orderId(++next))).rejects.toMatchObject({ code: 'NO_ROW' });
  });

  it('rejects bad meta before touching the database', async () => {
    const id = orderId(++next);
    await expect(
      db.transaction(tx => journal.write(tx, order, id, { meta: { actorId: '' }, events: () => [] })),
    ).rejects.toThrow();
  });

  it('create after delete continues the version sequence and replays to the new row', async () => {
    const id = orderId(++next);
    await place(id);
    await cancel(id);
    const again = await place(id, 'cus_again');
    expect(again.row).toMatchObject({ version: 3, customerId: 'cus_again' });
    expect(await versions(id)).toEqual([1, 2, 3]);
    const replayed = await journal.replay(db, order, id);
    expect(replayed.row).toMatchObject({ id, version: 3, customerId: 'cus_again', status: 'placed' });
    expect(await journal.verify(db, order, id)).toEqual({ ok: true });
  });

  it('a throwing projection rolls back events, row and jobs', async () => {
    const id = orderId(++next);
    await place(id);
    failProjection = true;
    try {
      await expect(pay(id)).rejects.toThrow('projection boom');
    } finally {
      failProjection = false;
    }
    expect(await countRows(history(id))).toBe(1);
    expect(await rowOf(id)).toMatchObject({ status: 'placed', version: 1 });
    const jobs = await db.select().from(tables.jobs);
    const paidEvents = await countRows(db.select().from(tables.events).where(eq(tables.events.type, 'OrderPaid')));
    expect(jobs.filter(job => job.effect === 'order-mail')).toHaveLength(paidEvents);
  });

  it('a caught error inside the caller transaction leaves no partial write (savepoint)', async () => {
    const id = orderId(++next);
    const other = orderId(++next);
    await place(id);
    failProjection = true;
    try {
      await db.transaction(async tx => {
        await journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 100 })] }).catch(() => null);
        await journal.write(tx, order, other, { meta, events: () => [OrderPlaced({ customerId: 'cus_3', total: 1 })] });
      });
    } finally {
      failProjection = false;
    }
    expect(await rowOf(id)).toMatchObject({ status: 'placed', version: 1 });
    expect(await countRows(history(id))).toBe(1);
    expect(await rowOf(other)).toMatchObject({ version: 1 });
  });

  it('projections run in the same transaction and see exact counts', async () => {
    const customerId = `cus_${orderId(++next)}`;
    await place(orderId(++next), customerId);
    await place(orderId(++next), customerId);
    const [count] = await db.select().from(customerOrderCounts).where(eq(customerOrderCounts.customerId, customerId));
    expect(count?.placed).toBe(2);
  });

  it('job rows are created only for effects that declare the event type', async () => {
    const id = orderId(++next);
    const placed = await place(id);
    const paid = await pay(id);
    const forPlaced = await db
      .select()
      .from(tables.jobs)
      .where(eq(tables.jobs.eventSeq, placed.events[0]?.seq ?? -1));
    const forPaid = await db
      .select()
      .from(tables.jobs)
      .where(eq(tables.jobs.eventSeq, paid.events[0]?.seq ?? -1));
    expect(forPlaced).toHaveLength(0);
    expect(forPaid).toHaveLength(1);
    expect(forPaid[0]).toMatchObject({ effect: 'order-mail', attempts: 0 });
    expect(forPaid[0]?.id).toMatch(/^job_/);
  });

  it('write and replay agree on every column a reducer set, even one a later reducer omits', async () => {
    // Replay is the source of truth for repair. If the saved row and the replayed row
    // differ, repair would silently rewrite data. The OrderNoted reducer sets only `note`.
    const id = orderId(++next);
    await place(id, 'cus_same');
    await db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderNoted({ note: 'gift' })] }));
    const written = await pay(id);
    const replayed = await journal.replay(db, order, id);
    expect(written.row).toMatchObject({ customerId: 'cus_same', total: 100, status: 'paid', note: 'gift', version: 3 });
    expect(replayed.row).toEqual({ id, version: 3, customerId: 'cus_same', total: 100, status: 'paid', note: 'gift' });
    expect(await journal.verify(db, order, id)).toEqual({ ok: true });
  });

  it('a patch key set to undefined leaves the column unchanged, in the row and in replay', async () => {
    const Opened = j.event('Opened', z.object({}));
    const Touched = j.event('Touched', z.object({}));
    const touchy = j
      .entity('touchy', orders)
      .create(Opened, () => ({ customerId: 'c', total: 1, status: 'placed' }))
      .on(Touched, () => ({ status: undefined, note: 'touched' }));
    const bare = j.compose({ tables });
    const id = orderId(++next);
    await db.transaction(tx => bare.write(tx, touchy, id, { meta, events: () => [Opened({})] }));
    const result = await db.transaction(tx => bare.write(tx, touchy, id, { meta, events: () => [Touched({})] }));
    expect(result.row).toMatchObject({ status: 'placed', note: 'touched' });
    const replayed = await bare.replay(db, touchy, id);
    expect(replayed.row).toEqual({ id, version: 2, customerId: 'c', total: 1, status: 'placed', note: 'touched' });
  });

  it('cancel then place in one write equals the same two writes: columns the create omits get their defaults', async () => {
    // A reducer returning null ends the old incarnation. A create after it must not
    // inherit columns from the deleted row.
    const twoStepId = orderId(++next);
    const oneStepId = orderId(++next);
    for (const id of [twoStepId, oneStepId]) {
      await place(id);
      await db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderNoted({ note: 'gift' })] }));
    }
    await cancel(twoStepId);
    const twoStep = await place(twoStepId, 'cus_again');
    const oneStep = await db.transaction(tx =>
      journal.write(tx, order, oneStepId, {
        meta,
        events: () => [OrderCancelled({ reason: 'x' }), OrderPlaced({ customerId: 'cus_again', total: 100 })],
      }),
    );
    expect(twoStep.row).toMatchObject({ note: 'none', customerId: 'cus_again', version: 4 });
    if (twoStep.row === null) throw new Error('two-step row missing');
    expect(oneStep.row).toEqual({ ...twoStep.row, id: oneStepId });
    expect(await rowOf(oneStepId)).toEqual({ ...twoStep.row, id: oneStepId });
    expect(await journal.verify(db, order, oneStepId)).toEqual({ ok: true });
  });

  it('a hand-built event skips the constructor, so write validates its data before anything lands', async () => {
    const id = orderId(++next);
    await place(id);
    const handBuilt: PendingOf<typeof OrderPaid> = { type: 'OrderPaid', data: { amount: -1 } };
    await expect(
      db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [handBuilt] })),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(await versions(id)).toEqual([1]);
  });

  it('a schema that changes its own output is UNSTABLE_SCHEMA, because replay would read a different value', async () => {
    const Bumped = j.event('Bumped', z.object({ n: z.number().transform(n => n + 1) }));
    const shaky = j
      .entity('shaky', orders)
      .create(Bumped, e => ({ customerId: 'c', total: e.data.n, status: 'placed' }));
    const bare = j.compose({ tables });
    const id = orderId(++next);
    await expect(
      db.transaction(tx => bare.write(tx, shaky, id, { meta, events: () => [Bumped({ n: 1 })] })),
    ).rejects.toMatchObject({ code: 'UNSTABLE_SCHEMA', message: expect.stringContaining('Bumped') });
    expect(await history(id)).toHaveLength(0);
  });

  it('meta that does not survive a JSON round trip is UNSTABLE_SCHEMA too', async () => {
    const dated = initJournal({ meta: z.object({ at: z.date() }) });
    const Ping = dated.event('Ping', z.object({}));
    const pinged = dated.entity('pinged', orders).create(Ping, () => ({ customerId: 'c', total: 1, status: 'placed' }));
    const bare = dated.compose({ tables });
    await expect(
      db.transaction(tx =>
        bare.write(tx, pinged, orderId(++next), { meta: { at: new Date() }, events: () => [Ping({})] }),
      ),
    ).rejects.toMatchObject({ code: 'UNSTABLE_SCHEMA' });
  });

  it('data JSON cannot hold (a Set, a Map, a class instance) is UNSTABLE_SCHEMA, even under z.unknown()', async () => {
    // A Set has no enumerable keys. Stored, it becomes `{}`, and a key-by-key compare
    // would call that equal. Only primitives, arrays and plain objects survive JSON.
    const Loose = j.event('Loose', z.object({ bag: z.unknown() }));
    const loose = j.entity('loose', orders).create(Loose, () => ({ customerId: 'c', total: 1, status: 'placed' }));
    const bare = j.compose({ tables });
    class Box {
      readonly value = 1;
    }
    for (const bag of [new Set(['a']), new Map([['k', 1]]), new Box()]) {
      const id = orderId(++next);
      await expect(
        db.transaction(tx => bare.write(tx, loose, id, { meta, events: () => [Loose({ bag })] })),
      ).rejects.toMatchObject({ code: 'UNSTABLE_SCHEMA' });
      expect(await history(id)).toHaveLength(0);
    }
  });

  it('data JSON cannot serialize (a bigint) is UNSTABLE_SCHEMA with the serializer error as cause, not a raw TypeError', async () => {
    const Big = j.event('Big', z.object({ n: z.bigint() }));
    const big = j.entity('big', orders).create(Big, () => ({ customerId: 'c', total: 1, status: 'placed' }));
    const bare = j.compose({ tables });
    const id = orderId(++next);
    const failure: unknown = await db
      .transaction(tx => bare.write(tx, big, id, { meta, events: () => [Big({ n: 1n })] }))
      .catch((error: unknown) => error);
    if (!isJournalError(failure)) throw new Error(`expected a JournalError, got ${String(failure)}`);
    expect(failure.code).toBe('UNSTABLE_SCHEMA');
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect(await history(id)).toHaveLength(0);
  });

  it("reducers, projections and the returned events see the stored data, not the caller's object", async () => {
    // A hand-built event can carry keys the schema strips. Replay only ever sees the
    // stored data, so write must fold the same data or verify fails later.
    const Counted = j.event('Counted', z.object({ n: z.int().positive() }));
    const counted = j
      .entity('counted', orders)
      .create(Counted, e => ({ customerId: 'c', total: Object.keys(e.data).length, status: 'placed' }));
    const id = orderId(++next);
    const keyCount = j.projection('key-count', counted, {
      Counted: (tx, e) =>
        tx.insert(customerOrderCounts).values({ customerId: `keys_${id}`, placed: Object.keys(e.data).length }),
    });
    const bare = j.compose({ tables, projections: [keyCount] });
    const data = { n: 1, bonus: 10 };
    const handBuilt: PendingOf<typeof Counted> = { type: 'Counted', data };
    const written = await db.transaction(tx => bare.write(tx, counted, id, { meta, events: () => [handBuilt] }));
    expect(written.row?.total).toBe(1);
    expect(written.events.map(e => e.data)).toStrictEqual([{ n: 1 }]);
    const [count] = await db
      .select()
      .from(customerOrderCounts)
      .where(eq(customerOrderCounts.customerId, `keys_${id}`));
    expect(count?.placed).toBe(1);
    const replayedCount = await bare.replay(db, counted, id);
    expect(replayedCount.row?.total).toBe(1);
    expect(await bare.verify(db, counted, id)).toEqual({ ok: true });
  });

  it('a create reducer key set to undefined means "not set": the default applies and verify passes', async () => {
    const Opened = j.event('OpenedBlank', z.object({}));
    const blank = j
      .entity('blank', orders)
      .create(Opened, () => ({ customerId: 'c', total: 1, status: 'placed', note: undefined }));
    const bare = j.compose({ tables });
    const id = orderId(++next);
    const written = await db.transaction(tx => bare.write(tx, blank, id, { meta, events: () => [Opened({})] }));
    expect(written.row?.note).toBe('none');
    const replayed = await bare.replay(db, blank, id);
    expect(replayed.row).toStrictEqual({ id, version: 1, customerId: 'c', total: 1, status: 'placed' });
    expect(await bare.verify(db, blank, id)).toEqual({ ok: true });
  });

  it('known limit: a column only a database default fills is not journal state, so a reducer that reads it differs between write and replay', async () => {
    // Write folds from the stored row, where `note` is 'none'. Replay folds from
    // nothing, where `note` is absent. The rule: a reducer must set every column
    // that any reducer later reads. This test names the limit; it is not a bug to fix.
    const Opened = j.event('OpenedLimit', z.object({}));
    const Copied = j.event('CopiedNote', z.object({}));
    const leaky = j
      .entity('leaky', orders)
      .create(Opened, () => ({ customerId: 'c', total: 1, status: 'placed' }))
      .on(Copied, row => ({ customerId: row.note ?? 'absent' }));
    const bare = j.compose({ tables });
    const id = orderId(++next);
    await db.transaction(tx => bare.write(tx, leaky, id, { meta, events: () => [Opened({})] }));
    const written = await db.transaction(tx => bare.write(tx, leaky, id, { meta, events: () => [Copied({})] }));
    expect(written.row?.customerId).toBe('none');
    const replayedLeaky = await bare.replay(db, leaky, id);
    expect(replayedLeaky.row?.customerId).toBe('absent');
    expect(await bare.verify(db, leaky, id)).toMatchObject({ ok: false });
  });

  it('an event type named like an Object.prototype member finds no inherited handler', async () => {
    // `handlers['toString']` on a plain object is Object.prototype.toString. An effect
    // would "run" it and acknowledge the job without any declared handler.
    const Weird = j.event('toString', z.object({}));
    const weird = j.entity('weird', orders).create(Weird, () => ({ customerId: 'c', total: 1, status: 'placed' }));
    const silent = j.effect('silent', weird, {});
    const noop = j.projection('noop', weird, {});
    expect([...silent.types]).toEqual([]);
    expect([...noop.types]).toEqual([]);
    const event = {
      type: 'toString',
      data: {},
      seq: 1,
      id: 'evt_x',
      kind: 'weird',
      entityId: orderId(0),
      version: 1,
      meta,
      recordedAt: new Date(),
      commandId: null,
      causeSeq: null,
      correlationId: null,
    };
    const ctx = {
      jobId: 'job_x',
      signal: new AbortController().signal,
      db,
      run: () => Promise.reject(new Error('no handler runs, so no command does')),
    };
    await expect(silent.run(event, ctx)).rejects.toThrow('no handler for "toString"');
    await expect(noop.run(db, event)).resolves.toBeUndefined();
  });

  it('a stored row whose version lags the log is a CONFLICT (unique index), not a corrupt log', async () => {
    const id = orderId(++next);
    // PGlite has one connection, so this is not a race. The real two-connection race is in journal.pg.test.ts.
    await db.insert(tables.events).values({
      id: 'evt_other',
      kind: 'order',
      entityId: id,
      version: 1,
      type: 'OrderPlaced',
      data: { customerId: 'cus_x', total: 1 },
      meta,
    });
    await db.insert(orders).values({ id, customerId: 'cus_x', total: 1, status: 'placed', version: 1 });
    await db.update(orders).set({ version: 0 }).where(eq(orders.id, id));
    await expect(
      db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

/** One create event for a legacy row, built from values the test knows. */
const legacyEvent = (customerId: string, total: number) => () => [OrderPlaced({ customerId, total })];

describe('replay, verify, repair', () => {
  it('replay folds the log; throughVersion gives an earlier state', async () => {
    const id = orderId(++next);
    await place(id);
    await pay(id);
    const full = await journal.replay(db, order, id);
    expect(full.row).toMatchObject({ status: 'paid', version: 2 });
    expect(full.events.map(e => e.type)).toEqual(['OrderPlaced', 'OrderPaid']);
    const early = await journal.replay(db, order, id, { throughVersion: 1 });
    expect(early.row).toMatchObject({ status: 'placed', version: 1 });
  });

  it('verify reports a drifted row and repair fixes it from the log', async () => {
    const id = orderId(++next);
    await place(id);
    await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, id));
    const bad = await journal.verify(db, order, id);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.expected).toMatchObject({ status: 'placed' });
      expect(bad.actual).toMatchObject({ status: 'cancelled' });
    }
    const jobsBefore = await countRows(db.select().from(tables.jobs));
    const repaired = await journal.repair(db, order, id);
    expect(repaired).toMatchObject({ status: 'placed', version: 1, note: 'none' });
    expect(await journal.verify(db, order, id)).toEqual({ ok: true });
    expect(await countRows(db.select().from(tables.jobs))).toBe(jobsBefore);
    expect(await countRows(history(id))).toBe(1);
  });

  it('repair recreates a row that was deleted by hand and deletes one the log says is gone', async () => {
    const id = orderId(++next);
    await place(id);
    await db.delete(orders).where(eq(orders.id, id));
    expect(await journal.repair(db, order, id)).toMatchObject({ status: 'placed', version: 1 });
    await cancel(id);
    await db.insert(orders).values({ id, customerId: 'ghost', total: 1, status: 'placed', version: 9 });
    expect(await journal.repair(db, order, id)).toBeNull();
    expect(await rowOf(id)).toBeNull();
  });

  it('NO_HISTORY for a row that predates the journal; writes still work on it', async () => {
    const id = orderId(++next);
    await db.insert(orders).values({ id, customerId: 'legacy', total: 7, status: 'placed' });
    await expect(journal.replay(db, order, id)).rejects.toMatchObject({ code: 'NO_HISTORY' });
    await expect(journal.verify(db, order, id)).rejects.toMatchObject({ code: 'NO_HISTORY' });
    await expect(journal.repair(db, order, id)).rejects.toSatisfy((e: unknown) => isJournalError(e, 'NO_HISTORY'));
    // Its history starts at version 2: version 1 is reserved for a real create.
    const paid = await pay(id);
    expect(paid.row).toMatchObject({ status: 'paid', version: 2 });
    expect(await versions(id)).toEqual([2]);
  });

  it('adopt brings a pre-journal row in: its create event becomes version 1, and replay, verify and repair work from then on', async () => {
    // Why: the first ordinary write to a legacy row starts its history at 2 and the original values
    // are gone after that. Adopt records a create that rebuilds the row as it is, so the history is
    // complete from version 1 and the row is never lost to a later write.
    const id = orderId(++next);
    const customerId = `cus_adopt_${next}`;
    await db.insert(orders).values({ id, customerId, total: 7, status: 'placed' });
    const adopted = await db.transaction(tx =>
      journal.adopt(tx, order, id, {
        meta,
        events: row => [OrderPlaced({ customerId: row?.customerId ?? '', total: row?.total ?? 0 })],
      }),
    );
    expect(adopted.row).toMatchObject({ customerId, total: 7, status: 'placed', version: 1, note: 'none' });
    expect(adopted.events.map(e => [e.type, e.version])).toEqual([['OrderPlaced', 1]]);
    expect(await journal.verify(db, order, id)).toEqual({ ok: true });
    // The event is the app's own: projections ran for it.
    const counts = await db.select().from(customerOrderCounts).where(eq(customerOrderCounts.customerId, customerId));
    expect(counts.map(c => c.placed)).toEqual([1]);
    // Ordinary writes continue from 1, and repair rebuilds the whole row from the log.
    await pay(id);
    expect(await versions(id)).toEqual([1, 2]);
    await db.update(orders).set({ total: 999 }).where(eq(orders.id, id));
    expect(await journal.repair(db, order, id)).toMatchObject({ total: 7, status: 'paid', version: 2 });
  });

  it('adopt refuses a row the journal already knows, a missing row, and a legacy row that was written to', async () => {
    const known = orderId(++next);
    await place(known);
    await expect(
      db.transaction(tx => journal.adopt(tx, order, known, { meta, events: legacyEvent('cus_1', 100) })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      db.transaction(tx => journal.adopt(tx, order, orderId(++next), { meta, events: legacyEvent('x', 1) })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const written = orderId(++next);
    await db.insert(orders).values({ id: written, customerId: 'legacy', total: 7, status: 'placed' });
    await pay(written);
    await expect(
      db.transaction(tx => journal.adopt(tx, order, written, { meta, events: legacyEvent('legacy', 7) })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('adopt refuses an event whose create reducer does not rebuild the row, and leaves the row and the log untouched', async () => {
    // Why: replay folds from nothing. If the adopted event built a different row, verify would report
    // drift on day one and repair would overwrite real data with the event's version of it.
    const id = orderId(++next);
    await db.insert(orders).values({ id, customerId: 'legacy', total: 7, status: 'placed' });
    const wrong = db.transaction(tx =>
      journal.adopt(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'legacy', total: 8 })] }),
    );
    await expect(wrong).rejects.toMatchObject({ code: 'VALUE_MISMATCH' });
    await expect(wrong).rejects.toThrow('column "total"');
    expect(await rowOf(id)).toMatchObject({ total: 7, version: 0 });
    expect(await versions(id)).toEqual([]);
    const noCreate = db.transaction(tx =>
      journal.adopt(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] }),
    );
    await expect(noCreate).rejects.toThrow('has no .create reducer');
    expect(await versions(id)).toEqual([]);
  });

  it('throughVersion cannot hide NO_HISTORY: a history that starts at version 2 is incomplete at any cut', async () => {
    // Why: `throughVersion: 1` on a log that starts at 2 would select nothing and read as "no entity",
    // when the truth is "an entity whose history cannot be replayed". The row is deleted
    // through the journal so that no stored row gives the game away.
    const id = orderId(++next);
    await db.insert(orders).values({ id, customerId: 'legacy', total: 7, status: 'placed' });
    await cancel(id);
    expect(await versions(id)).toEqual([2]);
    await expect(journal.replay(db, order, id, { throughVersion: 1 })).rejects.toMatchObject({ code: 'NO_HISTORY' });
  });

  it('HISTORY_GAP: a missing middle version is refused by replay, verify and repair, and the row is left alone', async () => {
    // Why: version 1 alone does not prove the log is complete. With version 2 gone, folding [1, 3]
    // would build a row the real history never produced, and repair would save it over a correct row.
    const id = orderId(++next);
    await place(id);
    await db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderNoted({ note: 'gap' })] }));
    await pay(id);
    await db.delete(tables.events).where(and(eq(tables.events.entityId, id), eq(tables.events.version, 2)));
    expect(await versions(id)).toEqual([1, 3]);
    await expect(journal.replay(db, order, id)).rejects.toMatchObject({ code: 'HISTORY_GAP' });
    await expect(journal.verify(db, order, id)).rejects.toMatchObject({ code: 'HISTORY_GAP' });
    await expect(journal.repair(db, order, id)).rejects.toSatisfy((e: unknown) => isJournalError(e, 'HISTORY_GAP'));
    expect(await rowOf(id)).toMatchObject({ status: 'paid', note: 'gap', version: 3 });
  });

  it('HISTORY_GAP: a row ahead of its log is refused too, so repair cannot roll a row back to an older state', async () => {
    // Why: the log [1, 2] folds cleanly, but the row says version 3. The last event was lost, not never
    // written. Repair would quietly undo it; refusing makes the loss visible.
    const id = orderId(++next);
    await place(id);
    await pay(id);
    await cancel(id);
    await db.insert(orders).values({ id, customerId: 'cus_1', total: 100, status: 'cancelled', version: 3 });
    await db.delete(tables.events).where(and(eq(tables.events.entityId, id), eq(tables.events.version, 3)));
    await expect(journal.replay(db, order, id)).rejects.toMatchObject({ code: 'HISTORY_GAP' });
    await expect(journal.repair(db, order, id)).rejects.toMatchObject({ code: 'HISTORY_GAP' });
    expect(await rowOf(id)).toMatchObject({ status: 'cancelled', version: 3 });
  });

  it('replay of an entity with no row and no events is an empty result, not an error', async () => {
    const result = await journal.replay(db, order, orderId(++next));
    expect(result).toEqual({ row: null, events: [] });
  });

  it('rerun replays one projection over the log in batches', async () => {
    const customerId = `cus_rerun_${next}`;
    await place(orderId(++next), customerId);
    await place(orderId(++next), customerId);
    await place(orderId(++next), customerId);
    await db.delete(customerOrderCounts).where(sql`true`);
    const total = await countRows(db.select().from(tables.events).where(eq(tables.events.type, 'OrderPlaced')));
    const result = await journal.rerun(db, customerStats, { batchSize: 2 });
    expect(result.events).toBe(total);
    const [count] = await db.select().from(customerOrderCounts).where(eq(customerOrderCounts.customerId, customerId));
    expect(count?.placed).toBe(3);
  });

  it('catalog lists entities, projections and effects', () => {
    expect(journal.catalog).toEqual({
      entities: [
        { kind: 'order', table: 'orders', events: ['OrderPlaced', 'OrderPaid', 'OrderNoted', 'OrderCancelled'] },
      ],
      projections: ['customer-stats', 'flaky', 'note-log'],
      effects: ['order-mail'],
    });
  });

  it('JournalError carries code, kind and entity id', () => {
    const error = new JournalError('NO_ROW', 'order', 'ord_1');
    expect(error).toMatchObject({ name: 'JournalError', code: 'NO_ROW', kind: 'order', entityId: 'ord_1' });
    expect(error.message).toContain('NO_ROW');
  });
});

/**
 * A transaction whose insert into the events table stores the rows in reverse,
 * so RETURNING hands them back in reverse. Savepoints it opens are wrapped too.
 */
const reversing = (tx: DbHandle): DbHandle =>
  new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return <T>(run: (sp: DbHandle) => Promise<T>) => target.transaction(sp => run(reversing(sp)));
      }
      if (prop === 'insert') {
        return (table: PgTable) => {
          if (table !== tables.events) return target.insert(table);
          const builder = target.insert(tables.events);
          return new Proxy(builder, {
            get(inner, name, innerReceiver) {
              if (name !== 'values') return Reflect.get(inner, name, innerReceiver);
              return (rows: PgInsertValue<typeof tables.events>[]) => inner.values(rows.toReversed());
            },
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

describe('rows returned by the events insert', () => {
  it('are folded, returned and projected in version order even when the insert returns them reversed', async () => {
    // Why: Postgres does not promise the order of RETURNING. OrderNoted keeps the last note,
    // so a fold in returned order would keep the first one and disagree with replay.
    const id = orderId(++next);
    await place(id);
    noted.length = 0;
    const result = await db.transaction(tx =>
      journal.write(reversing(tx), order, id, {
        meta,
        events: () => [OrderNoted({ note: 'a' }), OrderNoted({ note: 'b' }), OrderNoted({ note: 'c' })],
      }),
    );
    expect(result.row).toMatchObject({ note: 'c', version: 4 });
    expect(result.events.map(e => [e.version, e.data])).toEqual([
      [2, { note: 'a' }],
      [3, { note: 'b' }],
      [4, { note: 'c' }],
    ]);
    expect(noted).toEqual(['a', 'b', 'c']);
    expect(await journal.replay(db, order, id)).toMatchObject({ row: { note: 'c', version: 4 } });
    expect(await journal.verify(db, order, id)).toEqual({ ok: true });
  });

  it('sortedByVersion sorts a copy', () => {
    const returned = [{ version: 3 }, { version: 1 }, { version: 2 }];
    expect(sortedByVersion(returned).map(row => row.version)).toEqual([1, 2, 3]);
    expect(returned.map(row => row.version)).toEqual([3, 1, 2]);
  });
});

describe('duplicate handler names', () => {
  it('two effects with the same name are rejected, naming the duplicate', () => {
    const first = j.effect('mail', order, {
      OrderPaid: () => {
        /* handler body is irrelevant */
      },
    });
    const second = j.effect('mail', order, {
      OrderPlaced: () => {
        /* handler body is irrelevant */
      },
    });
    expect(() => j.compose({ tables, effects: [first, second] })).toThrow(/effect.*"mail"/);
  });

  it('two projections with the same name are rejected, naming the duplicate', () => {
    const first = j.projection('stats', order, {
      OrderPaid: () => {
        /* handler body is irrelevant */
      },
    });
    const second = j.projection('stats', order, {
      OrderPlaced: () => {
        /* handler body is irrelevant */
      },
    });
    expect(() => j.compose({ tables, projections: [first, second] })).toThrow(/projection.*"stats"/);
  });
});

describe('verify on JSON columns', () => {
  const docs = pgTable('docs', {
    id: varchar('id', { length: 256 }).primaryKey(),
    payload: jsonb('payload').notNull().$type<Record<string, never> | never[]>(),
    version: integer('version').notNull().default(0),
  });
  const Opened = j.event('DocOpened', z.object({}));
  const doc = j.entity('doc', docs).create(Opened, () => ({ payload: {} }));

  it('an object turned into an array by hand is reported as drift', async () => {
    await db.execute(
      sql`create table docs (id varchar(256) primary key, payload jsonb not null, version integer not null default 0)`,
    );
    const bare = j.compose({ tables });
    const id = `doc_${++next}`;
    await db.transaction(tx => bare.write(tx, doc, id, { meta, events: () => [Opened({})] }));
    expect(await bare.verify(db, doc, id)).toEqual({ ok: true });
    await db.update(docs).set({ payload: [] }).where(eq(docs.id, id));
    expect(await bare.verify(db, doc, id)).toMatchObject({ ok: false });
  });
});
