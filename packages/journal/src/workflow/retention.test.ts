/**
 * Retention of workflow runs on PGlite, and the guard around a run's jobs. A run row is kept for a time that depends
 * on how it ended; then `pruneWorkflows` deletes it and its steps, never its events. A job a run owns is the run's to
 * move: the raw job verbs refuse it, the sweeper leaves a live run's dead step alone, and the archive keeps `run_id`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, asc, count, eq, isNotNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { backoff } from '@arki/resilience';

import type { JobRetention } from '../retention.js';
import { jobId } from '../id.js';
import { initJournal } from '../journal.js';
import { createJobOps, createManagedJobOps } from '../outbox.js';
import { resolveRetention } from '../retention.js';
import { tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const caller = { actorId: 'usr_test' };
const workflowMeta = { actorId: 'system:workflow' };
const operator = { actor: 'usr_ops' };
const noRetry = backoff.constant(0).upTo(0);
const Go = z.object({});
const DAY = 86_400_000;
const HOUR = 3_600_000;

type Own = { readonly completed?: 'forever' | false | `${number}d`; readonly failed?: `${number}d` };

/** A journal of its own, with the workflows these tests need. `own` is the retention of the `quick` workflow. */
function build(retention: JobRetention = {}, own: Own = {}) {
  const init = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }), retention });
  const quick = init
    .workflow('quick', { version: 1, input: z.object({}), retention: own })
    .step('work', () => 'done')
    .finish();
  const sleeper = init
    .workflow('sleeper', { version: 1, input: z.object({}) })
    .step('charge', () => 'charged', { undo: () => void 0 })
    .sleep('cool', '1h')
    .finish();
  const stuck = init
    .workflow('stuck', { version: 1, input: z.object({}) })
    .step(
      'boom',
      () => {
        throw new Error('provider down');
      },
      { retry: noRetry },
    )
    .finish();
  const failing = init
    .workflow('failing', { version: 1, input: z.object({}), onDeadStep: 'compensate' })
    .step(
      'boom',
      () => {
        throw new Error('provider down');
      },
      { retry: noRetry },
    )
    .finish();
  const kid = init
    .workflow('kid', { version: 1, input: z.object({}) })
    .step('hold', () => 'held', { undo: () => void 0 })
    .waitFor('go', { signal: 'go', schema: Go })
    .finish();
  const parent = init
    .workflow('parent', { version: 1, input: z.object({}) })
    .child('kid', kid, { input: () => ({}) })
    .waitFor('confirm', { signal: 'confirm', schema: Go })
    .finish();
  const journal = init.compose({ workflows: [quick, sleeper, stuck, failing, kid, parent], workflowMeta });
  return { init, journal, quick, sleeper, stuck, failing, kid, parent };
}

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

beforeEach(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterEach(() => client.close());

const expectOk = (result: unknown) => expect(isFailure(result)).toBe(false);
async function settle(journal: { readonly drain: (db: PgliteDatabase) => Promise<number> }, limit = 60) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db)) === 0) return;
  }
  throw new Error('the runs did not settle');
}
const rowOf = async (id: string) => {
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  return row;
};
/** The hours between the end of a run and the time its row may go. */
const keptHours = async (id: string) => {
  const row = await rowOf(id);
  if (row?.keepUntil == null || row.finishedAt === null) throw new Error(`run ${id} has no keep_until`);
  return Math.round((row.keepUntil.getTime() - row.finishedAt.getTime()) / HOUR);
};
const expire = (where: ReturnType<typeof sql>) =>
  db.execute(sql`UPDATE workflow_runs SET keep_until = now() - interval '1 hour' WHERE ${where}`);
const eventCount = async (id: string) => {
  const [row] = await db.select({ n: count() }).from(tables.events).where(eq(tables.events.entityId, id));
  return row?.n ?? 0;
};
/** `pruneWorkflows` as an operator runs it; the number of runs it deleted. */
const prunedBy = async (journal: Pick<ReturnType<typeof build>['journal'], 'pruneWorkflows'>, limit?: number) => {
  const done = await journal.pruneWorkflows(db, limit === undefined ? {} : { limit }, operator);
  return done.pruned;
};
const operations = () => db.select().from(tables.jobOperations);
const hotJobsOf = (runId: string) => db.select().from(tables.jobs).where(eq(tables.jobs.runId, runId));
const archivedOf = (runId: string) =>
  db.select().from(tables.jobArchive).where(eq(tables.jobArchive.runId, runId)).orderBy(asc(tables.jobArchive.id));
const ageDeadJobs = (days: number) =>
  db
    .update(tables.jobs)
    .set({ deadAt: new Date(Date.now() - days * DAY) })
    .where(isNotNull(tables.jobs.deadAt));
