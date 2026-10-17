/**
 * The job verbs an operator uses: read the hot table and the archive, retry, discard, cancel, purge and replay.
 * Every verb that changes jobs writes exactly one `journal_job_operations` row in the same transaction, so the
 * audit and the change commit or roll back together. A caller's transaction is joined (a nested transaction is a
 * savepoint); the wake fires after commit only when the verb opened the transaction itself.
 * Imports only leaf files. Must not import `journal`, `api` or `worker` (the `JobRow` type is the one exception).
 */
import type { SQL } from 'drizzle-orm';
import { and, asc, desc, eq, getTableColumns, inArray, is, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { PgAsyncTransaction } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { getLogger } from '@arki/log';

import type { JournalTables } from './pg.js';
import type { ArchivedJob, ArchiveOutcome, EffectRetention, ResolvedKeep, ResolvedRetention } from './retention.js';
import type { DbHandle } from './types.js';
import type { JobRow } from './worker.js';
import { JournalError } from './errors.js';
import { jobId as newJobId, operationId as newOperationId } from './id.js';
import { keepFor, keepUntil, retryableForMs } from './retention.js';

const debug = getLogger('arki:journal');

/** Where a job is right now, from the database clock. `ready` and `delayed` are waiting; `running` holds a live lease. */
export type JobState = 'ready' | 'delayed' | 'running' | 'dead';

export type JobFilter = {
  /** `pending`: ready, delayed and running together. Default `pending`. */
  readonly status?: JobState | 'pending' | 'all';
  readonly effect?: string;
  readonly job?: string;
};

/** Ids (at most 500), or a filter over dead jobs, oldest dead first (`limit` default 100, at most 500). */
export type JobSelection =
  | { readonly ids: readonly string[] }
  | {
      readonly effect?: string;
      readonly job?: string;
      readonly deadBefore?: Date;
      readonly limit?: number;
    };

/** Who asked, and why. `actor` is a free string the app owns: a user id, `system:retention`, a script name. */
export type JobOperationInput = {
  readonly actor: string;
  readonly reason?: string;
  /** The Foreman execution that asked for it. */
  readonly executionId?: string;
};

export type JobAttempt = JournalTables['jobAttempts']['$inferSelect'];
export type JobOperation = JournalTables['jobOperations']['$inferSelect'];
export type { ArchivedJob } from './retention.js';

/** The event header of an effect job. The payload is not read. */
export type EventHeader = {
  readonly seq: number;
  readonly id: string;
  readonly kind: string;
  readonly entityId: string;
  readonly version: number;
  readonly type: string;
  readonly recordedAt: Date;
};

export type JobWithState = JobRow & { readonly state: JobState };

export type JobDetail = JobWithState & {
  /** Null on a queue job. */
  readonly event: EventHeader | null;
  /** Oldest first. A retried job keeps the attempts of its earlier runs; attempt numbers restart at 1. */
  readonly attemptLog: readonly JobAttempt[];
  /** The latest 100 operations that touched this job, newest first. */
  readonly operations: readonly JobOperation[];
};

export type JobCount = {
  readonly kind: JobRow['kind'];
  /** The effect name, or the queue job name. */
  readonly name: string;
  readonly ready: number;
  readonly delayed: number;
  readonly running: number;
  readonly dead: number;
  readonly oldestDeadAt: Date | null;
};

/** `after` is the `next` of the previous page, passed back untouched. */
type PageOptions = { readonly limit?: number; readonly after?: string };

const LIST_LIMIT = { default: 100, max: 200 } as const;
const RETRY_DEAD_LIMIT = { default: 100, max: 500 } as const;
const PURGE_LIMIT = { default: 1000, max: 5000 } as const;
const OPERATION_HISTORY = 100;

export type JobOpsDeps = {
  readonly tables: JournalTables;
  readonly retention: ResolvedRetention;
  /** Wakes this process's workers. */
  readonly wake: () => void;
  /** The per-effect retention override of a job row (the worker's lookup, shared). Default: none. */
  readonly overrideFor?: (job: { readonly effect: string | null }) => EffectRetention | undefined;
};

const idRows = z.object({ id: z.string() }).array();
/** The ids a raw statement returned. `execute` hands back the driver's result: `{ rows }` (pg, PGlite) or the rows themselves (postgres-js). */
const rowIds = (result: unknown): string[] => {
  const parsed = z.union([idRows, z.object({ rows: idRows })]).parse(result);
  return (Array.isArray(parsed) ? parsed : parsed.rows).map(row => row.id);
};

const argument = (what: string, detail: string) => new JournalError('BAD_ARGUMENT', 'job', what, detail);

function bounded(what: string, value: number | undefined, range: { readonly default: number; readonly max: number }) {
  const limit = value ?? range.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > range.max) {
    throw argument(what, `limit ${String(limit)} must be a whole number from 1 to ${range.max}`);
  }
  return limit;
}

