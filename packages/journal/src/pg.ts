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
      // Stamped by the library, never by the app. Null on rows written before these columns existed.
      /** The `cmd_` id of the command run that wrote this event. Null for a bare `journal.write`. */
      commandId: varchar('command_id'),
      /** Inside an effect's `ctx.run`: the seq of the event the job was for. Else null. */
      causeSeq: bigint('cause_seq', { mode: 'number' }),
      /** Shared by every event of one chain: inherited from the cause event or the parent run, else new per root run. */
      correlationId: varchar('correlation_id'),
      /** Set by `forget` when `data` was rewritten to the event's erased form. */
      erasedAt: timestamp('erased_at', { withTimezone: true, mode: 'date' }),
      /** The event's schema version when `data` was written. Older rows are upcast on read. */
      schemaVersion: integer('schema_version').notNull().default(1),
    },
    t => [
      unique('journal_events_kind_entity_id_version_unique').on(t.kind, t.entityId, t.version),
      index('journal_events_correlation_id_idx').on(t.correlationId),
    ],
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
      /** Higher runs first among due jobs. From the effect's schedule. */
      priority: integer('priority').notNull().default(0),
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
      index('journal_jobs_due_idx')
        .on(t.priority.desc(), t.availableAt)
        .where(sql`${t.deadAt} is null`),
    ],
  );

  const receipts = table('journal_receipts', {
    /** The app's idempotency key. Scope it to the caller when it comes from outside (tenant, actor, source). */
    key: varchar('key', { length: 256 }).primaryKey(),
    command: varchar('command', { length: 128 }).notNull(),
    /** The parsed input, after a JSON round trip. A repeat with another input is a conflict. */
    input: jsonb('input').notNull(),
    /** `{ value }` once the run finished; `{}` for a command that returned nothing; null while it runs. */
    result: jsonb('result').$type<{ readonly value?: unknown }>(),
    commandId: varchar('command_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  });

  const cursors = table('journal_cursors', {
    /** The async projection's name. */
    name: varchar('name', { length: 128 }).primaryKey(),
    /** Global scan progress: every event with a seq at or below this was looked at, matching or not. */
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  });

  return { events, jobs, receipts, cursors };
}

export type JournalTables = ReturnType<typeof journalTables>;
