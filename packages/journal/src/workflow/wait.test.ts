/**
 * Park, signal, timer and deadline on PGlite: the `waitFor` and `sleep` nodes and the run deadline.
 * Time is moved by shifting the time columns back (`tick`), as `jobs.test.ts` does. The race between a
 * signal, a timeout and a deadline on two real connections is in `wait.pg.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import { initJournal } from '../journal.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };

const Granted = z.object({ by: z.string().min(1) });
const SIGNAL = 'approval.granted';

const ran: string[] = [];

const approval = j
  .workflow('test.approval', { version: 1, input: z.object({}) })
  .step('open', () => {
    ran.push('open');
    return 'opened';
  })
  .waitFor('approved', { signal: SIGNAL, schema: Granted, timeout: '3d', onTimeout: 'fail' })
  .step('after', ({ results }) => {
    ran.push('after');
    return `ok:${results.approved.by}`;
  })
  .finish();

const lenient = j
  .workflow('test.lenient', { version: 1, input: z.object({}) })
  .waitFor('approved', { signal: SIGNAL, schema: Granted, timeout: '1h', onTimeout: 'continue' })
  .step('after', ({ results }) => `by:${results.approved?.by ?? 'nobody'}`)
  .finish();

const napping = j
  .workflow('test.napping', { version: 1, input: z.object({}) })
  .step('before', () => {
    ran.push('before');
  })
  .sleep('nap', '24h')
  .step('after', ({ results }) => {
    ran.push('after-nap');
    return results.nap;
  })
  .finish();

const bounded = j
  .workflow('test.bounded', { version: 1, input: z.object({}), deadline: '2h' })
  .waitFor('approved', { signal: SIGNAL, schema: Granted })
  .finish();

/** Waits for approval, then checks it and, on the first pass only, goes back to wait for a second one. */
let passes = 0;
const looping = j
  .workflow('test.looping', { version: 1, input: z.object({}) })
  .waitFor('approved', { signal: SIGNAL, schema: Granted, timeout: '3d', onTimeout: 'fail' })
  .step('check', ({ results }) => results.approved.by, { next: () => (passes++ === 0 ? 'approved' : 'next') })
  .finish();

const journal = j.compose({ workflows: [approval, lenient, napping, bounded, looping], workflowMeta });

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

/** Runs every due job until none is left, as a worker would. */
async function settle(limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the run did not settle');
}

/** Moves the clock forward for one run: every time column that decides when something happens shifts back. */
async function tick(runId: string, seconds: number) {
  const back = sql`make_interval(secs => ${seconds})`;
  await db
    .update(tables.jobs)
    .set({ availableAt: sql`${tables.jobs.availableAt} - ${back}` })
    .where(eq(tables.jobs.runId, runId));
  await db
    .update(tables.workflowRuns)
    .set({
      wakeAt: sql`${tables.workflowRuns.wakeAt} - ${back}`,
      deadlineAt: sql`${tables.workflowRuns.deadlineAt} - ${back}`,
    })
    .where(eq(tables.workflowRuns.id, runId));
}

const runRow = async (id: string) => {
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  return row;
};
const stepRow = async (id: string, path: string) => {
  const [row] = await db
    .select()
    .from(tables.workflowSteps)
    .where(and(eq(tables.workflowSteps.runId, id), eq(tables.workflowSteps.path, path)));
  return row;
};
const eventTypes = async (id: string) => {
  const rows = await db
    .select({ type: tables.events.type })
    .from(tables.events)
    .where(eq(tables.events.entityId, id))
    .orderBy(asc(tables.events.seq));
  return rows.map(row => row.type);
};
const signalsOf = (id: string) => db.select().from(tables.workflowSignals).where(eq(tables.workflowSignals.runId, id));
const timersOf = (id: string) =>
  db
    .select()
    .from(tables.jobs)
    .where(and(eq(tables.jobs.runId, id), eq(tables.jobs.effect, 'workflow.timer')));
