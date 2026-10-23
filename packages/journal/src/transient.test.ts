/**
 * The `events: 'transient'` setting on PGlite: an entity that keeps no event rows still gets a row,
 * a version check, inline projections and effects; everything that reads the log back is refused.
 * The create race on two connections is in `transient.pg.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import type { OrderId } from './test-support.js';
import { defineEntity } from './entity.js';
import { initJournal } from './journal.js';
import {
  customerOrderCounts,
  j,
  meta,
  openDb,
  order,
  OrderCancelled,
  orderId,
  OrderPaid,
  OrderPlaced,
  orders,
  tables,
} from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 1000;
const workflowMeta = { actorId: 'system:workflow' };

/** A journal whose default is transient: its entities keep no events unless they say so. */
const jt = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }), events: 'transient' });

/** Transient by the journal default. */
const draft = jt
  .entity('draft', orders)
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))
  .on(OrderPaid, () => ({ status: 'paid' }))
  .on(OrderCancelled, () => null);
/** Stored by its own override, under a transient default. */
const keptDraft = jt
  .entity('kept-draft', orders, { events: 'stored' })
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }));
/** Transient by its own override, under the stored default of `j`. */
const quickOrder = j
  .entity('quick-order', orders, { events: 'transient' })
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }));
/** The whole row, so one create event can rebuild any draft the transient entity left behind. */
const DraftImported = j.event(
  'DraftImported',
  z.object({ customerId: z.string().min(1), total: z.int().positive(), status: z.enum(['placed', 'paid']) }),
);
/** `draft` after the switch: same kind, same table, events stored, plus a create that rebuilds a row as it is. */
const draftStored = j
  .entity('draft', orders, { events: 'stored' })
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))
  .create(DraftImported, e => ({ customerId: e.data.customerId, total: e.data.total, status: e.data.status }))
  .on(OrderPaid, () => ({ status: 'paid' }))
  .on(OrderCancelled, () => null);

/** What the inline projection and the effect saw, so a test can check the seq they got. */
const projected: { readonly id: string; readonly seq: number; readonly type: string }[] = [];
const effected: { readonly id: string; readonly seq: number; readonly jobId: string }[] = [];

const draftStats = jt.projection('draft-stats', draft, {
  OrderPlaced: async (tx, e) => {
    projected.push({ id: e.entityId, seq: e.seq, type: e.type });
    await tx
      .insert(customerOrderCounts)
      .values({ customerId: e.data.customerId, placed: 1 })
      .onConflictDoUpdate({
        target: customerOrderCounts.customerId,
        set: { placed: sql`${customerOrderCounts.placed} + 1` },
      });
  },
  OrderPaid: (_tx, e) => {
    projected.push({ id: e.entityId, seq: e.seq, type: e.type });
  },
});
const draftMail = jt.effect('draft-mail', draft, {
  OrderPaid: (e, ctx) => {
    effected.push({ id: e.entityId, seq: e.seq, jobId: ctx.jobId });
  },
});
const simple = jt
  .workflow('test.transient-default', { version: 1, input: z.object({}) })
  .step('a', () => 'a')
  .finish();

const journal = jt.compose({ projections: [draftStats], effects: [draftMail], workflows: [simple], workflowMeta });
const stored = j.compose({});

const eventRowsOf = (kind: string, id: string) =>
  db
    .select()
    .from(tables.events)
    .where(sql`${tables.events.kind} = ${kind} and ${tables.events.entityId} = ${id}`)
    .orderBy(asc(tables.events.seq));
const rowOf = async (id: OrderId) => {
  const rows = await db.select().from(orders).where(eq(orders.id, id));
  return rows[0] ?? null;
};
const place = () => [OrderPlaced({ customerId: 'c', total: 1 })];

beforeAll(async () => {
  ({ db, client } = await openDb());
});
afterAll(async () => {
  await client.close();
});

