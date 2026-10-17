import type { PgSchema, PgTableFn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
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

/**
 * The journal tables. Call this once in the app's schema module so
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
      /** `effect`: an effect's job for one event. `queue`: a job scheduled by a runner (`@arki/queue/outbox`). */
      kind: varchar('kind', { length: 8 }).notNull().default('effect').$type<'effect' | 'queue'>(),
      /** Set on `effect` rows only. */
      eventSeq: bigint('event_seq', { mode: 'number' }).references(() => events.seq),
      /** Set on `effect` rows only. */
      effect: varchar('effect', { length: 128 }),
      /** Set on `queue` rows only: the persisted job name the runner looks up. */
      jobName: varchar('job_name', { length: 128 }),
      /** Set on `queue` rows only: the job's input as plain JSON, parsed by the runner. */
      args: jsonb('args'),
      /** `queue` rows only, optional: one unfinished row per job name and key. */
      dedupeKey: varchar('dedupe_key', { length: 256 }),
      /** Higher runs first among due jobs. From the effect's schedule. */
      priority: integer('priority').notNull().default(0),
      attempts: integer('attempts').notNull().default(0),
      availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      /** When the row was written. The archive reads the job's age from it. Rows that predate the column take the migration time. */
      enqueuedAt: timestamp('enqueued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      /** The archived job id a replay was made from. Null on every other row. */
      replayOf: text('replay_of'),
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
      // Each kind sets its own columns and leaves the other kind's empty.
      check(
        'journal_jobs_kind_check',
        sql`(${t.kind} = 'effect' and ${t.eventSeq} is not null and ${t.effect} is not null and ${t.jobName} is null and ${t.args} is null and ${t.dedupeKey} is null) or (${t.kind} = 'queue' and ${t.jobName} is not null and ${t.args} is not null and ${t.eventSeq} is null and ${t.effect} is null)`,
      ),
      uniqueIndex('journal_jobs_queue_dedupe_unique')
        .on(t.jobName, t.dedupeKey)
        .where(sql`${t.dedupeKey} is not null`),
    ],
  );

  const jobAttempts = table(
    'journal_job_attempts',
    {
      /** `att_xxx`. */
      id: varchar('id').primaryKey(),
      /** Deleted with the job: ack, discard and cancel fold the attempts into the archive row's `attempt_log` first. */
      jobId: varchar('job_id')
        .notNull()
        .references(() => jobs.id, { onDelete: 'cascade' }),
      /** 1, 2, 3 for this job's tries. */
      attempt: integer('attempt').notNull(),
      startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      /** Null while the attempt is open. */
      finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
      /** Null while open. `superseded`: the lease expired and another worker took the job. */
      outcome: varchar('outcome', { length: 16 }).$type<'ok' | 'retry' | 'dead' | 'superseded'>(),
      error: text('error'),
    },
    t => [index('journal_job_attempts_job_id_started_at_idx').on(t.jobId, t.startedAt)],
  );

  const jobArchive = table(
    'journal_job_archive',
    {
      /** The finished job's id (`job_xxx`). */
      id: varchar('id').primaryKey(),
      kind: varchar('kind', { length: 8 }).notNull().$type<'effect' | 'queue'>(),
      /** No foreign key: the archive outlives whatever the app does to its events. */
      eventSeq: bigint('event_seq', { mode: 'number' }),
      effect: varchar('effect', { length: 128 }),
      jobName: varchar('job_name', { length: 128 }),
      args: jsonb('args'),
      dedupeKey: varchar('dedupe_key', { length: 256 }),
      priority: integer('priority').notNull(),
      enqueuedAt: timestamp('enqueued_at', { withTimezone: true, mode: 'date' }).notNull(),
      attempts: integer('attempts').notNull(),
      lastError: text('last_error'),
      outcome: varchar('outcome', { length: 16 }).notNull().$type<'completed' | 'dead' | 'discarded' | 'cancelled'>(),
      /** The job's attempt rows, oldest first, folded in when the job left the hot table. */
      attemptLog: jsonb('attempt_log'),
      replayOf: text('replay_of'),
      finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }).notNull(),
      archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      /** Resolved from the retention policy when the row was archived. Null keeps it forever. */
      keepUntil: timestamp('keep_until', { withTimezone: true, mode: 'date' }),
      /** Set once the archive sink has the row. Null: not exported yet (or no sink). */
      exportedAt: timestamp('exported_at', { withTimezone: true, mode: 'date' }),
    },
    t => [
      index('journal_job_archive_keep_until_idx').on(t.keepUntil),
      index('journal_job_archive_unexported_idx')
        .on(t.archivedAt)
        .where(sql`${t.exportedAt} is null`),
      index('journal_job_archive_outcome_name_idx').on(
        t.outcome,
        sql`coalesce(${t.effect}, ${t.jobName})`,
        t.archivedAt,
      ),
    ],
  );

  const jobOperations = table(
    'journal_job_operations',
    {
      /** `jop_xxx`. */
      id: varchar('id').primaryKey(),
      action: varchar('action', { length: 32 })
        .notNull()
        .$type<
          'retry' | 'retryDead' | 'discard' | 'cancel' | 'replay' | 'purgeDead' | 'exportArchive' | 'pruneArchive'
        >(),
      /** Who did it: a free string. The retention sweeper writes `system:retention`. */
      actor: varchar('actor', { length: 256 }).notNull(),
      reason: text('reason'),
      /** The Foreman execution that asked for it, when there was one. */
      executionId: varchar('execution_id', { length: 256 }),
      /** The jobs it touched, as a JSON array of ids. */
      jobIds: jsonb('job_ids').notNull().$type<readonly string[]>(),
      count: integer('count').notNull(),
      at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    t => [index('journal_job_operations_job_ids_idx').using('gin', t.jobIds)],
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
    /**
     * HTTP response cache rows only (`@arki/journal/http`); null on a command receipt. The token of the
     * request that holds the key. Only that request can finish or abandon it.
     */
    owner: varchar('owner', { length: 64 }),
    /** Response cache rows only. After this time the key can be taken again. A command receipt never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    /** Response cache rows only. The stored response once the request finished; null while it runs. */
    response: jsonb('response'),
  });

  const cursors = table('journal_cursors', {
    /** The async projection's name. */
    name: varchar('name', { length: 128 }).primaryKey(),
    /** Global scan progress: every event with a seq at or below this was looked at, matching or not. */
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  });

  return { events, jobs, jobAttempts, jobArchive, jobOperations, receipts, cursors };
}

export type JournalTables = ReturnType<typeof journalTables>;
