/**
 * Test helper: an in-memory PGlite with a schema pushed, the fixture every
 * journal test rebuilds by hand. `@electric-sql/pglite` and `drizzle-kit` are
 * optional peers. Import this module only from tests. This is the one file
 * that may import them.
 */
import type { IdGenerationFailure } from '@arki/contracts';
import { PGlite } from '@electric-sql/pglite';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { drizzle } from 'drizzle-orm/pglite';

import type { JournalTables } from './pg.js';
import type { RetentionAge } from './retention.js';
import type { RootDb } from './types.js';
import { parseAge } from './retention.js';

/**
 * Open a fresh in-memory database with `schema` (the journal tables and the
 * app's tables) pushed. Returns the Drizzle database and the PGlite client;
 * call `client.close()` when the test file ends.
 */
export async function openJournalDb(schema: Record<string, unknown>) {
  const client = new PGlite('memory://');
  await client.waitReady;
  const db = drizzle({ client });
  const { apply } = await pushSchema(schema, db);
  await apply();
  return { db, client };
}

/** The database the harness opens when it is given none: the one `openJournalDb` returns. */
type PgliteDb = Awaited<ReturnType<typeof openJournalDb>>['db'];

/** How many drains `drain()` runs before it gives up: a job that keeps coming due would loop forever. */
const MAX_DRAINS = 1000;

/** How far ahead a job the harness holds back goes, while it runs another one. */
const HELD_BACK = sql`interval '100 years'`;

/** What the harness needs from `setup`'s return: the journal tables, and the composed journal it drains. */
type HarnessRuntime<Db> = {
  readonly tables: JournalTables;
  readonly journal: {
    readonly drain: (
      db: Db,
      opts?: { readonly batchSize?: number },
    ) => Promise<number | IdGenerationFailure>;
  };
};

/**
 * The harness's own members, on `db`. `runtime` gives the newest runtime (`crash` replaces it), `crash` is the restart
 * `workflowHarness` wires up, and `close` ends the database it opened, if it opened one.
 */
function harnessMembers<Db extends RootDb>(
  db: Db,
  runtime: () => HarnessRuntime<Db>,
  crash: () => void,
  close: () => Promise<void>,
) {
  /**
   * Time, as the worker sees it. It never reads a fake clock: now stays now, and every stored time that it compares with
   * now moves back. So a body that reads `Date.now()` and a query that reads `now()` keep agreeing.
   */
  const tick = async (age: RetentionAge) => {
    const back = sql`make_interval(secs => ${parseAge(age) / 1000})`;
    const { jobs, jobArchive, jobOperations, receipts, workflowRuns } = runtime().tables;
    /* eslint-disable drizzle/enforce-update-with-where -- time passes for every row, so every row's due time moves */
    await db.transaction(async tx => {
      await tx.update(jobs).set({
        availableAt: sql`${jobs.availableAt} - ${back}`,
        leaseUntil: sql`${jobs.leaseUntil} - ${back}`,
        deadAt: sql`${jobs.deadAt} - ${back}`,
      });
      await tx.update(jobArchive).set({ keepUntil: sql`${jobArchive.keepUntil} - ${back}` });
      await tx.update(jobOperations).set({ at: sql`${jobOperations.at} - ${back}` });
      await tx.update(receipts).set({ expiresAt: sql`${receipts.expiresAt} - ${back}` });
      await tx.update(workflowRuns).set({
        wakeAt: sql`${workflowRuns.wakeAt} - ${back}`,
        deadlineAt: sql`${workflowRuns.deadlineAt} - ${back}`,
        keepUntil: sql`${workflowRuns.keepUntil} - ${back}`,
      });
    });
    /* eslint-enable drizzle/enforce-update-with-where */
  };

  /** The effect jobs a worker could claim now, in the order it would claim them. */
  const dueJobs = async () => {
    const { jobs } = runtime().tables;
    return db
      .select({
        id: jobs.id,
        effect: jobs.effect,
        type: sql<string>`${jobs.args}->>'type'`,
        runId: jobs.runId,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, 'effect'),
          isNull(jobs.deadAt),
          lte(jobs.availableAt, sql`now()`),
          or(isNull(jobs.leaseUntil), lte(jobs.leaseUntil, sql`now()`)),
        ),
      )
      .orderBy(desc(jobs.priority), asc(jobs.availableAt), asc(jobs.id));
  };

  return {
    /** The database. It survives `crash()`. */
    db,
    /**
     * Moves time forward by `age` (seconds, or `'30m'`, `'1h'`, `'2d'`): every stored time that the worker or the
     * sweeper compares with now moves back by that much. Timers, retries, leases, deadlines and retention come due.
     */
    tick,
    /**
     * Moves time forward to `at`, read from a row `tick` moves, such as a run's `wakeAt`: read it again after a tick. A
     * time that has passed moves nothing.
     */
    tickTo: async (at: Date) => {
      const seconds = (at.getTime() - Date.now()) / 1000;
      if (seconds > 0) await tick(seconds);
    },
    /** The effect jobs a worker could claim now, in the order it would claim them. */
    dueJobs,
    /**
     * Runs exactly one due job, the first `pick` chooses, and no other: what a worker that is ahead of the rest does.
     * The job's own follow-up jobs stay due. Returns the job, or the failure the drain returned. Throws when none fits.
     */
    release: async (pick: (job: Awaited<ReturnType<typeof dueJobs>>[number]) => boolean) => {
      const due = await dueJobs();
      const job = due.find(candidate => pick(candidate));
      if (job === undefined) {
        const names = due.map(candidate => `${candidate.effect} ${candidate.type}`).join(', ');
        throw new Error(`workflowHarness: no due job fits; due: ${names === '' ? 'none' : names}`);
      }
      const { jobs } = runtime().tables;
      const others = inArray(
        jobs.id,
        due.filter(candidate => candidate.id !== job.id).map(candidate => candidate.id),
      );
      await db
        .update(jobs)
        .set({ availableAt: sql`${jobs.availableAt} + ${HELD_BACK}` })
        .where(others);
      try {
        const ran = await runtime().journal.drain(db, { batchSize: 1 });
        return typeof ran === 'number' ? job : ran;
      } finally {
        await db
          .update(jobs)
          .set({ availableAt: sql`${jobs.availableAt} - ${HELD_BACK}` })
          .where(others);
      }
    },
    /**
     * Runs the worker of the newest runtime until no job is due. Returns how many jobs it ran, or the failure a drain
     * returned. Throws when jobs are still due after 1000 drains.
     */
    drain: async () => {
      let ran = 0;
      for (let pass = 0; pass < MAX_DRAINS; pass++) {
        const drained = await runtime().journal.drain(db);
        if (typeof drained !== 'number') return drained;
        if (drained === 0) return ran;
        ran += drained;
      }
      throw new Error(`workflowHarness: jobs were still due after ${MAX_DRAINS} drains`);
    },
    /**
     * A process restart: the database keeps every row, and `setup` runs again, so the journal, its hooks and the
     * definitions are new. Read them from the harness after the crash. Work still awaiting on the old runtime is
     * abandoned the way a killed process abandons it: its job keeps its lease until the lease runs out (`tick` past it).
     */
    crash,
    /** Closes the database the harness opened. One the test gave stays open: it is the test's to close. */
    close,
  };
}
type HarnessMembers<Db extends RootDb> = ReturnType<typeof harnessMembers<Db>>;

