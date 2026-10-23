/**
 * The checkpoint fence on real Postgres with two workers on two connections: a run's node is checkpointed once,
 * whichever worker is slow. Needs Docker: starts a `postgres:16` container through testcontainers.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import { WorkflowBusy } from '../errors.js';
import { j, tables } from '../test-support.js';
import { limitLockId } from './limits.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;
let next = 0;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const noop = (): void => {
  // Replaced by the promise's resolver before the gate is returned.
};

/** A promise a test settles by hand, to hold a worker at a chosen point. */
function gate() {
  let open = noop;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { opened, open };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  poolA = new pg.Pool({ connectionString: container.getConnectionUri(), max: 3 });
  poolB = new pg.Pool({ connectionString: container.getConnectionUri(), max: 3 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema({ ...tables }, dbA);
  await apply();
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

type Script = { readonly started: ReturnType<typeof gate>; readonly hold: ReturnType<typeof gate> };
const script = (): Script => ({ started: gate(), hold: gate() });
let first = script();
let second = script();
let bodies = 0;
let checkpoints = 0;
const keys: string[] = [];
/** 'body': the first worker waits inside the step body. 'checkpoint': it waits inside the checkpoint command's transaction. */
let holdAt: 'body' | 'checkpoint' = 'body';

beforeEach(async () => {
  await dbA.delete(tables.jobs).where(sql`true`);
  first = script();
  second = script();
  bodies = 0;
  checkpoints = 0;
  keys.length = 0;
  holdAt = 'body';
});

const racing = j
  .workflow('test.racing', { version: 1, input: z.object({}) })
  .step('settle', async ctx => {
    bodies += 1;
    keys.push(ctx.key);
    const mine = bodies === 1 ? first : second;
    if (holdAt === 'body') {
      mine.started.open();
      await mine.hold.opened;
    }
    return { settled: bodies };
  })
  .step('after', () => 'done')
  .finish();

/** Two imports per account at a time: the start gate counts under an advisory lock. */
const gated = j
  .workflow('test.gated', {
    version: 1,
    input: z.object({ account: z.string() }),
    concurrency: { key: ({ account }) => account, limit: 2, onBusy: 'refuse' },
  })
  .step('load', () => 'loaded')
  .finish();

/** Three uploads at a time and one per account, across two workflows: each count is taken under its own lock. */
const uploads = j.limit({ name: 'test.uploads', total: 3, perKey: 1 });
const uploadOf = (name: string) =>
  j
    .workflow(name, {
      version: 1,
      input: z.object({ account: z.string() }),
      concurrency: { key: ({ account }) => account, shared: [uploads], onBusy: 'refuse' },
    })
    .step('load', () => 'loaded')
    .finish();
const uploadA = uploadOf('test.upload-a');
const uploadB = uploadOf('test.upload-b');

/** How many `load` bodies of the queued workflow run at once, and the most seen: the limit must cap it. */
const inFlight = { now: 0, most: 0 };
/** One load per account at a time; a busy start queues, and a run end starts the next. */
const queuedLoad = j
  .workflow('test.queued-load', {
    version: 1,
    input: z.object({ account: z.string(), n: z.int() }),
    concurrency: { key: ({ account }) => account, limit: 1, onBusy: 'queue' },
  })
  .step('load', async () => {
    inFlight.now += 1;
    inFlight.most = Math.max(inFlight.most, inFlight.now);
    await sleep(5);
    inFlight.now -= 1;
    return 'loaded';
  })
  .finish();

/** One run at a time across two parked workflows: a run of one ends, a queued run of the other is the candidate. */
const pgSlot = j.limit({ name: 'test.pg-slot', total: 1 });
const slotted = (name: string) =>
  j
    .workflow(name, {
      version: 1,
      input: z.object({}),
      concurrency: { shared: [pgSlot], onBusy: 'queue' },
    })
    .waitFor('go', { signal: 'go', schema: z.object({}) })
    .finish();
const slotHolder = slotted('test.pg-slot-a');
const slotWaiter = slotted('test.pg-slot-b');

const journal = j.compose({
  workflows: [racing, gated, uploadA, uploadB, queuedLoad, slotHolder, slotWaiter],
  workflowMeta,
});
journal.hooks.command.around(async (ctx, next) => {
  if (ctx.name === 'workflow.checkpoint' && holdAt === 'checkpoint') {
    checkpoints += 1;
    if (checkpoints === 1) {
      first.started.open();
      await first.hold.opened;
    }
  }
  await next();
});

/** The nodes whose result was checkpointed, in order. */
const completedOf = async (id: string) => {
  const rows = await dbA
    .select({ type: tables.events.type, data: tables.events.data })
    .from(tables.events)
    .where(eq(tables.events.entityId, id))
    .orderBy(asc(tables.events.seq));
  return rows
    .filter(row => row.type === 'NodeCompleted')
    .map(row => z.object({ path: z.string() }).parse(row.data).path);
};

/** The lease runs out while the first worker is stalled, as after a long pause or a lost network. */
const expireLease = () =>
  dbB
    .update(tables.jobs)
    .set({ leaseUntil: sql`now() - interval '1 second'` })
    .where(sql`true`);

describe('two workers race one run', () => {
  it('a worker that was taken over gets its checkpoint refused, so exactly one checkpoint of the node commits', async () => {
    const id = `racing_${++next}`;
    orThrow(await journal.run(dbA, racing.start, { input: {}, id }, caller));
    const stale = journal.drain(dbA, { leaseSeconds: 1 }).then(result => orThrow(result));
    await first.started.opened;
    await expireLease();
    const owner = journal.drain(dbB, { leaseSeconds: 1 }).then(result => orThrow(result));
    await second.started.opened;
    // The stale worker wakes up after the takeover; its body answered, and its checkpoint is refused.
    first.hold.open();
    await stale;
    expect(await completedOf(id)).toEqual([]);
    second.hold.open();
    await owner;
    expect((await completedOf(id)).filter(path => path === 'settle')).toEqual(['settle']);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    const [row] = await dbA.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
    expect(row?.results).toMatchObject({ settle: { settled: 2 } });
  }, 30_000);

  it('a claim waits for a checkpoint in flight, so the new owner finds the node done and does not run its body again', async () => {
    const id = `racing_${++next}`;
    holdAt = 'checkpoint';
    orThrow(await journal.run(dbA, racing.start, { input: {}, id }, caller));
    const stale = journal.drain(dbA, { leaseSeconds: 1 }).then(result => orThrow(result));
    await first.started.opened;
    await expireLease();
    let claimed = false;
    const owner = journal
      .drain(dbB, { leaseSeconds: 1 })
      .then(result => orThrow(result))
      .then(count => {
        claimed = true;
        return count;
      });
    await sleep(500);
    expect(claimed).toBe(false);
    first.hold.open();
    await stale;
    await owner;
    expect(bodies).toBe(1);
    expect((await completedOf(id)).filter(path => path === 'settle')).toEqual(['settle']);
  }, 30_000);
});

describe('concurrency gate under concurrent starts', () => {
  it('eight starts of one key on two connections at once create exactly the limit, so a race never overfills a key', async () => {
    const account = `acc_race_${Date.now()}`;
    const starts = Array.from({ length: 8 }, (_, n) =>
      journal.run(n % 2 === 0 ? dbA : dbB, gated.start, { input: { account } }, caller),
    );
    const outcomes = await Promise.all(starts);
    expect(outcomes.filter(outcome => WorkflowBusy.is(outcome))).toHaveLength(6);
    expect(outcomes.filter(outcome => !isFailure(outcome))).toHaveLength(2);
    const rows = await dbA
      .select({ id: tables.workflowRuns.id })
      .from(tables.workflowRuns)
      .where(eq(tables.workflowRuns.concurrencyKey, account));
    expect(rows).toHaveLength(2);
  });

  it('twelve starts of two workflows that share a limit, on two connections at once, never overfill its total or a key', async () => {
    const accounts = Array.from({ length: 6 }, (_, n) => `acc_upload_${Date.now()}_${n}`);
    // Each account is started by both workflows, so the per-key count and the total race at the same time.
    const starts = accounts.flatMap((account, n) => [
      journal.run(n % 2 === 0 ? dbA : dbB, uploadA.start, { input: { account } }, caller),
      journal.run(n % 2 === 0 ? dbB : dbA, uploadB.start, { input: { account } }, caller),
    ]);
    const outcomes = await Promise.all(starts);
    expect(outcomes.filter(outcome => !isFailure(outcome))).toHaveLength(3);
    expect(outcomes.filter(outcome => WorkflowBusy.is(outcome))).toHaveLength(9);
    const rows = await dbA
      .select({ account: tables.workflowRuns.concurrencyKey })
      .from(tables.workflowRuns)
      .where(sql`${tables.workflowRuns.limits} @> array['test.uploads']::text[]`);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(row => row.account)).size).toBe(3);
  });
});

describe('the queue under concurrent ends and starts', () => {
  it('starts and run ends on two connections at once never run more than the limit, and every queued run ends', async () => {
    const account = `acc_queue_${Date.now()}`;
    const startOne = (n: number) =>
      journal.run(n % 2 === 0 ? dbA : dbB, queuedLoad.start, { input: { account, n } }, caller);
    // Two workers, one per connection: a run end on one can meet a start or another end on the other.
    const drainBoth = async () => {
      for (let pass = 0; pass < 200; pass++) {
        const [a, b] = await Promise.all([journal.drain(dbA), journal.drain(dbB)]);
        if (orThrow(a) === 0 && orThrow(b) === 0) return;
      }
      throw new Error('the queued runs did not settle');
    };
    const first = await Promise.all([0, 1, 2, 3].map(n => startOne(n)));
    // The second wave lands while the workers end runs and promote the queue.
    const [second] = await Promise.all([Promise.all([4, 5, 6, 7].map(n => startOne(n))), drainBoth()]);
    await drainBoth();
    expect([...first, ...second].filter(outcome => isFailure(outcome))).toEqual([]);
    const rows = await dbA
      .select({
        id: tables.workflowRuns.id,
        state: tables.workflowRuns.state,
        startedAt: tables.workflowRuns.startedAt,
        finishedAt: tables.workflowRuns.finishedAt,
      })
      .from(tables.workflowRuns)
      .where(eq(tables.workflowRuns.concurrencyKey, account));
    // None is left queued: each slot that freed started the next run.
    expect(rows.map(row => row.state)).toEqual(Array.from({ length: 8 }, () => 'completed'));
    expect(inFlight.most).toBe(1);
    // Each run held the slot from its start (or its dequeue) to its end, and no two of those spans overlap.
    const dequeued = await dbA
      .select({ id: tables.events.entityId, at: sql<string>`${tables.events.data} ->> 'at'` })
      .from(tables.events)
      .where(eq(tables.events.type, 'RunDequeued'));
    const spans = rows
      .map(row => ({
        from: new Date(dequeued.find(event => event.id === row.id)?.at ?? row.startedAt).getTime(),
        to: row.finishedAt?.getTime() ?? Number.POSITIVE_INFINITY,
      }))
      .toSorted((a, b) => a.from - b.from);
    for (const [index, span] of spans.entries()) {
      expect(span.from).toBeGreaterThanOrEqual(spans[index - 1]?.to ?? 0);
    }
  });
});

describe('a promotion never waits for a lock', () => {
  it('a run end whose candidate needs a lock another connection holds commits at once and leaves it queued; a later change promotes it', async () => {
    const holder = orThrow(await journal.run(dbA, slotHolder.start, { input: {} }, caller)).runId;
    const waiter = orThrow(await journal.run(dbA, slotWaiter.start, { input: {} }, caller)).runId;
    const stateOf = async (id: string) => {
      const [row] = await dbA
        .select({ state: tables.workflowRuns.state })
        .from(tables.workflowRuns)
        .where(eq(tables.workflowRuns.id, id));
      return row?.state;
    };
    // The holder parks on its wait, so the signal below ends it.
    for (let pass = 0; pass < 20; pass++) if (orThrow(await journal.drain(dbA)) === 0) break;
    expect(await stateOf(holder)).toBe('parked');
    expect(await stateOf(waiter)).toBe('queued');
    // Another session holds the lock of the waiter's own limit, which the holder's end has not taken.
    const other = await poolB.connect();
    const lockId = limitLockId('workflow/test.pg-slot-b');
    try {
      await other.query('select pg_advisory_lock(hashtextextended($1, 0))', [lockId]);
      const ended = journal.run(
        dbA,
        slotHolder.signal('go'),
        { runId: holder, deliveryId: `go:${holder}`, payload: {} },
        caller,
      );
      const waited = await Promise.race([ended.then(() => 'committed'), sleep(5000).then(() => 'waiting')]);
      expect(waited).toBe('committed');
      orThrow(await ended);
      expect(await stateOf(holder)).toBe('completed');
      expect(await stateOf(waiter)).toBe('queued');
    } finally {
      await other.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockId]);
      other.release();
    }
    // A later change (here an operator verb on the limit) looks again, and now the lock is free.
    orThrow(await journal.limits.override(dbA, { name: 'test.pg-slot', total: 1 }, { actor: 'usr_ops' }));
    expect(await stateOf(waiter)).toBe('running');
  });
});

