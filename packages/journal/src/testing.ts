/**
 * Test helper: an in-memory PGlite with a schema pushed, the fixture every
 * journal test rebuilds by hand. `@electric-sql/pglite` and `drizzle-kit` are
 * optional peers. Import this module only from tests. This is the one file
 * that may import them.
 */
import type { IdGenerationFailure } from '@arki/contracts';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { drizzle } from 'drizzle-orm/pglite';

import type { JournalTables } from './pg.js';
import type { RetentionAge } from './retention.js';
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

/** The database the harness opens: the one `openJournalDb` returns. */
type HarnessDb = Awaited<ReturnType<typeof openJournalDb>>['db'];

/** How many drains `drain()` runs before it gives up: a job that keeps coming due would loop forever. */
const MAX_DRAINS = 1000;

/** What the harness needs from `setup`'s return: the journal tables, and the composed journal it drains. */
type HarnessRuntime = {
  readonly tables: JournalTables;
  readonly journal: { readonly drain: (db: HarnessDb) => Promise<number | IdGenerationFailure> };
};

/**
 * The harness's own members, on `db` and `client`. `runtime` gives the newest runtime (`crash` replaces it), and
 * `crash` is the restart `workflowHarness` wires up.
 */
function harnessMembers(db: HarnessDb, client: PGlite, runtime: () => HarnessRuntime, crash: () => void) {
  return {
    /** The PGlite database. It survives `crash()`. */
    db,
    /**
     * Moves time forward by `age` (seconds, or `'30m'`, `'1h'`, `'2d'`): every stored time that the worker or the
     * sweeper compares with now moves back by that much. Timers, retries, leases, deadlines and retention come due.
     */
    tick: async (age: RetentionAge) => {
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
    /** Closes the PGlite database. */
    close: () => client.close(),
  };
}
type HarnessMembers = ReturnType<typeof harnessMembers>;

/**
 * What `setup` returns: the journal tables, the composed journal, and anything else the test reads (its workflow
 * definitions). It may not use a name the harness gives (`db`, `tick`, `drain`, `crash`, `close`).
 */
type HarnessSetup = HarnessRuntime & Readonly<Partial<Record<keyof HarnessMembers, never>>>;

/** What `workflowHarness` gives: everything `setup` returned, each as its own member, and the harness's members. */
type WorkflowHarness<S extends HarnessSetup> = Omit<S, keyof HarnessMembers> & HarnessMembers;

/**
 * A database and a workflow runtime for tests, with time and crashes under the test's control.
 *
 * `setup` builds the runtime: `initJournal`, the workflow definitions and the compose. It returns `tables`, `journal`
 * and the definitions the test uses; the harness shows each of them as its own member. `crash()` runs `setup` again on
 * the same database, as a restarted process would. `schema` is every table to push; default: the returned `tables`.
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
export async function workflowHarness<S extends HarnessSetup>(options: {
  readonly setup: () => S;
  readonly schema?: Record<string, unknown>;
}): Promise<WorkflowHarness<S>> {
  const { setup } = options;
  // `setup` only declares; it touches no database, so it runs first and names the tables to push.
  let current = setup();
  const { db, client } = await openJournalDb(options.schema ?? current.tables);
  const crash = () => {
    current = setup();
    Object.assign(harness, current);
  };
  const harness: WorkflowHarness<S> = { ...current, ...harnessMembers(db, client, () => current, crash) };
  return harness;
}
