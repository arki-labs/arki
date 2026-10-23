/**
 * `postgresEvents`: entities whose events live in another Postgres database, and `copyLog`, which
 * moves an entity kind's history between logs for a store switch. Both databases are PGlite here;
 * the read order under concurrent transactions needs two connections, so it is in
 * `postgres.pg.test.ts`.
 */
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';
import { ensure } from '@arki/schema';

import { ContractSkip, eventLogContract } from './event-log-contract.js';
import { initJournal } from './journal.js';
import { eventLogTables } from './pg.js';
import { postgresEvents } from './postgres.js';
import { OrderNoted, OrderPaid, OrderPlaced, orders, tables } from './test-support.js';
import { openJournalDb } from './testing.js';
import { eventLogPositionSchema } from './zod.js';

let db: PgliteDatabase;
let client: PGlite;
// The store database exists before the entities are defined, as an app's would at import time.
const storeClient = new PGlite('memory://');
const storeDb = drizzle({ client: storeClient });
const storeTables = eventLogTables();
const storeLog = postgresEvents({ db: storeDb, tables: storeTables });
let next = 0;
const meta = { actorId: 'user:1' };

const metaSchema = z.object({ actorId: z.string().min(1) });
const define = (events: 'stored' | typeof storeLog) => {
  const jx = initJournal({ tables, meta: metaSchema, events });
  const order = jx
    .entity('pg-order', orders)
    .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))
    .on(OrderPaid, () => ({ status: 'paid' }))
    .on(OrderNoted, (_row, e) => ({ note: e.data.note }));
  const placed: string[] = [];
  const placedProjection = jx.projection(
    'placed-pg',
    order,
    {
      OrderPlaced: (_tx, e) => {
        placed.push(e.entityId);
      },
    },
    { lane: 'async' },
  );
  return { order, placed, journal: jx.compose({ projections: [placedProjection] }) };
};
/** The app before and after a switch: the same entity, first on the built-in log, then on the store. */
const local = define('stored');
const remote = define(storeLog);

const newId = () => `ord_pg_${++next}` as const;
const write = (
  app: typeof local,
  id: ReturnType<typeof newId>,
  events: () => ReturnType<typeof OrderPlaced | typeof OrderPaid | typeof OrderNoted>[],
) => db.transaction(tx => app.journal.write(tx, app.order, id, { meta, events }));
const place = (app: typeof local, id: ReturnType<typeof newId>) =>
  write(app, id, () => [OrderPlaced({ customerId: 'c', total: 1 })]);
const builtInEvents = (id: string) =>
  db.select().from(tables.events).where(eq(tables.events.entityId, id)).orderBy(tables.events.version);
const storeEvents = (id: string) => storeLog.stream('pg-order', id);

beforeAll(async () => {
  ({ db, client } = await openJournalDb({ ...tables, orders }));
  await storeClient.waitReady;
  const { apply } = await pushSchema(storeTables, storeDb);
  await apply();
});
afterAll(async () => {
  await client.close();
  await storeClient.close();
});

describe('an entity on postgresEvents', () => {
  it('lands its events in the store database, and an async projection follows the store', async () => {
    // Why: this is the adapter end to end. The write commits only the row and a forward job; the
    // worker appends to the other database; catchUp then reads the store's own order, so the
    // projection sees each create once and its cursor holds a store position.
    const first = newId();
    const second = newId();
    const written = orThrow(await place(remote, first));
    orThrow(await place(remote, second));
    expect(await storeEvents(first)).toEqual([]);

    orThrow(await remote.journal.drain(db));
    const landed = await storeEvents(first);
    expect(landed.map(e => [e.id, e.version, e.seq])).toEqual(written.events.map(e => [e.id, e.version, e.seq]));
    expect(landed[0]).not.toHaveProperty('transactionId');
    expect(await builtInEvents(first)).toEqual([]);

    await remote.journal.catchUp(db);
    expect(remote.placed).toEqual(expect.arrayContaining([first, second]));
    const [cursor] = await remote.journal.cursors(db);
    expect(cursor).toMatchObject({ name: 'placed-pg', behind: false, position: expect.stringMatching(/^\d+:\d+$/) });
    expect(cursor).not.toHaveProperty('distance', expect.anything());

    const third = newId();
    orThrow(await place(remote, third));
    orThrow(await remote.journal.drain(db));
    const [behind] = await remote.journal.cursors(db);
    expect(behind).toMatchObject({ behind: true });
    await remote.journal.catchUp(db);
    expect(remote.placed.filter(id => id === third)).toEqual([third]);
  });

  it('refuses a position another log made', async () => {
    // Why: after a store switch, a projection's cursor still holds the old log's position. Read
    // here as if it were this log's, it would start at a random point; it must fail instead.
    const all = storeLog.all;
    expect(all).toBeDefined();
    await expect(all?.after(ensure('42', eventLogPositionSchema), { limit: 10 })).rejects.toThrow(/transaction id:seq/);
  });
});

