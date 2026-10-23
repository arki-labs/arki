/**
 * What an operator reads about workflow runs: a page of runs, one run with its steps, counts, the stranded runs and a
 * run's events. Everything derived (`running`, `stuck`, `residual`, `stranded`) is worked out here from the run,
 * step, signal and job tables; nothing is stored for it.
 */
import { and, arrayContains, asc, count, desc, eq, getTableColumns, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AsyncSchemaFailure } from '@arki/failure';

import type { JobOperationInput, PageOptions } from '../outbox.js';
import type { JournalTables } from '../pg.js';
import type { DbHandle, TransactionSource } from '../types.js';
import type { StepStatus } from './machine.js';
import type { MetadataChange, MetadataOutcome, TagsOutcome } from './run-fields.js';
import type { StepPhase } from './states.js';
import type {
  CancelOutcome,
  ReplayArgs,
  RescheduleArgs,
  RescheduleOutcome,
  SignalOutcome,
  StartOutcome,
} from './runner.js';
import type { CommandFailure, CommandNotFound, WorkflowStranded } from '../errors.js';
import { JournalError } from '../errors.js';
import { bounded, cursorText, LIST_LIMIT, pageOf, pastCursor } from '../outbox.js';
import { stepStatusSql } from './machine.js';
import { BATCH_LIMIT } from './run-fields.js';
import { codeOf } from './stranded.js';

/** Why a run has no code to go on with: no registered workflow has its name and version, or the registered one has other nodes. */
export type StrandedReason = WorkflowStranded['data']['reason'];

type RunRow = JournalTables['workflowRuns']['$inferSelect'];
type StepRow = JournalTables['workflowSteps']['$inferSelect'];
type SignalRow = JournalTables['workflowSignals']['$inferSelect'];
type EventRow = JournalTables['events']['$inferSelect'];
export type RunState = RunRow['state'];

/** A run in a list: without its input, results, output and metadata, which can be large. */
export type RunSummary = Pick<
  RunRow,
  | 'id'
  | 'name'
  | 'workflowVersion'
  | 'state'
  | 'node'
  | 'waitingFor'
  | 'wakeAt'
  | 'deadlineAt'
  | 'parentId'
  | 'parentPath'
  | 'scope'
  | 'tags'
  | 'rootId'
  | 'batchId'
  | 'replayOf'
  | 'cancelledAt'
  | 'cancelReason'
  | 'startAt'
  | 'ttlAt'
  | 'startedAt'
  | 'finishedAt'
> & {
  /** When a delayed run's first node is due, while that is still ahead and it has not started; otherwise null. */
  readonly delayedUntil: Date | null;
  /** A step of this unfinished run is dead and waits for an operator: a failed `undo`, or a failed `do` while the run is not compensating. */
  readonly stuck: boolean;
  /** The run's code is missing or has other nodes. Null for a finished run and for a run with its code. */
  readonly stranded: StrandedReason | null;
};

export type RunFilter = {
  readonly state?: RunState;
  readonly name?: string;
  readonly version?: number;
  readonly parentId?: string;
  readonly stuck?: boolean;
  /** Runs that have this tag among theirs. */
  readonly tag?: string;
  readonly scope?: string;
  /** The runs of one tree below its top run (the top run itself has no `rootId`). */
  readonly rootId?: string;
  /** The runs one `def.startBatch` started. */
  readonly batchId?: string;
  /** Runs started at or after `from`, and before `to`. */
  readonly from?: Date;
  readonly to?: Date;
};

export type StepView = Pick<
  StepRow,
  'path' | 'phase' | 'attempt' | 'key' | 'jobId' | 'result' | 'error' | 'reason' | 'startedAt' | 'finishedAt'
> & {
  /** `running` while the step's job holds a live lease; otherwise what the row stores. */
  readonly status: StepStatus;
  readonly stuck: boolean;
};

/**
 * One run in full. The type parameters type the stored values: `def.read` checks them with the definition's schemas;
 * `journal.workflows.run` leaves them as stored. `output` is `null` until the run completes.
 */
export type RunDetail<Input = unknown, Output = unknown, Results = RunRow['results']> = {
  readonly run: Omit<RunRow, 'input' | 'output' | 'results'> & {
    readonly input: Input;
    readonly output: Output | null;
    readonly results: Results;
    readonly delayedUntil: Date | null;
    readonly stuck: boolean;
    readonly stranded: StrandedReason | null;
  };
  /** Oldest first. */
  readonly steps: readonly StepView[];
  /** The paths whose undo was skipped: the work they did stays done. */
  readonly residual: readonly string[];
  readonly children: readonly Pick<
    RunRow,
    'id' | 'name' | 'workflowVersion' | 'state' | 'parentPath' | 'startedAt' | 'finishedAt'
  >[];
  /** Signals that arrived and that no wait has taken yet. */
  readonly signals: readonly Pick<SignalRow, 'id' | 'name' | 'deliveryId' | 'payload' | 'receivedAt'>[];
};