const noWake = (): void => {
  // No worker to wake in this test.
};
const sweeper = () => createJobOps({ tables, retention: resolveRetention({}), wake: noWake }).sweepOnce(db);
/** The runner's own path to a run's jobs, as the retention policy sees it. */
const runOps = () => createManagedJobOps({ tables, retention: resolveRetention({}), wake: noWake });

describe('pruneWorkflows', () => {
  it('pruneWorkflows deletes finished runs past keep_until and keeps their events', async () => {
    const { journal, quick } = build();
    const id = newId('quick');
    expectOk(await journal.run(db, quick.start, { input: {}, id }, caller));
    await settle(journal);
    expect(await rowOf(id)).toMatchObject({ state: 'completed' });
    const events = await eventCount(id);
    expect(events).toBeGreaterThan(0);

    // Not yet: the default keeps a completed run 7 days.
    expect(await journal.pruneWorkflows(db, {}, operator)).toEqual({ pruned: 0, operationId: null });
    await expire(sql`id = ${id}`);
    const done = await journal.pruneWorkflows(db, {}, operator);

    expect(done.pruned).toBe(1);
    expect(await rowOf(id)).toBeUndefined();
    const steps = await db.select().from(tables.workflowSteps).where(eq(tables.workflowSteps.runId, id));
    expect(steps, 'the steps go with the run').toEqual([]);
    expect(await eventCount(id), 'the events are the record and stay').toBe(events);
    expect(await operations()).toEqual([
      expect.objectContaining({ action: 'pruneWorkflows', actor: 'usr_ops', jobIds: [id], count: 1 }),
    ]);
  });

  it('a completed child is not pruned while its parent can still compensate it', async () => {
    const { journal, parent, kid } = build();
    const id = newId('parent');
    expectOk(await journal.run(db, parent.start, { input: {}, id }, caller));
    await settle(journal);
    expectOk(await journal.run(db, kid.signal('go'), { runId: `${id}/kid`, deliveryId: 'go', payload: {} }, caller));
    await settle(journal);
    expect(await rowOf(`${id}/kid`)).toMatchObject({ state: 'completed' });
    expect(await rowOf(id)).toMatchObject({ state: 'parked' });

    await expire(sql`id = ${`${id}/kid`}`);
    expect(await prunedBy(journal)).toBe(0);
    expect(await rowOf(`${id}/kid`), 'the parent is unfinished, so its child stays').toBeDefined();

    // The parent is cancelled: it reopens the child, both end, and nothing can compensate them any more.
    expectOk(await journal.run(db, parent.cancel, { runId: id, reason: 'stop' }, caller));
    await settle(journal);
    expect(await rowOf(id)).toMatchObject({ state: 'cancelled' });
    expect(await rowOf(`${id}/kid`)).toMatchObject({ state: 'cancelled' });
    await expire(sql`finished_at IS NOT NULL`);
    expect(await prunedBy(journal)).toBe(2);
  });

  it('an unfinished run is never pruned', async () => {
    const { journal, sleeper } = build();
    const id = newId('parked');
    expectOk(await journal.run(db, sleeper.start, { input: {}, id }, caller));
    await settle(journal);
    expect(await rowOf(id)).toMatchObject({ state: 'parked', finishedAt: null });
    // A keep_until on a live run is a bug somewhere else; the prune must not make it worse.
    await expire(sql`id = ${id}`);
    expect(await prunedBy(journal)).toBe(0);
    expect(await rowOf(id)).toBeDefined();
  });

  it('the batch limit bounds one call, and the rest goes on the next', async () => {
    const { journal, quick } = build();
    for (const n of [1, 2, 3]) expectOk(await journal.run(db, quick.start, { input: {}, id: newId(`b${n}`) }, caller));
    await settle(journal);
    await expire(sql`finished_at IS NOT NULL`);
    expect(await prunedBy(journal, 2)).toBe(2);
    expect(await prunedBy(journal, 2)).toBe(1);
  });
});

