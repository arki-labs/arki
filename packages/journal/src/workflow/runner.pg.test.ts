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

import { orThrow } from '@arki/failure';

import { j, tables } from '../test-support.js';

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

const journal = j.compose({ workflows: [racing], workflowMeta });
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
    const stale = journal.drain(dbA, { leaseSeconds: 1 });
    await first.started.opened;
    await expireLease();
    const owner = journal.drain(dbB, { leaseSeconds: 1 });
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
    const stale = journal.drain(dbA, { leaseSeconds: 1 });
    await first.started.opened;
    await expireLease();
    let claimed = false;
    const owner = journal.drain(dbB, { leaseSeconds: 1 }).then(count => {
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
