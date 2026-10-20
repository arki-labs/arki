import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import type { ArchiveSink, JobRetention } from './retention.js';
import { initJournal } from './journal.js';
import { j, meta, openDb, order, orderId, OrderPaid, OrderPlaced, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 1000;

const DAY = 86_400_000;
const op = { actor: 'retention-test' } as const;

// Two effects on the same event. `quiet` keeps no record of anything; `loud` has no override, so it follows the journal.
const quiet = j
  .effect('quiet', order, { OrderPaid: () => {} })
  .withSchedule({ retention: { completed: false, dead: false } });
const loud = j.effect('loud', order, { OrderPaid: () => {} });
// The retention is the app's, given once to `initJournal`.
const withRetention = (retention: JobRetention) =>
  initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }), retention });
const journal = withRetention({ archive: { completed: '7d', dead: '90d' } }).compose({ effects: [quiet, loud] });

const sink: ArchiveSink = { name: 'test-sink', write: () => Promise.resolve() };

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(tables.jobs);
  await db.delete(tables.jobArchive);
  await db.delete(tables.jobOperations);
});

/** One paid order: one job row per effect. */
const payOrder = async () => {
  const id = orderId(++next);
  orThrow(
    await db.transaction(tx =>
      journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
    ),
  );
  const paid = orThrow(
    await db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] })),
  );
  const rows = await db
    .select()
    .from(tables.jobs)
    .where(eq(tables.jobs.eventSeq, paid.events[0]?.seq ?? -1));
  const byEffect = Object.fromEntries(rows.map(row => [row.effect, row.id]));
  const quietId = byEffect.quiet;
  const loudId = byEffect.loud;
  if (quietId === undefined || loudId === undefined) throw new Error('expected one job per effect');
  return { quietId, loudId };
};

const kill = (id: string, ageDays: number) =>
  db
    .update(tables.jobs)
    .set({ deadAt: new Date(Date.now() - ageDays * DAY), attempts: 8, lastError: 'boom' })
    .where(eq(tables.jobs.id, id));

const archived = async () => (await journal.archivedJobs(db)).jobs.map(row => [row.effect, row.outcome]);

describe('per-effect retention wins over the journal', () => {
  it('at ack: the effect that keeps nothing leaves no archive row, the other follows the journal', async () => {
    await payOrder();
    expect(await journal.drain(db).then(result => orThrow(result))).toBe(2);
    expect(await archived()).toEqual([['loud', 'completed']]);
  });

  it('at discard', async () => {
    const { quietId, loudId } = await payOrder();
    await kill(quietId, 1);
    await kill(loudId, 1);
    orThrow(await journal.discard(db, quietId, op));
    orThrow(await journal.discard(db, loudId, op));
    expect(await archived()).toEqual([['loud', 'discarded']]);
  });

  it('at purge: one call groups the dead jobs by effect, archiving one and deleting the other', async () => {
    const { quietId, loudId } = await payOrder();
    await kill(quietId, 40);
    await kill(loudId, 40);
    const purged = orThrow(await journal.purgeDead(db, { olderThan: new Date(Date.now() - 35 * DAY) }, op));
    expect(purged).toMatchObject({ archived: 1, deleted: 1 });
    expect(await archived()).toEqual([['loud', 'dead']]);
    expect(await db.select().from(tables.jobs).where(eq(tables.jobs.id, quietId))).toEqual([]);
  });

  it('a longer per-effect retryableFor keeps its dead jobs out of a purge that the journal would allow', async () => {
    const patient = j
      .effect('patient', order, { OrderPaid: () => {} })
      .withSchedule({ retention: { retryableFor: '90d' } });
    const own = j.compose({ effects: [patient] });
    const id = orderId(++next);
    orThrow(
      await db.transaction(tx =>
        own.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      ),
    );
    const paid = orThrow(
      await db.transaction(tx => own.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] })),
    );
    const [row] = await db
      .select()
      .from(tables.jobs)
      .where(eq(tables.jobs.eventSeq, paid.events[0]?.seq ?? -1));
    await kill(row?.id ?? '', 40);
    const purged = orThrow(await own.purgeDead(db, { olderThan: new Date(Date.now() - 35 * DAY) }, op));
    expect(purged).toMatchObject({ archived: 0, deleted: 0, operationId: null });
  });
});

describe('the boot check', () => {
  it("'untilExported' on an effect without a sink is BAD_DEFINITION, naming the effect", () => {
    const exported = j
      .effect('ledger-mail', order, { OrderPaid: () => {} })
      .withSchedule({ retention: { completed: 'untilExported' } });
    expect(() => j.compose({ effects: [exported] })).toThrow(
      expect.objectContaining({ code: 'BAD_DEFINITION', message: expect.stringContaining('ledger-mail') }),
    );
    expect(() => withRetention({ archive: { sink } }).compose({ effects: [exported] })).not.toThrow();
  });

  it("'untilExported' in the journal policy without a sink is BAD_DEFINITION", () => {
    expect(() => withRetention({ archive: { dead: 'untilExported' } }).compose({})).toThrow(
      expect.objectContaining({ code: 'BAD_DEFINITION' }),
    );
  });

  it('a bad age on an effect fails at init, not at the first ack', () => {
    const typo = j
      .effect('typo', order, { OrderPaid: () => {} })
      // @ts-expect-error '30x' is not an age; the check also runs for callers the type cannot stop
      .withSchedule({ retention: { completed: '30x' } });
    expect(() => j.compose({ effects: [typo] })).toThrow(expect.objectContaining({ code: 'BAD_DEFINITION' }));
  });

  it('journal.retention is the resolved policy', () => {
    expect(journal.retention.completed).toMatchObject({ store: true, ageMs: 7 * DAY });
    expect(journal.retention.retryableForMs).toBe(30 * DAY);
  });
});