describe('a transient entity', () => {
  it('writes the row and no event row, and the caller still gets recorded events with a seq and a stamp', async () => {
    // Why: the setting drops the log, not the row or the write's result. Code that reads `events`
    // off a write (seq for a cursor, recordedAt for a timestamp) must work in both modes.
    const id = orderId(++next);
    const placed = orThrow(
      await db.transaction(tx =>
        journal.write(tx, draft, id, { meta, events: () => [OrderPlaced({ customerId: 'c1', total: 5 })] }),
      ),
    );
    expect(placed.row).toMatchObject({ id, customerId: 'c1', total: 5, status: 'placed', version: 1 });
    expect(placed.events).toHaveLength(1);
    const event = placed.events[0];
    expect(event?.seq).toBeGreaterThan(0);
    expect(event?.recordedAt).toBeInstanceOf(Date);
    expect(event?.version).toBe(1);
    expect(event?.id).toMatch(/^evt_/);
    expect(await eventRowsOf('draft', id)).toHaveLength(0);
  });

  it('takes seq from the same sequence as stored events, so seq stays the global write order', async () => {
    // Why: `seq` is "global write order". A transient event and a stored event written one after the
    // other must be ordered by seq, or a cursor over one could not be compared with the other.
    const a = orderId(++next);
    const b = orderId(++next);
    const transient = orThrow(
      await db.transaction(tx =>
        journal.write(tx, draft, a, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      ),
    );
    const kept = orThrow(
      await db.transaction(tx =>
        journal.write(tx, keptDraft, b, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      ),
    );
    const later = orThrow(
      await db.transaction(tx => journal.write(tx, draft, a, { meta, events: () => [OrderPaid({ amount: 1 })] })),
    );
    const seqs = [transient.events[0]?.seq, kept.events[0]?.seq, later.events[0]?.seq];
    expect(seqs).toEqual(seqs.toSorted((x, y) => (x ?? 0) - (y ?? 0)));
    expect(new Set(seqs).size).toBe(3);
  });

  it('runs inline projections with the event, seq included', async () => {
    // Why: a projection keeps a read model in the same transaction. It gets the in-memory event,
    // and the event looks exactly like a stored one, so the projection code is the same in both modes.
    const id = orderId(++next);
    projected.length = 0;
    const placed = orThrow(
      await db.transaction(tx =>
        journal.write(tx, draft, id, { meta, events: () => [OrderPlaced({ customerId: 'proj-c', total: 2 })] }),
      ),
    );
    expect(projected).toEqual([{ id, seq: placed.events[0]?.seq, type: 'OrderPlaced' }]);
    const [count] = await db.select().from(customerOrderCounts).where(eq(customerOrderCounts.customerId, 'proj-c'));
    expect(count?.placed).toBe(1);
  });

  it('queues the effect job with a null event_seq and the event copy in args, and the worker runs it', async () => {
    // Why: the job cannot point at an event row that does not exist. It carries its own copy, so the
    // effect runs from `args` exactly as it does for a stored event (slice 1).
    const id = orderId(++next);
    effected.length = 0;
    orThrow(
      await db.transaction(tx =>
        journal.write(tx, draft, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      ),
    );
    const paid = orThrow(
      await db.transaction(tx => journal.write(tx, draft, id, { meta, events: () => [OrderPaid({ amount: 1 })] })),
    );
    const event = paid.events[0];
    if (event === undefined) throw new Error('no event');
    const [job] = await db
      .select()
      .from(tables.jobs)
      .where(sql`${tables.jobs.args}->>'id' = ${event.id}`);
    expect(job).toMatchObject({ kind: 'effect', effect: 'draft-mail', eventSeq: null });
    expect(job?.args).toMatchObject({ seq: event.seq, id: event.id, kind: 'draft', entityId: id, version: 2 });
    expect(orThrow(await journal.drain(db))).toBeGreaterThan(0);
    // Jobs from earlier tests drain too; only this id's job matters here.
    expect(effected.filter(ran => ran.id === id)).toEqual([{ id, seq: event.seq, jobId: job?.id }]);
  });

  it('still refuses a stale expectedVersion with CONFLICT', async () => {
    // Why: the version check lives on the row, not in the log. Optimistic concurrency keeps working
    // for an entity that keeps no events.
    const id = orderId(++next);
    orThrow(
      await db.transaction(tx =>
        journal.write(tx, draft, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      ),
    );
    await expect(
      db.transaction(tx =>
        journal.write(tx, draft, id, { meta, events: () => [OrderPaid({ amount: 1 })], expectedVersion: 0 }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const fine = orThrow(
      await db.transaction(tx =>
        journal.write(tx, draft, id, { meta, events: () => [OrderPaid({ amount: 1 })], expectedVersion: 1 }),
      ),
    );
    expect(fine.row?.version).toBe(2);
  });

  it('restarts the version at 1 after a delete and a new create, where a stored entity continues', async () => {
    // Why: with no log, nothing remembers the deleted row. `version` counts one row's lifetime, not
    // the id's. Documented behaviour; this test pins it next to the stored entity's.
    const id = orderId(++next);
    orThrow(await db.transaction(tx => journal.write(tx, draft, id, { meta, events: place })));
    orThrow(
      await db.transaction(tx => journal.write(tx, draft, id, { meta, events: () => [OrderPaid({ amount: 1 })] })),
    );
    orThrow(
      await db.transaction(tx =>
        journal.write(tx, draft, id, { meta, events: () => [OrderCancelled({ reason: 'test' })] }),
      ),
    );
    expect(await rowOf(id)).toBeNull();
    const again = orThrow(await db.transaction(tx => journal.write(tx, draft, id, { meta, events: place })));
    expect(again.row?.version).toBe(1);
    expect(again.events[0]?.version).toBe(1);

    const keptId = orderId(++next);
    orThrow(await db.transaction(tx => stored.write(tx, order, keptId, { meta, events: place })));
    orThrow(
      await db.transaction(tx =>
        stored.write(tx, order, keptId, { meta, events: () => [OrderCancelled({ reason: 'test' })] }),
      ),
    );
    const continued = orThrow(await db.transaction(tx => stored.write(tx, order, keptId, { meta, events: place })));
    expect(continued.row?.version).toBe(3);
  });
});

describe('the setting', () => {
  it('is the journal default, and each entity may override it either way', async () => {
    // Why: D-3. One journal can mix both kinds; an app chooses per entity where the log matters.
    expect(draft.eventStorage).toBe('transient');
    expect(keptDraft.eventStorage).toBe('stored');
    expect(order.eventStorage).toBe('stored');
    expect(quickOrder.eventStorage).toBe('transient');
    const keptId = orderId(++next);
    orThrow(
      await db.transaction(tx =>
        journal.write(tx, keptDraft, keptId, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      ),
    );
    expect(await eventRowsOf('kept-draft', keptId)).toHaveLength(1);
    const quickId = orderId(++next);
    orThrow(
      await db.transaction(tx =>
        stored.write(tx, quickOrder, quickId, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      ),
    );
    expect(await eventRowsOf('quick-order', quickId)).toHaveLength(0);
    const quickRow = await rowOf(quickId);
    expect(quickRow?.version).toBe(1);
  });

  it('defaults to stored for a standalone defineEntity, which cannot see a journal default', () => {
    // Why: D-2. Nothing changes for code that never passes the setting.
    expect(defineEntity('standalone', orders, 'id').eventStorage).toBe('stored');
    expect(defineEntity('standalone-transient', orders, 'id', 'transient').eventStorage).toBe('transient');
  });

  it('keeps workflow runs stored under a transient default, so a run can resume from its events', async () => {
    // Why: the workflow runner replays `workflow.run` events to resume. A journal default of
    // 'transient' must not silently break every workflow.
    const id = `run_${++next}`;
    expect(isFailure(await journal.run(db, simple.start, { input: {}, id }, meta))).toBe(false);
    for (let pass = 0; pass < 20; pass++) {
      if (orThrow(await journal.drain(db)) === 0) break;
    }
    const [run] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
    expect(run?.state).toBe('completed');
    const runEvents = await eventRowsOf('workflow.run', id);
    expect(runEvents.length).toBeGreaterThan(1);
  });
});

describe('refusals', () => {
  it('compose refuses an async projection and a tap on a transient entity with BAD_DEFINITION', () => {
    // Why: both read `journal_events` after the commit. On a transient entity they would see
    // nothing, silently. A setup error is better than a read model that never fills.
    const lagging = jt.projection(
      'lagging',
      draft,
      {
        OrderPlaced: () => {
          /* only the refusal matters */
        },
      },
      { lane: 'async' },
    );
    expect(() => jt.compose({ projections: [lagging] })).toThrow(
      expect.objectContaining({ code: 'BAD_DEFINITION', message: expect.stringContaining('transient') }),
    );
    const watching = jt.tap('watching', draft, {
      OrderPlaced: () => {
        /* only the refusal matters */
      },
    });
    expect(() => jt.compose({ taps: [watching] })).toThrow(
      expect.objectContaining({ code: 'BAD_DEFINITION', message: expect.stringContaining('transient') }),
    );
    // The inline lane and a stored entity are fine.
    expect(() => jt.compose({ projections: [draftStats] })).not.toThrow();
    const laggingKept = jt.projection(
      'lagging-kept',
      keptDraft,
      {
        OrderPlaced: () => {
          /* only the refusal matters */
        },
      },
      { lane: 'async' },
    );
    expect(() => jt.compose({ projections: [laggingKept] })).not.toThrow();
  });

  it('replay, verify, repair, forget, rerun and adopt refuse a transient entity with NO_HISTORY', async () => {
    // Why: every one of them reads the log back. Refusing up front, with a message that names the
    // setting, beats a silent "no history" that looks like data loss.
    const id = orderId(++next);
    orThrow(await db.transaction(tx => journal.write(tx, draft, id, { meta, events: place })));
    const noHistory = expect.objectContaining({ code: 'NO_HISTORY', message: expect.stringContaining('transient') });
    await expect(journal.replay(db, draft, id)).rejects.toEqual(noHistory);
    await expect(journal.verify(db, draft, id)).rejects.toEqual(noHistory);
    await expect(journal.repair(db, draft, id)).rejects.toEqual(noHistory);
    await expect(journal.forget(db, draft, id)).rejects.toEqual(noHistory);
    await expect(journal.rerun(db, draftStats)).rejects.toEqual(noHistory);
    await expect(
      db.transaction(tx => journal.adopt(tx, draft, orderId(++next), { meta, events: place })),
    ).rejects.toEqual(noHistory);
    // The row is untouched by the refusals.
    const row = await rowOf(id);
    expect(row?.version).toBe(1);
  });
});

const pay = () => [OrderPaid({ amount: 1 })];
/** One create event built from the stored row; `total` overrides it to make a create that does not rebuild the row. */
const importRow = (total?: number) => (row: { customerId: string; total: number; status: string } | null) => [
  DraftImported({
    customerId: row?.customerId ?? '',
    total: total ?? row?.total ?? 0,
    status: row?.status === 'paid' ? 'paid' : 'placed',
  }),
];
const draftVersions = async (id: OrderId) => {
  const rows = await eventRowsOf('draft', id);
  return rows.map(e => e.version);
};
/** Three transient writes: the row is at version 3 and the log has nothing for it. */
const writeThreeTransient = async () => {
  const id = orderId(++next);
  orThrow(await db.transaction(tx => journal.write(tx, draft, id, { meta, events: place })));
  orThrow(await db.transaction(tx => journal.write(tx, draft, id, { meta, events: pay })));
  orThrow(await db.transaction(tx => journal.write(tx, draft, id, { meta, events: pay })));
  expect(await rowOf(id)).toMatchObject({ status: 'paid', version: 3 });
  expect(await draftVersions(id)).toEqual([]);
  return id;
};

describe('switching an entity from transient to stored', () => {
  it('adopt takes a row at any version with no history: its create becomes version 1 and the log is complete', async () => {
    // Why: the switch is "change the setting, adopt each row before its first write". A row the
    // transient entity left at version 3 has no history to continue from, so adopt must accept it as
    // it accepts a legacy row at version 0. The version drops to 1 because the history starts there.
    const id = await writeThreeTransient();
    const adopted = orThrow(
      await db.transaction(tx => stored.adopt(tx, draftStored, id, { meta, events: importRow() })),
    );
    expect(adopted.row).toMatchObject({ id, customerId: 'c', total: 1, status: 'paid', version: 1 });
    expect(adopted.events.map(e => [e.type, e.version])).toEqual([['DraftImported', 1]]);
    expect(await draftVersions(id)).toEqual([1]);
    expect(orThrow(await stored.replay(db, draftStored, id)).row).toMatchObject({ status: 'paid', version: 1 });
    expect(await stored.verify(db, draftStored, id)).toEqual({ ok: true });
    // Writes continue from the complete history.
    const paid = orThrow(await db.transaction(tx => stored.write(tx, draftStored, id, { meta, events: pay })));
    expect(paid.row?.version).toBe(2);
    expect(await draftVersions(id)).toEqual([1, 2]);
  });

  it('adopt refuses a row that was written to after the switch, and changes nothing', async () => {
    // Why: that write recorded version 4 on top of nothing. The log can never be completed from
    // here, and a create at version 1 would leave a gap replay cannot fold over.
    const id = await writeThreeTransient();
    orThrow(await db.transaction(tx => stored.write(tx, draftStored, id, { meta, events: pay })));
    expect(await draftVersions(id)).toEqual([4]);
    const refused = db.transaction(tx => stored.adopt(tx, draftStored, id, { meta, events: importRow() }));
    await expect(refused).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(refused).rejects.toThrow('written to after its events started being stored');
    expect(await rowOf(id)).toMatchObject({ version: 4 });
    expect(await draftVersions(id)).toEqual([4]);
  });

  it('adopt refuses a create that does not rebuild the row, and the row stays at its version', async () => {
    // Why: the same rule as for a legacy row. A history that starts with a different row than the
    // one stored would make verify report drift at once and repair overwrite real data.
    const id = await writeThreeTransient();
    const wrong = db.transaction(tx => stored.adopt(tx, draftStored, id, { meta, events: importRow(999) }));
    await expect(wrong).rejects.toMatchObject({ code: 'VALUE_MISMATCH' });
    await expect(wrong).rejects.toThrow('column "total"');
    expect(await rowOf(id)).toMatchObject({ total: 1, version: 3 });
    expect(await draftVersions(id)).toEqual([]);
  });
});