function assertOperation(op: JobOperationInput): void {
  if (op.actor.trim() === '') throw argument('actor', 'every operation names who did it; `actor` must not be empty');
}

const iso = (date: Date) => sql`${date.toISOString()}::timestamptz`;

/*
 * The cursor. Postgres keeps microseconds and a JS `Date` only milliseconds, so the sort time travels as text from
 * the database, exact to the microsecond, and goes back into a row comparison on the raw column: the table's
 * indexes serve the sort and no row repeats or goes missing at a page edge. Opaque on purpose: the caller never
 * builds one, so the encoding can change without breaking anyone.
 */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const cursorShape = z.tuple([z.string().regex(CURSOR_TIME), z.string().min(1)]);

/** The column as microsecond-exact UTC text, selected next to each paged row. */
const cursorText = (column: SQL | { readonly name: string }) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

// `btoa` rather than `Buffer`: the package runs in the browser and Hermes too. The payload is ASCII (a timestamp and a generated id).
const encodeCursor = (at: string, id: string): string =>
  btoa(JSON.stringify([at, id]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

function decodeCursor(after: string): { readonly at: string; readonly id: string } {
  try {
    const [at, id] = cursorShape.parse(JSON.parse(atob(after.replaceAll('-', '+').replaceAll('_', '/'))));
    return { at, id };
  } catch {
    throw argument('after', 'not a cursor this journal gave out; pass the `next` of a previous page unchanged');
  }
}

/** The row comparison for the page after `after`: `(column, id)` strictly past the cursor in the sort direction. */
function pastCursor(
  after: string | undefined,
  column: SQL | { readonly name: string },
  id: SQL | { readonly name: string },
  newestFirst: boolean,
) {
  if (after === undefined) return;
  const cursor = decodeCursor(after);
  const past = sql.raw(newestFirst ? '<' : '>');
  return sql`(${column}, ${id}) ${past} (${cursor.at}::timestamp AT TIME ZONE 'UTC', ${cursor.id}::varchar)`;
}

/** Cut a `limit + 1` fetch into a page and the cursor of its last row. */
function pageOf<Row extends { readonly id: string; readonly cursorAt: string }>(rows: readonly Row[], limit: number) {
  const items: Omit<Row, 'cursorAt'>[] = [];
  let next: string | null = null;
  for (const [index, row] of rows.slice(0, limit).entries()) {
    const { cursorAt, ...item } = row;
    items.push(item);
    if (index === limit - 1 && rows.length > limit) next = encodeCursor(cursorAt, row.id);
  }
  return { items, next };
}

const noOverride = (): EffectRetention | undefined => void 0;

export function createJobOps(deps: JobOpsDeps) {
  const { events: eventsTable, jobs: jobsTable, jobAttempts, jobArchive, jobOperations } = deps.tables;
  const policy = deps.retention;

  const stateOf = sql<JobState>`
    CASE
        WHEN ${jobsTable.deadAt} IS NOT NULL THEN 'dead'
        WHEN ${jobsTable.leaseUntil} > now() THEN 'running'
        WHEN ${jobsTable.availableAt} > now() THEN 'delayed'
        ELSE 'ready' END
  `;
  const where = {
    dead: sql`${jobsTable.deadAt} IS NOT NULL`,
    pending: sql`${jobsTable.deadAt} IS NULL`,
    running: sql`${jobsTable.deadAt} IS NULL AND ${jobsTable.leaseUntil} > now()`,
    delayed: sql`${jobsTable.deadAt} IS NULL AND (${jobsTable.leaseUntil} IS NULL OR ${jobsTable.leaseUntil} <= now()) AND ${jobsTable.availableAt} > now()`,
    ready: sql`${jobsTable.deadAt} IS NULL AND (${jobsTable.leaseUntil} IS NULL OR ${jobsTable.leaseUntil} <= now()) AND ${jobsTable.availableAt} <= now()`,
  } as const;
  const jobName = sql<string>`coalesce(${jobsTable.effect}, ${jobsTable.jobName})`;
  const withState = { ...getTableColumns(jobsTable), state: stateOf };

  const nameFilter = (filter: { readonly effect?: string; readonly job?: string }) => [
    filter.effect === undefined ? undefined : eq(jobsTable.effect, filter.effect),
    filter.job === undefined ? undefined : eq(jobsTable.jobName, filter.job),
  ];

  // ---- reads --------------------------------------------------------------------------------------------------

  /**
   * Pending jobs by `(available_at, id)` ascending; dead jobs by `(dead_at, id)` descending. `limit` 1 to 200,
   * default 100. `next` is the cursor of the following page, null on the last one.
   */
  const jobs = async (
    db: DbHandle,
    opts?: JobFilter & PageOptions,
  ): Promise<{ readonly jobs: JobWithState[]; readonly next: string | null }> => {
    const status = opts?.status ?? 'pending';
    const limit = bounded('jobs', opts?.limit, LIST_LIMIT);
    const newestFirst = status === 'dead';
    const key = newestFirst ? jobsTable.deadAt : jobsTable.availableAt;
    const rows = await db
      .select({ ...withState, cursorAt: cursorText(key) })
      .from(jobsTable)
      .where(
        and(
          status === 'all' ? undefined : where[status],
          ...nameFilter(opts ?? {}),
          pastCursor(opts?.after, key, jobsTable.id, newestFirst),
        ),
      )
      .orderBy(...(newestFirst ? [desc(key), desc(jobsTable.id)] : [asc(key), asc(jobsTable.id)]))
      .limit(limit + 1);
    const page = pageOf(rows, limit);
    return { jobs: page.items, next: page.next };
  };

  const job = async (db: DbHandle, id: string): Promise<JobDetail | undefined> => {
    const [row] = await db.select(withState).from(jobsTable).where(eq(jobsTable.id, id)).limit(1);
    if (row === undefined) return undefined;
    const [event] =
      row.eventSeq === null
        ? []
        : await db
            .select({
              seq: eventsTable.seq,
              id: eventsTable.id,
              kind: eventsTable.kind,
              entityId: eventsTable.entityId,
              version: eventsTable.version,
              type: eventsTable.type,
              recordedAt: eventsTable.recordedAt,
            })
            .from(eventsTable)
            .where(eq(eventsTable.seq, row.eventSeq))
            .limit(1);
    const attempts = await db
      .select()
      .from(jobAttempts)
      .where(eq(jobAttempts.jobId, id))
      .orderBy(asc(jobAttempts.startedAt), asc(jobAttempts.attempt));
    const operations = await db
      .select()
      .from(jobOperations)
      .where(sql`${jobOperations.jobIds} @> ${JSON.stringify([id])}::jsonb`)
      .orderBy(desc(jobOperations.at), desc(jobOperations.id))
      .limit(OPERATION_HISTORY);
    return { ...row, event: event ?? null, attemptLog: attempts, operations };
  };

  const jobCounts = (db: DbHandle): Promise<JobCount[]> =>
    db
      .select({
        kind: jobsTable.kind,
        name: jobName,
        ready: sql<number>`(count(*) filter (where ${where.ready}))::int`,
        delayed: sql<number>`(count(*) filter (where ${where.delayed}))::int`,
        running: sql<number>`(count(*) filter (where ${where.running}))::int`,
        dead: sql<number>`(count(*) filter (where ${where.dead}))::int`,
        oldestDeadAt: sql<Date | null>`min(${jobsTable.deadAt})`.mapWith(jobsTable.deadAt),
      })
      .from(jobsTable)
      .groupBy(jobsTable.kind, jobName)
      .orderBy(asc(jobsTable.kind), asc(jobName));

  /** Newest first by `(at, id)`. `jobId` keeps the operations that touched that job. */
  const jobOperationsList = async (
    db: DbHandle,
    opts?: PageOptions & { readonly jobId?: string },
  ): Promise<{ readonly operations: JobOperation[]; readonly next: string | null }> => {
    const limit = bounded('jobOperations', opts?.limit, LIST_LIMIT);
    const rows = await db
      .select({ ...getTableColumns(jobOperations), cursorAt: cursorText(jobOperations.at) })
      .from(jobOperations)
      .where(
        and(
          opts?.jobId === undefined
            ? undefined
            : sql`${jobOperations.jobIds} @> ${JSON.stringify([opts.jobId])}::jsonb`,
          pastCursor(opts?.after, jobOperations.at, jobOperations.id, true),
        ),
      )
      .orderBy(desc(jobOperations.at), desc(jobOperations.id))
      .limit(limit + 1);
    const page = pageOf(rows, limit);
    return { operations: page.items, next: page.next };
  };

  /** Newest first by `(archived_at, id)`. */
  const archivedJobs = async (
    db: DbHandle,
    opts?: PageOptions & {
      readonly outcome?: ArchiveOutcome;
      readonly effect?: string;
      readonly job?: string;
    },
  ): Promise<{ readonly jobs: ArchivedJob[]; readonly next: string | null }> => {
    const limit = bounded('archivedJobs', opts?.limit, LIST_LIMIT);
    const rows = await db
      .select({ ...getTableColumns(jobArchive), cursorAt: cursorText(jobArchive.archivedAt) })
      .from(jobArchive)
      .where(
        and(
          opts?.outcome === undefined ? undefined : eq(jobArchive.outcome, opts.outcome),
          opts?.effect === undefined ? undefined : eq(jobArchive.effect, opts.effect),
          opts?.job === undefined ? undefined : eq(jobArchive.jobName, opts.job),
          pastCursor(opts?.after, jobArchive.archivedAt, jobArchive.id, true),
        ),
      )
      .orderBy(desc(jobArchive.archivedAt), desc(jobArchive.id))
      .limit(limit + 1);
    const page = pageOf(rows, limit);
    return { jobs: page.items, next: page.next };
  };

  /** One archived job with its `attemptLog`: the attempts the job had when it left the hot table, oldest first. */
  const archivedJob = async (db: DbHandle, id: string) => {
    const [row] = await db.select().from(jobArchive).where(eq(jobArchive.id, id)).limit(1);
    return row;
  };

  /** Without a sink nothing is ever exported, so `unexported` is 0 and `oldestUnexportedAt` null. */
  const archiveStatus = async (db: DbHandle) => {
    const sinkWaiting = policy.sink === undefined ? sql`false` : sql`${jobArchive.exportedAt} IS NULL`;
    const [row] = await db
      .select({
        rows: sql<number>`count(*)::int`,
        unexported: sql<number>`(count(*) filter (where ${sinkWaiting}))::int`,
        oldestUnexportedAt: sql<Date | null>`min(${jobArchive.archivedAt}) filter (where ${sinkWaiting})`.mapWith(
          jobArchive.archivedAt,
        ),
        pastKeepUntil: sql<number>`(count(*) filter (where ${jobArchive.keepUntil} < now()))::int`,
      })
      .from(jobArchive);
    return row ?? { rows: 0, unexported: 0, oldestUnexportedAt: null, pastKeepUntil: 0 };
  };

  const overrideOf = deps.overrideFor ?? noOverride;
  /** The keep rule for a job row going out with this outcome: its effect's override, else the journal's. */
  const keepOf =
    (outcome: ArchiveOutcome) =>
    (row: { readonly effect: string | null }): ResolvedKeep =>
      keepFor(policy, outcome, overrideOf(row));

  // ---- writes -------------------------------------------------------------------------------------------------

  /** The transaction is ours when the caller gave a root database; then the wake is ours to fire after commit. */
  const inTransaction = async <T>(db: DbHandle, run: (tx: DbHandle) => Promise<T>, wake: boolean): Promise<T> => {
    const owns = !is(db, PgAsyncTransaction);
    const result = await db.transaction(run);
    if (owns && wake) deps.wake();
    return result;
  };

  const record = async (
    tx: DbHandle,
    action: JobOperation['action'],
    op: JobOperationInput,
    ids: readonly string[],
    count = ids.length,
  ): Promise<string> => {
    const id = newOperationId();
    await tx.insert(jobOperations).values({
      id,
      action,
      actor: op.actor,
      reason: op.reason ?? null,
      executionId: op.executionId ?? null,
      jobIds: ids,
      count,
    });
    return id;
  };

  /**
   * Remove jobs from the hot table and, for each job whose keep rule stores, write its archive row in the same
   * statement with the attempt log folded in (the attempts are read from the pre-delete snapshot, before the
   * cascade removes them). The rows `where` matches are locked first and grouped by effect, because one call can
   * hold effects with different keep rules; each group is then one statement. `limit` takes the oldest dead first
   * and skips rows another transaction holds. `eligible` drops candidates after the lock (a per-effect horizon).
   */
  const removeJobs = async (
    tx: DbHandle,
    args: {
      readonly where: SQL | undefined;
      readonly limit?: number;
      readonly eligible?: (row: { readonly effect: string | null; readonly deadAt: Date | null }) => boolean;
      readonly outcome: Exclude<ArchiveOutcome, 'completed'>;
      /** What the archive row stores as `finished_at`. */
      readonly finishedAt: SQL;
      readonly keepOf: (row: { readonly effect: string | null }) => ResolvedKeep;
    },
  ): Promise<{ readonly archivedIds: readonly string[]; readonly deletedIds: readonly string[] }> => {
    const query = tx
      .select({ id: jobsTable.id, effect: jobsTable.effect, deadAt: jobsTable.deadAt })
      .from(jobsTable)
      .where(args.where)
      .orderBy(asc(jobsTable.deadAt), asc(jobsTable.id));
    const found =
      args.limit === undefined
        ? await query.for('update')
        : await query.limit(args.limit).for('update', { skipLocked: true });
    const groups = new Map<string, { keep: ResolvedKeep; ids: string[] }>();
    for (const row of found) {
      if (args.eligible?.(row) === false) continue;
      const group = groups.get(row.effect ?? '') ?? { keep: args.keepOf(row), ids: [] };
      group.ids.push(row.id);
      groups.set(row.effect ?? '', group);
    }
    const archivedIds: string[] = [];
    const deletedIds: string[] = [];
    for (const { keep, ids } of groups.values()) {
      if (!keep.store) {
        const rows = await tx.delete(jobsTable).where(inArray(jobsTable.id, ids)).returning({ id: jobsTable.id });
        deletedIds.push(...rows.map(row => row.id));
        continue;
      }
      // Retention is a horizon of days, so the worker's clock is good enough for keep_until.
      const until = keepUntil(keep, new Date())?.toISOString() ?? null;
      const result: unknown = await tx.execute(sql`
        WITH gone AS (
          DELETE FROM ${jobsTable} WHERE ${inArray(jobsTable.id, ids)} RETURNING *
        ), log AS (
          SELECT a.job_id, jsonb_agg(jsonb_build_object(
            'attempt', a.attempt,
            'startedAt', a.started_at,
            'finishedAt', coalesce(a.finished_at, now()),
            'outcome', coalesce(a.outcome, 'superseded'),
            'error', a.error
          ) ORDER BY a.started_at, a.attempt) AS entries
          FROM ${jobAttempts} a WHERE a.job_id IN (SELECT id FROM gone) GROUP BY a.job_id
        )
        INSERT INTO ${jobArchive} (
          id, kind, event_seq, effect, job_name, args, dedupe_key, priority, enqueued_at, attempts,
          last_error, outcome, attempt_log, replay_of, finished_at, keep_until
        )
        SELECT g.id, g.kind, g.event_seq, g.effect, g.job_name, g.args, g.dedupe_key, g.priority, g.enqueued_at, g.attempts,
          g.last_error, ${args.outcome}::varchar, coalesce(log.entries, '[]'::jsonb), g.replay_of, ${args.finishedAt},
          ${until}::timestamptz
        FROM gone g LEFT JOIN log ON log.job_id = g.id
        RETURNING id
      `);
      archivedIds.push(...rowIds(result));
    }
    return { archivedIds, deletedIds };
  };

  const retryPatch = {
    deadAt: null,
    attempts: 0,
    lastError: null,
    leaseToken: null,
    leaseUntil: null,
    availableAt: sql`now()`,
  } as const;

  /** Dead to pending under the same id (the idempotency key a handler passes outside). Earlier attempt rows stay. */
  const retry = async (db: DbHandle, id: string, op: JobOperationInput): Promise<{ operationId: string }> => {
    assertOperation(op);
    return inTransaction(
      db,
      async tx => {
        const rows = await tx
          .update(jobsTable)
          .set(retryPatch)
          .where(and(eq(jobsTable.id, id), isNotNull(jobsTable.deadAt)))
          .returning({ id: jobsTable.id });
        if (rows.length === 0)
          throw new JournalError('JOB_NOT_DEAD', 'job', id, 'not a dead job; only a dead job is retried');
        const operationId = await record(tx, 'retry', op, [id]);
        debug.debug('retry {jobId}: {operationId}', { jobId: id, operationId });
        return { operationId };
      },
      true,
    );
  };

  /** A dead job leaves the hot table. It lands in the archive as `discarded` unless the policy keeps nothing. */
  const discard = async (db: DbHandle, id: string, op: JobOperationInput): Promise<{ operationId: string }> => {
    assertOperation(op);
    return inTransaction(
      db,
      async tx => {
        const removed = await removeJobs(tx, {
          where: and(eq(jobsTable.id, id), isNotNull(jobsTable.deadAt)),
          outcome: 'discarded',
          finishedAt: sql`now()`,
          keepOf: keepOf('discarded'),
        });
        const gone = [...removed.archivedIds, ...removed.deletedIds];
        if (gone.length === 0)
          throw new JournalError('JOB_NOT_DEAD', 'job', id, 'not a dead job; only a dead job is discarded');
        const operationId = await record(tx, 'discard', op, gone);
        debug.debug('discard {jobId}: {operationId}, archived {archived}', {
          jobId: id,
          operationId,
          archived: removed.archivedIds.length > 0,
        });
        return { operationId };
      },
      false,
    );
  };

  /** A waiting job (ready or delayed) leaves the hot table, archived as `cancelled`. A job a worker holds is refused. */
  const cancel = async (db: DbHandle, id: string, op: JobOperationInput): Promise<{ operationId: string }> => {
    assertOperation(op);
    return inTransaction(
      db,
      async tx => {
        const removed = await removeJobs(tx, {
          where: and(
            eq(jobsTable.id, id),
            isNull(jobsTable.deadAt),
            or(isNull(jobsTable.leaseUntil), lte(jobsTable.leaseUntil, sql`now()`)),
          ),
          outcome: 'cancelled',
          finishedAt: sql`now()`,
          keepOf: keepOf('cancelled'),
        });
        const gone = [...removed.archivedIds, ...removed.deletedIds];
        if (gone.length === 0) {
          const [row] = await tx.select({ state: stateOf }).from(jobsTable).where(eq(jobsTable.id, id)).limit(1);
          if (row?.state === 'running')
            throw new JournalError('JOB_RUNNING', 'job', id, 'a worker holds the lease; cancel after it finishes');
          throw new JournalError(
            'JOB_NOT_PENDING',
            'job',
            id,
            'not a waiting job; only a ready or delayed job is cancelled',
          );
        }
        const operationId = await record(tx, 'cancel', op, gone);
        debug.debug('cancel {jobId}: {operationId}, archived {archived}', {
          jobId: id,
          operationId,
          archived: removed.archivedIds.length > 0,
        });
        return { operationId };
      },
      false,
    );
  };

  /**
   * Retry many dead jobs, all or none. By ids: every id must be a dead job, else `JOB_NOT_DEAD` and nothing changes.
   * By filter: the oldest dead jobs first, up to `limit`. Nothing selected writes no operation row (`operationId: null`).
   */
  const retryDead = async (
    db: DbHandle,
    selection: JobSelection,
    op: JobOperationInput,
  ): Promise<{ ids: readonly string[]; operationId: string | null }> => {
    assertOperation(op);
    const filter = 'ids' in selection ? undefined : selection;
    const ids = 'ids' in selection ? [...new Set(selection.ids)] : undefined;
    if (ids !== undefined && (ids.length === 0 || ids.length > RETRY_DEAD_LIMIT.max))
      throw argument('ids', `select 1 to ${RETRY_DEAD_LIMIT.max} ids, got ${ids.length}`);
    const limit = ids === undefined ? bounded('retryDead', filter?.limit, RETRY_DEAD_LIMIT) : 0;
    return inTransaction(
      db,
      async tx => {
        const guard =
          ids !== undefined || filter === undefined
            ? and(inArray(jobsTable.id, [...(ids ?? [])]), isNotNull(jobsTable.deadAt))
            : and(
                isNotNull(jobsTable.deadAt),
                inArray(
                  jobsTable.id,
                  sql`(SELECT ${jobsTable.id} FROM ${jobsTable} WHERE ${and(
                    isNotNull(jobsTable.deadAt),
                    ...nameFilter(filter),
                    filter.deadBefore === undefined ? undefined : sql`${jobsTable.deadAt} < ${iso(filter.deadBefore)}`,
                  )} ORDER BY ${jobsTable.deadAt}, ${jobsTable.id} LIMIT ${limit} FOR UPDATE SKIP LOCKED)`,
                ),
              );
        const rows = await tx.update(jobsTable).set(retryPatch).where(guard).returning({ id: jobsTable.id });
        const changed = rows.map(row => row.id);
        if (ids !== undefined && changed.length !== ids.length) {
          const missing = ids.filter(id => !changed.includes(id));
          throw new JournalError('JOB_NOT_DEAD', 'job', missing.join(','), 'not dead jobs; nothing was retried');
        }
        if (changed.length === 0) return { ids: changed, operationId: null };
        const operationId = await record(tx, 'retryDead', op, changed);
        debug.debug('retryDead: {count} jobs, {operationId}', { count: changed.length, operationId });
        return { ids: changed, operationId };
      },
      true,
    );
  };

  /**
   * Dead jobs that died before `olderThan` leave the hot table: archived as `dead`, or deleted when the policy keeps
   * nothing. The oldest go first, up to `limit` (default 1000, at most 5000). A bound shorter than `retryableFor`
   * is refused with `BAD_ARGUMENT`: that would take away jobs an operator may still retry. Nothing purged writes no
   * operation row (`operationId: null`).
   */
  const purgeDead = async (
    db: DbHandle,
    opts: { readonly olderThan: Date; readonly limit?: number },
    op: JobOperationInput,
  ): Promise<{ archived: number; deleted: number; operationId: string | null }> => {
    assertOperation(op);
    const limit = bounded('purgeDead', opts.limit, PURGE_LIMIT);
    const newest = Date.now() - policy.retryableForMs;
    if (!(opts.olderThan.getTime() <= newest))
      throw argument(
        'olderThan',
        `a dead job stays retryable for ${policy.retryableForMs} ms; olderThan must be that far in the past or more`,
      );
    return inTransaction(
      db,
      async tx => {
        // A per-effect `retryableFor` longer than the journal's keeps its dead jobs retryable past `olderThan`.
        const removed = await removeJobs(tx, {
          where: and(isNotNull(jobsTable.deadAt), sql`${jobsTable.deadAt} < ${iso(opts.olderThan)}`),
          limit,
          eligible: row =>
            row.deadAt !== null && row.deadAt.getTime() <= Date.now() - retryableForMs(policy, overrideOf(row)),
          outcome: 'dead',
          finishedAt: sql`coalesce(g.dead_at, now())`,
          keepOf: keepOf('dead'),
        });
        const count = removed.archivedIds.length + removed.deletedIds.length;
        const operationId =
          count === 0 ? null : await record(tx, 'purgeDead', op, [...removed.archivedIds, ...removed.deletedIds]);
        debug.debug('purgeDead: {count} jobs, archived {archived}, {operationId}', {
          count,
          archived: removed.archivedIds.length,
          operationId,
        });
        return { archived: removed.archivedIds.length, deleted: removed.deletedIds.length, operationId };
      },
      false,
    );
  };

  /**
   * A new hot job from an archived one: same kind, effect or job name, event, args and priority, a new `job_xxx`
   * id and `replay_of` set. It is not a retry: the new id is a new idempotency key. `JOB_EXISTS` when an unfinished
   * job already holds the dedupe key (or, for an effect job, the same event and effect).
   */
  const replay = async (
    db: DbHandle,
    archivedId: string,
    op: JobOperationInput,
  ): Promise<{ jobId: string; operationId: string }> => {
    assertOperation(op);
    return inTransaction(
      db,
      async tx => {
        const [source] = await tx.select().from(jobArchive).where(eq(jobArchive.id, archivedId)).limit(1);
        if (source === undefined) throw argument(archivedId, 'no archived job with this id');
        const id = newJobId();
        const rows = await tx
          .insert(jobsTable)
          .values({
            id,
            kind: source.kind,
            eventSeq: source.eventSeq,
            effect: source.effect,
            jobName: source.jobName,
            args: source.args,
            dedupeKey: source.dedupeKey,
            priority: source.priority,
            replayOf: source.id,
          })
          .onConflictDoNothing()
          .returning({ id: jobsTable.id });
        if (rows.length === 0)
          throw new JournalError('JOB_EXISTS', 'job', archivedId, 'an unfinished job holds the same dedupe key');
        const operationId = await record(tx, 'replay', op, [archivedId, id], 1);
        debug.debug('replay {archivedId} as {jobId}: {operationId}', { archivedId, jobId: id, operationId });
        return { jobId: id, operationId };
      },
      true,
    );
  };

  return {
    jobs,
    job,
    jobCounts,
    jobOperations: jobOperationsList,
    archivedJobs,
    archivedJob,
    archiveStatus,
    retry,
    discard,
    cancel,
    retryDead,
    purgeDead,
    replayJob: replay,
  };
}

/** The job verbs and reads, as `createJobOps` builds them. */
export type JobOps = ReturnType<typeof createJobOps>;
