/**
 * `outbox()`: schedule a queue job inside the caller's Postgres transaction. The job row
 * lands in the journal's `journal_jobs` table and commits with the business write or not
 * at all. The journal worker runs it (with `outboxRunner`). No Redis on this path.
 */
import { and, eq, is, isNull, sql } from 'drizzle-orm';
import { getTableConfig, PgAsyncTransaction } from 'drizzle-orm/pg-core';

import type { AsyncSchemaFailure } from '@arki/failure';
import type { DbHandle, JournalTables } from '@arki/journal';
import { InvalidInput, ValidatorDefect } from '@arki/failure';
import { jobId } from '@arki/journal';
import { parseAsync } from '@arki/schema';

import type { AnyJobDefinition, JobDefinition, QueuePriority } from '../types/job.ts';
import { QUEUE_PRIORITIES } from '../types/job.ts';
import { OUTBOX_ERROR_CODES, outboxError } from './errors.ts';

/** A Drizzle transaction or savepoint. A root database has no `rollback`, so it does not fit. */
export type OutboxTx = DbHandle & { rollback(): never };

export type OutboxOptions = {
  /** The journal tables of the app (`journalTables(schema?)`); only `jobs` is written. */
  readonly tables: Pick<JournalTables, 'jobs'>;
  /** UTF-8 bytes of `JSON.stringify(args)`. Default 262_144 (256 KiB). */
  readonly maxArgsBytes?: number;
};

export type ScheduleOptions = {
  /** Due this long after the transaction's `now()`. Default 0. Non-negative safe integer. */
  readonly delayMs?: number;
  /** Dedupes among unfinished rows (pending, running, dead) of the same job, like `TriggerOptions.jobId`. */
  readonly key?: string;
  /** Same scale as `trigger`: 1 critical … 10 background. Default NORMAL (5). */
  readonly priority?: QueuePriority;
};

/** `id` is the job id (`job_xxx`), provisional until the caller's transaction commits. */
export type Scheduled = { readonly id: string; readonly deduplicated: boolean };

export type Outbox = {
  runAfter<TInput, TOutput, TContext>(
    tx: OutboxTx,
    job: JobDefinition<TInput, TOutput, TContext>,
    args: NoInfer<TInput>,
    options?: ScheduleOptions,
  ): Promise<Scheduled | AsyncSchemaFailure>;
  runAt<TInput, TOutput, TContext>(
    tx: OutboxTx,
    job: JobDefinition<TInput, TOutput, TContext>,
    args: NoInfer<TInput>,
    at: Date,
    options?: Omit<ScheduleOptions, 'delayMs'>,
  ): Promise<Scheduled | AsyncSchemaFailure>;
  /** Delete a row no worker holds. `false` when it is running, finished, or never existed. */
  cancel(tx: DbHandle, id: string): Promise<boolean>;
};

const DEFAULT_MAX_ARGS_BYTES = 262_144;
const PRIORITIES = new Set<number>(Object.values(QUEUE_PRIORITIES));
/** The journal runs higher first, default 0; the queue runs lower first, NORMAL 5. `5 - p` maps NORMAL to 0. */
const storedPriority = (priority: QueuePriority): number => QUEUE_PRIORITIES.NORMAL - priority;
const WAKE_PAYLOAD = '{"queue":1}';

