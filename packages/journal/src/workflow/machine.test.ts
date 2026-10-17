import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { workflowRunId } from '../id.js';
import { j, meta, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';
import { workflowMachine } from './machine.js';

const machine = workflowMachine(j, tables);
const { run, events } = machine;
const journal = j.compose({ tables, projections: [machine.steps] });
const shape = {
  nodes: [
    { name: 'hold', kind: 'step', undo: true },
    { name: 'settled', kind: 'waitFor', undo: false },
  ],
} as const;

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

const clock = (minute: number) => new Date(Date.UTC(2026, 9, 17, 12, minute)).toISOString();
const started = (minute = 0, concurrencyKey: string | null = null) =>
  events.RunStarted({
    name: 'payments.refund',
    workflowVersion: 1,
    shape,
    shapeHash: 'h1',
    input: { paymentId: 'pay_1' },
    deadlineAt: clock(600),
    parentId: null,
    parentPath: null,
    concurrencyKey,
    at: clock(minute),
  });
type RunEvent = ReturnType<(typeof events)[keyof typeof events]>;
const write = (id: string, ...pending: RunEvent[]) =>
  db.transaction(tx => journal.write(tx, run, id, { meta, events: () => pending }));
const runRow = async (id: string) =>
  (await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id)))[0];
const stepRows = (id: string) =>
  db
    .select()
    .from(tables.workflowSteps)
    .where(eq(tables.workflowSteps.runId, id))
    .orderBy(asc(tables.workflowSteps.path), asc(tables.workflowSteps.phase));

