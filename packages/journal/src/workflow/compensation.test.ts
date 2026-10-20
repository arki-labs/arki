/**
 * Cancel and compensation on PGlite: a run that stops (cancel, timeout, deadline, a failed step) undoes the steps it
 * completed, newest first, and then ends `cancelled` or `failed`. Time is moved by shifting time columns back, as
 * `wait.test.ts` does. Signal, timeout and cancel on two real connections are in `wait.pg.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFailure, isFailure, orThrow, UnexpectedDefect } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const caller = { actorId: 'usr_test' };
const workflowMeta = { actorId: 'system:workflow' };
const SIGNAL = 'order.confirmed';
const Confirmed = z.object({ by: z.string() });
const Declined = defineFailure('test.declined', { status: 402, data: z.object({}), message: 'declined' });
const noRetry = backoff.constant(0).upTo(0);

/** Every undo and every do that ran, in order, so a test sees the order and the repeats. */
const log: string[] = [];
let failUndoOnce = false;
let alwaysFailUndo = false;
let gate: Promise<void> = Promise.resolve();
const noop = (): void => {
  // Replaced by the promise's resolver before the gate is returned.
};
/** A promise a test settles by hand, to hold a step in flight. */
function holdGate() {
  let open = noop;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { opened, open };
}

/** charge then reserve, then a wait that fails the run when nobody confirms in time. */
const order = j
  .workflow('test.order', { version: 1, input: z.object({}) })
  .step('charge', ({ key }) => ({ chargeId: `ch:${key}` }), {
    undo: ({ result, key }) => {
      log.push(`undo charge ${result.chargeId} ${key}`);
    },
  })
  .step('reserve', () => ({ slot: 7 }), {
    undo: ({ result, key }) => {
      log.push(`undo reserve ${result.slot} ${key}`);
    },
  })
  .waitFor('confirm', { signal: SIGNAL, schema: Confirmed, timeout: '1h', onTimeout: 'fail' })
  .finish();

/** `note` has no undo; `paid` does. */
const mixed = j
  .workflow('test.mixed', { version: 1, input: z.object({}) })
  .step('note', () => 'noted')
  .step('paid', () => 'ok', { undo: () => void log.push('undo paid') })
  .waitFor('confirm', { signal: SIGNAL, schema: Confirmed })
  .finish();

const three = j
  .workflow('test.three', { version: 1, input: z.object({}) })
  .step('a', () => 'a', { undo: () => void log.push('undo a') })
  .step('b', () => 'b', {
    undo: () => {
      log.push('undo b');
      if (failUndoOnce) {
        failUndoOnce = false;
        throw new Error('undo b failed once');
      }
    },
    retry: backoff.constant(0).upTo(2).while(reason => UnexpectedDefect.is(reason)),
  })
  .step('c', () => 'c', { undo: () => void log.push('undo c') })
  .waitFor('confirm', { signal: SIGNAL, schema: Confirmed })
  .finish();

/** `gen` runs twice because `gate` jumps back once. */
let genVisits = 0;
const looping = j
  .workflow('test.compensation.looping', { version: 1, input: z.object({}) })
  .step('gen', ({ key }) => `gen@${key}`, { undo: ({ key, result }) => void log.push(`undo ${result} with ${key}`) })
  .step('gate', () => 'gate', { next: () => (genVisits++ === 0 ? 'gen' : 'next') })
  .waitFor('confirm', { signal: SIGNAL, schema: Confirmed })
  .finish();

const bounded = j
  .workflow('test.bounded', { version: 1, input: z.object({}), deadline: '2h' })
  .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
  .waitFor('confirm', { signal: SIGNAL, schema: Confirmed })
  .finish();

const declining = j
  .workflow('test.declining', { version: 1, input: z.object({}) })
  .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
  .step('authorize', () => Declined({}), {
    retry: backoff
      .constant(0)
      .upTo(2)
      .while(reason => UnexpectedDefect.is(reason)),
  })
  .finish();

const decliningAndCompensating = j
  .workflow('test.declining.compensating', { version: 1, input: z.object({}), onDeadStep: 'compensate' })
  .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
  .step('authorize', () => Declined({}), {
    retry: backoff
      .constant(0)
      .upTo(2)
      .while(reason => UnexpectedDefect.is(reason)),
  })
  .finish();

