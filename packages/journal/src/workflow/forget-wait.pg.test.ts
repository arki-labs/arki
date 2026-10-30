/**
 * `forget` and an event copied into a wait result, on real Postgres. A wait stores a pointer to the event, never the
 * event, so erasing the event in the log erases it for every run that took it: parked, running or finished. Each test
 * checks two things: what the run reads (`def.read`, `results.x` in a body), and that the private words are in no
 * table a run writes. Needs Docker: starts a `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import { initJournal } from '../journal.js';
import { journalTables } from '../pg.js';
import { workflowHarnessOn } from '../testing.js';

type PrayerId = `pry_${string}`;
const prayerIdSchema = z.templateLiteral(['pry_', z.string()]);
const prayers = pgTable('forget_prayers', {
  id: varchar('id', { length: 256 }).primaryKey().$type<PrayerId>(),
  version: integer('version').notNull().default(0),
});
/** One row per run that used the words, so a test sees what the body read. */
const uses = pgTable('forget_uses', {
  runId: varchar('run_id', { length: 256 }).primaryKey(),
  text: varchar('text', { length: 256 }).notNull(),
});

const tables = journalTables();
const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const SECRET = 'my private prayer for Ana';
const ERASED = '[erased]';
const WAKE = 'workflow.wake:forget-prayer';

function prayerApp() {
  const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
  const PrayerOpened = j.event('PrayerOpened', z.object({}));
  const PrayerWritten = j.event('PrayerWritten', z.object({ text: z.string().min(1) }), {
    erased: () => ({ text: ERASED }),
  });
  const PrayerAnswered = j.event('PrayerAnswered', z.object({}));
  const prayer = j
    .entity('forget-prayer', prayers, { events: 'stored' })
    .create(PrayerOpened, () => ({}))
    .on(PrayerWritten, () => ({}))
    .on(PrayerAnswered, () => ({}));
  const input = z.object({ prayerId: prayerIdSchema });
  const written = { prayer: { entity: prayer, events: [PrayerWritten], match: ({ input: given }: { input: { prayerId: PrayerId } }) => given.prayerId } };

  /** Takes the prayer, then a step uses its words: the step may run after the words were erased. */
  const keeper = j
    .workflow('forget.keeper', { version: 1, input })
    .waitFor('heard', { on: written })
    .step('use', async ({ runId, results, db }) => {
      await db.insert(uses).values({ runId, text: results.heard.event.data.text });
      return results.heard.event.data.text.length;
    })
    .finish();
  /** Takes the prayer, then parks on a second wait: the words are in `results` while it is parked. */
  const parker = j
    .workflow('forget.parker', { version: 1, input })
    .waitFor('heard', { on: written })
    .waitFor('answered', {
      on: { prayer: { entity: prayer, events: [PrayerAnswered], match: ({ input: given }) => given.prayerId } },
    })
    // The output holds a length, not the words: what a run derives from an event is the workflow's own data.
    .finish(({ results }) => ({ length: results.heard.event.data.text.length, via: results.answered.via }));

  const journal = j.compose({ workflows: [keeper, parker], workflowMeta });
  return { tables, journal, prayer, PrayerOpened, PrayerWritten, PrayerAnswered, keeper, parker };
}

