/**
 * The runner core on PGlite: start, the step effect, the checkpoint, `when`, `next`, retry, timeout and the limits.
 * Races between two real workers are in `runner.pg.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { isJournalError } from '../errors.js';
import { initJournal } from '../journal.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';
import { stepStatusSql } from './machine.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const noRetry = backoff.constant(0).upTo(0);

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

/** Every body that runs leaves its key here, so a test can see what ran and with which key. */
const ran: { readonly name: string; readonly key: string; readonly attempt: number }[] = [];
const note = (name: string, ctx: { readonly key: string; readonly attempt: number }) =>
  ran.push({ name, key: ctx.key, attempt: ctx.attempt });
const ranOf = (name: string) => ran.filter(entry => entry.name === name);

const sum = j
  .workflow('test.sum', { version: 1, input: z.object({ n: z.int() }) })
  .step('double', ({ input }) => ({ doubled: input.n * 2 }))
  .step('plusOne', ({ results }) => ({ value: results.double.doubled + 1 }))
  .step('label', ({ results }) => `v=${results.plusOne.value}`)
  .finish();

const guarded = j
  .workflow('test.guarded', { version: 1, input: z.object({ vip: z.boolean() }) })
  .step('first', () => 'first')
  .step(
    'bonus',
    ctx => {
      note('bonus', ctx);
      return { points: 10 };
    },
    { when: ({ input }) => input.vip },
  )
  .step('total', ({ results }) => (results.bonus?.points ?? 0) + 1)
  .finish();

const hunt = j
  .workflow('test.hunt', { version: 1, input: z.object({ rounds: z.int().positive() }) })
  .step('generate', ctx => {
    note('generate', ctx);
    return { candidates: 3 };
  })
  .step(
    'gate',
    ctx => {
      note('gate', ctx);
      return { done: ranOf('gate').filter(entry => entry.key.startsWith(ctx.runId)).length >= ctx.input.rounds };
    },
    { next: ({ result }) => (result.done ? 'next' : 'generate') },
  )
  .step('publish', ctx => note('publish', ctx))
  .finish();

const flaky = j
  .workflow('test.flaky', { version: 1, input: z.object({}) })
  .step(
    'provider',
    ctx => {
      note('provider', ctx);
      throw new Error('provider down');
    },
    { retry: backoff.constant(0).upTo(2) },
  )
  .step('after', () => 'never')
  .finish();

const charge = j
  .workflow('test.charge', { version: 1, input: z.object({ paymentId: z.string() }) })
  .step(
    'charge',
    ctx => {
      note('charge', ctx);
      return { chargeId: `ch_${ctx.input.paymentId}` };
    },
    { key: ({ input }) => `charge:${input.paymentId}` },
  )
  .finish();

const running = j
  .workflow('test.running', { version: 1, input: z.object({}) })
  .step('look', async ({ runId, db: root }) => {
    const [row] = await root
      .select({ status: stepStatusSql(tables), stored: tables.workflowSteps.status, jobId: tables.workflowSteps.jobId })
      .from(tables.workflowSteps)
      .where(and(eq(tables.workflowSteps.runId, runId), eq(tables.workflowSteps.path, 'look')));
    return { status: row?.status ?? 'missing', stored: row?.stored ?? 'missing', hasJob: row?.jobId != null };
  })
  .finish();

let sawAbort = false;
const hanging = j
  .workflow('test.hanging', { version: 1, input: z.object({}) })
  .step(
    'hang',
    async ({ signal }) => {
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
      });
      return 'late';
    },
    { timeout: 0.05, retry: noRetry },
  )
  .finish();

const small = j
  .workflow('test.small', { version: 1, input: z.object({ text: z.string() }), limits: { payload: 64 } })
  .step('big', () => 'x'.repeat(100), { retry: noRetry })
  .finish();

const routed = j
  .workflow('test.routed', { version: 1, input: z.object({}) })
  .step('a', ctx => note('a', ctx))
  .step('b', ctx => note('b', ctx), { next: () => 'a' })
  .finish();
/** The same workflow with a router that names a node that does not exist before it. The builder's types would not allow it. */
const misrouted = {
  ...routed,
  nodes: routed.nodes.map(node =>
    node.kind === 'step' && node.name === 'b' ? { ...node, options: { ...node.options, next: () => 'later' } } : node,
  ),
};

