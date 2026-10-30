/**
 * `ctx.attempt` and the lease fence of a workflow step's `ctx.run`, on PGlite (one connection).
 * The race between two real workers is in `fence.pg.test.ts`; here the attempt row is closed by hand,
 * which is exactly what a claim by another worker does to it.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findCause, orThrow } from '@arki/failure';

import { isJournalError, JournalError } from './errors.js';
import { backoff } from './index.js';
import { j, meta, openDb, order, OrderNoted, OrderPaid, OrderPlaced, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 1000;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

const noteOrder = j.command(
  'noteOrder',
  z.object({ orderId: z.templateLiteral(['ord_', z.string()]), note: z.string().min(1) }),
  { writes: [OrderNoted] },
  (input, { write }) => write(order, input.orderId, () => [OrderNoted({ note: input.note })]),
);

/** Places and pays an order, which queues one job for the handlers of the journal under test. */
async function payOrder(journal: { write: typeof countingJournal.write }) {
  const id: `ord_${number}` = `ord_${++next}`;
  orThrow(
    await db.transaction(tx =>
      journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
    ),
  );
  orThrow(await db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] })));
  return id;
}

const attemptsSeen: number[] = [];
const counting = j
  .effect('count-attempts', order, {
    OrderPaid: (_event, ctx) => {
      attemptsSeen.push(ctx.attempt);
      if (ctx.attempt < 3) throw new Error('not yet');
    },
  })
  .withSchedule({
    retry: backoff.constant(0).upTo(2),
  });
const countingJournal = j.compose({ effects: [counting] });

const outcomes: string[] = [];
/** Set by a test: a claim by another worker closes this attempt before the step runs its command. */
let takenOver = false;
const noteWriter = j.task(
  'note-writer',
  {
    version: 1,
    input: z.object({ orderId: z.templateLiteral(['ord_', z.string()]) }),
    startOn: {
      entity: order,
      event: OrderPaid,
      timing: 'after-commit',
      id: e => `note:${e.entityId}`,
      input: e => ({ orderId: e.entityId }),
    },
  },
  async ({ input, run }) => {
    // Nothing else about the job changes for this body.
    if (takenOver) {
      await db
        .update(tables.jobAttempts)
        .set({ finishedAt: new Date(), outcome: 'superseded' })
        .where(isNull(tables.jobAttempts.finishedAt));
    }
    try {
      orThrow(await run(noteOrder, { orderId: input.orderId, note: 'from the step' }, meta));
      outcomes.push('committed');
    } catch (error) {
      outcomes.push(isJournalError(findCause(error, JournalError), 'LEASE_LOST') ? 'LEASE_LOST' : 'other');
      throw error;
    }
  },
);
const fencedJournal = j.compose({ workflows: [noteWriter], workflowMeta: meta });

const noteOf = async (id: string) => {
  const rows = await db
    .select({ type: tables.events.type })
    .from(tables.events)
    .where(and(eq(tables.events.entityId, id), eq(tables.events.type, 'OrderNoted')));
  return rows;
};

describe('ctx.attempt', () => {
  it('counts 1, 2, 3 across retries so a handler can tell a first try from a re-run of the same job', async () => {
    await payOrder(countingJournal);
    for (let tryNo = 0; tryNo < 3; tryNo++) {
      await db
        .update(tables.jobs)
        .set({ availableAt: new Date(0) })
        .where(sql`true`);
      await countingJournal.drain(db).then(result => orThrow(result));
    }
    expect(attemptsSeen).toEqual([1, 2, 3]);
  });
});

describe('the lease fence of ctx.run', () => {
  it('a command from a handler whose attempt is still open commits, so the fence costs a healthy job nothing', async () => {
    const id = await payOrder(fencedJournal);
    // The start job, then the step job.
    expect(await fencedJournal.drain(db).then(result => orThrow(result))).toBe(2);
    expect(outcomes).toEqual(['committed']);
    expect(await noteOf(id)).toHaveLength(1);
  });

  it('a handler whose attempt was taken over gets LEASE_LOST and its command commits nothing', async () => {
    outcomes.length = 0;
    takenOver = true;
    const id = await payOrder(fencedJournal);
    expect(await fencedJournal.drain(db).then(result => orThrow(result))).toBe(2);
    expect(outcomes).toEqual(['LEASE_LOST']);
    expect(await noteOf(id)).toHaveLength(0);
  });
});