/** The run's timer jobs that left the hot table as cancelled. The archive row keeps no `run_id`, so they are found by their event. */
const cancelledTimersOf = (id: string) =>
  db
    .select({ id: tables.jobArchive.id })
    .from(tables.jobArchive)
    .innerJoin(tables.events, eq(tables.events.seq, tables.jobArchive.eventSeq))
    .where(
      and(
        eq(tables.events.entityId, id),
        eq(tables.jobArchive.effect, 'workflow.timer'),
        eq(tables.jobArchive.outcome, 'cancelled'),
      ),
    );

const expectOk = (result: unknown) => {
  expect(isFailure(result)).toBe(false);
};

const start = async (
  def: typeof approval | typeof lenient | typeof napping | typeof bounded | typeof looping,
  prefix: string,
) => {
  const id = newId(prefix);
  expectOk(await journal.run(db, def.start, { input: {}, id }, caller));
  return id;
};
const deliver = (
  def: typeof approval | typeof bounded | typeof lenient | typeof looping,
  runId: string,
  deliveryId: string,
  by = 'alice',
) => journal.run(db, def.signal(SIGNAL), { runId, deliveryId, payload: { by } }, caller);

describe('waitFor and signals', () => {
  it('a signal before the run parks is consumed at the wait, so an early webhook is never lost', async () => {
    const id = await start(approval, 'early');
    // The run has not even reached the wait: its first step has not run.
    expect(await runRow(id)).toMatchObject({ state: 'running', node: 'open' });
    expect(await deliver(approval, id, 'evt_1')).toEqual({ status: 'kept' });
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'completed', output: 'ok:alice' });
    expect(await eventTypes(id)).not.toContain('Parked');
    expect(await signalsOf(id)).toMatchObject([{ deliveryId: 'evt_1', consumedBy: 'approved' }]);
    expect(await timersOf(id), 'no park, so no timer job was left behind').toEqual([]);
  });

  it('a signal after the run parks wakes it in the same commit as the signal row', async () => {
    const id = await start(approval, 'late');
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'parked', node: 'approved', waitingFor: SIGNAL });
    const parkedRow = await runRow(id);
    expect(parkedRow?.wakeAt?.getTime()).toBeGreaterThan(Date.now() + 2 * 86_400_000);
    expect(await deliver(approval, id, 'evt_2', 'bob')).toEqual({ status: 'woke' });
    // No worker has run since: the signal row, the node's result and the next node are all committed.
    expect(await runRow(id)).toMatchObject({ state: 'running', node: 'after', results: { approved: { by: 'bob' } } });
    expect(await stepRow(id, 'approved')).toMatchObject({ status: 'done', result: { by: 'bob' } });
    expect(await signalsOf(id)).toMatchObject([{ deliveryId: 'evt_2', consumedBy: 'approved' }]);
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'completed', output: 'ok:bob' });
  });

  it('a repeated delivery of one signal is a no-op, so a webhook resend never wakes the run twice', async () => {
    const id = await start(approval, 'dup');
    await settle();
    expect(await deliver(approval, id, 'evt_3')).toEqual({ status: 'woke' });
    expect(await deliver(approval, id, 'evt_3')).toEqual({ status: 'duplicate' });
    await settle();
    expect(await signalsOf(id)).toHaveLength(1);
    const types = await eventTypes(id);
    expect(types.filter(type => type === 'SignalReceived')).toHaveLength(1);
    expect(await runRow(id)).toMatchObject({ state: 'completed' });
  });

  it('the timer job is cancelled in the moving commit when the signal wins, so no ghost delayed job stays', async () => {
    const id = await start(approval, 'cancel');
    await settle();
    expect(await timersOf(id)).toMatchObject([{ runId: id, effect: 'workflow.timer' }]);
    expectOk(await deliver(approval, id, 'evt_4'));
    expect(await timersOf(id)).toEqual([]);
    expect(await cancelledTimersOf(id)).toHaveLength(1);
    const operations = await db.select().from(tables.jobOperations).where(eq(tables.jobOperations.action, 'cancel'));
    expect(operations.map(operation => operation.actor)).toContain('system:workflow');
  });

  it('a payload the wait would refuse is refused at the door, so a bad webhook cannot fail the run', async () => {
    const id = await start(approval, 'bad');
    await settle();
    const refused = await journal.run(
      db,
      approval.signal(SIGNAL),
      { runId: id, deliveryId: 'evt_5', payload: { by: '' } },
      caller,
    );
    expect(isFailure(refused)).toBe(true);
    expect(await runRow(id)).toMatchObject({ state: 'parked' });
    expect(await signalsOf(id)).toEqual([]);
  });

  it('a signal for a run that does not exist is a not-found failure, and one for a finished run is dropped', async () => {
    const missing = await deliver(approval, 'nope_1', 'evt_6');
    expect(isFailure(missing)).toBe(true);
    const id = await start(approval, 'done');
    expectOk(await deliver(approval, id, 'evt_7'));
    await settle();
    expect(await deliver(approval, id, 'evt_8')).toEqual({ status: 'finished' });
    expect(await signalsOf(id)).toHaveLength(1);
  });

  it('asking for the signal of a name no waitFor waits for is refused at once, not a command that never fires', () => {
    // The types stop this call; a caller without them (plain JavaScript) still gets the error.
    expect(() => Reflect.apply(approval.signal, undefined, ['nobody.waits'])).toThrow(
      /no waitFor node waits for signal/,
    );
  });
});

