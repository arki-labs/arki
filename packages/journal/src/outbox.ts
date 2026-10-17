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
import type { ArchiveOutcome, ResolvedKeep, ResolvedRetention } from './retention.js';
import type { DbHandle } from './types.js';
import type { JobRow } from './worker.js';
import { JournalError } from './errors.js';
import { jobId as newJobId, operationId as newOperationId } from './id.js';
import { keepFor, keepUntil } from './retention.js';

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

/**
 * Where the next page starts: the last row of the previous page. `at` is the row's sort time (`availableAt`;
 * `deadAt` for dead jobs; `archivedAt` for the archive; `at` for operations), `id` its id.
 */
export type JobCursor = { readonly at: Date; readonly id: string };

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

type PageOptions = { readonly limit?: number; readonly after?: JobCursor };

const LIST_LIMIT = { default: 100, max: 200 } as const;
const RETRY_DEAD_LIMIT = { default: 100, max: 500 } as const;
const PURGE_LIMIT = { default: 1000, max: 5000 } as const;
const OPERATION_HISTORY = 100;

export type JobOpsDeps = {
  readonly tables: JournalTables;
  readonly retention: ResolvedRetention;
  /** Wakes this process's workers. */
  readonly wake: () => void;
};

const idRows = z.object({ id: z.string() }).array();
/** The ids a raw statement returned. `execute` hands back the driver's result: `{ rows }` (pg, PGlite) or the rows themselves (postgres-js). */
const archivedIds = (result: unknown): string[] => {
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

/** Postgres keeps microseconds, a JS `Date` milliseconds. Sorting and paging on the truncated value makes the cursor exact. */
const ms = (column: SQL | { readonly name: string }) => sql`date_trunc('milliseconds', ${column})`;
const iso = (date: Date) => sql`${date.toISOString()}::timestamptz`;

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

  /** Pending jobs by `(available_at, id)` ascending; dead jobs by `(dead_at, id)` descending. `limit` 1 to 200, default 100. */
  const jobs = async (db: DbHandle, opts?: JobFilter & PageOptions): Promise<JobWithState[]> => {
    const status = opts?.status ?? 'pending';
    const limit = bounded('jobs', opts?.limit, LIST_LIMIT);
    const newestFirst = status === 'dead';
    const key = ms(newestFirst ? jobsTable.deadAt : jobsTable.availableAt);
    const after = opts?.after;
    const cursor =
      after === undefined
        ? undefined
        : newestFirst
          ? sql`(${key}, ${jobsTable.id}) < (${iso(after.at)}, ${after.id}::varchar)`
          : sql`(${key}, ${jobsTable.id}) > (${iso(after.at)}, ${after.id}::varchar)`;
    return db
      .select(withState)
      .from(jobsTable)
      .where(and(status === 'all' ? undefined : where[status], ...nameFilter(opts ?? {}), cursor))
      .orderBy(...(newestFirst ? [desc(key), desc(jobsTable.id)] : [asc(key), asc(jobsTable.id)]))
      .limit(limit);
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
  ): Promise<JobOperation[]> => {
    const limit = bounded('jobOperations', opts?.limit, LIST_LIMIT);
    const key = ms(jobOperations.at);
    const after = opts?.after;
    return db
      .select()
      .from(jobOperations)
      .where(
        and(
          opts?.jobId === undefined
            ? undefined
            : sql`${jobOperations.jobIds} @> ${JSON.stringify([opts.jobId])}::jsonb`,
          after === undefined
            ? undefined
            : sql`(${key}, ${jobOperations.id}) < (${iso(after.at)}, ${after.id}::varchar)`,
        ),
      )
      .orderBy(desc(key), desc(jobOperations.id))
      .limit(limit);
  };

  /** Newest first by `(archived_at, id)`. */
  const archivedJobs = async (
    db: DbHandle,
    opts?: PageOptions & {
      readonly outcome?: ArchiveOutcome;
      readonly effect?: string;
      readonly job?: string;
    },
  ) => {
    const limit = bounded('archivedJobs', opts?.limit, LIST_LIMIT);
    const key = ms(jobArchive.archivedAt);
    const after = opts?.after;
    return db
      .select()
      .from(jobArchive)
      .where(
        and(
          opts?.outcome === undefined ? undefined : eq(jobArchive.outcome, opts.outcome),
          opts?.effect === undefined ? undefined : eq(jobArchive.effect, opts.effect),
          opts?.job === undefined ? undefined : eq(jobArchive.jobName, opts.job),
          after === undefined ? undefined : sql`(${key}, ${jobArchive.id}) < (${iso(after.at)}, ${after.id}::varchar)`,
        ),
      )
      .orderBy(desc(key), desc(jobArchive.id))
      .limit(limit);
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

  // eslint-disable-next-line unicorn/no-useless-undefined -- no per-effect override yet: the effect and runner overrides are wired where the verbs are exposed
  const keepForOutcome = (outcome: ArchiveOutcome) => keepFor(policy, outcome, undefined);

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
   * Remove jobs from the hot table in one statement and, when `keep` stores, write their archive rows in the same
   * statement with the attempt log folded in (the attempts are read from the pre-delete snapshot, before the
   * cascade removes them). `where` is the whole guard: a row it does not match is neither deleted nor archived.
   */
  const removeJobs = async (
    tx: DbHandle,
    args: {
      readonly where: SQL | undefined;
      readonly outcome: Exclude<ArchiveOutcome, 'completed'>;
      /** What the archive row stores as `finished_at`. */
      readonly finishedAt: SQL;
      readonly keep: ResolvedKeep;
    },
  ): Promise<{ readonly ids: readonly string[]; readonly archived: boolean }> => {
    if (!args.keep.store) {
      const rows = await tx.delete(jobsTable).where(args.where).returning({ id: jobsTable.id });
      return { ids: rows.map(row => row.id), archived: false };
    }
    // Retention is a horizon of days, so the worker's clock is good enough for keep_until.
    const until = keepUntil(args.keep, new Date())?.toISOString() ?? null;
    const result: unknown = await tx.execute(sql`
      WITH gone AS (
        DELETE FROM ${jobsTable} WHERE ${args.where ?? sql`true`} RETURNING *
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
    return { ids: archivedIds(result), archived: true };
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
          keep: keepForOutcome('discarded'),
        });
        if (removed.ids.length === 0)
          throw new JournalError('JOB_NOT_DEAD', 'job', id, 'not a dead job; only a dead job is discarded');
        const operationId = await record(tx, 'discard', op, removed.ids);
        debug.debug('discard {jobId}: {operationId}, archived {archived}', {
          jobId: id,
          operationId,
          archived: removed.archived,
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
          keep: keepForOutcome('cancelled'),
        });
        if (removed.ids.length === 0) {
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
        const operationId = await record(tx, 'cancel', op, removed.ids);
        debug.debug('cancel {jobId}: {operationId}, archived {archived}', {
          jobId: id,
          operationId,
          archived: removed.archived,
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
        const removed = await removeJobs(tx, {
          where: sql`${jobsTable.id} IN (SELECT ${jobsTable.id} FROM ${jobsTable} WHERE ${jobsTable.deadAt} IS NOT NULL AND ${jobsTable.deadAt} < ${iso(opts.olderThan)} ORDER BY ${jobsTable.deadAt}, ${jobsTable.id} LIMIT ${limit} FOR UPDATE SKIP LOCKED)`,
          outcome: 'dead',
          finishedAt: sql`coalesce(g.dead_at, now())`,
          keep: keepForOutcome('dead'),
        });
        const count = removed.ids.length;
        const operationId = count === 0 ? null : await record(tx, 'purgeDead', op, removed.ids);
        debug.debug('purgeDead: {count} jobs, archived {archived}, {operationId}', {
          count,
          archived: removed.archived,
          operationId,
        });
        return {
          archived: removed.archived ? count : 0,
          deleted: removed.archived ? 0 : count,
          operationId,
        };
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
    replay,
  };
}
