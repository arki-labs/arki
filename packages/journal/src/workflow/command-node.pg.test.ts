/**
 * A command node on real Postgres with two workers on two connections. PGlite has one connection, so it cannot show
 * a stale owner racing the new one. Exactly once has to hold here too: whichever worker gets there, the command
 * commits one time, with its checkpoint. Needs Docker: starts a `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import { j, meta, order, OrderNoted, OrderPlaced, orders, tables } from '../test-support.js';

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
  const { apply } = await pushSchema({ ...tables, orders }, dbA);
  await apply();
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

/** Where the first worker stops: before its command starts, or inside the command's open transaction. */
let holdAt: 'before-command' | 'in-command' = 'before-command';
let started = gate();
let hold = gate();
let commandCalls = 0;
let attempts = 0;

beforeEach(async () => {
  await dbA.delete(tables.jobs).where(sql`true`);
  await dbA.delete(tables.jobArchive).where(sql`true`);
  started = gate();
  hold = gate();
  commandCalls = 0;
  attempts = 0;
});

const noteOrder = j.command(
  'noteOrder',
  z.object({ orderId: z.templateLiteral(['ord_', z.string()]) }),
  { writes: [OrderNoted], output: z.object({ noted: z.boolean() }) },
  async (input, { write }) => {
    commandCalls += 1;
    const written = await write(order, input.orderId, () => [OrderNoted({ note: 'once' })]);
    if (holdAt === 'in-command' && commandCalls === 1) {
      started.open();
      await hold.opened;
    }
    return isFailure(written) ? written : { noted: true };
  },
);

const noting = j
  .workflow('noting', { version: 1, input: z.object({ orderId: z.templateLiteral(['ord_', z.string()]) }) })
  .command('note', noteOrder, ({ input }) => ({ orderId: input.orderId }))
  .finish(({ results }) => results.note.noted);
const journal = j.compose({ workflows: [noting], workflowMeta: meta });

// The hook wraps the node's whole attempt: the worker has read the run and is about to run the command.
journal.hooks.step.around(async (_ctx, proceed) => {
  attempts += 1;
  if (holdAt === 'before-command' && attempts === 1) {
    started.open();
    await hold.opened;
  }
  return proceed();
});

async function startNoting() {
  const id: `ord_${number}` = `ord_${++next}`;
  orThrow(
    await dbA.transaction(tx =>
      journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
    ),
  );
  const runId = `noting:${id}`;
  orThrow(await journal.run(dbA, noting.start, { id: runId, input: { orderId: id } }, meta));
  return { id, runId };
}

const notesOf = async (id: string) =>
  dbA
    .select({ seq: tables.events.seq })
    .from(tables.events)
    .where(and(eq(tables.events.entityId, id), eq(tables.events.type, 'OrderNoted')));

/** The lease runs out while the first worker is stalled, as after a long pause or a lost network. */
const expireLease = () =>
  dbB
    .update(tables.jobs)
    .set({ leaseUntil: sql`now() - interval '1 second'` })
    .where(sql`true`);

const finished = async (runId: string) => {
  const [run] = await dbA.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, runId));
  return run;
};

describe('a command node with two workers on real Postgres', () => {
  it('a stale worker that wakes after the takeover runs nothing: the new owner committed the command once', async () => {
    holdAt = 'before-command';
    const { id, runId } = await startNoting();
    const stale = journal.drain(dbA, { leaseSeconds: 1 });
    await started.opened;
    await expireLease();
    orThrow(await journal.drain(dbB, { leaseSeconds: 1 }));
    expect(await finished(runId)).toMatchObject({ state: 'completed', output: true });

    hold.open();
    orThrow(await stale);
    expect(commandCalls, 'the fence stopped the stale worker before its handler').toBe(1);
    expect(await notesOf(id)).toHaveLength(1);
  });

  it('a claim waits for the command in flight, then finds the node settled, so the command never runs twice', async () => {
    holdAt = 'in-command';
    const { id, runId } = await startNoting();
    const stale = journal.drain(dbA, { leaseSeconds: 1 });
    await started.opened;
    await expireLease();
    const owner = journal.drain(dbB, { leaseSeconds: 1 });
    // Long enough for a claim that did not wait to reach the handler.
    await sleep(300);
    expect(commandCalls, 'the second worker must not start while the first is inside its transaction').toBe(1);

    hold.open();
    orThrow(await stale);
    orThrow(await owner);
    expect(commandCalls).toBe(1);
    expect(await notesOf(id)).toHaveLength(1);
    expect(await finished(runId)).toMatchObject({ state: 'completed', output: true });
  });
});