describe('how long a run is kept', () => {
  it('the defaults are completed 7d, failed 90d, and a cancelled run follows failed', async () => {
    const { journal, quick, failing, sleeper } = build();
    const done = newId('done');
    const failed = newId('failed');
    const cancelled = newId('cancelled');
    expectOk(await journal.run(db, quick.start, { input: {}, id: done }, caller));
    expectOk(await journal.run(db, failing.start, { input: {}, id: failed }, caller));
    expectOk(await journal.run(db, sleeper.start, { input: {}, id: cancelled }, caller));
    await settle(journal);
    expectOk(await journal.run(db, sleeper.cancel, { runId: cancelled, reason: 'stop' }, caller));
    await settle(journal);
    expect(await keptHours(done)).toBe(7 * 24);
    expect(await rowOf(failed)).toMatchObject({ state: 'failed' });
    expect(await keptHours(failed)).toBe(90 * 24);
    expect(await keptHours(cancelled)).toBe(90 * 24);
  });

  it('cancelled runs follow retention.cancelled, which defaults to failed', async () => {
    const followsFailed = build({ workflows: { failed: '10d' } });
    const own = build({ workflows: { failed: '10d', cancelled: '2d' } });
    const first = newId('follows');
    const second = newId('own');
    expectOk(await followsFailed.journal.run(db, followsFailed.sleeper.start, { input: {}, id: first }, caller));
    await settle(followsFailed.journal);
    expectOk(
      await followsFailed.journal.run(db, followsFailed.sleeper.cancel, { runId: first, reason: 'stop' }, caller),
    );
    await settle(followsFailed.journal);
    expectOk(await own.journal.run(db, own.sleeper.start, { input: {}, id: second }, caller));
    await settle(own.journal);
    expectOk(await own.journal.run(db, own.sleeper.cancel, { runId: second, reason: 'stop' }, caller));
    await settle(own.journal);
    expect(await keptHours(first)).toBe(10 * 24);
    expect(await keptHours(second)).toBe(2 * 24);
  });

  it("a workflow's own retention overrides the journal default", async () => {
    const { journal, quick, sleeper } = build({ workflows: { completed: '7d' } }, { completed: '1d' });
    const own = newId('own');
    expectOk(await journal.run(db, quick.start, { input: {}, id: own }, caller));
    await settle(journal);
    expect(await keptHours(own)).toBe(24);
    // The workflow that sets nothing keeps the journal's time.
    const sleeperId = newId('plain');
    expectOk(await journal.run(db, sleeper.start, { input: {}, id: sleeperId }, caller));
    await settle(journal);
    await db.execute(sql`UPDATE workflow_runs SET wake_at = now() - interval '2 hours' WHERE id = ${sleeperId}`);
    await db.execute(
      sql`UPDATE journal_jobs SET available_at = now() - interval '2 hours' WHERE run_id = ${sleeperId}`,
    );
    await settle(journal);
    expect(await keptHours(sleeperId)).toBe(7 * 24);
  });

  it("'forever' keeps the row, and false makes the next prune delete it", async () => {
    const forever = build({}, { completed: 'forever' });
    const gone = build({}, { completed: false });
    const keep = newId('forever');
    const drop = newId('false');
    expectOk(await forever.journal.run(db, forever.quick.start, { input: {}, id: keep }, caller));
    await settle(forever.journal);
    expectOk(await gone.journal.run(db, gone.quick.start, { input: {}, id: drop }, caller));
    await settle(gone.journal);
    const kept = await rowOf(keep);
    expect(kept?.keepUntil).toBeNull();
    expect(await prunedBy(gone.journal)).toBe(1);
    expect(await rowOf(drop)).toBeUndefined();
    expect(await rowOf(keep)).toBeDefined();
  });

  it("'untilExported' is refused for workflow retention", () => {
    const refused = { code: 'BAD_DEFINITION' };
    expect(() => build({ workflows: { completed: 'untilExported' } })).toThrow(expect.objectContaining(refused));
    expect(() => build({ workflows: { cancelled: { age: '1d', max: 5 } } })).toThrow(expect.objectContaining(refused));
    const init = initJournal({ tables });
    expect(() =>
      init.workflow('w', { version: 1, input: z.object({}), retention: { failed: 'untilExported' } }),
    ).toThrow(expect.objectContaining(refused));
  });
});