describe('copyLog', () => {
  it('moves a kind from the built-in log to the store, so writes after the switch continue the history', async () => {
    // Why: without the copy, the first forward job after the switch expects version N while the
    // store is at 0, and the ladder parks it forever. With it, the store holds the same events,
    // erased ones still erased, and the next write appends N+1 there.
    const id = newId();
    orThrow(await place(local, id));
    orThrow(await write(local, id, () => [OrderNoted({ note: 'secret' })]));
    orThrow(await local.journal.forget(db, local.order, id));
    const before = await builtInEvents(id);

    const copied = await local.journal.copyLog(db, local.order, { to: storeLog });
    expect(copied.events).toBeGreaterThanOrEqual(2);
    const after = await storeEvents(id);
    expect(after.map(e => [e.id, e.version, e.seq, e.data])).toEqual(before.map(e => [e.id, e.version, e.seq, e.data]));
    expect(after[1]?.erasedAt).toBeInstanceOf(Date);

    // A copy cut short runs again: the repeats are no-ops.
    await expect(local.journal.copyLog(db, local.order, { to: storeLog })).resolves.toMatchObject({
      events: copied.events,
    });

    // The flip: the same entity now on the store.
    const paid = orThrow(await write(remote, id, () => [OrderPaid({ amount: 1 })]));
    expect(paid.events.map(e => e.version)).toEqual([3]);
    orThrow(await remote.journal.drain(db));
    const switched = await storeEvents(id);
    expect(switched.map(e => e.version)).toEqual([1, 2, 3]);
    expect(orThrow(await remote.journal.verify(db, remote.order, id))).toMatchObject({ ok: true });
  });

  it('moves a kind from the store back to the built-in log', async () => {
    // Why: the switch back has the mirror failure: the row is at N and the built-in log empty, so
    // the next write would insert N+1 over a gap and replay would be wrong.
    const id = newId();
    orThrow(await place(remote, id));
    orThrow(await write(remote, id, () => [OrderPaid({ amount: 2 })]));
    orThrow(await remote.journal.drain(db));

    await remote.journal.copyLog(db, remote.order, { to: 'stored' });
    const back = await builtInEvents(id);
    expect(back.map(e => e.version)).toEqual([1, 2]);
    expect(orThrow(await local.journal.verify(db, local.order, id))).toMatchObject({ ok: true });
  });

  it('is refused while forward jobs of the kind wait, and onto the log the kind already uses', async () => {
    // Why: a waiting job holds events the store does not have yet, so a copy taken now would miss
    // them. Copying a log onto itself is always an operator mistake.
    const id = newId();
    orThrow(await place(remote, id));
    await expect(remote.journal.copyLog(db, remote.order, { to: 'stored' })).rejects.toMatchObject({
      code: 'FORWARD_PENDING',
    });
    orThrow(await remote.journal.drain(db));
    await expect(remote.journal.copyLog(db, remote.order, { to: storeLog })).rejects.toMatchObject({
      code: 'BAD_DEFINITION',
    });
    await expect(local.journal.copyLog(db, local.order, { to: 'stored' })).rejects.toMatchObject({
      code: 'BAD_DEFINITION',
    });
  });
});

describe('postgresEvents meets the event log contract', () => {
  for (const contractCase of eventLogContract(async () => {
    await storeDb.execute(sql`truncate ${storeTables.events}`);
    return { log: storeLog };
  })) {
    it(contractCase.name, async context => {
      try {
        await contractCase.run();
      } catch (error) {
        if (error instanceof ContractSkip) context.skip(error.message);
        throw error;
      }
    });
  }
});