const dying = j
  .workflow('test.dying', { version: 1, input: z.object({}) })
  .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
  .step(
    'ship',
    () => {
      throw new Error('carrier down');
    },
    { retry: noRetry },
  )
  .finish();
const dyingAndCompensating = j
  .workflow('test.dying.compensating', { version: 1, input: z.object({}), onDeadStep: 'compensate' })
  .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
  .step(
    'ship',
    () => {
      throw new Error('carrier down');
    },
    { retry: noRetry },
  )
  .finish();

/** `slow` holds on a gate the test opens: the cancel arrives while it is in flight. */
const slowOrder = j
  .workflow('test.slow', { version: 1, input: z.object({}) })
  .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
  .step(
    'slow',
    async () => {
      log.push('slow started');
      await gate;
      return 'slow done';
    },
    { undo: ({ result }) => void log.push(`undo slow ${result}`) },
  )
  .step('last', () => 'last', { undo: () => void log.push('undo last') })
  .finish();

/** `later` fails once and retries in a minute: its retry job sits pending when the cancel arrives. */
let laterTries = 0;
let laterKeepsFailing = false;
const retrying = j
  .workflow('test.retrying', { version: 1, input: z.object({}) })
  .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
  .step(
    'later',
    () => {
      log.push('later ran');
      laterTries++;
      if (laterTries > 1 && !laterKeepsFailing) return 'later done';
      throw new Error('not yet');
    },
    {
      retry: backoff
        .constant(60_000)
        .upTo(2)
        .while(reason => UnexpectedDefect.is(reason)),
      undo: () => void log.push('undo later'),
    },
  )
  .finish();

const stuckUndo = j
  .workflow('test.stuckundo', { version: 1, input: z.object({}) })
  .step('charge', () => 'charged', {
    undo: () => {
      log.push('undo charge tried');
      if (alwaysFailUndo) throw new Error('refund provider down');
    },
    retry: backoff.constant(0).upTo(1).while(reason => UnexpectedDefect.is(reason)),
  })
  .waitFor('confirm', { signal: SIGNAL, schema: Confirmed })
  .finish();

const journal = j.compose({
  workflows: [
    order,
    mixed,
    three,
    looping,
    bounded,
    declining,
    decliningAndCompensating,
    dying,
    dyingAndCompensating,
    slowOrder,
    retrying,
    stuckUndo,
  ],
  workflowMeta,
});

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