describe('the workflow.run reducers', () => {
  it('RunStarted creates a running run that pins its version and shape, so a later code change cannot rewrite what it was', async () => {
    const id = workflowRunId();
    await write(id, started());
    expect(await runRow(id)).toMatchObject({
      state: 'running',
      name: 'payments.refund',
      workflowVersion: 1,
      shape,
      shapeHash: 'h1',
      input: { paymentId: 'pay_1' },
      node: null,
      results: {},
      concurrencyKey: null,
      finishedAt: null,
      version: 1,
    });
    expect((await runRow(id))?.deadlineAt).toEqual(new Date(clock(600)));
  });

  it('a happy run folds scheduled, parked, signalled and completed into the right state at each point', async () => {
    const id = workflowRunId();
    await write(
      id,
      started(),
      events.NodeScheduled({
        path: 'hold',
        phase: 'do',
        attempt: 1,
        key: `${id}:hold:do`,
        jobId: 'job_1',
        at: clock(1),
      }),
    );
    expect(await runRow(id)).toMatchObject({ state: 'running', node: 'hold' });

    await write(
      id,
      events.NodeCompleted({ path: 'hold', phase: 'do', result: { holdId: 'h_1' }, resolvedBy: null, at: clock(2) }),
    );
    expect(await runRow(id)).toMatchObject({ results: { hold: { holdId: 'h_1' } } });

    await write(
      id,
      events.Parked({ node: 'settled', waitingFor: 'provider.refund.settled', wakeAt: clock(300), at: clock(3) }),
    );
    expect(await runRow(id)).toMatchObject({ state: 'parked', node: 'settled', waitingFor: 'provider.refund.settled' });
    expect((await runRow(id))?.wakeAt).toEqual(new Date(clock(300)));

    await write(
      id,
      events.SignalReceived({ name: 'provider.refund.settled', deliveryId: 'evt_1', at: clock(4) }),
      events.NodeCompleted({ path: 'settled', phase: 'do', result: { ok: true }, resolvedBy: null, at: clock(4) }),
      events.NodeScheduled({
        path: 'notify',
        phase: 'do',
        attempt: 1,
        key: `${id}:notify:do`,
        jobId: null,
        at: clock(4),
      }),
    );
    expect(await runRow(id)).toMatchObject({
      state: 'running',
      node: 'notify',
      waitingFor: null,
      wakeAt: null,
      results: { hold: { holdId: 'h_1' }, settled: { ok: true } },
    });

    await write(id, events.RunCompleted({ output: { done: true }, at: clock(5), keepUntil: clock(60) }));
    const done = await runRow(id);
    expect(done).toMatchObject({
      state: 'completed',
      output: { done: true },
      node: null,
      wakeAt: null,
      waitingFor: null,
    });
    expect(done?.finishedAt).toEqual(new Date(clock(5)));
    expect(done?.keepUntil).toEqual(new Date(clock(60)));
  });

  it('a timer wakes a parked run, so a sleep ends without a signal', async () => {
    const id = workflowRunId();
    await write(id, started(), events.Parked({ node: 'coolOff', waitingFor: null, wakeAt: clock(30), at: clock(1) }));
    await write(id, events.TimerFired({ node: 'coolOff', at: clock(30) }));
    expect(await runRow(id)).toMatchObject({ state: 'running', wakeAt: null });
  });

  it('a skipped do node is null in results, and a skipped undo leaves results alone', async () => {
    const id = workflowRunId();
    await write(
      id,
      started(),
      events.NodeCompleted({ path: 'a', phase: 'do', result: 1, resolvedBy: null, at: clock(1) }),
      events.NodeSkipped({ path: 'b', phase: 'do', reason: 'when', actorId: null, at: clock(2) }),
      events.NodeSkipped({ path: 'a', phase: 'undo', reason: 'no undo', actorId: null, at: clock(3) }),
    );
    expect((await runRow(id))?.results).toEqual({ a: 1, b: null });
  });

  it('a dead step leaves the run state alone, because stuck is derived from the step row', async () => {
    const id = workflowRunId();
    await write(
      id,
      started(),
      events.NodeScheduled({ path: 'hold', phase: 'do', attempt: 1, key: 'k', jobId: null, at: clock(1) }),
    );
    await write(id, events.NodeFailed({ path: 'hold', phase: 'do', attempt: 1, error: 'boom', at: clock(2) }));
    expect(await runRow(id)).toMatchObject({ state: 'running', node: 'hold', finishedAt: null });
  });

  it('cancel then compensation: the first cancel request keeps its time and reason, and the run ends cancelled', async () => {
    const id = workflowRunId();
    await write(
      id,
      started(),
      events.CancelRequested({ reason: 'customer asked', actorId: 'foreman:alice', at: clock(1) }),
    );
    await write(
      id,
      events.CancelRequested({ reason: 'second', actorId: null, at: clock(2) }),
      events.CompensationStarted({ at: clock(2) }),
    );
    expect(await runRow(id)).toMatchObject({ state: 'compensating', cancelReason: 'customer asked', waitingFor: null });
    expect((await runRow(id))?.cancelledAt).toEqual(new Date(clock(1)));

    // A node scheduled during compensation (an undo) must not flip the run back to running.
    await write(
      id,
      events.NodeScheduled({ path: 'hold', phase: 'undo', attempt: 1, key: 'k:undo', jobId: null, at: clock(3) }),
    );
    expect(await runRow(id)).toMatchObject({ state: 'compensating', node: 'hold' });

    await write(id, events.RunCancelled({ at: clock(4), keepUntil: null }));
    const row = await runRow(id);
    expect(row).toMatchObject({ state: 'cancelled', node: null, keepUntil: null });
    expect(row?.finishedAt).toEqual(new Date(clock(4)));
  });

  it('a deadline then RunFailed ends the run failed; DeadlineReached alone changes no state', async () => {
    const id = workflowRunId();
    await write(id, started(), events.DeadlineReached({ at: clock(600) }));
    expect(await runRow(id)).toMatchObject({ state: 'running' });
    await write(id, events.RunFailed({ error: 'deadline', at: clock(601), keepUntil: clock(900) }));
    expect(await runRow(id)).toMatchObject({ state: 'failed', finishedAt: new Date(clock(601)) });
  });

  it('replay rebuilds the same row from the events, so the row is a projection of the log', async () => {
    const id = workflowRunId();
    await write(
      id,
      started(),
      events.NodeCompleted({ path: 'hold', phase: 'do', result: { holdId: 'h' }, resolvedBy: null, at: clock(1) }),
      events.Parked({ node: 'settled', waitingFor: 'x', wakeAt: null, at: clock(2) }),
    );
    const stored = await runRow(id);
    const replayed = await db.transaction(tx => journal.replay(tx, run, id));
    expect(replayed.row).toMatchObject({
      state: 'parked',
      results: { hold: { holdId: 'h' } },
      version: stored?.version,
    });
  });
});

