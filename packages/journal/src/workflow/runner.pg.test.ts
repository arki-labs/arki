/**
 * The checkpoint fence on real Postgres with two workers on two connections: a run's node is checkpointed once,
 * whichever worker is slow. Needs Docker: starts a `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

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
    await journal.run(dbA, racing.start, { input: {}, id }, caller);
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
    await journal.run(dbA, racing.start, { input: {}, id }, caller);
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