describe('a timer and the park it was made for', () => {
  it('a timer left from an earlier park of the same node does nothing, so a loop never has its second wait cut short', async () => {
    passes = 0;
    const id = await start(looping, 'loop');
    await settle();
    const [firstTimer] = await timersOf(id);
    expect(firstTimer).toBeDefined();
    // A worker that crashed holds this timer. Its lease keeps the signal's commit from cancelling it.
    await db
      .update(tables.jobs)
      .set({ leaseUntil: sql`now() + interval '1 hour'` })
      .where(eq(tables.jobs.id, firstTimer?.id ?? ''));
    expectOk(await deliver(looping, id, 'evt_loop_1'));
    await settle();
    // The run went round the loop and waits on the same node again.
    expect(await runRow(id)).toMatchObject({ state: 'parked', node: 'approved' });
    const parkedTypes = await eventTypes(id);
    expect(parkedTypes.filter(type => type === 'Parked')).toHaveLength(2);
    // The lease ends and the old timer retries, long past due.
    await db
      .update(tables.jobs)
      .set({ leaseUntil: null, availableAt: sql`now() - interval '1 second'` })
      .where(eq(tables.jobs.id, firstTimer?.id ?? ''));
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'parked', node: 'approved' });
    expect(await eventTypes(id)).not.toContain('TimerFired');
    // The second wait still ends by its own signal.
    expectOk(await deliver(looping, id, 'evt_loop_2'));
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'completed' });
  });
});

