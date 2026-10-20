/**
 * Versions and stranded runs on PGlite. A run pins its `(name, version)` and shape; new runs start the newest version,
 * an older version only finishes its runs, and a run whose code is gone or edited is never run with other code: its jobs
 * are dead at once and visible, and an operator retries them when the code is back.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { asc, eq, isNotNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TransactionDefect } from '@arki/db/transaction';
import { isFailure, orThrow } from '@arki/failure';

import type { j as sharedJournal } from '../test-support.js';
import { WorkflowStranded } from '../errors.js';
import { initJournal } from '../journal.js';
import { tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const caller = { actorId: 'usr_test' };
const workflowMeta = { actorId: 'system:workflow' };
const operator = { actor: 'usr_ops' };
type Init = typeof sharedJournal;
/** A journal setup of its own: its commands only know what its `compose` registered. */
const fresh = (): Init => initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });

/** Version 1 lets two people approve, and waits an hour before it asks. */
const ApprovalV1 = z.object({ by: z.enum(['ann', 'bob']) });
const ApprovalV2 = z.object({ by: z.string().min(1) });

const refundV1 = (init: Init, log: string[]) =>
  init
    .workflow('refund', { version: 1, input: z.object({ cents: z.int() }) })
    .step('charge', () => void log.push('v1 charge'), { undo: () => void log.push('v1 undo charge') })
    .sleep('cool', '1h')
    .waitFor('approve', { signal: 'approve', schema: ApprovalV1 })
    .step('pay', () => void log.push('v1 pay'))
    .finish();

const refundV2 = (init: Init, log: string[]) =>
  init
    .workflow('refund', { version: 2, input: z.object({ cents: z.int() }) })
    .step('charge', () => void log.push('v2 charge'), { undo: () => void log.push('v2 undo charge') })
    .step('audit', () => void log.push('v2 audit'))
    .waitFor('approve', { signal: 'approve', schema: ApprovalV2 })
    .step('pay', () => void log.push('v2 pay'))
    .finish();

/** The same name and version as `refundV1`, with another node in the middle: an edit that forgot to bump the version. */
const editedRefundV1 = (init: Init, log: string[]) =>
  init
    .workflow('refund', { version: 1, input: z.object({ cents: z.int() }) })
    .step('charge', () => void log.push('edited charge'), { undo: () => void log.push('edited undo charge') })
    .step('extra', () => void log.push('edited extra'))
    .sleep('cool', '1h')
    .waitFor('approve', { signal: 'approve', schema: ApprovalV1 })
    .step('pay', () => void log.push('edited pay'))
    .finish();

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

beforeEach(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterEach(() => client.close());

const eventTypesOf = async (id: string) => {
  const rows = await db
    .select({ type: tables.events.type })
    .from(tables.events)
    .where(eq(tables.events.entityId, id))
    .orderBy(asc(tables.events.seq));
  return rows.map(row => row.type);
};

type Draining = { readonly drain: (db: PgliteDatabase) => Promise<number> };
async function settle(journal: Draining, limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db)) === 0) return;
  }
  throw new Error('the runs did not settle');
}

/** Moves the clock forward for one run: every time column that decides when something happens shifts back. */
async function tick(runId: string, seconds: number) {
  const back = sql`make_interval(secs => ${seconds})`;
  await db
    .update(tables.jobs)
    .set({ availableAt: sql`${tables.jobs.availableAt} - ${back}` })
    .where(eq(tables.jobs.runId, runId));
  await db
    .update(tables.jobs)
    .set({ availableAt: sql`${tables.jobs.availableAt} - ${back}` })
    .where(eq(tables.jobs.effect, 'workflow.timer'));
  await db
    .update(tables.workflowRuns)
    .set({ wakeAt: sql`${tables.workflowRuns.wakeAt} - ${back}` })
    .where(eq(tables.workflowRuns.id, runId));
}

const rowOf = async (id: string) => {
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  return row;
};
const eventTypes = async (id: string) => {
  const found = await db
    .select({ type: tables.events.type })
    .from(tables.events)
    .where(eq(tables.events.entityId, id))
    .orderBy(asc(tables.events.seq));
  return found.map(event => event.type);
};
const deadJobs = () => db.select().from(tables.jobs).where(isNotNull(tables.jobs.deadAt));
const expectOk = (result: unknown) => expect(isFailure(result)).toBe(false);