const harnessFor = (db: NodePgDatabase) => workflowHarnessOn(db, { setup: prayerApp });

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: NodePgDatabase;
let h: ReturnType<typeof harnessFor>;
let next = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle({ client: pool });
  const { apply } = await pushSchema({ ...tables, prayers, uses }, db);
  await apply();
  h = harnessFor(db);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate ${tables.events}, ${tables.jobs}, ${tables.workflowRuns}, ${prayers}, ${uses} cascade`);
});

const drained = async () => expect(isFailure(await h.drain())).toBe(false);
const newPrayer = async () => {
  const id: PrayerId = `pry_${++next}`;
  orThrow(await h.journal.write(db, h.prayer, id, { meta: caller, events: () => [h.PrayerOpened({})] }));
  return id;
};
const pray = async (id: PrayerId) =>
  orThrow(await h.journal.write(db, h.prayer, id, { meta: caller, events: () => [h.PrayerWritten({ text: SECRET })] }));
const answer = async (id: PrayerId) =>
  orThrow(await h.journal.write(db, h.prayer, id, { meta: caller, events: () => [h.PrayerAnswered({})] }));
const stateOf = async (runId: string) => {
  const [row] = await db
    .select({ state: tables.workflowRuns.state, output: tables.workflowRuns.output })
    .from(tables.workflowRuns)
    .where(eq(tables.workflowRuns.id, runId));
  return row;
};
/** How many rows of the tables a run writes hold the private words: its row, its steps and the events of its own log. */
const copiesOf = async (runId: string) => {
  const pattern = `%${SECRET}%`;
  const counts = await Promise.all([
    db.execute(sql`select count(*)::int as n from ${tables.workflowRuns} where id = ${runId} and results::text like ${pattern}`),
    db.execute(sql`select count(*)::int as n from ${tables.workflowSteps} where run_id = ${runId} and result::text like ${pattern}`),
    db.execute(
      sql`select count(*)::int as n from ${tables.events} where entity_id = ${runId} and data::text like ${pattern}`,
    ),
  ]);
  return counts.flatMap(result => result.rows.map(row => z.object({ n: z.number() }).parse(row).n));
};

describe('forget and a wait result', () => {
  it('a finished run keeps no copy of the event, and reads the erased form', async () => {
    const id = await newPrayer();
    orThrow(await h.journal.run(db, h.parker.start, { id: 'run_done', input: { prayerId: id } }, caller));
    await drained();
    await pray(id);
    await drained();
    await answer(id);
    await drained();
    expect(await stateOf('run_done')).toMatchObject({ state: 'completed', output: { length: SECRET.length, via: 'prayer' } });

    orThrow(await h.journal.forget(db, h.prayer, id));

    const read = orThrow(await h.parker.read(db, 'run_done'));
    expect(read?.run.results.heard?.event.data.text).toBe(ERASED);
    expect(await copiesOf('run_done')).toEqual([0, 0, 0]);
  });

  it('a parked run reads the erased form, and goes on when its next event comes', async () => {
    const id = await newPrayer();
    orThrow(await h.journal.run(db, h.parker.start, { id: 'run_parked', input: { prayerId: id } }, caller));
    await drained();
    await pray(id);
    await drained();
    expect(await stateOf('run_parked')).toMatchObject({ state: 'parked' });

    orThrow(await h.journal.forget(db, h.prayer, id));

    const read = orThrow(await h.parker.read(db, 'run_parked'));
    expect(read?.run.results.heard?.event.data.text).toBe(ERASED);
    expect(await copiesOf('run_parked')).toEqual([0, 0, 0]);
    await answer(id);
    await drained();
    // The run was not harmed: it finished, and its output was worked out from the erased form.
    expect(await stateOf('run_parked')).toMatchObject({ state: 'completed', output: { length: ERASED.length, via: 'prayer' } });
  });

  it('a running run goes on after its copy is erased, and its body reads the erased form', async () => {
    const id = await newPrayer();
    orThrow(await h.journal.run(db, h.keeper.start, { id: 'run_running', input: { prayerId: id } }, caller));
    await drained();
    await pray(id);
    // Only the wake runs: the run has taken the event, and its `use` step is scheduled but has not started.
    orThrow(await h.release(job => job.effect === WAKE && job.type === 'PrayerWritten'));
    expect(await stateOf('run_running')).toMatchObject({ state: 'running' });
    expect(await copiesOf('run_running')).toEqual([0, 0, 0]);

    orThrow(await h.journal.forget(db, h.prayer, id));
    await drained();

    expect(await stateOf('run_running')).toMatchObject({ state: 'completed', output: ERASED.length });
    const [used] = await db.select().from(uses).where(eq(uses.runId, 'run_running'));
    expect(used?.text).toBe(ERASED);
  });
});
