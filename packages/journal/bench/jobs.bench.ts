// Speed of the journal worker on queue rows (`kind = 'queue'`, the rows `@arki/queue/outbox`
// schedules): one row committed with its wake, claimed under a lease, run and acknowledged.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// The rival is the hand-written minimum on the same table: one `FOR UPDATE SKIP LOCKED` claim,
// the handler, one delete. It has no lease renewal, no retry and no fencing, so the gap is what
// those cost. Every case schedules with the same SQL and must hand the handler the same args
// once and leave no row behind. The second group adds 10 000 rows no worker can claim (dead
// and stranded), the case that decides whether the claim needs its own index.

import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { JobRunner } from '@arki/journal';
import { compare, defineSuite } from '@arki/bench';
import { initJournal, jobId } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

const tables = journalTables();
const jobs = tables.jobs;
const journal = initJournal({ meta: z.object({}) }).compose({ tables });
const STRANDED = 10_000;

/** One PGlite per environment, created on first use. `stranded` adds rows no worker claims. */
function lazyEnvironment(stranded: number) {
  let pending: ReturnType<typeof createEnvironment> | undefined;
  return () => (pending ??= createEnvironment(stranded));
}

async function createEnvironment(stranded: number) {
  const { db } = await openJournalDb({ ...tables });
  if (stranded > 0)
    await db.execute(sql`
      insert into journal_jobs (id, kind, job_name, args, dead_at)
      select 'job_s' || n, 'queue', case when n % 2 = 0 then 'renamed.v0' else 'bench' end, '{}'::jsonb,
             case when n % 2 = 0 then null else now() end
      from generate_series(1, ${stranded}) as n`);
  return db;
}

const environments = { plain: lazyEnvironment(0), stranded: lazyEnvironment(STRANDED) };
type Db = Awaited<ReturnType<typeof createEnvironment>>;

/** What `runAfter` writes: the row and its wake, in one transaction. */
async function schedule(db: Db, args: unknown): Promise<void> {
  await db.transaction(async tx => {
    await tx.insert(jobs).values({ id: jobId(), kind: 'queue', jobName: 'bench', args });
    await tx.execute(sql`select pg_notify('journal_wake', '{"queue":1}')`);
  });
}

/** Rows a case left behind: must be zero. Dead and stranded rows do not count. */
async function leftOver(db: Db): Promise<number> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.jobName, 'bench'), isNull(jobs.deadAt)));
  return rows.length;
}

/** `@arki/journal`: `drain` with a runner. */
async function viaDrain(db: Db, args: unknown): Promise<string> {
  const seen: unknown[] = [];
  const runner: JobRunner = {
    names: ['bench'],
    run: job => {
      seen.push(job.args);
      return Promise.resolve();
    },
    retryDelay: () => undefined,
  };
  await schedule(db, args);
  await journal.drain(db, { jobs: runner, batchSize: 1 });
  return JSON.stringify({ seen, left: await leftOver(db) });
}

/** The hand-written minimum: claim one due row with SKIP LOCKED, run, delete. */
async function viaRawLoop(db: Db, args: unknown): Promise<string> {
  const seen: unknown[] = [];
  await schedule(db, args);
  const claimed = await db.transaction(async tx => {
    const [due] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          isNull(jobs.deadAt),
          lte(jobs.availableAt, sql`now()`),
          or(isNull(jobs.leaseUntil), lte(jobs.leaseUntil, sql`now()`)),
          eq(jobs.kind, 'queue'),
          eq(jobs.jobName, 'bench'),
        ),
      )
      .orderBy(desc(jobs.priority), asc(jobs.availableAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (due !== undefined)
      await tx.update(jobs).set({ leaseUntil: sql`now() + interval '60 seconds'` }).where(eq(jobs.id, due.id));
    return due;
  });
  if (claimed !== undefined) {
    seen.push(claimed.args);
    await db.delete(jobs).where(eq(jobs.id, claimed.id));
  }
  return JSON.stringify({ seen, left: await leftOver(db) });
}

const inputs: unknown[] = [{ userId: 'usr_1' }, { runId: 'drun_1', budgetLimitUsd: 5, autoImport: false }, 'x'.repeat(1024)];
const expected = (args: unknown): string => JSON.stringify({ seen: [args], left: 0 });

const group = (id: string, title: string, environment: () => Promise<Db>, contractId: string) =>
  compare<unknown>({
    id,
    title,
    contract: {
      id: contractId,
      description:
        'one queue row committed with its wake is claimed, its args reach the handler exactly once, and no live row is left',
    },
    inputs,
    expected,
    mode: 'async',
    baseline: 'drain',
    cases: c => ({
      drain: c({
        label: '@arki/journal drain({ jobs }) (lease, renewal, fenced ack)',
        package: '@arki/journal',
        setup: args => ({ environment: environment(), args }),
        run: async ({ environment: db, args }) => viaDrain(await db, args),
      }),
      rawLoop: c({
        label: 'hand-written SKIP LOCKED claim + delete (no renewal, no retry, no fencing)',
        package: 'drizzle-orm',
        setup: args => ({ environment: environment(), args }),
        run: async ({ environment: db, args }) => viaRawLoop(await db, args),
      }),
    }),
  });

export default defineSuite({
  id: '@arki/journal/jobs',
  intro:
    'One queue row (`kind = \'queue\'`, as `@arki/queue/outbox` schedules it) scheduled with its wake, claimed, run and acknowledged by the journal worker, against the hand-written minimum on the same table and the same in-memory PGlite.',
  notes: [
    'PGlite has one connection, so this is the cost of one claim, run and ack, not throughput under contention. Contention and the wake channel are proven in `src/jobs.pg.test.ts`, not timed here.',
    'The hand-written loop skips what the worker pays for: lease renewal, retry with backoff and the lease-token fence on ack.',
    `The second group adds ${String(STRANDED)} rows no worker can claim (half dead, half under a name the runner does not know). The existing due index serves both lanes; a gap here is the signal for a dedicated claim index.`,
    'Not compared yet: pg-boss `send`/`fetch` and graphile-worker `addJob` with a caller-owned client. Both need a dependency and an API check first.',
  ],
  groups: [
    group('queue-row', 'Schedule, claim, run and ack one queue row', environments.plain, 'journal-queue-row/v1'),
    group(
      'queue-row-stranded',
      `The same, next to ${String(STRANDED)} dead and stranded rows`,
      environments.stranded,
      'journal-queue-row-stranded/v1',
    ),
  ],
});
