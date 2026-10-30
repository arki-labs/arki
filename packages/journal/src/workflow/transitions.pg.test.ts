/**
 * `limits.transitions` on real Postgres. A transition is the first try of a node, counted on the run row when the node
 * is scheduled. A run that would make more than the limit stops before the node's body runs: it compensates, then ends
 * `failed` with `WorkflowTransitionLimit`. The loop here is `spin` then `rest` (a sleep that goes back to `spin`), so
 * every round is two transitions, and the restart test can stop the process between rounds. Needs Docker: starts a
 * `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { count, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, varchar } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import { initJournal } from '../journal.js';
import { journalTables } from '../pg.js';
import { workflowHarnessOn } from '../testing.js';

/** One row per `spin` body that ran. The key is the step's own, so a repeated attempt writes nothing twice. */
const spins = pgTable('transition_spins', {
  key: varchar('key', { length: 512 }).primaryKey(),
  runId: varchar('run_id', { length: 256 }).notNull(),
});
/** One row per `undo` that ran: compensation is not counted, and it still runs for the work already done. */
const undos = pgTable('transition_undos', {
  key: varchar('key', { length: 512 }).primaryKey(),
  runId: varchar('run_id', { length: 256 }).notNull(),
});

const tables = journalTables();
const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const ROUND = '1m';

function loopApp() {
  const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
  const input = z.object({ rounds: z.int().positive() });
  const loop = (name: string, transitions: number) =>
    j
      .workflow(name, { version: 1, input, limits: { transitions } })
      .step(
        'spin',
        async ({ runId, key, db }) => {
          await db.insert(spins).values({ key, runId }).onConflictDoNothing();
          const [done] = await db.select({ n: count() }).from(spins).where(eq(spins.runId, runId));
          return { n: done?.n ?? 0 };
        },
        {
          undo: async ({ runId, key, db }) => {
            await db.insert(undos).values({ key, runId }).onConflictDoNothing();
          },
        },
      )
      .sleep('rest', ROUND, { next: ({ input: given, results }) => (results.spin.n < given.rounds ? 'spin' : 'next') })
      .step('tail', () => 'done')
      .finish();
  const capped = loop('transitions.capped', 5);
  const roomy = loop('transitions.roomy', 100);
  /** A workflow with no `limits`: it gets the default cap. */
  const defaulted = j
    .workflow('transitions.defaulted', { version: 1, input })
    .step('spin', async ({ runId, key, db }) => {
      await db.insert(spins).values({ key, runId }).onConflictDoNothing();
      const [done] = await db.select({ n: count() }).from(spins).where(eq(spins.runId, runId));
      return { n: done?.n ?? 0 };
    })
    .step('again', () => 'again', {
      next: ({ input: given, results }) => (results.spin.n < given.rounds ? 'spin' : 'next'),
    })
    .finish();
  /** One node that fails its first try: the retry is the same transition. */
  const flaky = j
    .workflow('transitions.flaky', { version: 1, input: z.object({}), limits: { transitions: 1 } })
    .step('once', ({ attempt }) => {
      if (attempt === 1) throw new Error('first try fails');
      return 'ok';
    })
    .finish();
  const journal = j.compose({ workflows: [capped, roomy, defaulted, flaky], workflowMeta });
  return { tables, journal, capped, roomy, defaulted, flaky };
}