describe('versions', () => {
  it('version 2 leaves version 1 runs untouched', async () => {
    const init = fresh();
    const log: string[] = [];
    const v1 = refundV1(init, log);
    const first = init.compose({ workflows: [v1], workflowMeta });
    const finishing = newId('finishing');
    const cancelling = newId('cancelling');
    expectOk(await first.run(db, v1.start, { input: { cents: 5 }, id: finishing }, caller));
    expectOk(await first.run(db, v1.start, { input: { cents: 5 }, id: cancelling }, caller));
    await settle(first);
    log.length = 0;

    // The deploy: a new process declares both versions and composes once.
    const deployed = fresh();
    const v2 = refundV2(deployed, log);
    const both = deployed.compose({ workflows: [refundV1(deployed, log), v2], workflowMeta });
    // The timer of version 1 fires after version 2 is registered: the run goes on with version 1's nodes.
    await tick(finishing, 3700);
    await settle(both);
    expect(await rowOf(finishing)).toMatchObject({ state: 'parked', node: 'approve', workflowVersion: 1 });

    // `by: 'zed'` is fine for version 2's signal and refused by version 1's schema, which this run was started with.
    const refused = await both.run(
      db,
      v2.signal('approve'),
      { runId: finishing, deliveryId: 'd1', payload: { by: 'zed' } },
      caller,
    );
    expect(isFailure(refused)).toBe(true);
    expectOk(
      await both.run(db, v2.signal('approve'), { runId: finishing, deliveryId: 'd2', payload: { by: 'ann' } }, caller),
    );
    expectOk(await both.run(db, v2.cancel, { runId: cancelling, reason: 'changed my mind' }, caller));
    await settle(both);

    expect(await rowOf(finishing)).toMatchObject({ state: 'completed', workflowVersion: 1 });
    expect(await rowOf(cancelling)).toMatchObject({ state: 'cancelled', workflowVersion: 1 });
    expect(log).toEqual(['v1 pay', 'v1 undo charge']);
  });

  it('a second compose with workflows on one initJournal is refused, so commands and worker never see different code', () => {
    const init = fresh();
    const v1 = refundV1(init, []);
    init.compose({ workflows: [v1], workflowMeta });
    expect(() => init.compose({ workflows: [v1, refundV2(init, [])], workflowMeta })).toThrow(
      /compose workflows once per initJournal/,
    );
  });

  it('new runs start the highest registered version', async () => {
    const init = fresh();
    const log: string[] = [];
    const v1 = refundV1(init, log);
    const v2 = refundV2(init, log);
    // Registration order does not decide it.
    const journal = init.compose({ workflows: [v2, v1], workflowMeta });
    const id = newId('newest');
    expectOk(await journal.run(db, v2.start, { input: { cents: 1 }, id }, caller));
    expect(await rowOf(id)).toMatchObject({ workflowVersion: 2 });
    await settle(journal);
    expect(log).toEqual(['v2 charge', 'v2 audit']);
  });

  it('starting a retired version is refused', async () => {
    const init = fresh();
    const log: string[] = [];
    const v1 = refundV1(init, log);
    const v2 = refundV2(init, log);
    const journal = init.compose({ workflows: [v1, v2], workflowMeta });
    const id = newId('retired');
    await expect(journal.run(db, v1.start, { input: { cents: 1 }, id }, caller)).resolves.toMatchObject({ code: TransactionDefect.code, cause: { code: 'WORKFLOW_VERSION_RETIRED' } });
    expect(await rowOf(id)).toBeUndefined();
  });

  it('a v1 parent still starts its v1 child after v2 of the child is registered', async () => {
    const init = fresh();
    const log: string[] = [];
    const kidV1 = init
      .workflow('kid', { version: 1, input: z.object({}) })
      .step('work', () => 'v1 kid')
      .finish();
    const kidV2 = init
      .workflow('kid', { version: 2, input: z.object({}) })
      .step('work', () => 'v2 kid')
      .step('more', () => 'more')
      .finish();
    const parent = init
      .workflow('parent', { version: 1, input: z.object({}) })
      .child('kid', kidV1, { input: () => ({}) })
      .step('after', ({ results }) => void log.push(`parent saw ${results.kid}`))
      .finish();
    const journal = init.compose({ workflows: [parent, kidV1, kidV2], workflowMeta });
    const id = newId('parent');
    expectOk(await journal.run(db, parent.start, { input: {}, id }, caller));
    await settle(journal);
    const [kid] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.parentId, id));
    expect(kid).toMatchObject({ name: 'kid', workflowVersion: 1, state: 'completed' });
    expect(await rowOf(id)).toMatchObject({ state: 'completed' });
    expect(log).toEqual(['parent saw v1 kid']);
  });

  it('two versions with one name and version but different shapes are refused at compose', () => {
    const init = fresh();
    const log: string[] = [];
    expect(() =>
      init.compose({ workflows: [refundV1(init, log), editedRefundV1(init, log)], workflowMeta }),
    ).toThrowError(expect.objectContaining({ code: 'BAD_DEFINITION' }));
  });
});

