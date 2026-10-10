import type { PgSchema, PgTableFn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * The two journal tables. Call this once in the app's schema module so
 * `drizzle-kit generate` creates them. The library never creates tables at
 * runtime.
 */
export function journalTables(schema?: PgSchema) {
  const table: PgTableFn<string | undefined> = schema === undefined ? pgTable : schema.table;

  const events = table(
    'journal_events',
    {
      /** Global order. `rerun` walks the log by this. */
      seq: bigserial('seq', { mode: 'number' }).primaryKey(),
      /** `evt_xxx`. */
      id: varchar('id').notNull().unique(),
      kind: varchar('kind', { length: 64 }).notNull(),
      entityId: varchar('entity_id', { length: 256 }).notNull(),
      /** 1, 2, 3 per entity. */
      version: integer('version').notNull(),
      type: varchar('type', { length: 128 }).notNull(),
      data: jsonb('data').notNull(),
      meta: jsonb('meta').notNull(),
      recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    t => [unique('journal_events_kind_entity_id_version_unique').on(t.kind, t.entityId, t.version)],
  );

  const jobs = table(
    'journal_jobs',
    {
      /** `job_xxx`. Pass it on as an idempotency key. */
      id: varchar('id').primaryKey(),
      eventSeq: bigint('event_seq', { mode: 'number' })
        .notNull()
        .references(() => events.seq),
      effect: varchar('effect', { length: 128 }).notNull(),
      attempts: integer('attempts').notNull().default(0),
      availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
      leaseToken: varchar('lease_token'),
      lastError: text('last_error'),
      /** Set when attempts run out. A human clears it or deletes the row. */
      deadAt: timestamp('dead_at', { withTimezone: true, mode: 'date' }),
    },
    t => [
      unique('journal_jobs_event_seq_effect_unique').on(t.eventSeq, t.effect),
      index('journal_jobs_available_at_idx')
        .on(t.availableAt)
        .where(sql`${t.deadAt} is null`),
    ],
  );

  return { events, jobs };
}

export type JournalTables = ReturnType<typeof journalTables>;