describe('retention of a cancelled timer', () => {
  it("is archived under the retention given to initJournal, not the default, so the app's keep time governs it", async () => {
    const kept = initJournal({
      tables,
      meta: z.object({ actorId: z.string().min(1) }),
      retention: { archive: { dead: '30d' } },
    });
    const retained = kept
      .workflow('test.retained', { version: 1, input: z.object({}) })
      .waitFor('approved', { signal: SIGNAL, schema: Granted, timeout: '3d' })
      .finish();
    const keptJournal = kept.compose({ workflows: [retained], workflowMeta });
    const id = newId('retained');
    expectOk(await keptJournal.run(db, retained.start, { input: {}, id }, caller));
    for (let pass = 0; pass < 40 && (await keptJournal.drain(db).then(result => orThrow(result))) > 0; pass++);
    expect(await timersOf(id)).toHaveLength(1);
    expectOk(
      await keptJournal.run(
        db,
        retained.signal(SIGNAL),
        { runId: id, deliveryId: 'evt_ret', payload: { by: 'alice' } },
        caller,
      ),
    );
    const [archived] = await cancelledTimersOf(id);
    expect(archived).toBeDefined();
    const [row] = await db
      .select({ keepUntil: tables.jobArchive.keepUntil })
      .from(tables.jobArchive)
      .where(eq(tables.jobArchive.id, archived?.id ?? ''));
    const days = ((row?.keepUntil?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days, 'the default keeps dead jobs 90 days; this app keeps them 30').toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });
});

describe('timeout', () => {
  it('a waitFor that times out with onTimeout fail fails the run and marks the node failed', async () => {
    const id = await start(approval, 'timeout');
    await settle();
    await tick(id, 4 * 86_400);
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'failed', node: null });
    expect(await stepRow(id, 'approved')).toMatchObject({ status: 'failed' });
    const approvedStep = await stepRow(id, 'approved');
    expect(approvedStep?.error).toContain(SIGNAL);
    expect(await eventTypes(id)).toEqual([
      'RunStarted',
      'NodeScheduled',
      'NodeCompleted',
      'NodeScheduled',
      'Parked',
      'TimerFired',
      'NodeFailed',
      'CompensationStarted',
      // `open` declares no undo: it is recorded as skipped, then the run ends failed.
      'NodeSkipped',
      'RunFailed',
    ]);
  });

  it('a waitFor that times out with onTimeout continue gives the node the result null and the run goes on', async () => {
    const id = await start(lenient, 'continue');
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'parked', node: 'approved' });
    await tick(id, 2 * 3600);
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'completed', output: 'by:nobody', results: { approved: null } });
  });

  it('a timeout that is not due yet does nothing, so a run is never failed early', async () => {
    const id = await start(approval, 'notdue');
    await settle();
    await tick(id, 86_400);
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'parked' });
  });
});

describe('sleep', () => {
  it('a sleep resumes the run only after its due time', async () => {
    ran.length = 0;
    const id = await start(napping, 'nap');
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'parked', node: 'nap', waitingFor: null });
    expect(ran).toEqual(['before']);
    await tick(id, 3600);
    await settle();
    expect(ran, 'an hour into a 24 hour sleep, the step after it has not run').toEqual(['before']);
    await tick(id, 24 * 3600);
    await settle();
    expect(ran).toEqual(['before', 'after-nap']);
    expect(await runRow(id)).toMatchObject({ state: 'completed', output: null, results: { nap: null } });
  });
});

describe('deadline', () => {
  it('a run still waiting when its deadline passes is failed, so no run waits forever', async () => {
    const id = await start(bounded, 'deadline');
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'parked' });
    expect(await timersOf(id), 'the wait has no timeout; only the deadline timer is queued').toHaveLength(1);
    await tick(id, 3 * 3600);
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'failed' });
    expect(await eventTypes(id)).toContain('DeadlineReached');
  });

  it('a late signal cannot defeat a deadline that has passed but whose timer has not fired yet', async () => {
    const id = await start(bounded, 'late-deadline');
    await settle();
    await db
      .update(tables.workflowRuns)
      .set({ deadlineAt: new Date(Date.now() - 1000) })
      .where(eq(tables.workflowRuns.id, id));
    expect(await deliver(bounded, id, 'evt_9')).toEqual({ status: 'kept' });
    expect(await runRow(id)).toMatchObject({ state: 'failed' });
    expect(await eventTypes(id)).toContain('DeadlineReached');
    expect(await timersOf(id), 'the deadline timer of a failed run is cancelled too').toEqual([]);
  });

  it('a run that finishes in time cancels its deadline timer', async () => {
    const id = await start(bounded, 'in-time');
    await settle();
    expect(await timersOf(id)).toHaveLength(1);
    expectOk(await deliver(bounded, id, 'evt_10'));
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'completed' });
    expect(await timersOf(id)).toEqual([]);
    expect(await cancelledTimersOf(id)).toHaveLength(1);
  });
});
