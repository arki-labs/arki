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
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { EventLogPosition } from './event-log.js';
import type { WorkflowShape } from './workflow/shape.js';
import type { RUN_STATES, StepPhase, STEP_STATUSES } from './workflow/states.js';

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
      /** `effect` rows of a stored event: its seq. Null for a transient entity's event, which has no row. The worker never reads the event by it; `args` holds the copy it runs. */
      eventSeq: bigint('event_seq', { mode: 'number' }).references(() => events.seq),
      /** Set on `effect` rows only. */
      effect: varchar('effect', { length: 128 }),
      /** Set on `queue` rows only: the persisted job name the runner looks up. */
      jobName: varchar('job_name', { length: 128 }),
      /**
       * `queue` rows: the job's input as plain JSON, parsed by the runner.
       * `effect` rows: the job's own copy of the `journal_events` row it is for, decoded by `StoredEventRow`.
       */
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
      /**
       * The workflow run that owns this step or timer job. Null for every other job and for rows written
       * before the column. No foreign key: the job outlives a pruned run row until the sweeper archives it.
       */
      runId: varchar('run_id', { length: 256 }),
    },
    t => [
      unique('journal_jobs_event_seq_effect_unique').on(t.eventSeq, t.effect),
      // One job per event and effect for transient events too, whose `event_seq` is null: an archive
      // replay of such a job cannot run the effect twice.
      uniqueIndex('journal_jobs_effect_event_id_unique')
        .on(sql`(${t.args}->>'id')`, t.effect)
        .where(sql`${t.kind} = 'effect'`),
      index('journal_jobs_due_idx')
        .on(t.priority.desc(), t.availableAt)
        .where(sql`${t.deadAt} is null`),
      // Each kind sets its own columns and leaves the other kind's empty. An effect row's `event_seq`
      // is optional: a transient entity's event has no row to point at.
      check(
        'journal_jobs_kind_check',
        sql`(${t.kind} = 'effect' and ${t.effect} is not null and ${t.args} is not null and ${t.jobName} is null and ${t.dedupeKey} is null) or (${t.kind} = 'queue' and ${t.jobName} is not null and ${t.args} is not null and ${t.eventSeq} is null and ${t.effect} is null)`,
      ),
      uniqueIndex('journal_jobs_queue_dedupe_unique')
        .on(t.jobName, t.dedupeKey)
        .where(sql`${t.dedupeKey} is not null`),
      index('journal_jobs_run_id_idx')
        .on(t.runId)
        .where(sql`${t.runId} is not null`),
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
      /** The workflow run the job belonged to. Null for other jobs and for rows archived before the column. */
      runId: varchar('run_id', { length: 256 }),
    },
    t => [
      index('journal_job_archive_run_id_idx')
        .on(t.runId)
        .where(sql`${t.runId} is not null`),
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
          | 'retry'
          | 'retryDead'
          | 'discard'
          | 'cancel'
          | 'replay'
          | 'purgeDead'
          | 'exportArchive'
          | 'pruneArchive'
          | 'pruneWorkflows'
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
    /** Completed response cache rows only. Retention starts at finish; null while unresolved. Command receipts never expire. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    /** Response cache rows only. The stored response once the request finished; null while it runs. */
    response: jsonb('response'),
  });

  const cursors = table('journal_cursors', {
    /** The async projection's name. */
    name: varchar('name', { length: 128 }).primaryKey(),
    /**
     * Global scan progress: every event up to this position was looked at, matching or not. The
     * log's own cursor (the built-in log writes a seq as text). Null: nothing scanned yet.
     */
    position: text('position').$type<EventLogPosition>(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  });

  // `workflow.run` entity table. Its `version` is the journal's entity version; the workflow's own version is `workflowVersion`.
  const workflowRuns = table(
    'workflow_runs',
    {
      /** `wfr_xxx`, or the caller's own id: `start` is idempotent on it. */
      id: varchar('id', { length: 256 }).primaryKey(),
      name: varchar('name', { length: 128 }).notNull(),
      /** The workflow definition's version this run is pinned to. */
      workflowVersion: integer('workflow_version').notNull(),
      /** The node manifest at start: lets Foreman draw a run whose code is gone. */
      shape: jsonb('shape').notNull().$type<WorkflowShape>(),
      shapeHash: varchar('shape_hash', { length: 64 }).notNull(),
      input: jsonb('input').notNull(),
      state: varchar('state', { length: 16 })
        .notNull()
        .$type<(typeof RUN_STATES)[number]>(),
      /** The node the run is at. Null once finished. */
      node: varchar('node', { length: 256 }),
      /** Done step results by node path. `null` for a node a `when` skipped. A projection of the events, bounded by `limits.payload`. */
      results: jsonb('results').notNull().$type<Readonly<Record<string, unknown>>>().default({}),
      output: jsonb('output'),
      /** When a parked run wakes by itself. */
      wakeAt: timestamp('wake_at', { withTimezone: true, mode: 'date' }),
      deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'date' }),
      /** The signal name a parked run waits for. */
      waitingFor: varchar('waiting_for', { length: 128 }),
      parentId: varchar('parent_id', { length: 256 }),
      parentPath: varchar('parent_path', { length: 256 }),
      concurrencyKey: varchar('concurrency_key', { length: 256 }),
      /** The key of the tenant the run belongs to, from `start`. A child has its parent's. */
      scope: varchar('scope', { length: 256 }),
      /** Labels to find the run by, from `start`. A child has none of its own. */
      tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
      /** Free JSON data about the run, from `start`. */
      metadata: jsonb('metadata').notNull().$type<Readonly<Record<string, unknown>>>().default({}),
      /** The top run of the tree this run is in. Null for a run with no parent. */
      rootId: varchar('root_id', { length: 256 }),
      /**
       * How many of the run's events changed only `metadata` or `tags`. `version - field_changes` counts the events
       * that moved the run, so an approval taken on a run is not voided by its progress reports.
       */
      fieldChanges: integer('field_changes').notNull().default(0),
      /** When the run's first node is due, from `start({ delay })` or `reschedule`. Null: it was due at once. */
      startAt: timestamp('start_at', { withTimezone: true, mode: 'date' }),
      /** When a run whose first node has not started gives up and ends `expired`. Null: it never expires. */
      ttlAt: timestamp('ttl_at', { withTimezone: true, mode: 'date' }),
      /** The `ttl` of `start` in milliseconds (a bigint: 25 days is past an integer), so `reschedule` can move `ttl_at`. */
      ttlMs: bigint('ttl_ms', { mode: 'number' }),
      /** The batch of `def.startBatch` that started the run. Null for a run started on its own. */
      batchId: varchar('batch_id', { length: 256 }),
      /** The run that `journal.workflows.replay` started this one again from. Null for a run that is no replay. */
      replayOf: varchar('replay_of', { length: 256 }),
      cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
      cancelReason: text('cancel_reason'),
      startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
      finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
      /** Set when the run finishes, from the retention policy. Null keeps it. */
      keepUntil: timestamp('keep_until', { withTimezone: true, mode: 'date' }),
      /** The journal's entity version. */
      version: integer('version').notNull().default(0),
    },
    t => [
      // The unfinished runs per name and concurrency key, which the start gate counts under an advisory lock.
      index('workflow_runs_concurrency_idx')
        .on(t.name, t.concurrencyKey)
        .where(sql`${t.finishedAt} is null`),
      index('workflow_runs_state_name_idx').on(t.state, t.name),
      index('workflow_runs_parent_id_idx').on(t.parentId),
      index('workflow_runs_keep_until_idx').on(t.keepUntil),
      index('workflow_runs_scope_idx').on(t.scope),
      index('workflow_runs_tags_idx').using('gin', t.tags),
      index('workflow_runs_root_id_idx').on(t.rootId),
      index('workflow_runs_batch_id_idx').on(t.batchId),
    ],
  );

  const workflowSteps = table(
    'workflow_steps',
    {
      runId: varchar('run_id', { length: 256 })
        .notNull()
        .references(() => workflowRuns.id, { onDelete: 'cascade' }),
      /** The node's path inside the run. */
      path: varchar('path', { length: 256 }).notNull(),
      /** `undo` rows are compensation: their own key, attempts and retry. */
      phase: varchar('phase', { length: 4 }).notNull().$type<StepPhase>(),
      status: varchar('status', { length: 16 }).notNull().$type<(typeof STEP_STATUSES)[number]>(),
      attempt: integer('attempt').notNull().default(0),
      /** The step's idempotency key. Null on a step that was skipped before it was ever scheduled. */
      key: varchar('key', { length: 512 }),
      jobId: varchar('job_id'),
      result: jsonb('result'),
      error: text('error'),
      /** Why a step was skipped. */
      reason: text('reason'),
      startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
      finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    },
    t => [primaryKey({ name: 'workflow_steps_pk', columns: [t.runId, t.path, t.phase] })],
  );

  const workflowSignals = table(
    'workflow_signals',
    {
      /** `wsg_xxx`. */
      id: varchar('id').primaryKey(),
      runId: varchar('run_id', { length: 256 })
        .notNull()
        .references(() => workflowRuns.id, { onDelete: 'cascade' }),
      name: varchar('name', { length: 128 }).notNull(),
      /** The sender's own id for this delivery. A repeat returns the first row. */
      deliveryId: varchar('delivery_id', { length: 256 }).notNull(),
      payload: jsonb('payload'),
      receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      /** Null until a wait takes the signal. A signal is consumed once. */
      consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
      /** The node path that took it. */
      consumedBy: varchar('consumed_by', { length: 256 }),
    },
    t => [unique('workflow_signals_run_name_delivery_unique').on(t.runId, t.name, t.deliveryId)],
  );

  return {
    events,
    jobs,
    jobAttempts,
    jobArchive,
    jobOperations,
    receipts,
    cursors,
    workflowRuns,
    workflowSteps,
    workflowSignals,
  };
}