async function settle(limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the run did not settle');
}
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
const stepRow = async (id: string, path: string, phase: 'do' | 'undo') => {
  const [row] = await db
    .select()
    .from(tables.workflowSteps)
    .where(
      and(
        eq(tables.workflowSteps.runId, id),
        eq(tables.workflowSteps.path, path),
        eq(tables.workflowSteps.phase, phase),
      ),
    );
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
/** How many events of `type` the run has. */
const countOf = async (id: string, type: string) => {
  const types = await eventTypes(id);
  return types.filter(found => found === type).length;
};
/** Whether a job of the run is dead (out of retries, waiting for an operator). */
const hasDeadJob = async (id: string) => {
  const jobs = await jobsOf(id);
  return jobs.some(job => job.deadAt !== null);
};
const jobsOf = (id: string) => db.select().from(tables.jobs).where(eq(tables.jobs.runId, id));

const expectOk = (result: unknown) => {
  expect(isFailure(result)).toBe(false);
};

type Startable = {
  readonly start: typeof order.start;
  readonly cancel: typeof order.cancel;
};
const start = async (def: Startable, prefix: string) => {
  const id = newId(prefix);
  expect(isFailure(await journal.run(db, def.start, { input: {}, id }, caller))).toBe(false);
  return id;
};
/** Cancels, then moves the clock a little: the undo job the cancel queued is due at the cancel's own millisecond. */
const cancel = async (def: Startable, runId: string, reason = 'customer asked') => {
  const outcome = await journal.run(db, def.cancel, { runId, reason }, caller);
  await tick(runId, 5);
  return outcome;
};

describe('compensation, in reverse', () => {
  it('charge → reserve → timeout → undo runs in reverse so money is never held without its reservation', async () => {
    log.length = 0;
    const id = await start(order, 'timeout');
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'parked', node: 'confirm' });
    await tick(id, 2 * 3600);
    await settle();
    // The reservation is released first; only then is the charge refunded.
    expect(log).toEqual([`undo reserve 7 ${id}:reserve:undo`, `undo charge ch:${id}:charge:do ${id}:charge:undo`]);
    expect(await runRow(id)).toMatchObject({ state: 'failed', node: null });
    expect(await stepRow(id, 'reserve', 'undo')).toMatchObject({ status: 'done', key: `${id}:reserve:undo` });
    expect(await stepRow(id, 'charge', 'undo')).toMatchObject({ status: 'done' });
    // A wait has nothing to undo: no row for it.
    expect(await stepRow(id, 'confirm', 'undo')).toBeUndefined();
    const types = await eventTypes(id);
    expect(types.indexOf('CompensationStarted')).toBeGreaterThan(types.indexOf('NodeFailed'));
    expect(types.at(-1)).toBe('RunFailed');
  });

  it('cancel on a parked run undoes completed steps in reverse and ends cancelled', async () => {
    log.length = 0;
    const id = await start(order, 'cancel');
    await settle();
    expect(await cancel(order, id)).toEqual({ state: 'compensating' });
    // The wait is dropped and its timer cancelled in the cancel's own commit; the first undo is already queued.
    const cancelling = await runRow(id);
    expect(cancelling).toMatchObject({ state: 'compensating', cancelReason: 'customer asked' });
    expect(cancelling?.cancelledAt).toBeInstanceOf(Date);
    const queued = await jobsOf(id);
    expect(queued.map(job => job.effect)).toEqual(['workflow.step']);
    await settle();
    expect(log[0]).toContain('undo reserve');
    expect(log[1]).toContain('undo charge');
    expect(await runRow(id)).toMatchObject({ state: 'cancelled', node: null });
    const ended = await runRow(id);
    expect(ended?.finishedAt).toBeInstanceOf(Date);
    expect(await stepRow(id, 'confirm', 'do')).toMatchObject({ status: 'skipped' });
    const types = await eventTypes(id);
    expect(types).toContain('CancelRequested');
    expect(types.at(-1)).toBe('RunCancelled');
    expect(types).not.toContain('RunFailed');
  });

  it('a step without undo is skipped and recorded as residual', async () => {
    log.length = 0;
    const id = await start(mixed, 'residual');
    await settle();
    expectOk(await cancel(mixed, id));
    await settle();
    expect(log).toEqual(['undo paid']);
    expect(await runRow(id)).toMatchObject({ state: 'cancelled' });
    // The residual of a run is its undo rows that were skipped: `note` was done and could not be undone.
    const residual = await db
      .select({ path: tables.workflowSteps.path, reason: tables.workflowSteps.reason })
      .from(tables.workflowSteps)
      .where(
        and(
          eq(tables.workflowSteps.runId, id),
          eq(tables.workflowSteps.phase, 'undo'),
          eq(tables.workflowSteps.status, 'skipped'),
        ),
      );
    expect(residual).toEqual([{ path: 'note', reason: 'the step declares no undo' }]);
  });

  it('compensation crash resumes at the undone step, not from the start', async () => {
    log.length = 0;
    failUndoOnce = true;
    const id = await start(three, 'resume');
    await settle();
    expectOk(await cancel(three, id));
    await settle();
    // `c` was undone once. `b` failed and ran again on its own row; `a` came after. Nothing started over.
    expect(log).toEqual(['undo c', 'undo b', 'undo b', 'undo a']);
    expect(await stepRow(id, 'b', 'undo')).toMatchObject({ status: 'done', attempt: 2 });
    expect(await runRow(id)).toMatchObject({ state: 'cancelled' });
  });
});

describe('a loop', () => {
  it('undoes each completed visit once, newest first, each under its own key', async () => {
    log.length = 0;
    genVisits = 0;
    const id = await start(looping, 'loop');
    await settle();
    expectOk(await cancel(looping, id));
    await settle();
    expect(log).toEqual([`undo gen@${id}:gen:do:2 with ${id}:gen:undo:2`, `undo gen@${id}:gen:do with ${id}:gen:undo`]);
    expect(await runRow(id)).toMatchObject({ state: 'cancelled' });
  });
});