export type RunCount = {
  readonly name: string;
  readonly version: number;
  readonly state: RunState;
  readonly runs: number;
};

export type StrandedRun = Pick<RunRow, 'id' | 'name' | 'workflowVersion' | 'state' | 'startedAt'> & {
  readonly code: StrandedReason;
};

export type HistoryEvent = Pick<EventRow, 'seq' | 'id' | 'version' | 'type' | 'data' | 'meta' | 'recordedAt'>;

/**
 * A batch at a glance: how many of its runs are in each state, and their ids, oldest first. `runIds` holds at most
 * `BATCH_LIMIT`; `more` is true when there are more (one id is used by several `startBatch` calls), and
 * `runs(db, { batchId })` pages through all of them.
 */
export type BatchSummary = {
  readonly batchId: string;
  readonly total: number;
  readonly states: Partial<Readonly<Record<RunState, number>>>;
  readonly runIds: readonly string[];
  readonly more: boolean;
};

export type WorkflowReads = {
  /** Runs, newest first, with an opaque `next` cursor (pass it as `after`). `limit` 1 to 200, default 100. */
  runs(
    db: DbHandle,
    opts?: RunFilter & PageOptions,
  ): Promise<{ readonly runs: RunSummary[]; readonly next: string | null }>;
  /** One run with its steps, children and unconsumed signals; undefined when there is no such run. */
  run(db: DbHandle, id: string): Promise<RunDetail | undefined>;
  /** How many runs there are per workflow name, version and state. */
  counts(db: DbHandle): Promise<RunCount[]>;
  /** The runs of one batch: counts by state and the run ids. An unknown batch has none. */
  batch(db: DbHandle, batchId: string): Promise<BatchSummary>;
  /** Unfinished runs whose code is missing or has other nodes, oldest first. `limit` 1 to 200, default 100. */
  stranded(db: DbHandle, opts?: { readonly limit?: number }): Promise<StrandedRun[]>;
  /** The run's events, oldest first, with an opaque `next` cursor. */
  history(
    db: DbHandle,
    id: string,
    opts?: PageOptions,
  ): Promise<{ readonly events: HistoryEvent[]; readonly next: string | null }>;
};