export type JournalTables = ReturnType<typeof journalTables>;

/** A `timestamptz` column after a JSON round trip: an ISO string in, a `Date` out. */
const jsonTimestamp = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: text => new Date(text),
  encode: date => date.toISOString(),
});

/**
 * A `journal_events` row as an effect job's `args` holds it: the row the write inserted, after the
 * jsonb round trip. Its output is exactly the row type (`JournalTables['events']['$inferSelect']`),
 * so the worker decodes the copy as it would decode the stored row. The type is the table's; this
 * schema only brings the timestamps back from their JSON strings.
 */
export const StoredEventRow = z.object({
  seq: z.int(),
  id: z.string(),
  kind: z.string(),
  entityId: z.string(),
  version: z.int(),
  type: z.string(),
  data: z.unknown(),
  meta: z.unknown(),
  recordedAt: jsonTimestamp,
  commandId: z.string().nullable(),
  causeSeq: z.int().nullable(),
  correlationId: z.string().nullable(),
  erasedAt: jsonTimestamp.nullable(),
  schemaVersion: z.int(),
});
export type StoredEventRow = JournalTables['events']['$inferSelect'];
/** The node manifest a run stores in `workflow_runs.shape`, the type of that column. */
export type { WorkflowShape } from './workflow/shape.js';

/** The names of journal tables that no top-level export of `Module` holds. */
type MissingJournalTables<Module> = {
  [Name in keyof JournalTables]: JournalTables[Name] extends Module[keyof Module] ? never : Name;
}[keyof JournalTables];

/**
 * drizzle-kit reads only a schema module's top-level exports, so every journal
 * table must be exported on its own. Put this line in the module that calls
 * `journalTables()`:
 *
 * `type _ = ExportsEveryJournalTable<typeof import('./journal.tables')>;`
 *
 * It fails to compile while a table is missing and names it. Tables match by
 * type, so the export names are the app's own.
 */
export type ExportsEveryJournalTable<
  Module extends ([MissingJournalTables<Module>] extends [never]
    ? unknown
    : { missingJournalTableExports: MissingJournalTables<Module> }),
> = Module;
