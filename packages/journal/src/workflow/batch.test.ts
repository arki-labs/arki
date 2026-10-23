/**
 * `def.startBatch` and `journal.workflows.batch` on PGlite. A batch starts many runs in one call, so an app can fan out
 * a thousand imports without a thousand round trips. Each item must keep its own outcome: one busy or taken item must
 * not cost the others their runs, and a malformed item is a caller bug that refuses the whole batch before anything
 * is written.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InvalidInput, orThrow } from '@arki/failure';

import { CommandConflict, WorkflowBusy } from '../errors.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';
import { BATCH_LIMIT } from './run-fields.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

/** One import per account at a time: the second item for a busy account is refused. */
const importTask = j.task(
  'test.import',
  {
    version: 1,
    input: z.object({ account: z.string(), n: z.int() }),
    concurrency: { key: ({ account }) => account, limit: 1, onBusy: 'refuse' },
  },
  ({ input }) => input.n,
);

const journal = j.compose({ workflows: [importTask], workflowMeta });

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

/** Runs every due job until none is left, as a worker would. */
async function settle(limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the runs did not settle');
}

const runsOfBatch = (batchId: string) =>
  db
    .select({ id: tables.workflowRuns.id, input: tables.workflowRuns.input, tags: tables.workflowRuns.tags })
    .from(tables.workflowRuns)
    .where(eq(tables.workflowRuns.batchId, batchId));

describe('def.startBatch', () => {
  it('starts every item it can and gives each refused item its own outcome, without rolling back the others', async () => {
    const account = newId('acc');
    const taken = newId('imp');
    // Another run already holds this id with another input, so the item that names it is a conflict.
    orThrow(await journal.run(db, importTask.start, { input: { account: newId('other'), n: 0 }, id: taken }, caller));
    const result = orThrow(
      await journal.run(
        db,
        importTask.startBatch,
        {
          items: [
            { input: { account, n: 1 }, tags: ['first'] },
            { input: { account, n: 2 } },
            { input: { account: newId('acc'), n: 3 }, id: taken },
            { input: { account: newId('acc'), n: 4 } },
          ],
        },
        caller,
      ),
    );
    expect(result.batchId).toMatch(/^wfb_/);
    const [first, busy, conflict, last] = result.runs;
    expect(first).toEqual({ runId: expect.any(String) });
    expect(WorkflowBusy.is(busy), 'the second item for the same account finds it busy').toBe(true);
    expect(CommandConflict.is(conflict), 'the id is taken by another run').toBe(true);
    expect(last).toEqual({ runId: expect.any(String) });
    // Why: the items before and after the refusals committed, so the refused items rolled back only themselves.
    const rows = await runsOfBatch(result.batchId);
    expect(rows.map(row => row.input).toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { account, n: 1 },
      expect.objectContaining({ n: 4 }),
    ]);
    expect(rows.find(row => row.tags.includes('first'))).toBeDefined();
    // The run that held the id is still the other start's, outside the batch.
    const [holder] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, taken));
    expect(holder?.batchId).toBeNull();
  });

  it('keeps a given batch id, and a plain start has none', async () => {
    const batchId = newId('batch');
    const result = orThrow(
      await journal.run(
        db,
        importTask.startBatch,
        { items: [{ input: { account: newId('acc'), n: 1 } }], batchId },
        caller,
      ),
    );
    expect(result.batchId).toBe(batchId);
    expect(await runsOfBatch(batchId)).toHaveLength(1);
  });

  it('refuses the whole batch with InvalidInput when one item does not fit the start schema, and writes nothing', async () => {
    const batchId = newId('batch');
    const refused = await journal.run(
      db,
      importTask.startBatch,
      {
        items: [
          { input: { account: newId('acc'), n: 1 } },
          // @ts-expect-error -- `n` must be a whole number: this item is the caller's bug
          { input: { account: newId('acc'), n: 'two' } },
        ],
        batchId,
      },
      caller,
    );
    expect(InvalidInput.is(refused)).toBe(true);
    expect(InvalidInput.is(refused) ? refused.data.issues[0]?.path : undefined).toEqual(['items', 1, 'input', 'n']);
    // Why: the good item did not start either. Half a batch from a malformed call would be hard to repair.
    expect(await runsOfBatch(batchId)).toEqual([]);
  });

  it(`refuses more than ${BATCH_LIMIT} items, and an empty batch`, async () => {
    const item = { input: { account: 'acc_limit', n: 1 } };
    const over = await journal.run(
      db,
      importTask.startBatch,
      { items: Array.from({ length: BATCH_LIMIT + 1 }, () => item) },
      caller,
    );
    expect(InvalidInput.is(over)).toBe(true);
    expect(InvalidInput.is(await journal.run(db, importTask.startBatch, { items: [] }, caller))).toBe(true);
    const [row] = await db
      .select({ id: tables.workflowRuns.id })
      .from(tables.workflowRuns)
      .where(eq(tables.workflowRuns.concurrencyKey, 'acc_limit'));
    expect(row).toBeUndefined();
  });
});

describe('journal.workflows.batch', () => {
  it('counts the runs of a batch by state and lists their ids, oldest first', async () => {
    const result = orThrow(
      await journal.run(
        db,
        importTask.startBatch,
        { items: [{ input: { account: newId('acc'), n: 1 } }, { input: { account: newId('acc'), n: 2 } }] },
        caller,
      ),
    );
    const ids = result.runs.map(run => ('runId' in run ? run.runId : 'refused'));
    expect(await journal.workflows.batch(db, result.batchId)).toEqual({
      batchId: result.batchId,
      total: 2,
      states: { running: 2 },
      runIds: ids,
      more: false,
    });
    await settle();
    // Why: a caller polls this to know when the whole fan-out is done.
    expect(await journal.workflows.batch(db, result.batchId)).toMatchObject({ total: 2, states: { completed: 2 } });
    const page = await journal.workflows.runs(db, { batchId: result.batchId });
    expect(page.runs.map(run => run.id).toSorted()).toEqual(ids.toSorted());
    expect(page.runs.every(run => run.batchId === result.batchId)).toBe(true);
  });

  it('gives an unknown batch no runs', async () => {
    expect(await journal.workflows.batch(db, 'wfb_unknown')).toEqual({
      batchId: 'wfb_unknown',
      total: 0,
      states: {},
      runIds: [],
      more: false,
    });
  });
});