/** The operator verbs. Each writes under the run's row lock, and its events carry `op.actor`, `op.reason` and `op.executionId`. */
export type WorkflowVerbs<Tx> = {
  /**
   * A dead step runs again. A failed `do` or `undo` step gets its next attempt with the same key. A failed child or map
   * node starts its failed children again under new ids (`<id>~2`, then `~3`); the old runs stay as history. When the
   * run is stranded, every dead job of the run (steps, parks, deadline, undos) is retried once the code is registered
   * again, each with the job verb's operations row and a `JobRetried` event; until then the stranded error is thrown.
   * `STEP_NOT_DEAD` for any other step.
   */
  retryStep(
    source: TransactionSource<Tx>,
    args: { readonly runId: string; readonly path: string; readonly phase: StepPhase },
    op: JobOperationInput,
  ): Promise<{ readonly how: 'rescheduled' | 'childrenRestarted' | 'jobRetried' } | CommandFailure>;
  /**
   * Gives the result of a failed `do` step of a running run. The result is checked with the step's `output` schema, then
   * the run carries on as if the step had returned it: the worker routes the result (`next` may be a function) and
   * the body does not run again. `STEP_NOT_RESOLVABLE` for a step with no `output` schema.
   */
  resolveStep(
    source: TransactionSource<Tx>,
    args: { readonly runId: string; readonly path: string; readonly result: unknown },
    op: JobOperationInput,
  ): Promise<{ readonly runId: string } | CommandFailure>;
  /** Gives up a failed `undo` of a compensating run. `op.reason` is required. Compensation goes on and the path is `residual`. */
  skipUndo(
    source: TransactionSource<Tx>,
    args: { readonly runId: string; readonly path: string },
    op: JobOperationInput,
  ): Promise<{ readonly runId: string } | CommandFailure>;
  /**
   * Delivers signal `name` to a run, for an operator who holds only JSON: the run's own version checks the payload
   * (`def.signal(name)` is the typed door for app code; both are one transition). A repeated `deliveryId` is a
   * `duplicate`. `SignalReceived` carries the operator.
   */
  signal(
    source: TransactionSource<Tx>,
    args: { readonly runId: string; readonly name: string; readonly deliveryId: string; readonly payload: unknown },
    op: JobOperationInput,
  ): Promise<SignalOutcome | CommandFailure>;
  /** Cancels a run of any workflow, for an operator: the same transition as `def.cancel`. `CancelRequested` carries the operator. */
  cancel(
    source: TransactionSource<Tx>,
    args: { readonly runId: string; readonly reason: string },
    op: JobOperationInput,
  ): Promise<CancelOutcome | CommandFailure>;
  /**
   * Changes the metadata of an unfinished run (running, parked or compensating), like `ctx.metadata` in a step: one
   * `MetadataChange` (`set`, `increment`, `append` or `remove`) and one `MetadataChanged` event, which carries the
   * operator. `CommandConflict` once the run has finished; `CommandInvalid` for a wrong value type or metadata over the
   * limit. Returns the metadata after the change.
   */
  setMetadata(
    source: TransactionSource<Tx>,
    args: { readonly runId: string; readonly change: MetadataChange },
    op: JobOperationInput,
  ): Promise<MetadataOutcome | CommandFailure>;
  /**
   * Adds tags to an unfinished run, like `ctx.tags.add`: tags it has already change nothing, the rest go in one
   * `RunTagged` event that carries the operator. `CommandInvalid` past `RUN_FIELD_LIMITS.tags`. Returns all its tags.
   */
  addTags(
    source: TransactionSource<Tx>,
    args: { readonly runId: string; readonly tags: readonly string[] },
    op: JobOperationInput,
  ): Promise<TagsOutcome | CommandFailure>;
  /**
   * Whether `resolveStep` would take `result` for step `path`: the step's `output` schema of the run's own version
   * checks it, and nothing is written. A step `resolveStep` could never resolve throws `STEP_NOT_RESOLVABLE`.
   */
  /**
   * Moves the start of a run whose first node has not started: its first node becomes due at the new time (a time in
   * the past is now), and its `ttl` and deadline count from it. One `RunRescheduled` event carries the operator.
   * `CommandConflict` once the first node has started (a worker holds or has tried its job, or the run moved on);
   * `CommandNotFound` for no such run.
   */
  reschedule(
    source: TransactionSource<Tx>,
    args: RescheduleArgs,
    op: JobOperationInput,
  ): Promise<RescheduleOutcome | CommandFailure>;
  /**
   * Starts a new run of the run's workflow at the newest registered version, under a new id, with the old run's input,
   * scope, tags and metadata unless `overrides` gives them (and `delay`, `ttl`). Works for a finished or an
   * unfinished run; its children are not copied, the new run starts its own. The new run's `replayOf` is the old id,
   * and its `RunStarted` carries the operator. It is a start: `WorkflowBusy` at a busy concurrency key (with
   * `onBusy: 'join'`, the running run's id), `InvalidInput` when the input no longer fits the newest input schema,
   * `CommandNotFound` for no such run.
   */
  replay(
    source: TransactionSource<Tx>,
    args: ReplayArgs,
    op: JobOperationInput,
  ): Promise<StartOutcome | CommandNotFound | CommandFailure>;
  checkResult(
    db: DbHandle,
    args: { readonly runId: string; readonly path: string; readonly result: unknown },
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly issues: string } | AsyncSchemaFailure>;
};

export type WorkflowOps<Tx> = WorkflowReads & WorkflowVerbs<Tx>;