describe('deadline and failures', () => {
  it('deadline fails a parked run and compensates', async () => {
    log.length = 0;
    const id = await start(bounded, 'deadline');
    await settle();
    await tick(id, 3 * 3600);
    await settle();
    expect(log).toEqual(['undo charge']);
    expect(await runRow(id)).toMatchObject({ state: 'failed' });
    const types = await eventTypes(id);
    expect(types).toContain('DeadlineReached');
    expect(types.indexOf('CompensationStarted')).toBeGreaterThan(types.indexOf('DeadlineReached'));
    expect(types.at(-1)).toBe('RunFailed');
  });

  it('a dead step waits for an operator by default and compensates with onDeadStep', async () => {
    log.length = 0;
    const waiting = await start(dying, 'dead_wait');
    const compensating = await start(dyingAndCompensating, 'dead_comp');
    await settle();
    // Default: the run stays running and the step's job is dead. Nothing is undone.
    expect(await runRow(waiting)).toMatchObject({ state: 'running', node: 'ship' });
    expect(await eventTypes(waiting)).not.toContain('CompensationStarted');
    expect(await hasDeadJob(waiting)).toBe(true);
    // With onDeadStep: the same dead step compensates and the run fails, with no dead job left for an operator.
    expect(await runRow(compensating)).toMatchObject({ state: 'failed' });
    expect(log).toEqual(['undo charge']);
    expect(await jobsOf(compensating)).toEqual([]);
  });

  it('a step that returns a failure is dead at once and waits for an operator by default', async () => {
    log.length = 0;
    const waiting = await start(declining, 'returned_wait');
    const compensating = await start(decliningAndCompensating, 'returned_comp');
    await settle();
    // Default: dead like a step that died of thrown errors. One attempt (no retry), the run stays running, nothing undone.
    expect(await stepRow(waiting, 'authorize', 'do')).toMatchObject({ status: 'failed', attempt: 1 });
    expect(await runRow(waiting)).toMatchObject({ state: 'running', node: 'authorize' });
    expect(await countOf(waiting, 'CompensationStarted')).toBe(0);
    expect(await hasDeadJob(waiting)).toBe(true);
    // With onDeadStep: 'compensate' the same decision compensates at once.
    expect(await runRow(compensating)).toMatchObject({ state: 'failed' });
    expect(await stepRow(compensating, 'authorize', 'do')).toMatchObject({ status: 'failed', attempt: 1 });
    expect(log).toEqual(['undo charge']);
  });

  it('an undo that keeps failing leaves the run compensating and stuck', async () => {
    log.length = 0;
    alwaysFailUndo = true;
    const id = await start(stuckUndo, 'stuck');
    await settle();
    expectOk(await cancel(stuckUndo, id));
    await settle();
    alwaysFailUndo = false;
    expect(log).toEqual(['undo charge tried', 'undo charge tried']);
    expect(await runRow(id)).toMatchObject({ state: 'compensating', finishedAt: null });
    expect(await stepRow(id, 'charge', 'undo')).toMatchObject({ status: 'failed', attempt: 2 });
    expect(await hasDeadJob(id)).toBe(true);
    expect(await eventTypes(id)).not.toContain('RunCancelled');
  });
});