const restartProcess = promisify(execFile);
const restartScript = `
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { orThrow } from '@arki/failure';
import { initJournal } from './src/journal.ts';
import { tables } from './src/test-support.ts';
const pool = new pg.Pool({ connectionString: process.env.JOURNAL_TEST_URL });
const db = drizzle({ client: pool });
const init = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
const v1 = init.workflow('process.restart', { version: 1, input: z.object({}) })
  .step('prepare', () => 1)
  .waitFor('approval', { signal: 'approval', schema: z.object({ by: z.string() }) })
  .step('finish', () => ({ version: 1 })).finish();
const phase = process.env.JOURNAL_TEST_PHASE;
const base = init.workflow('process.restart', { version: 2, input: z.object({}) })
  .step('prepare', () => 2);
const v2 = (phase === 'incompatible' ? base.step('extra', () => 'edited code') : base)
  .step('finish', () => ({ version: 2 })).finish();
const journal = init.compose({ workflows: phase === 'start' ? [v1] : [v1, v2], workflowMeta: { actorId: 'system:workflow' } });
const meta = { actorId: 'restart:test' };
const resumeId = process.env.JOURNAL_TEST_RESUME_ID;
const changedId = process.env.JOURNAL_TEST_CHANGED_ID;
async function drain() { for (let n = 0; n < 20; n++) if (await journal.drain(db) === 0) return; throw new Error('did not settle'); }
try {
  if (phase === 'start') {
    orThrow(await journal.run(db, v1.start, { input: {}, id: resumeId }, meta));
    await drain();
  } else if (phase === 'resume') {
    orThrow(await journal.run(db, v1.signal('approval'), { runId: resumeId, deliveryId: 'restart:approve', payload: { by: 'operator' } }, meta));
    await drain();
    orThrow(await journal.run(db, v2.start, { input: {}, id: changedId }, meta));
  } else await drain();
} finally { await pool.end(); }
`;

