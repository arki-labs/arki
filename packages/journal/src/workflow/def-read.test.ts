/**
 * `def.read` on PGlite: one run of this workflow, read with the same query as `journal.workflows.run`, with every
 * stored value that has a schema checked again. A run of another workflow is not this workflow's run, and a stored
 * value its schema no longer takes is refused, never handed out under a type it does not have.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InvalidInput, isFailure, orThrow } from '@arki/failure';

import { WorkflowReadMismatch } from '../errors.js';
import { initJournal } from '../journal.js';
import { tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const caller = { actorId: 'usr_test' };
const init = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });

const payment = init
  .workflow('test.defread.payment', {
    version: 1,
    input: z.object({ amount: z.number() }),
    output: z.object({ total: z.number() }),
  })
  .step('charge', ({ input }) => ({ chargeId: `ch_${input.amount}` }), { output: z.object({ chargeId: z.string() }) })
  .step('note', () => 'noted')
  .finish(({ input }) => ({ total: input.amount }));
const other = init
  .workflow('test.defread.other', { version: 1, input: z.object({}) })
  .step('only', () => 'done')
  .finish();
/** The stored input is the schema's output, a number, which this schema's input (a string) no longer takes. */
const transformed = init
  .workflow('test.defread.transformed', { version: 1, input: z.object({ n: z.string().transform(Number) }) })
  .step('only', () => 'done')
  .finish();
/** The undos that ran. */
const undone: string[] = [];
/** Charges, then waits for a confirmation it may never get: a cancel or the deadline drops the wait. */
const confirmed = init
  .workflow('test.defread.confirmed', { version: 1, input: z.object({}), deadline: '2h' })
  .step('charge', () => 'charged', { undo: () => void undone.push('charge') })
  .waitFor('confirm', { signal: 'confirm', schema: z.object({ by: z.string() }) })
  .finish();

const journal = init.compose({
  workflows: [payment, other, transformed, confirmed],
  workflowMeta: { actorId: 'system:workflow' },
});

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

async function settle() {
  for (let pass = 0; pass < 40; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the run did not settle');
}
async function parkedOnConfirm(id: string) {
  expect(isFailure(await journal.run(db, confirmed.start, { input: {}, id }, caller))).toBe(false);
  await settle();
  expect(await confirmed.read(db, id)).toMatchObject({ run: { state: 'parked', node: 'confirm' } });
}
/** What `def.read` gives for a run that ended while it waited: the wait left no key, so the read is not refused. */
async function readEnded(id: string) {
  const read = await confirmed.read(db, id);
  if (read === undefined || isFailure(read)) throw new Error(`expected the run, got ${JSON.stringify(read)}`);
  return read.run;
}
async function finishedPayment(id: string) {
  expect(isFailure(await journal.run(db, payment.start, { input: { amount: 7 }, id }, caller))).toBe(false);
  await settle();
}

describe('def.read', () => {
  it('reads a finished run back with its checked input, output and step results', async () => {
    await finishedPayment('pay_1');
    const read = await payment.read(db, 'pay_1');
    if (read === undefined || isFailure(read)) throw new Error('expected the run');
    // Typed by the definition: the output and the checked step result need no narrowing before use.
    expect(read.run.output?.total).toBe(7);
    expect(read.run.results.charge?.chargeId).toBe('ch_7');
    expect(read).toMatchObject({
      run: {
        id: 'pay_1',
        state: 'completed',
        input: { amount: 7 },
        output: { total: 7 },
        results: { charge: { chargeId: 'ch_7' }, note: 'noted' },
        stranded: null,
      },
    });
  });

  it('gives undefined for a run of another workflow and for an unknown id', async () => {
    expect(isFailure(await journal.run(db, other.start, { input: {}, id: 'other_1' }, caller))).toBe(false);
    await settle();
    // The untyped read sees the run; this workflow's read does not, because it is not this workflow's run.
    expect(await journal.workflows.run(db, 'other_1')).toBeDefined();
    expect(await payment.read(db, 'other_1')).toBeUndefined();
    expect(await payment.read(db, 'no_such_run')).toBeUndefined();
  });

  it('refuses a stored output that no longer fits the output schema, naming the field', async () => {
    await finishedPayment('pay_2');
    await db.update(tables.workflowRuns).set({ output: { total: 'seven' } }).where(eq(tables.workflowRuns.id, 'pay_2'));
    const read = await payment.read(db, 'pay_2');
    expect(WorkflowReadMismatch.is(read)).toBe(true);
    expect(read).toMatchObject({
      code: 'journal.workflow_read_mismatch',
      data: { runId: 'pay_2', field: 'output', detail: expect.stringContaining('WORKFLOW_READ_MISMATCH') },
    });
    // The schema's issues travel as the cause.
    expect(isFailure(read) && InvalidInput.is(read.cause)).toBe(true);
  });

  it('refuses a stored step result that no longer fits the step output schema, naming the node', async () => {
    await finishedPayment('pay_3');
    await db
      .update(tables.workflowRuns)
      .set({ results: { charge: { chargeId: 42 }, note: 'noted' } })
      .where(eq(tables.workflowRuns.id, 'pay_3'));
    expect(await payment.read(db, 'pay_3')).toMatchObject({
      code: 'journal.workflow_read_mismatch',
      data: { field: 'results.charge' },
    });
  });

  it('refuses a run whose input schema transforms its value: the stored input is the output', async () => {
    expect(isFailure(await journal.run(db, transformed.start, { input: { n: '5' }, id: 'tr_1' }, caller))).toBe(false);
    await settle();
    expect(await journal.workflows.run(db, 'tr_1')).toMatchObject({ run: { input: { n: 5 } } });
    expect(await transformed.read(db, 'tr_1')).toMatchObject({
      code: 'journal.workflow_read_mismatch',
      data: { field: 'input' },
    });
  });

  describe('a wait that never got its signal', () => {
    it('a run cancelled while parked reads back, and the dropped wait has no result', async () => {
      await parkedOnConfirm('conf_cancel');
      expect(
        isFailure(await journal.run(db, confirmed.cancel, { runId: 'conf_cancel', reason: 'no longer needed' }, caller)),
      ).toBe(false);
      await settle();
      const run = await readEnded('conf_cancel');
      expect(run.state).toBe('cancelled');
      expect(run.results).toEqual({ charge: 'charged' });
      expect(Object.hasOwn(run.results, 'confirm')).toBe(false);
    });

    it('a run failed by its deadline while parked reads back, and the dropped wait has no result', async () => {
      await parkedOnConfirm('conf_deadline');
      // Three hours pass: the deadline (2h) and its timer come due.
      const back = sql`make_interval(hours => 3)`;
      await db
        .update(tables.workflowRuns)
        .set({ deadlineAt: sql`${tables.workflowRuns.deadlineAt} - ${back}` })
        .where(eq(tables.workflowRuns.id, 'conf_deadline'));
      await db
        .update(tables.jobs)
        .set({ availableAt: sql`${tables.jobs.availableAt} - ${back}` })
        .where(eq(tables.jobs.runId, 'conf_deadline'));
      await settle();
      const run = await readEnded('conf_deadline');
      expect(run.state).toBe('failed');
      expect(run.results).toEqual({ charge: 'charged' });
      expect(Object.hasOwn(run.results, 'confirm')).toBe(false);
    });
  });
});