const seqCursor = z.int().positive();
// `btoa` rather than `Buffer`: the package runs in the browser and Hermes too.
const encodeSeq = (seq: number) => btoa(String(seq)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
function decodeSeq(after: string): number {
  try {
    return seqCursor.parse(Number(atob(after.replaceAll('-', '+').replaceAll('_', '/'))));
  } catch {
    throw new JournalError(
      'BAD_ARGUMENT',
      'workflow',
      'after',
      'not a cursor this journal gave out; pass the `next` of a previous page unchanged',
    );
  }
}

export function createWorkflowReads(deps: {
  readonly tables: JournalTables;
  /** The code the journal was composed with, by `name@version`. */
  readonly registry: ReadonlyMap<string, { readonly shapeHash: string }>;
}): WorkflowReads {
  const { tables, registry } = deps;
  const { workflowRuns: runs, workflowSteps: steps, workflowSignals: signals, events: eventsTable } = tables;

  const strandedOf = (run: Pick<RunRow, 'id' | 'name' | 'workflowVersion' | 'shapeHash' | 'finishedAt'>) => {
    if (run.finishedAt !== null) return null;
    const code = codeOf(run, registry);
    if (!(code instanceof JournalError)) return null;
    return code.code === 'WORKFLOW_SHAPE_CHANGED' ? 'WORKFLOW_SHAPE_CHANGED' : 'WORKFLOW_UNKNOWN';
  };
  /** A dead step of an unfinished run. A failed `do` while the run compensates is settled, not waiting for anyone. */
  const stuckSql = sql<boolean>`(${runs.finishedAt} IS NULL AND EXISTS (SELECT 1 FROM ${steps} WHERE ${steps.runId} = ${runs.id} AND ${steps.status} = 'failed' AND (${steps.phase} = 'undo' OR ${runs.state} <> 'compensating')))`;

  /** `start_at` while it is ahead by the database clock and the run has not started (`running`, no node result). */
  const delayedUntilSql = sql<Date | null>`CASE WHEN ${runs.startAt} > now() AND ${runs.state} = 'running' AND ${runs.results} = '{}'::jsonb THEN ${runs.startAt} END`.mapWith(
    runs.startAt,
  );

  const summaryColumns = {
    id: runs.id,
    name: runs.name,
    workflowVersion: runs.workflowVersion,
    state: runs.state,
    node: runs.node,
    waitingFor: runs.waitingFor,
    wakeAt: runs.wakeAt,
    deadlineAt: runs.deadlineAt,
    parentId: runs.parentId,
    parentPath: runs.parentPath,
    scope: runs.scope,
    tags: runs.tags,
    rootId: runs.rootId,
    batchId: runs.batchId,
    replayOf: runs.replayOf,
    cancelledAt: runs.cancelledAt,
    cancelReason: runs.cancelReason,
    startAt: runs.startAt,
    ttlAt: runs.ttlAt,
    startedAt: runs.startedAt,
    finishedAt: runs.finishedAt,
    delayedUntil: delayedUntilSql,
  };

  const runsPage: WorkflowReads['runs'] = async (db, opts) => {
    const limit = bounded('workflow runs', opts?.limit, LIST_LIMIT);
    const rows = await db
      .select({
        ...summaryColumns,
        shapeHash: runs.shapeHash,
        stuck: stuckSql,
        cursorAt: cursorText(runs.startedAt),
      })
      .from(runs)
      .where(
        and(
          opts?.state === undefined ? undefined : eq(runs.state, opts.state),
          opts?.name === undefined ? undefined : eq(runs.name, opts.name),
          opts?.version === undefined ? undefined : eq(runs.workflowVersion, opts.version),
          opts?.parentId === undefined ? undefined : eq(runs.parentId, opts.parentId),
          opts?.stuck === undefined ? undefined : opts.stuck ? stuckSql : sql`NOT ${stuckSql}`,
          opts?.tag === undefined ? undefined : arrayContains(runs.tags, [opts.tag]),
          opts?.scope === undefined ? undefined : eq(runs.scope, opts.scope),
          opts?.rootId === undefined ? undefined : eq(runs.rootId, opts.rootId),
          opts?.batchId === undefined ? undefined : eq(runs.batchId, opts.batchId),
          opts?.from === undefined ? undefined : gte(runs.startedAt, opts.from),
          opts?.to === undefined ? undefined : lt(runs.startedAt, opts.to),
          pastCursor(opts?.after, runs.startedAt, runs.id, true),
        ),
      )
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .limit(limit + 1);
    const page = pageOf(rows, limit);
    return {
      runs: page.items.map(({ shapeHash, ...run }) => ({ ...run, stranded: strandedOf({ ...run, shapeHash }) })),
      next: page.next,
    };
  };

  const run: WorkflowReads['run'] = async (db, id) => {
    const [row] = await db
      .select({ ...getTableColumns(runs), delayedUntil: delayedUntilSql, stuck: stuckSql })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    if (row === undefined) return;
    const { stuck, ...base } = row;
    const stepRows = await db
      .select({
        path: steps.path,
        phase: steps.phase,
        status: stepStatusSql(tables),
        attempt: steps.attempt,
        key: steps.key,
        jobId: steps.jobId,
        result: steps.result,
        error: steps.error,
        reason: steps.reason,
        startedAt: steps.startedAt,
        finishedAt: steps.finishedAt,
      })
      .from(steps)
      .where(eq(steps.runId, id))
      .orderBy(asc(steps.startedAt), asc(steps.path), asc(steps.phase));
    const children = await db
      .select({
        id: runs.id,
        name: runs.name,
        workflowVersion: runs.workflowVersion,
        state: runs.state,
        parentPath: runs.parentPath,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(eq(runs.parentId, id))
      .orderBy(asc(runs.startedAt), asc(runs.id));
    const waiting = await db
      .select({
        id: signals.id,
        name: signals.name,
        deliveryId: signals.deliveryId,
        payload: signals.payload,
        receivedAt: signals.receivedAt,
      })
      .from(signals)
      .where(and(eq(signals.runId, id), isNull(signals.consumedAt)))
      .orderBy(asc(signals.receivedAt), asc(signals.id));
    return {
      run: { ...base, stuck, stranded: strandedOf(base) },
      steps: stepRows.map(step => ({
        ...step,
        stuck:
          base.finishedAt === null &&
          step.status === 'failed' &&
          (step.phase === 'undo' || base.state !== 'compensating'),
      })),
      residual: stepRows.filter(step => step.phase === 'undo' && step.status === 'skipped').map(step => step.path),
      children,
      signals: waiting,
    };
  };

  const counts: WorkflowReads['counts'] = db =>
    db
      .select({
        name: runs.name,
        version: runs.workflowVersion,
        state: runs.state,
        runs: count(),
      })
      .from(runs)
      .groupBy(runs.name, runs.workflowVersion, runs.state)
      .orderBy(asc(runs.name), asc(runs.workflowVersion), asc(runs.state));

  const batch: WorkflowReads['batch'] = async (db, batchId) => {
    const byState = await db
      .select({ state: runs.state, runs: count() })
      .from(runs)
      .where(eq(runs.batchId, batchId))
      .groupBy(runs.state);
    // One more than the cap tells whether the list is cut.
    const ids = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.batchId, batchId))
      .orderBy(asc(runs.startedAt), asc(runs.id))
      .limit(BATCH_LIMIT + 1);
    return {
      batchId,
      total: byState.reduce((sum, row) => sum + row.runs, 0),
      states: Object.fromEntries(byState.map(row => [row.state, row.runs])),
      runIds: ids.slice(0, BATCH_LIMIT).map(row => row.id),
      more: ids.length > BATCH_LIMIT,
    };
  };

  const stranded: WorkflowReads['stranded'] = async (db, opts) => {
    const limit = bounded('stranded workflow runs', opts?.limit, LIST_LIMIT);
    // One representative run per name, version and shape: the code is the same for all of them.
    const groups = await db
      .select({
        id: sql<string>`min(${runs.id})`,
        name: runs.name,
        workflowVersion: runs.workflowVersion,
        shapeHash: runs.shapeHash,
      })
      .from(runs)
      .where(isNull(runs.finishedAt))
      .groupBy(runs.name, runs.workflowVersion, runs.shapeHash);
    const gone = groups.filter(group => codeOf(group, registry) instanceof JournalError);
    if (gone.length === 0) return [];
    const rows = await db
      .select({
        id: runs.id,
        name: runs.name,
        workflowVersion: runs.workflowVersion,
        shapeHash: runs.shapeHash,
        state: runs.state,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(
        and(
          isNull(runs.finishedAt),
          or(
            ...gone.map(group =>
              and(
                eq(runs.name, group.name),
                eq(runs.workflowVersion, group.workflowVersion),
                eq(runs.shapeHash, group.shapeHash),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(runs.startedAt), asc(runs.id))
      .limit(limit);
    return rows.flatMap(({ shapeHash, finishedAt, ...row }) => {
      const code = strandedOf({ ...row, shapeHash, finishedAt });
      return code === null ? [] : [{ ...row, code }];
    });
  };

  const history: WorkflowReads['history'] = async (db, id, opts) => {
    const limit = bounded('workflow history', opts?.limit, LIST_LIMIT);
    const after = opts?.after === undefined ? undefined : decodeSeq(opts.after);
    const rows = await db
      .select({
        seq: eventsTable.seq,
        id: eventsTable.id,
        version: eventsTable.version,
        type: eventsTable.type,
        data: eventsTable.data,
        meta: eventsTable.meta,
        recordedAt: eventsTable.recordedAt,
      })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.kind, 'workflow.run'),
          eq(eventsTable.entityId, id),
          after === undefined ? undefined : sql`${eventsTable.seq} > ${after}`,
        ),
      )
      .orderBy(asc(eventsTable.seq))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { events: page, next: rows.length > limit && last !== undefined ? encodeSeq(last.seq) : null };
  };

  return { runs: runsPage, run, counts, batch, stranded, history };
}