describe("a run's jobs", () => {
  it('an archived workflow job keeps its run_id', async () => {
    const { journal, quick, stuck } = build();
    const done = newId('acked');
    expectOk(await journal.run(db, quick.start, { input: {}, id: done }, caller));
    await settle(journal);
    const acked = await archivedOf(done);
    expect(acked.length, 'the ack archives the finished step').toBeGreaterThan(0);
    expect(acked[0]).toMatchObject({ outcome: 'completed', effect: 'workflow.step', runId: done });

    const failed = newId('discarded');
    expectOk(await journal.run(db, stuck.start, { input: {}, id: failed }, caller));
    await settle(journal);
    const [dead] = await hotJobsOf(failed);
    await runOps().discard(db, dead?.id ?? '', operator);
    expect(await archivedOf(failed)).toEqual([expect.objectContaining({ outcome: 'discarded', runId: failed })]);
  });

  it("the sweeper never archives a live run's dead step", async () => {
    const { journal, stuck } = build();
    const live = newId('live');
    expectOk(await journal.run(db, stuck.start, { input: {}, id: live }, caller));
    await settle(journal);
    expect(await rowOf(live)).toMatchObject({ finishedAt: null });
    expect(await hotJobsOf(live)).toEqual([expect.objectContaining({ attempts: 1 })]);
    await ageDeadJobs(40);

    await sweeper();

    expect(await hotJobsOf(live), 'the live run still has its dead step to retry').toHaveLength(1);
    expect(await archivedOf(live)).toEqual([]);

    // The run ends: the dead job no longer has an owner who can retry it, so the sweeper archives it as any dead job.
    await db.execute(sql`UPDATE workflow_runs SET state = 'failed', finished_at = now() WHERE id = ${live}`);
    await sweeper();
    expect(await hotJobsOf(live)).toEqual([]);
    expect(await archivedOf(live)).toEqual([expect.objectContaining({ outcome: 'dead', runId: live })]);
  });

  it('raw discard refuses a workflow-managed job with JOB_MANAGED, and so do retry, cancel and replayJob', async () => {
    const { journal, stuck, sleeper, quick } = build();
    const dead = newId('dead');
    const waiting = newId('waiting');
    const acked = newId('acked');
    expectOk(await journal.run(db, stuck.start, { input: {}, id: dead }, caller));
    expectOk(await journal.run(db, sleeper.start, { input: {}, id: waiting }, caller));
    expectOk(await journal.run(db, quick.start, { input: {}, id: acked }, caller));
    await settle(journal);
    const [deadJob] = await hotJobsOf(dead);
    const [timer] = await hotJobsOf(waiting);
    const [archived] = await archivedOf(acked);
    expect(deadJob?.deadAt).not.toBeNull();
    expect(timer).toMatchObject({ effect: 'workflow.timer' });
    const refused = expect.objectContaining({ code: 'JOB_MANAGED' });

    await expect(journal.retry(db, deadJob?.id ?? '', operator)).rejects.toEqual(refused);
    await expect(journal.discard(db, deadJob?.id ?? '', operator)).rejects.toEqual(refused);
    await expect(journal.cancel(db, timer?.id ?? '', operator)).rejects.toEqual(refused);
    await expect(journal.replayJob(db, archived?.id ?? '', operator)).rejects.toEqual(refused);

    expect(await hotJobsOf(dead), 'the dead step is untouched').toEqual([deadJob]);
    expect(await hotJobsOf(waiting), 'the timer is untouched').toEqual([timer]);
    expect(await operations(), 'a refusal writes no operation row').toEqual([]);
  });

  it('retryDead and purgeDead leave workflow-managed jobs alone', async () => {
    const { journal, stuck } = build();
    const run = newId('stuck');
    expectOk(await journal.run(db, stuck.start, { input: {}, id: run }, caller));
    await settle(journal);
    const [managed] = await hotJobsOf(run);
    const loose = jobId();
    await db.insert(tables.jobs).values({ id: loose, kind: 'queue', jobName: 'demo', args: {}, deadAt: new Date() });
    await ageDeadJobs(40);

    const retried = await journal.retryDead(db, {}, operator);
    expect(retried.ids, "the count of a bulk retry is the loose job's alone").toEqual([loose]);
    await expect(journal.retryDead(db, { ids: [managed?.id ?? ''] }, operator)).rejects.toMatchObject({
      code: 'JOB_MANAGED',
    });

    await db
      .update(tables.jobs)
      .set({ deadAt: new Date(Date.now() - 40 * DAY) })
      .where(eq(tables.jobs.id, loose));
    const purged = await journal.purgeDead(db, { olderThan: new Date(Date.now() - 35 * DAY) }, operator);
    expect(purged).toMatchObject({ archived: 1, deleted: 0 });
    expect(await archivedOf(run)).toEqual([]);
    const [still] = await hotJobsOf(run);
    expect(still).toMatchObject({ id: managed?.id, attempts: managed?.attempts });
    expect(still?.deadAt).not.toBeNull();
  });

  it('the runner still cancels its own timers', async () => {
    const { journal, sleeper } = build();
    const id = newId('sleeping');
    expectOk(await journal.run(db, sleeper.start, { input: {}, id }, caller));
    await settle(journal);
    const [timer] = await hotJobsOf(id);
    expect(timer).toMatchObject({ effect: 'workflow.timer' });

    expectOk(await journal.run(db, sleeper.cancel, { runId: id, reason: 'stop' }, caller));
    await settle(journal);

    expect(await hotJobsOf(id)).toEqual([]);
    const archived = await archivedOf(id);
    expect(archived.filter(job => job.outcome === 'cancelled')).toEqual([
      expect.objectContaining({ id: timer?.id, runId: id }),
    ]);
    const cancels = await db
      .select({ n: count() })
      .from(tables.jobOperations)
      .where(and(eq(tables.jobOperations.action, 'cancel'), eq(tables.jobOperations.actor, 'system:workflow')));
    expect(cancels[0]?.n).toBeGreaterThan(0);
  });
});
