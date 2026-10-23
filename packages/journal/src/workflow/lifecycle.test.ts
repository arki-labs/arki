/**
 * Lifecycle hooks (`on`) on PGlite. A hook is how an app reacts to a run's end: send the receipt, page someone, start
 * the follow-up. So it must run once the end is committed and never for an end that rolled back, must survive a crash
 * or a throw (it is a durable job, retried), must call the code of the run's own version, and must never be able to
 * change a run that is already over.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { IdGenerationFailure } from '@arki/contracts';
import { defineFailure, isFailure, orThrow } from '@arki/failure';

import type { j as sharedJournal } from '../test-support.js';
import { need } from '../handlers.js';
import { initJournal } from '../journal.js';
import { tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';
import { LIFECYCLE_EFFECT } from './runner.js';

const caller = { actorId: 'usr_test' };
const workflowMeta = { actorId: 'system:workflow' };
const operator = { actor: 'usr_ops' };
type Init = typeof sharedJournal;
/** A journal setup of its own: one compose with workflows per `initJournal()`. */
const fresh = (): Init => initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });

const Declined = defineFailure('test.lifecycle_declined', { status: 409 });

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

beforeEach(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterEach(() => client.close());

type Draining = { readonly drain: (db: PgliteDatabase) => Promise<number | IdGenerationFailure> };
async function settle(journal: Draining, limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the runs did not settle');
}

/** A run's state, or undefined when there is no such run. */
const stateOf = (id: string) =>
  db
    .select({ state: tables.workflowRuns.state })
    .from(tables.workflowRuns)
    .where(eq(tables.workflowRuns.id, id))
    .then(([row]) => row?.state);
/** Every hook job ever written, live or archived. */
const hookJobs = async () => {
  const live = await db.select().from(tables.jobs).where(eq(tables.jobs.effect, LIFECYCLE_EFFECT));
  const archived = await db.select().from(tables.jobArchive).where(eq(tables.jobArchive.effect, LIFECYCLE_EFFECT));
  return { live, archived };
};
/** Makes every waiting job due now: the faked passing of a retry's delay. */
const makeDue = () =>
  db
    .update(tables.jobs)
    .set({ availableAt: sql`now() - interval '1 hour'` })
    .where(isNotNull(tables.jobs.effect));

describe('on: lifecycle hooks', () => {
  it('success gets the typed output once, only after the end is committed, then complete runs', async () => {
    const init = fresh();
    const calls: string[] = [];
    const outputs: unknown[] = [];
    const total = init.task(
      'test.lifecycle.total',
      {
        version: 1,
        input: z.object({ cents: z.array(z.int()) }),
        output: z.object({ total: z.int() }),
        on: {
          success: ctx => {
            calls.push(`success ${ctx.workflow} v${ctx.version} ${ctx.runId}`);
            outputs.push({
              output: ctx.output,
              input: ctx.input,
              scope: ctx.scope,
              tags: ctx.tags,
              metadata: ctx.metadata,
              state: ctx.state,
            });
          },
          complete: ctx => void calls.push(`complete ${ctx.state}`),
        },
      },
      ({ input }) => ({ total: input.cents.reduce((sum, cents) => sum + cents, 0) }),
    );
    const journal = init.compose({ workflows: [total], workflowMeta });
    // The run's last checkpoint rolls back while this is set: the run has not ended, so no hook may run.
    let rollBack = true;
    journal.hooks.command.around(async (ctx, next) => {
      await next();
      if (rollBack && ctx.name === 'workflow.checkpoint') throw new Error('the checkpoint transaction rolls back');
    });

    const id = newId('total');
    orThrow(
      await journal.run(
        db,
        total.start,
        { input: { cents: [2, 3] }, id, scope: 'org_1', tags: ['billing'], metadata: { source: 'test' } },
        caller,
      ),
    );
    await settle(journal);
    // The step's job is dead (its checkpoint never committed), so the run has not ended and no hook job exists.
    expect(await stateOf(id)).toBe('running');
    expect(calls).toEqual([]);
    expect(await hookJobs()).toEqual({ live: [], archived: [] });

    rollBack = false;
    orThrow(await journal.workflows.retryStep(db, { runId: id, path: 'run', phase: 'do' }, operator));
    await settle(journal);
    expect(await stateOf(id)).toBe('completed');
    expect(calls).toEqual([`success test.lifecycle.total v1 ${id}`, 'complete completed']);
    expect(outputs).toEqual([
      {
        output: { total: 5 },
        input: { cents: [2, 3] },
        scope: 'org_1',
        tags: ['billing'],
        metadata: { source: 'test' },
        state: 'completed',
      },
    ]);
    const jobs = await hookJobs();
    expect(jobs.live).toHaveLength(0);
    expect(jobs.archived).toHaveLength(1);
  });

  it('failure gets the error text after the undo ran, when a dead step makes the run compensate', async () => {
    const init = fresh();
    const log: string[] = [];
    const charge = init
      .workflow('test.lifecycle.charge', {
        version: 1,
        input: z.object({}),
        onDeadStep: 'compensate',
        on: {
          failure: ctx => void log.push(`failure: ${ctx.error.length > 0 ? 'has error text' : 'no text'}`),
          complete: ctx => void log.push(`complete ${ctx.state}`),
        },
      })
      .step('reserve', () => void log.push('reserve'), { undo: () => void log.push('undo reserve') })
      .step('charge', () => Declined({}))
      .finish();
    const journal = init.compose({ workflows: [charge], workflowMeta });

    const id = newId('charge');
    orThrow(await journal.run(db, charge.start, { input: {}, id }, caller));
    await settle(journal);
    expect(await stateOf(id)).toBe('failed');
    expect(log).toEqual(['reserve', 'undo reserve', 'failure: has error text', 'complete failed']);
  });

  it('cancel runs for a cancelled run, and complete after it', async () => {
    const init = fresh();
    const log: string[] = [];
    const approval = init
      .workflow('test.lifecycle.approval', {
        version: 1,
        input: z.object({}),
        on: {
          success: () => void log.push('success'),
          cancel: ctx => void log.push(`cancel ${ctx.runId}`),
          complete: ctx => void log.push(`complete ${ctx.state}`),
        },
      })
      .waitFor('approve', { signal: 'approve', schema: z.object({}) })
      .finish();
    const journal = init.compose({ workflows: [approval], workflowMeta });

    const id = newId('approval');
    orThrow(await journal.run(db, approval.start, { input: {}, id }, caller));
    await settle(journal);
    expect(log).toEqual([]);
    orThrow(await journal.workflows.cancel(db, { runId: id, reason: 'withdrawn' }, operator));
    await settle(journal);
    expect(await stateOf(id)).toBe('cancelled');
    expect(log).toEqual([`cancel ${id}`, 'complete cancelled']);
  });

  it('expired runs for a run whose ttl passed before it started, and complete after it', async () => {
    const init = fresh();
    const log: string[] = [];
    const remind = init.task(
      'test.lifecycle.remind',
      {
        version: 1,
        input: z.object({ to: z.string() }),
        on: {
          expired: ctx => void log.push(`expired ${ctx.input.to}`),
          complete: ctx => void log.push(`complete ${ctx.state}`),
        },
      },
      ({ input }) => void log.push(`reminded ${input.to}`),
    );
    const journal = init.compose({ workflows: [remind], workflowMeta });

    const id = newId('remind');
    orThrow(await journal.run(db, remind.start, { input: { to: 'ann' }, id, ttl: '1h' }, caller));
    await db
      .update(tables.workflowRuns)
      .set({ ttlAt: sql`now() - interval '1 minute'` })
      .where(eq(tables.workflowRuns.id, id));
    await settle(journal);
    expect(await stateOf(id)).toBe('expired');
    expect(log).toEqual(['expired ann', 'complete expired']);
  });

  it('a hook that throws is retried as a job, and the run stays completed the whole time', async () => {
    const init = fresh();
    const attempts: number[] = [];
    const ping = init.task(
      'test.lifecycle.ping',
      {
        version: 1,
        input: z.object({}),
        on: {
          success: ctx => {
            attempts.push(ctx.attempt);
            if (ctx.attempt === 1) throw new Error('the mail server is down');
          },
        },
      },
      () => 'pong',
    );
    const journal = init.compose({ workflows: [ping], workflowMeta });

    const id = newId('ping');
    orThrow(await journal.run(db, ping.start, { input: {}, id }, caller));
    await settle(journal);
    expect(attempts).toEqual([1]);
    expect(await stateOf(id)).toBe('completed');
    const [waiting] = await hookJobs().then(jobs => jobs.live);
    // A throw is stored as a defect (its text stays private) and retried later, not dead.
    expect(waiting?.lastError).toContain('unexpected_defect');
    expect(waiting?.attempts).toBe(1);
    expect(waiting?.deadAt).toBeNull();

    await makeDue();
    await settle(journal);
    expect(attempts).toEqual([1, 2]);
    expect(await stateOf(id)).toBe('completed');
    expect(await hookJobs().then(jobs => jobs.live)).toHaveLength(0);
  });

  it('a hook that returns a failure is final: its job is dead at once, and the run is still completed', async () => {
    const init = fresh();
    let calls = 0;
    const ping = init.task(
      'test.lifecycle.refused',
      {
        version: 1,
        input: z.object({}),
        on: {
          success: () => {
            calls += 1;
            return Declined({});
          },
        },
      },
      () => 'pong',
    );
    const journal = init.compose({ workflows: [ping], workflowMeta });

    const id = newId('refused');
    orThrow(await journal.run(db, ping.start, { input: {}, id }, caller));
    await settle(journal);
    const [dead] = await db
      .select()
      .from(tables.jobs)
      .where(and(eq(tables.jobs.effect, LIFECYCLE_EFFECT), isNotNull(tables.jobs.deadAt)));
    expect(dead).toBeDefined();
    expect(calls).toBe(1);
    expect(await stateOf(id)).toBe('completed');
  });

  it('a version 1 run calls the version 1 hook, even after version 2 is deployed', async () => {
    const log: string[] = [];
    const approvalV = (init: Init, version: number) =>
      init
        .workflow('test.lifecycle.versioned', {
          version,
          input: z.object({}),
          on: { cancel: () => void log.push(`v${version} cancel`) },
        })
        .waitFor('approve', { signal: 'approve', schema: z.object({}) })
        .finish();
    const first = fresh();
    const v1 = approvalV(first, 1);
    const before = first.compose({ workflows: [v1], workflowMeta });
    const id = newId('versioned');
    orThrow(await before.run(db, v1.start, { input: {}, id }, caller));
    await settle(before);

    // The deploy: a new process declares both versions and composes once.
    const deployed = fresh();
    const after = deployed.compose({
      workflows: [approvalV(deployed, 1), approvalV(deployed, 2)],
      workflowMeta,
    });
    orThrow(await after.workflows.cancel(db, { runId: id, reason: 'withdrawn' }, operator));
    await settle(after);
    expect(log).toEqual(['v1 cancel']);
  });

  it('a compose with no on queues no hook job at all', async () => {
    const init = fresh();
    const plain = init.task('test.lifecycle.plain', { version: 1, input: z.object({}) }, () => 'done');
    const journal = init.compose({ workflows: [plain], workflowMeta });

    const id = newId('plain');
    orThrow(await journal.run(db, plain.start, { input: {}, id }, caller));
    await settle(journal);
    expect(await stateOf(id)).toBe('completed');
    expect(await hookJobs()).toEqual({ live: [], archived: [] });
  });

  it('next to a definition with on, a run of one without on ends its hook job as done and calls nothing', async () => {
    const init = fresh();
    const log: string[] = [];
    const hooked = init.task(
      'test.lifecycle.hooked',
      { version: 1, input: z.object({}), on: { complete: () => void log.push('hooked complete') } },
      () => 'done',
    );
    const plain = init.task('test.lifecycle.unhooked', { version: 1, input: z.object({}) }, () => 'done');
    const journal = init.compose({ workflows: [hooked, plain], workflowMeta });

    orThrow(await journal.run(db, plain.start, { input: {}, id: newId('unhooked') }, caller));
    await settle(journal);
    expect(log).toEqual([]);
    const jobs = await hookJobs();
    expect(jobs.live).toHaveLength(0);
    expect(jobs.archived).toHaveLength(1);
  });

  it('a hook gets the needs of its definition, and its ctx.run records workflowMeta', async () => {
    type Mailer = { send(to: string): void };
    const sent: string[] = [];
    const mailer: Mailer = { send: to => void sent.push(to) };
    const init = fresh();
    const followUp = init.task('test.lifecycle.followUp', { version: 1, input: z.object({ to: z.string() }) }, () => 1);
    const signup = init.task(
      'test.lifecycle.signup',
      {
        version: 1,
        input: z.object({ email: z.string() }),
        needs: { mailer: need<Mailer>() },
        on: {
          success: async ctx => {
            ctx.mailer.send(ctx.input.email);
            const started = await ctx.run(followUp.start, {
              input: { to: ctx.input.email },
              id: `follow_${ctx.runId}`,
            });
            return isFailure(started) ? started : undefined;
          },
        },
      },
      () => 'welcome',
    );
    const journal = init.compose({ workflows: [followUp, signup], workflowMeta, services: { mailer } });

    const id = newId('signup');
    orThrow(await journal.run(db, signup.start, { input: { email: 'ann@example.com' }, id }, caller));
    await settle(journal);
    expect(sent).toEqual(['ann@example.com']);
    expect(await stateOf(`follow_${id}`)).toBe('completed');
    const [started] = await db
      .select({ meta: tables.events.meta })
      .from(tables.events)
      .where(and(eq(tables.events.entityId, `follow_${id}`), eq(tables.events.type, 'RunStarted')));
    expect(started?.meta).toEqual(workflowMeta);
  });
});
