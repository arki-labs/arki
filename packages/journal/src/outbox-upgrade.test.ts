/**
 * An app on the pre-T13 journal schema runs the migration to the T13 schema. The old jobs table is the
 * shape at the commit before T13 (`git show 1f001fa5bf:packages/journal/src/pg.ts`); the migration is
 * what `pushSchema` computes, which is what `drizzle-kit generate` would write.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq, getTableName, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { jobId } from './id.js';
import { journalTables } from './pg.js';

const tables = journalTables();

/** `journal_jobs` before T13: no `enqueued_at`, no `replay_of`. */
const oldJobs = pgTable(
  'journal_jobs',
  {
    id: varchar('id').primaryKey(),
    kind: varchar('kind', { length: 8 }).notNull().default('effect').$type<'effect' | 'queue'>(),
    eventSeq: bigint('event_seq', { mode: 'number' }).references(() => tables.events.seq),
    effect: varchar('effect', { length: 128 }),
    jobName: varchar('job_name', { length: 128 }),
    args: jsonb('args'),
    dedupeKey: varchar('dedupe_key', { length: 256 }),
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
    leaseToken: varchar('lease_token'),
    lastError: text('last_error'),
    deadAt: timestamp('dead_at', { withTimezone: true, mode: 'date' }),
  },
  t => [
    unique('journal_jobs_event_seq_effect_unique').on(t.eventSeq, t.effect),
    index('journal_jobs_due_idx')
      .on(t.priority.desc(), t.availableAt)
      .where(sql`${t.deadAt} is null`),
    check(
      'journal_jobs_kind_check',
      sql`(${t.kind} = 'effect' and ${t.eventSeq} is not null and ${t.effect} is not null and ${t.jobName} is null and ${t.args} is null and ${t.dedupeKey} is null) or (${t.kind} = 'queue' and ${t.jobName} is not null and ${t.args} is not null and ${t.eventSeq} is null and ${t.effect} is null)`,
    ),
    uniqueIndex('journal_jobs_queue_dedupe_unique')
      .on(t.jobName, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
);

const client = new PGlite('memory://');
const db = drizzle({ client });
const pendingId = jobId();
const deadId = jobId();
const deadAt = new Date('2026-09-01T00:00:00.000Z');

beforeAll(async () => {
  await client.waitReady;
  const before = await pushSchema(
    { events: tables.events, jobs: oldJobs, receipts: tables.receipts, cursors: tables.cursors },
    db,
  );
  await before.apply();
  await db.insert(oldJobs).values([
    { id: pendingId, kind: 'queue', jobName: 'demo', args: { n: 1 } },
    { id: deadId, kind: 'queue', jobName: 'demo', args: { n: 2 }, attempts: 8, lastError: 'boom', deadAt },
  ]);
  const after = await pushSchema(tables, db);
  await after.apply();
});

afterAll(() => client.close());

describe('the T13 migration on an app with old job rows', () => {
  it('creates the archive, attempts and operations tables, so the new verbs have somewhere to write', async () => {
    const names = [tables.jobArchive, tables.jobAttempts, tables.jobOperations].map(table => getTableName(table));
    const found = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_name in ('journal_job_archive', 'journal_job_attempts', 'journal_job_operations')`,
    );
    expect(found.rows.map(row => row.table_name).sort()).toEqual([...names].sort());
  });

  it('keeps the old pending and dead rows with every old value, so no queued work or failure is lost', async () => {
    const pending = (await db.select().from(tables.jobs).where(eq(tables.jobs.id, pendingId)))[0];
    const dead = (await db.select().from(tables.jobs).where(eq(tables.jobs.id, deadId)))[0];
    expect(pending).toMatchObject({ kind: 'queue', jobName: 'demo', args: { n: 1 }, attempts: 0, deadAt: null });
    expect(dead).toMatchObject({ kind: 'queue', jobName: 'demo', args: { n: 2 }, attempts: 8, lastError: 'boom' });
    expect(dead?.deadAt).toEqual(deadAt);
  });

  it('gives old rows enqueued_at = migration time and no replay_of, and invents no attempt history', async () => {
    const rows = await db.select().from(tables.jobs);
    const [{ migratedAt }] = (await db.execute<{ migratedAt: Date }>(sql`select now() as "migratedAt"`)).rows as [
      { migratedAt: Date },
    ];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.replayOf).toBeNull();
      // Set when the column was added, i.e. after the rows were written and before this check.
      expect(row.enqueuedAt.getTime()).toBeGreaterThan(deadAt.getTime());
      expect(row.enqueuedAt.getTime()).toBeLessThanOrEqual(new Date(migratedAt).getTime());
    }
    expect(await db.select().from(tables.jobAttempts)).toEqual([]);
    expect(await db.select().from(tables.jobArchive)).toEqual([]);
    expect(await db.select().from(tables.jobOperations)).toEqual([]);
  });
});
