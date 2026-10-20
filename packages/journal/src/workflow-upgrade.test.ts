/**
 * An app on the pre-T12 journal schema (T13 shape: no `run_id` on the job tables, no workflow
 * tables) runs the migration. The migration is what `pushSchema` computes, which is what
 * `drizzle-kit generate` would write.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import { jobId } from './id.js';
import { journalTables } from './pg.js';

const tables = journalTables();

const client = new PGlite('memory://');
const db = drizzle({ client });
const liveId = orThrow(jobId());
const archivedId = orThrow(jobId());
const at = new Date('2026-09-01T00:00:00.000Z');

beforeAll(async () => {
  await client.waitReady;
  // The T13 schema: today's tables with everything T12 added taken away again.
  const current = await pushSchema(tables, db);
  await current.apply();
  await db.execute(sql`drop table workflow_steps, workflow_signals, workflow_runs`);
  await db.execute(sql`alter table journal_jobs drop column run_id`);
  await db.execute(sql`alter table journal_job_archive drop column run_id`);
  await db.execute(
    sql`insert into journal_jobs (id, kind, job_name, args) values (${liveId}, 'queue', 'demo', '{"n":1}'::jsonb)`,
  );
  await db.execute(
    sql`insert into journal_job_archive (id, kind, job_name, priority, enqueued_at, attempts, outcome, finished_at) values (${archivedId}, 'queue', 'demo', 0, ${at.toISOString()}, 1, 'completed', ${at.toISOString()})`,
  );
  const after = await pushSchema(tables, db);
  await after.apply();
});

afterAll(() => client.close());

describe('the T12 migration on an app with old job rows', () => {
  it('creates the three workflow tables, so runs have somewhere to live', async () => {
    const found = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'workflow_%'`,
    );
    expect(found.rows.map(row => row.table_name).sort()).toEqual([
      'workflow_runs',
      'workflow_signals',
      'workflow_steps',
    ]);
  });

  it('old live and archived job rows keep every value and get run_id = null, so no job is claimed by a run it never belonged to', async () => {
    const live = (await db.select().from(tables.jobs).where(eq(tables.jobs.id, liveId)))[0];
    const archived = (await db.select().from(tables.jobArchive).where(eq(tables.jobArchive.id, archivedId)))[0];
    expect(live).toMatchObject({ kind: 'queue', jobName: 'demo', args: { n: 1 }, runId: null });
    expect(archived).toMatchObject({ kind: 'queue', jobName: 'demo', outcome: 'completed', runId: null });
  });

  it('invents no run, step or signal rows', async () => {
    expect(await db.select().from(tables.workflowRuns)).toEqual([]);
    expect(await db.select().from(tables.workflowSteps)).toEqual([]);
    expect(await db.select().from(tables.workflowSignals)).toEqual([]);
  });

  it('creates the run_id indexes on both job tables, so the sweeper can find a run’s jobs without a scan', async () => {
    const found = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where indexname in ('journal_jobs_run_id_idx', 'journal_job_archive_run_id_idx')`,
    );
    expect(found.rows.map(row => row.indexname).sort()).toEqual([
      'journal_job_archive_run_id_idx',
      'journal_jobs_run_id_idx',
    ]);
  });
});