describe('the step projection', () => {
  it('writes one row per node and phase with the status the events say, so Foreman can read position without replaying', async () => {
    const id = workflowRunId();
    await write(
      id,
      started(),
      events.NodeScheduled({
        path: 'hold',
        phase: 'do',
        attempt: 1,
        key: `${id}:hold:do`,
        jobId: 'job_1',
        at: clock(1),
      }),
    );
    expect(await stepRows(id)).toMatchObject([
      { path: 'hold', phase: 'do', status: 'scheduled', attempt: 1, key: `${id}:hold:do`, jobId: 'job_1' },
    ]);

    await write(
      id,
      events.NodeCompleted({ path: 'hold', phase: 'do', result: { holdId: 'h' }, resolvedBy: null, at: clock(2) }),
    );
    const [hold] = await stepRows(id);
    expect(hold).toMatchObject({ status: 'done', result: { holdId: 'h' } });
    expect(hold?.startedAt).toEqual(new Date(clock(1)));
    expect(hold?.finishedAt).toEqual(new Date(clock(2)));
  });

  it('a failed step keeps its error and attempt, and a retry reschedules the same row with a clean slate', async () => {
    const id = workflowRunId();
    await write(
      id,
      started(),
      events.NodeScheduled({ path: 'pay', phase: 'do', attempt: 1, key: 'k', jobId: 'job_1', at: clock(1) }),
    );
    await write(id, events.NodeFailed({ path: 'pay', phase: 'do', attempt: 3, error: 'provider down', at: clock(2) }));
    expect(await stepRows(id)).toMatchObject([{ status: 'failed', attempt: 3, error: 'provider down' }]);

    await write(
      id,
      events.NodeScheduled({ path: 'pay', phase: 'do', attempt: 4, key: 'k', jobId: 'job_2', at: clock(3) }),
    );
    const rows = await stepRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'scheduled', attempt: 4, error: null, jobId: 'job_2', finishedAt: null });
    expect(rows[0]?.startedAt).toEqual(new Date(clock(1)));
  });

  it('an undo is its own row beside the do row, and a skipped node never scheduled still gets a row with its reason', async () => {
    const id = workflowRunId();
    await write(
      id,
      started(),
      events.NodeCompleted({ path: 'hold', phase: 'do', result: 1, resolvedBy: null, at: clock(1) }),
      events.NodeCompleted({ path: 'payBack', phase: 'do', result: 2, resolvedBy: 'foreman:alice', at: clock(2) }),
      events.CompensationStarted({ at: clock(3) }),
      events.NodeSkipped({ path: 'payBack', phase: 'undo', reason: 'no undo declared', actorId: null, at: clock(3) }),
      events.NodeScheduled({ path: 'hold', phase: 'undo', attempt: 1, key: 'k:undo', jobId: null, at: clock(4) }),
    );
    expect((await stepRows(id)).map(r => [r.path, r.phase, r.status, r.reason])).toEqual([
      ['hold', 'do', 'done', null],
      ['hold', 'undo', 'scheduled', null],
      ['payBack', 'do', 'done', null],
      ['payBack', 'undo', 'skipped', 'no undo declared'],
    ]);
  });

  it('steps are deleted with their run, so pruning a run leaves no orphans', async () => {
    const id = workflowRunId();
    await write(
      id,
      started(),
      events.NodeScheduled({ path: 'hold', phase: 'do', attempt: 1, key: 'k', jobId: null, at: clock(1) }),
    );
    await db.delete(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
    expect(await stepRows(id)).toEqual([]);
  });

  it('a second unfinished run with the same name and concurrency key is refused by the database, and a finished one frees the key', async () => {
    const first = workflowRunId();
    await write(first, started(0, 'pay_1'));
    await expect(write(workflowRunId(), started(0, 'pay_1'))).rejects.toThrow();
    await write(first, events.RunCompleted({ output: null, at: clock(1), keepUntil: null }));
    await expect(write(workflowRunId(), started(0, 'pay_1'))).resolves.not.toThrow();
  });
});