/** Why `value` is not plain JSON, or `undefined` when it is. `ancestors` catches cycles, not shared references. */
function jsonProblem(value: unknown, path: string, ancestors: Set<object>): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : `${path} is ${String(value)}`;
  if (value === undefined) return `${path} is undefined`;
  if (typeof value !== 'object') return `${path} is a ${typeof value}`;
  if (ancestors.has(value)) return `${path} is a cycle`;
  const proto: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
    return `${path} is a ${value.constructor.name}, not a plain object`;
  ancestors.add(value);
  try {
    const entries: [string, unknown][] = Array.isArray(value)
      ? Array.from({ length: value.length }, (_, index): [string, unknown] => [`${path}[${index}]`, value[index]])
      : Object.entries(value).map(([key, child]): [string, unknown] => [`${path}.${key}`, child]);
    for (const [childPath, child] of entries) {
      const problem = jsonProblem(child, childPath, ancestors);
      if (problem !== undefined) return problem;
    }
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

/** Throws `OUTBOX_E003` unless `args` is plain JSON within `maxBytes` UTF-8 bytes. */
export function assertJsonArgs(args: unknown, maxBytes: number, jobName: string): void {
  const problem = jsonProblem(args, 'args', new Set());
  if (problem !== undefined)
    throw outboxError(OUTBOX_ERROR_CODES.notJson, `outbox: "${jobName}" args are not plain JSON: ${problem}`);
  const bytes = new TextEncoder().encode(JSON.stringify(args)).byteLength;
  if (bytes > maxBytes)
    throw outboxError(
      OUTBOX_ERROR_CODES.notJson,
      `outbox: "${jobName}" args are ${String(bytes)} bytes as JSON; the limit is ${String(maxBytes)}`,
    );
}

type When = { readonly at: Date } | { readonly delayMs: number };

/** The scheduling entry point. Build it once per app: `export const schedule = outbox({ tables })`. */
export function outbox(options: OutboxOptions): Outbox {
  const jobs = options.tables.jobs;
  const maxArgsBytes = options.maxArgsBytes ?? DEFAULT_MAX_ARGS_BYTES;
  // The journal's wake channel: every journal worker of this table hears it.
  const tableSchema = getTableConfig(jobs).schema;
  const channel = tableSchema === undefined ? 'journal_wake' : `${tableSchema}_journal_wake`;

  const schedule = async (
    tx: OutboxTx,
    job: AnyJobDefinition,
    args: unknown,
    when: When,
    scheduleOptions: Omit<ScheduleOptions, 'delayMs'> | undefined,
  ): Promise<Scheduled | AsyncSchemaFailure> => {
    const name = job._internal.name;
    // Catches callers that skip the types. Not a security boundary.
    if (!is(tx, PgAsyncTransaction))
      throw outboxError(
        OUTBOX_ERROR_CODES.notInTransaction,
        `outbox: "${name}" was scheduled on a root database; pass the transaction`,
      );
    if ('at' in when ? Number.isNaN(when.at.getTime()) : !Number.isSafeInteger(when.delayMs) || when.delayMs < 0)
      throw outboxError(
        OUTBOX_ERROR_CODES.badTiming,
        'at' in when
          ? `outbox: "${name}" runAt got an invalid Date`
          : `outbox: "${name}" delayMs must be a non-negative safe integer, got ${String(when.delayMs)}`,
      );
    const priority = scheduleOptions?.priority ?? QUEUE_PRIORITIES.NORMAL;
    if (!PRIORITIES.has(priority))
      throw outboxError(
        OUTBOX_ERROR_CODES.badTiming,
        `outbox: "${name}" priority ${String(priority)} is not one of QUEUE_PRIORITIES`,
      );
    // Validated now, so a bad call rolls back the business write. The parsed value is dropped:
    // the raw args are stored and the worker parses them, so a transform runs once.
    const parsed = await parseAsync(job._internal.inputSchema, args);
    if (InvalidInput.is(parsed) || ValidatorDefect.is(parsed)) return parsed;
    assertJsonArgs(args, maxArgsBytes, name);

    const key = scheduleOptions?.key;
    const insert = tx.insert(jobs).values({
      id: jobId(),
      kind: 'queue',
      jobName: name,
      // Drizzle sends JS null as SQL NULL; the column needs the JSON value null.
      args: args === null ? sql`'null'::jsonb` : args,
      dedupeKey: key ?? null,
      priority: storedPriority(priority),
      // Database time: the delay counts from the transaction's now(), like an effect's delaySeconds.
      ...('at' in when
        ? { availableAt: when.at }
        : when.delayMs > 0
          ? { availableAt: sql`now() + make_interval(secs => ${when.delayMs / 1000})` }
          : {}),
    });
    const inserted = await (key === undefined
      ? insert.returning({ id: jobs.id })
      : insert
          .onConflictDoNothing({ target: [jobs.jobName, jobs.dedupeKey], where: sql`${jobs.dedupeKey} is not null` })
          .returning({ id: jobs.id }));
    const row = inserted[0];
    if (row === undefined) {
      const [existing] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.jobName, name), eq(jobs.dedupeKey, key ?? '')));
      if (existing === undefined)
        throw new Error(`outbox: "${name}" key ${JSON.stringify(key)} conflicted but no row holds it`);
      return { id: existing.id, deduplicated: true };
    }
    // Delivered at commit, dropped on rollback; identical payloads in one transaction coalesce.
    await tx.execute(sql`select pg_notify(${channel}, ${WAKE_PAYLOAD})`);
    return { id: row.id, deduplicated: false };
  };

  return {
    runAfter: (tx, job, args, scheduleOptions) =>
      schedule(tx, job, args, { delayMs: scheduleOptions?.delayMs ?? 0 }, scheduleOptions),
    runAt: (tx, job, args, at, scheduleOptions) =>
      // `instanceof` first: a JS caller may pass anything.
      schedule(tx, job, args, { at: at instanceof Date ? at : new Date(Number.NaN) }, scheduleOptions),
    cancel: async (tx, id) => {
      const gone = await tx
        .delete(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.kind, 'queue'), isNull(jobs.leaseToken)))
        .returning({ id: jobs.id });
      return gone.length === 1;
    },
  };
}