const journal = j.compose({
  workflows: [sum, guarded, hunt, flaky, charge, running, hanging, small, misrouted],
  workflowMeta,
});

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

/** Runs every due job until none is left, as a worker would. */
async function settle(limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db)) === 0) return;
  }
  throw new Error('the run did not settle');
}

const runRow = async (id: string) =>
  (await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id)))[0];
const stepRow = async (id: string, path: string) =>
  (
    await db
      .select()
      .from(tables.workflowSteps)
      .where(and(eq(tables.workflowSteps.runId, id), eq(tables.workflowSteps.path, path)))
  )[0];
const eventTypes = async (id: string) =>
  (
    await db
      .select({ type: tables.events.type })
      .from(tables.events)
      .where(eq(tables.events.entityId, id))
      .orderBy(asc(tables.events.seq))
  ).map(row => row.type);
const jobsOf = (id: string) => db.select().from(tables.jobs).where(eq(tables.jobs.runId, id));

describe('start and the step effect', () => {
  it('a three-step run completes and stores each typed result, so a later step reads what an earlier one returned', async () => {
    const id = newId('sum');
    const started = await journal.run(db, sum.start, { input: { n: 4 }, id }, caller);
    expect(started).toEqual({ runId: id });
    expect(await runRow(id)).toMatchObject({
      state: 'running',
      node: 'double',
      workflowVersion: 1,
      shapeHash: sum.shapeHash,
    });
    await settle();
    const row = await runRow(id);
    expect(row).toMatchObject({
      state: 'completed',
      node: null,
      results: { double: { doubled: 8 }, plusOne: { value: 9 }, label: 'v=9' },
      output: 'v=9',
    });
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(await eventTypes(id)).toEqual([
      'RunStarted',
      'NodeScheduled',
      'NodeCompleted',
      'NodeScheduled',
      'NodeCompleted',
      'NodeScheduled',
      'NodeCompleted',
      'RunCompleted',
    ]);
    expect(await stepRow(id, 'plusOne')).toMatchObject({
      status: 'done',
      attempt: 1,
      key: `${id}:plusOne:do`,
      result: { value: 9 },
    });
  });

  it('every step job carries its run id and the step row names its job, so the sweeper and Foreman can tie them together', async () => {
    const id = newId('sum');
    await journal.run(db, sum.start, { input: { n: 1 }, id }, caller);
    const queued = await jobsOf(id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.effect).toBe('workflow.step');
    expect((await stepRow(id, 'double'))?.jobId).toBe(queued[0]?.id);
    await settle();
    expect((await jobsOf(id)).length).toBe(0);
  });

  it('a step is running while its body runs, derived from the lease of its job: the row still says scheduled', async () => {
    const id = newId('running');
    await journal.run(db, running.start, { input: {}, id }, caller);
    await settle();
    expect((await runRow(id))?.results).toEqual({ look: { status: 'running', stored: 'scheduled', hasJob: true } });
    expect((await stepRow(id, 'look'))?.status).toBe('done');
  });

  it('starting twice with one id and one input is one run, and another input is refused', async () => {
    const id = newId('sum');
    expect(await journal.run(db, sum.start, { input: { n: 1 }, id }, caller)).toEqual({ runId: id });
    expect(await journal.run(db, sum.start, { input: { n: 1 }, id }, caller)).toEqual({ runId: id });
    expect(await eventTypes(id)).toEqual(['RunStarted', 'NodeScheduled']);
    const refused = await journal.run(db, sum.start, { input: { n: 2 }, id }, caller);
    expect(isFailure(refused)).toBe(true);
    expect(await jobsOf(id)).toHaveLength(1);
  });

  it('start without an id makes a wfr_ id', async () => {
    const started = await journal.run(db, sum.start, { input: { n: 3 } }, caller);
    expect(isFailure(started)).toBe(false);
    if (isFailure(started)) return;
    expect(started.runId).toMatch(/^wfr_/);
  });

  it('a start of a workflow no compose registered says so, because no step effect would queue its job', async () => {
    const lone = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
    const orphan = lone
      .workflow('test.orphan', { version: 1, input: z.object({}) })
      .step('a', () => 1)
      .finish();
    const loneJournal = lone.compose({});
    await expect(loneJournal.run(db, orphan.start, { input: {} }, caller)).rejects.toSatisfy(error =>
      isJournalError(error, 'WORKFLOW_UNKNOWN'),
    );
  });
});