const harnessFor = (db: NodePgDatabase) => workflowHarnessOn(db, { setup: loopApp });

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: NodePgDatabase;
let h: ReturnType<typeof harnessFor>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle({ client: pool });
  const { apply } = await pushSchema({ ...tables, spins, undos }, db);
  await apply();
  h = harnessFor(db);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate ${tables.events}, ${tables.jobs}, ${tables.workflowRuns}, ${spins}, ${undos} cascade`);
});

const runRow = async (id: string) => {
  const [row] = await db
    .select({
      state: tables.workflowRuns.state,
      node: tables.workflowRuns.node,
      transitions: tables.workflowRuns.transitions,
      output: tables.workflowRuns.output,
    })
    .from(tables.workflowRuns)
    .where(eq(tables.workflowRuns.id, id));
  return row;
};
/** The error the run's `RunFailed` event stored: the text an operator reads. */
const failureText = async (id: string) => {
  const rows = await db
    .select({ data: tables.events.data })
    .from(tables.events)
    .where(sql`${tables.events.entityId} = ${id} and ${tables.events.type} = 'RunFailed'`);
  return z.object({ error: z.string() }).parse(rows[0]?.data).error;
};
const spinCount = async (id: string) => {
  const [row] = await db.select({ n: count() }).from(spins).where(eq(spins.runId, id));
  return row?.n ?? 0;
};
const undoCount = async (id: string) => {
  const [row] = await db.select({ n: count() }).from(undos).where(eq(undos.runId, id));
  return row?.n ?? 0;
};
/** Runs every due job, then moves the clock one round on and runs again, `rounds` times. */
const play = async (rounds: number) => {
  for (let round = 0; round < rounds; round += 1) {
    expect(isFailure(await h.drain())).toBe(false);
    await h.tick(ROUND);
  }
  expect(isFailure(await h.drain())).toBe(false);
};

describe('limits.transitions', () => {
  it('a loop that passes its limit stops before the node that would pass it, and compensates', async () => {
    orThrow(await h.journal.run(db, h.capped.start, { id: 'run_over', input: { rounds: 100 } }, caller));
    await play(10);

    // The limit is 5: spin, rest, spin, rest, spin ran. The sixth node (`rest`) was scheduled and is refused.
    expect(await runRow('run_over')).toMatchObject({ state: 'failed', transitions: 6 });
    expect(await spinCount('run_over')).toBe(3);
    const text = await failureText('run_over');
    expect(text).toContain('journal.workflow_transition_limit');
    expect(text).toContain('limits.transitions is 5');
    // The work already done is undone, as for any failure: the three spins that finished.
    expect(await undoCount('run_over')).toBe(3);
  });

  it('a loop under its limit runs on to its end', async () => {
    orThrow(await h.journal.run(db, h.capped.start, { id: 'run_under', input: { rounds: 2 } }, caller));
    await play(4);

    // spin, rest, spin, rest, tail: five transitions, exactly the limit.
    expect(await runRow('run_under')).toMatchObject({ state: 'completed', transitions: 5, output: 'done' });
    expect(await spinCount('run_under')).toBe(2);
    expect(await undoCount('run_under')).toBe(0);
  });

  it('one transition over the limit is refused', async () => {
    orThrow(await h.journal.run(db, h.capped.start, { id: 'run_edge', input: { rounds: 3 } }, caller));
    await play(6);

    // spin, rest, spin, rest, spin, rest, tail would be seven.
    expect(await runRow('run_edge')).toMatchObject({ state: 'failed', transitions: 6 });
  });

  it('the count survives a restart, so a loop cannot reset its limit by crashing', async () => {
    orThrow(await h.journal.run(db, h.capped.start, { id: 'run_restart', input: { rounds: 100 } }, caller));
    await play(1);
    expect(await runRow('run_restart')).toMatchObject({ state: 'parked', node: 'rest', transitions: 4 });

    h.crash();
    expect(await runRow('run_restart')).toMatchObject({ transitions: 4 });
    await play(1);
    // The fifth transition is the last allowed one; after the restart the sixth is still refused.
    expect(await runRow('run_restart')).toMatchObject({ state: 'failed', transitions: 6 });
    expect(await spinCount('run_restart')).toBe(3);
  });

  it('the backfill of the upgrade note gives an open run the count its events say', async () => {
    orThrow(await h.journal.run(db, h.roomy.start, { id: 'run_backfill', input: { rounds: 100 } }, caller));
    await play(2);
    const counted = (await runRow('run_backfill'))?.transitions;
    expect(counted).toBeGreaterThan(1);

    // A run that was open before the column existed has the default, 0. The statement is the one in docs/upgrades/0.3.0-to-0.4.0.md.
    await db.execute(sql`update ${tables.workflowRuns} set transitions = 0 where id = 'run_backfill'`);
    await db.execute(sql`
      update workflow_runs r set transitions = (
        select count(*) from journal_events e
        where e.kind = 'workflow.run' and e.entity_id = r.id and e.type = 'NodeScheduled'
          and e.data->>'phase' = 'do' and (e.data->>'attempt')::int = 1
      ) where r.finished_at is null`);
    expect((await runRow('run_backfill'))?.transitions).toBe(counted);
  });

  it('a retry of a step is not a transition', async () => {
    orThrow(await h.journal.run(db, h.flaky.start, { id: 'run_flaky', input: {} }, caller));
    expect(isFailure(await h.drain())).toBe(false);
    await h.tick('1h');
    expect(isFailure(await h.drain())).toBe(false);
    // The limit is 1 and the step ran twice: the second try did not count, or the run would have been stopped.
    expect(await runRow('run_flaky')).toMatchObject({ state: 'completed', transitions: 1, output: 'ok' });
  });

  it('the default limit is 1000, and a definition keeps the cap it was given', () => {
    // 1000 jobs is too slow to run here; the stop itself is proved with a cap of 5 above.
    expect(h.defaulted.limits.transitions).toBe(1000);
    expect(h.capped.limits.transitions).toBe(5);
  });
});