/**
 * What `setup` returns: the journal tables, the composed journal, and anything else the test reads (its workflow
 * definitions). It may not use a name the harness gives (`db`, `tick`, `drain`, `crash`, `close`).
 */
type HarnessSetup<Db extends RootDb> = HarnessRuntime<Db> & Readonly<Partial<Record<keyof HarnessMembers<Db>, never>>>;

/** What `workflowHarness` gives: everything `setup` returned, each as its own member, and the harness's members. */
type WorkflowHarness<S extends HarnessSetup<Db>, Db extends RootDb> = Omit<S, keyof HarnessMembers<Db>> &
  HarnessMembers<Db>;

/**
 * A database and a workflow runtime for tests, with time and crashes under the test's control.
 *
 * `setup` builds the runtime: `initJournal`, the workflow definitions and the compose. It returns `tables`, `journal`
 * and the definitions the test uses; the harness shows each of them as its own member. `crash()` runs `setup` again on
 * the same database, as a restarted process would. `schema` is every table to push; default: the returned `tables`.
 *
 * `tick` and `tickTo` control the clock, and `dueJobs` and `release` run the due jobs one by one, so a test can put an
 * event, a wake and a timer in the order it wants to see.
 *
 * @example
 * const h = await workflowHarness({
 *   setup: () => {
 *     const tables = journalTables();
 *     const j = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
 *     const nap = j.workflow('nap', { version: 1, input: z.object({}) }).sleep('wait', '1h').finish();
 *     return { tables, journal: j.compose({ workflows: [nap], workflowMeta: { actorId: 'system' } }), nap };
 *   },
 * });
 * await h.journal.run(h.db, h.nap.start, { input: {}, id: 'nap_1' }, { actorId: 'usr_1' });
 * await h.drain(); // parked on its timer
 * await h.tick('1h');
 * await h.drain(); // completed: see h.nap.read(h.db, 'nap_1')
 * await h.close();
 */
export async function workflowHarness<S extends HarnessSetup<PgliteDb>>(options: {
  readonly setup: () => S;
  readonly schema?: Record<string, unknown>;
}): Promise<WorkflowHarness<S, PgliteDb>> {
  // `setup` only declares; it touches no database, so it runs first and names the tables to push.
  const first = options.setup();
  const { db, client } = await openJournalDb(options.schema ?? first.tables);
  return harnessOn(db, first, options.setup, () => client.close());
}

/**
 * `workflowHarness` on a database the test opened, such as a real Postgres with two pools for a race. The schema is the
 * test's to push, and the database is the test's to close: `close()` does nothing.
 */
export function workflowHarnessOn<Db extends RootDb, S extends HarnessSetup<Db>>(
  db: Db,
  options: { readonly setup: () => S },
): WorkflowHarness<S, Db> {
  return harnessOn(db, options.setup(), options.setup, () => Promise.resolve());
}

function harnessOn<Db extends RootDb, S extends HarnessSetup<Db>>(
  db: Db,
  first: S,
  setup: () => S,
  close: () => Promise<void>,
): WorkflowHarness<S, Db> {
  let current = first;
  const crash = () => {
    current = setup();
    Object.assign(harness, current);
  };
  const harness: WorkflowHarness<S, Db> = { ...current, ...harnessMembers(db, () => current, crash, close) };
  return harness;
}