describe('when and next', () => {
  it('a step whose when is false is skipped and its result is null, so a later step sees null and the body never ran', async () => {
    const skipped = newId('guarded');
    await journal.run(db, guarded.start, { input: { vip: false }, id: skipped }, caller);
    await settle();
    expect(await runRow(skipped)).toMatchObject({
      state: 'completed',
      results: { first: 'first', bonus: null, total: 1 },
      output: 1,
    });
    expect(await stepRow(skipped, 'bonus')).toMatchObject({ status: 'skipped', reason: 'when' });
    expect(ranOf('bonus')).toHaveLength(0);

    const taken = newId('guarded');
    await journal.run(db, guarded.start, { input: { vip: true }, id: taken }, caller);
    await settle();
    expect(await runRow(taken)).toMatchObject({ results: { bonus: { points: 10 }, total: 11 } });
  });

  it('a next that names an earlier step loops back, gives each visit its own key, and stops when it says next', async () => {
    const id = newId('hunt');
    await journal.run(db, hunt.start, { input: { rounds: 3 }, id }, caller);
    await settle();
    const mine = (name: string) => ranOf(name).filter(entry => entry.key.startsWith(id));
    expect(mine('generate').map(entry => entry.key)).toEqual([
      `${id}:generate:do`,
      `${id}:generate:do:2`,
      `${id}:generate:do:3`,
    ]);
    expect(mine('gate')).toHaveLength(3);
    expect(mine('publish')).toHaveLength(1);
    expect(await runRow(id)).toMatchObject({ state: 'completed', node: null });
  });

  it('a next that names a node that is not earlier fails the step as a bad definition, without a retry of the body', async () => {
    const id = newId('routed');
    await journal.run(db, routed.start, { input: {}, id }, caller);
    await settle();
    expect(ranOf('b').filter(entry => entry.key.startsWith(id))).toHaveLength(1);
    const step = await stepRow(id, 'b');
    expect(step?.status).toBe('failed');
    expect(step?.error).toContain('BAD_DEFINITION');
    expect((await runRow(id))?.state).toBe('running');
  });
});

describe('failure, retry and the key', () => {
  it('a failing step retries on its own backoff with one key, then waits dead for an operator while the run stays running', async () => {
    const id = newId('flaky');
    await journal.run(db, flaky.start, { input: {}, id }, caller);
    await settle();
    const tries = ranOf('provider').filter(entry => entry.key.startsWith(id));
    expect(tries.map(entry => entry.attempt)).toEqual([1, 2, 3]);
    expect(new Set(tries.map(entry => entry.key))).toEqual(new Set([`${id}:provider:do`]));
    expect(await stepRow(id, 'provider')).toMatchObject({ status: 'failed', attempt: 3 });
    expect((await stepRow(id, 'provider'))?.error).toContain('provider down');
    expect(await runRow(id)).toMatchObject({ state: 'running', node: 'provider' });
    expect((await eventTypes(id)).filter(type => type === 'NodeFailed')).toHaveLength(3);
    const [dead] = await jobsOf(id);
    expect(dead?.deadAt).toBeInstanceOf(Date);
    expect(await stepRow(id, 'after')).toBeUndefined();
  });

  it('a custom key reaches the body and the step row, so the provider and the operator see the same key', async () => {
    const id = newId('charge');
    await journal.run(db, charge.start, { input: { paymentId: 'pay_7' }, id }, caller);
    await settle();
    expect(ranOf('charge').filter(entry => entry.key === 'charge:pay_7')).toHaveLength(1);
    expect((await stepRow(id, 'charge'))?.key).toBe('charge:pay_7');
  });

  it('a step that runs past its timeout is aborted and fails with STEP_TIMEOUT', async () => {
    const id = newId('hanging');
    await journal.run(db, hanging.start, { input: {}, id }, caller);
    await settle();
    expect(sawAbort).toBe(true);
    const step = await stepRow(id, 'hang');
    expect(step?.status).toBe('failed');
    expect(step?.error).toContain('STEP_TIMEOUT');
  });
});