describe('stranded runs', () => {
  it('an edited shape strands its runs instead of running the wrong step', async () => {
    const original = fresh();
    const log: string[] = [];
    const v1 = refundV1(original, log);
    const journalA = original.compose({ workflows: [v1], workflowMeta });
    const id = newId('edited');
    expectOk(await journalA.run(db, v1.start, { input: { cents: 1 }, id }, caller));

    const edited = fresh();
    const journalB = edited.compose({ workflows: [editedRefundV1(edited, log)], workflowMeta });
    await settle(journalB);

    expect(log, 'no node body ran, with either version of the code').toEqual([]);
    expect(await eventTypes(id)).toEqual(['RunStarted', 'NodeScheduled']);
    expect(await rowOf(id)).toMatchObject({ state: 'running' });
    const dead = await deadJobs();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ attempts: 1, effect: 'workflow.step' });
    expect(dead[0]?.lastError).toContain('has other nodes');
    expect(JSON.parse(dead[0]?.lastError ?? 'null')).toMatchObject({
      code: WorkflowStranded.code,
      data: { runId: id, name: 'refund', version: 1, reason: 'WORKFLOW_SHAPE_CHANGED' },
    });
  });

  it('a run whose version is no longer registered is stranded, not run with other code', async () => {
    const original = fresh();
    const log: string[] = [];
    const v1 = refundV1(original, log);
    const journalA = original.compose({ workflows: [v1], workflowMeta });
    const id = newId('gone');
    expectOk(await journalA.run(db, v1.start, { input: { cents: 1 }, id }, caller));

    const later = fresh();
    const journalB = later.compose({ workflows: [refundV2(later, log)], workflowMeta });
    await settle(journalB);

    expect(log, 'version 2 did not run the step of a version 1 run').toEqual([]);
    expect(await rowOf(id)).toMatchObject({ state: 'running', workflowVersion: 1 });
    const dead = await deadJobs();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ attempts: 1 });
    expect(JSON.parse(dead[0]?.lastError ?? 'null')).toMatchObject({
      code: WorkflowStranded.code,
      data: { runId: id, name: 'refund', version: 1, reason: 'WORKFLOW_UNKNOWN' },
    });
  });

  it('retryStep resumes a stranded run once its code is back', async () => {
    const original = fresh();
    const log: string[] = [];
    const v1 = refundV1(original, log);
    const journalA = original.compose({ workflows: [v1], workflowMeta });
    const id = newId('resumes');
    expectOk(await journalA.run(db, v1.start, { input: { cents: 1 }, id }, caller));
    const edited = fresh();
    const journalB = edited.compose({ workflows: [editedRefundV1(edited, log)], workflowMeta });
    await settle(journalB);
    const [dead] = await deadJobs();
    expect(dead).toBeDefined();

    // Still stranded: the retry says why and leaves the job dead.
    const retryCharge = (journal: typeof journalA) =>
      journal.workflows.retryStep(db, { runId: id, path: 'charge', phase: 'do' }, operator);
    await expect(retryCharge(journalB)).resolves.toMatchObject({ code: TransactionDefect.code, cause: { code: 'WORKFLOW_SHAPE_CHANGED' } });
    expect(await deadJobs()).toHaveLength(1);

    // The app deploys the old code again; the operator retries.
    expect(await retryCharge(journalA)).toEqual({ how: 'jobRetried' });
    await settle(journalA);
    expect(await eventTypesOf(id)).toContain('JobRetried');
    // The job verb's own audit row is written too.
    const operations = await journalA.jobOperations(db);
    expect(operations.operations.map(operation => operation.actor)).toContain('usr_ops');

    expect(log).toEqual(['v1 charge']);
    expect(await rowOf(id)).toMatchObject({ state: 'parked', node: 'cool' });
    await tick(id, 3700);
    await settle(journalA);
    expect(await rowOf(id)).toMatchObject({ state: 'parked', node: 'approve' });
  });

  it('a timer of a stranded run is dead at once, and the run wakes after the retry', async () => {
    const original = fresh();
    const log: string[] = [];
    const v1 = refundV1(original, log);
    const journalA = original.compose({ workflows: [v1], workflowMeta });
    const id = newId('timer');
    expectOk(await journalA.run(db, v1.start, { input: { cents: 1 }, id }, caller));
    await settle(journalA);
    await tick(id, 3700);
    const edited = fresh();
    const journalB = edited.compose({ workflows: [editedRefundV1(edited, log)], workflowMeta });
    await settle(journalB);

    expect(await rowOf(id)).toMatchObject({ state: 'parked', node: 'cool' });
    const dead = await deadJobs();
    expect(dead.map(job => [job.effect, job.attempts])).toEqual([['workflow.timer', 1]]);

    // The timer's job belongs to the park of `cool`, so that is the step to retry.
    orThrow(await journalA.workflows.retryStep(db, { runId: id, path: 'cool', phase: 'do' }, operator));
    await settle(journalA);
    expect(await rowOf(id)).toMatchObject({ state: 'parked', node: 'approve' });
  });

  it('retryStep on a stranded run also revives its deadline timer', async () => {
    const log: string[] = [];
    const deadlined = (init: Init, extra: boolean) => {
      const builder = init
        .workflow('refund', { version: 1, input: z.object({ cents: z.int() }), deadline: '2h' })
        .step('charge', () => void log.push('charge'), { undo: () => void log.push('undo charge') });
      return (extra ? builder.step('extra', () => void log.push('extra')) : builder)
        .waitFor('approve', { signal: 'approve', schema: ApprovalV1 })
        .finish();
    };
    const original = fresh();
    const v1 = deadlined(original, false);
    const journalA = original.compose({ workflows: [v1], workflowMeta });
    const id = newId('deadline');
    expectOk(await journalA.run(db, v1.start, { input: { cents: 1 }, id }, caller));
    await settle(journalA);
    expect(await rowOf(id)).toMatchObject({ state: 'parked', node: 'approve' });

    // The deadline comes while only the edited code is deployed: its timer dies at once.
    await tick(id, 3 * 3600);
    await db
      .update(tables.workflowRuns)
      .set({ deadlineAt: sql`${tables.workflowRuns.deadlineAt} - make_interval(secs => ${3 * 3600})` })
      .where(eq(tables.workflowRuns.id, id));
    const edited = fresh();
    const journalB = edited.compose({ workflows: [deadlined(edited, true)], workflowMeta });
    await settle(journalB);
    expect(await rowOf(id)).toMatchObject({ state: 'parked' });
    expect(await deadJobs()).toHaveLength(1);

    orThrow(await journalA.workflows.retryStep(db, { runId: id, path: 'approve', phase: 'do' }, operator));
    await settle(journalA);

    // The deadline fired: the run undid its charge and failed.
    expect(await rowOf(id)).toMatchObject({ state: 'failed' });
    expect(log).toEqual(['charge', 'undo charge']);
    expect(await deadJobs()).toHaveLength(0);
  });

  it('a signal to a stranded run is refused, not applied with the wrong schema', async () => {
    const original = fresh();
    const log: string[] = [];
    const v1 = refundV1(original, log);
    const journalA = original.compose({ workflows: [v1], workflowMeta });
    const id = newId('signal');
    expectOk(await journalA.run(db, v1.start, { input: { cents: 1 }, id }, caller));
    await settle(journalA);
    await tick(id, 3700);
    await settle(journalA);

    const edited = fresh();
    const editedDef = editedRefundV1(edited, log);
    const journalB = edited.compose({ workflows: [editedDef], workflowMeta });
    await expect(
      journalB.run(db, editedDef.signal('approve'), { runId: id, deliveryId: 'd1', payload: { by: 'ann' } }, caller),
    ).resolves.toMatchObject({ code: TransactionDefect.code, cause: { code: 'WORKFLOW_SHAPE_CHANGED' } });

    const later = fresh();
    const v2 = refundV2(later, log);
    const journalC = later.compose({ workflows: [v2], workflowMeta });
    await expect(
      journalC.run(db, v2.signal('approve'), { runId: id, deliveryId: 'd2', payload: { by: 'zed' } }, caller),
    ).resolves.toMatchObject({ code: TransactionDefect.code, cause: { code: 'WORKFLOW_UNKNOWN' } });
    expect(await db.select().from(tables.workflowSignals).where(eq(tables.workflowSignals.runId, id))).toEqual([]);
  });

  it('a cancel of a stranded run is refused and writes nothing, and works once the code is back', async () => {
    const original = fresh();
    const log: string[] = [];
    const v1 = refundV1(original, log);
    const journalA = original.compose({ workflows: [v1], workflowMeta });
    const id = newId('cancel');
    expectOk(await journalA.run(db, v1.start, { input: { cents: 1 }, id }, caller));
    await settle(journalA);
    const before = await eventTypes(id);

    const edited = fresh();
    const editedDef = editedRefundV1(edited, log);
    const journalB = edited.compose({ workflows: [editedDef], workflowMeta });
    await expect(journalB.run(db, editedDef.cancel, { runId: id, reason: 'stop' }, caller)).resolves.toMatchObject({ code: TransactionDefect.code, cause: { code: 'WORKFLOW_SHAPE_CHANGED' } });
    expect(await eventTypes(id), 'the refused cancel left no CancelRequested behind').toEqual(before);

    log.length = 0;
    expectOk(await journalA.run(db, v1.cancel, { runId: id, reason: 'stop' }, caller));
    await settle(journalA);
    expect(await rowOf(id)).toMatchObject({ state: 'cancelled' });
    expect(log).toEqual(['v1 undo charge']);
  });
});