describe('cancel while work is in flight or pending', () => {
  it('a step in flight when cancel arrives is undone after it settles, never dropped', async () => {
    log.length = 0;
    const held = holdGate();
    gate = held.opened;
    const id = await start(slowOrder, 'inflight');
    const draining = settle();
    // Wait until `slow` is running on its lease.
    for (let tries = 0; tries < 200 && !log.includes('slow started'); tries++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(log).toContain('slow started');
    expect(await cancel(slowOrder, id)).toEqual({ state: 'compensating' });
    // No undo is queued while the step may still be charging: only its own job exists.
    expect(await stepRow(id, 'charge', 'undo')).toBeUndefined();
    expect(await stepRow(id, 'slow', 'do')).toMatchObject({ status: 'scheduled' });
    held.open();
    await draining;
    await settle();
    expect(log.filter(line => line.startsWith('undo'))).toEqual(['undo slow slow done', 'undo charge']);
    expect(log).not.toContain('undo last');
    expect(await runRow(id)).toMatchObject({ state: 'cancelled' });
    expect(await stepRow(id, 'slow', 'do')).toMatchObject({ status: 'done', result: 'slow done' });
    // `last` never ran: nothing was scheduled for it.
    expect(await stepRow(id, 'last', 'do')).toBeUndefined();
  });

  it('a pending step job is cancelled with the run so it never runs', async () => {
    log.length = 0;
    const id = await start(slowOrder, 'pending');
    // No worker has run: the first step's job is waiting in the queue.
    expect(await jobsOf(id)).toHaveLength(1);
    expect(await cancel(slowOrder, id)).toEqual({ state: 'cancelled' });
    expect(await jobsOf(id)).toEqual([]);
    await settle();
    expect(log).toEqual([]);
    expect(await runRow(id)).toMatchObject({ state: 'cancelled' });
    expect(await stepRow(id, 'charge', 'do')).toMatchObject({ status: 'skipped' });
    const archived = await db
      .select({ outcome: tables.jobArchive.outcome })
      .from(tables.jobArchive)
      .innerJoin(tables.events, eq(tables.events.seq, tables.jobArchive.eventSeq))
      .where(and(eq(tables.events.entityId, id), eq(tables.jobArchive.effect, 'workflow.step')));
    expect(archived).toEqual([{ outcome: 'cancelled' }]);
  });

  it('a step waiting to retry is not skipped by cancel so a charge it may have made is undone', async () => {
    for (const keepsFailing of [false, true]) {
      log.length = 0;
      laterTries = 0;
      laterKeepsFailing = keepsFailing;
      const id = await start(retrying, 'backoff');
      await settle();
      expect(laterTries).toBe(1);
      expectOk(await cancel(retrying, id));
      // The first try may have acted before it threw: its retry stays, and no undo is queued until it settles.
      expect(await stepRow(id, 'later', 'do')).toMatchObject({ status: 'scheduled', attempt: 2 });
      expect(await stepRow(id, 'charge', 'undo')).toBeUndefined();
      await settle();
      expect(log).toEqual(['later ran']);
      await tick(id, 3600);
      await settle();
      // One more run, never a further retry; then the undos go on.
      expect(laterTries).toBe(2);
      expect(log).toEqual(
        keepsFailing
          ? ['later ran', 'later ran', 'undo charge']
          : ['later ran', 'later ran', 'undo later', 'undo charge'],
      );
      expect(await runRow(id)).toMatchObject({ state: 'cancelled' });
    }
    laterKeepsFailing = false;
  });
});

describe('cancel refusals', () => {
  it('cancel on a finished or compensating run is a returned conflict', async () => {
    log.length = 0;
    const done = await start(dyingAndCompensating, 'finished');
    await settle();
    const refusedFinished = await cancel(dyingAndCompensating, done);
    expect(isFailure(refusedFinished)).toBe(true);
    expect(refusedFinished).toMatchObject({ data: { detail: expect.stringContaining('already failed') } });
    expect(await runRow(done)).toMatchObject({ state: 'failed', cancelReason: null });

    // A run held in compensation by a failing undo refuses a second cancel.
    alwaysFailUndo = true;
    const stuck = await start(stuckUndo, 'twice');
    await settle();
    expect(await cancel(stuckUndo, stuck, 'first')).toEqual({ state: 'compensating' });
    const again = await cancel(stuckUndo, stuck, 'second');
    alwaysFailUndo = false;
    expect(isFailure(again)).toBe(true);
    expect(again).toMatchObject({ data: { detail: expect.stringContaining('already compensating') } });
    // The first reason stays.
    expect(await runRow(stuck)).toMatchObject({ cancelReason: 'first' });
    expect(await countOf(stuck, 'CancelRequested')).toBe(1);

    const missing = await cancel(order, 'nope_1');
    expect(isFailure(missing)).toBe(true);
    expect(missing).toMatchObject({ data: { detail: expect.stringContaining('no workflow run') } });
  });
});