describe('payload limit', () => {
  it('a step result over limits.payload fails the step with WORKFLOW_LIMIT and stores nothing', async () => {
    const id = newId('small');
    await journal.run(db, small.start, { input: { text: 'ok' }, id }, caller);
    await settle();
    const step = await stepRow(id, 'big');
    expect(step?.status).toBe('failed');
    expect(step?.error).toContain('WORKFLOW_LIMIT');
    expect((await runRow(id))?.results).toEqual({});
  });

  it('a start input over limits.payload is a returned conflict, not a thrown error, and writes no run', async () => {
    const id = newId('small');
    const refused = await journal.run(db, small.start, { input: { text: 'y'.repeat(200) }, id }, caller);
    expect(isFailure(refused)).toBe(true);
    expect(await runRow(id)).toBeUndefined();
  });
});

describe('the checkpoint fence', () => {
  /** What another worker's claim does to this job's attempt row: closes it as superseded. */
  const supersede = async (id: string) => {
    const owned = await db.select({ id: tables.jobs.id }).from(tables.jobs).where(eq(tables.jobs.runId, id));
    await db
      .update(tables.jobAttempts)
      .set({ finishedAt: new Date(), outcome: 'superseded' })
      .where(
        and(
          inArray(
            tables.jobAttempts.jobId,
            owned.map(job => job.id),
          ),
          isNull(tables.jobAttempts.finishedAt),
        ),
      );
  };
  const supersedeFirst = { id: '' };
  // One compose with workflows per initJournal(): this block composes its own journal.
  const staleInit = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
  const stale = staleInit
    .workflow('test.stale', { version: 1, input: z.object({}) })
    .step('slow', async ctx => {
      note('slow', ctx);
      await supersede(supersedeFirst.id);
      return 'late';
    })
    .finish();
  const staleJournal = staleInit.compose({ workflows: [stale], workflowMeta });

  it('a stale owner checkpoint is rejected with LEASE_LOST, so a superseded worker writes nothing', async () => {
    const id = newId('stale');
    supersedeFirst.id = id;
    await staleJournal.run(db, stale.start, { input: {}, id }, caller);
    await staleJournal.drain(db);
    expect(ranOf('slow').filter(entry => entry.key.startsWith(id))).toHaveLength(1);
    expect(await eventTypes(id)).toEqual(['RunStarted', 'NodeScheduled']);
    expect((await stepRow(id, 'slow'))?.status).toBe('scheduled');
    const [job] = await jobsOf(id);
    expect(job?.lastError).toContain('LEASE_LOST');
  });
});

describe('a crash between the body and the checkpoint', () => {
  const crashInit = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
  const crashing = crashInit
    .workflow('test.crashing', { version: 1, input: z.object({}) })
    .step('chargeCard', ctx => {
      note('chargeCard', ctx);
      return { chargeId: 'ch_1' };
    })
    .finish();
  const crashJournal = crashInit.compose({ workflows: [crashing], workflowMeta });
  let died = false;
  crashJournal.hooks.command.around(async (ctx, next) => {
    // The process dies after the body answered, before the checkpoint commits.
    if (ctx.name === 'workflow.checkpoint' && !died) {
      died = true;
      throw new Error('process died');
    }
    await next();
  });

  it('crash after external success before checkpoint re-runs the step with the same key, and the committed checkpoint never runs it again', async () => {
    const id = newId('crashing');
    await crashJournal.run(db, crashing.start, { input: {}, id }, caller);
    await crashJournal.drain(db);
    expect(await eventTypes(id)).toEqual(['RunStarted', 'NodeScheduled']);
    // The job failed; its retry is due.
    await db
      .update(tables.jobs)
      .set({ availableAt: new Date(0) })
      .where(eq(tables.jobs.runId, id));
    await crashJournal.drain(db);
    await crashJournal.drain(db);
    const tries = ranOf('chargeCard').filter(entry => entry.key.startsWith(id));
    expect(tries).toHaveLength(2);
    expect(tries[0]?.key).toBe(tries[1]?.key);
    expect(await runRow(id)).toMatchObject({ state: 'completed', results: { chargeCard: { chargeId: 'ch_1' } } });
    expect((await eventTypes(id)).filter(type => type === 'NodeCompleted')).toHaveLength(1);
    await crashJournal.drain(db);
    expect(ranOf('chargeCard').filter(entry => entry.key.startsWith(id))).toHaveLength(2);
  });
});