it('separate processes resume persisted waits with pinned code and strand structurally incompatible code', async () => {
  const resumeId = `restart_resume_${Date.now()}`;
  const changedId = `restart_changed_${Date.now()}`;
  const runProcess = (phase: string) =>
    restartProcess('bun', ['-e', restartScript], {
      cwd: process.cwd(),
      timeout: 30_000,
      env: {
        ...process.env,
        JOURNAL_TEST_URL: container.getConnectionUri(),
        JOURNAL_TEST_PHASE: phase,
        JOURNAL_TEST_RESUME_ID: resumeId,
        JOURNAL_TEST_CHANGED_ID: changedId,
      },
    });
  await runProcess('start');
  const [parked] = await dbA.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, resumeId));
  expect(parked).toMatchObject({ state: 'parked', workflowVersion: 1, waitingFor: 'approval' });
  await runProcess('resume');
  const [resumed] = await dbA.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, resumeId));
  expect(resumed).toMatchObject({ state: 'completed', workflowVersion: 1, output: { version: 1 } });
  await runProcess('incompatible');
  const [stranded] = await dbA.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, changedId));
  expect(stranded).toMatchObject({ state: 'running', workflowVersion: 2, output: null });
  const [job] = await dbA.select().from(tables.jobs).where(eq(tables.jobs.runId, changedId));
  expect(job).toMatchObject({ attempts: 1, deadAt: expect.any(Date) });
  expect(JSON.parse(job?.lastError ?? 'null')).toMatchObject({
    code: 'journal.workflow_stranded',
    data: { runId: changedId, name: 'process.restart', version: 2, reason: 'WORKFLOW_SHAPE_CHANGED' },
  });
  const events = await dbA
    .select()
    .from(tables.events)
    .where(eq(tables.events.entityId, changedId))
    .orderBy(asc(tables.events.seq));
  expect(events.map(event => event.type)).toEqual(['RunStarted', 'NodeScheduled']);
}, 60_000);
