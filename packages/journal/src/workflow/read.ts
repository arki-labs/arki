/**
 * What an operator reads about workflow runs: a page of runs, one run with its steps, counts, the stranded runs and a
 * run's events. Everything derived (`running`, `stuck`, `residual`, `stranded`) is worked out here from the run,
 * step, signal and job tables; nothing is stored for it.
 */
import { and, asc, count, desc, eq, getTableColumns, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AsyncSchemaFailure, SchemaFailure } from '@arki/failure';

import type { JobOperationInput, PageOptions } from '../outbox.js';
import type { JournalTables } from '../pg.js';
import type { DbHandle, TransactionSource } from '../types.js';
import type { CancelOutcome, SignalOutcome } from './runner.js';
import { JournalError } from '../errors.js';
import { bounded, cursorText, LIST_LIMIT, pageOf, pastCursor } from '../outbox.js';
import { stepStatusSql } from './machine.js';
import { codeOf } from './stranded.js';

/** Why a run has no code to go on with: no registered workflow has its name and version, or the registered one has other nodes. */
export type StrandedReason = 'WORKFLOW_UNKNOWN' | 'WORKFLOW_SHAPE_CHANGED';

type RunRow = JournalTables['workflowRuns']['$inferSelect'];
type StepRow = JournalTables['workflowSteps']['$inferSelect'];
type SignalRow = JournalTables['workflowSignals']['$inferSelect'];
type EventRow = JournalTables['events']['$inferSelect'];
export type RunState = RunRow['state'];

/** A run in a list: without its input, results and output, which can be large. */
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
  | 'cancelledAt'
  | 'cancelReason'
  | 'startedAt'
  | 'finishedAt'
> & {
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
};

export type StepView = Pick<
  StepRow,
  'path' | 'phase' | 'attempt' | 'key' | 'jobId' | 'result' | 'error' | 'reason' | 'startedAt' | 'finishedAt'
> & {
  /** `running` while the step's job holds a live lease; otherwise what the row stores. */
  readonly status: StepRow['status'] | 'running';
  readonly stuck: boolean;
};

export type RunDetail = {
  readonly run: RunRow & { readonly stuck: boolean; readonly stranded: StrandedReason | null };
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
    args: { readonly runId: string; readonly path: string; readonly phase: 'do' | 'undo' },
    op: JobOperationInput,
  ): Promise<{ readonly how: 'rescheduled' | 'childrenRestarted' | 'jobRetried' } | SchemaFailure>;
  /**
   * Gives the result of a failed `do` step of a running run. The result is checked with the step's `output` schema, then
   * the run carries on as if the step had returned it: the worker routes the result (`next` may be a function) and
   * the body does not run again. `STEP_NOT_RESOLVABLE` for a step with no `output` schema.
   */
  resolveStep(
    source: TransactionSource<Tx>,
    args: { readonly runId: string; readonly path: string; readonly result: unknown },
    op: JobOperationInput,
  ): Promise<{ readonly runId: string } | SchemaFailure>;
  /** Gives up a failed `undo` of a compensating run. `op.reason` is required. Compensation goes on and the path is `residual`. */
  skipUndo(
    source: TransactionSource<Tx>,
    args: { readonly runId: string; readonly path: string },
    op: JobOperationInput,
  ): Promise<{ readonly runId: string } | SchemaFailure>;
  /**
   * Delivers signal `name` to a run, for an operator who holds only JSON: the run's own version checks the payload
   * (`def.signal(name)` is the typed door for app code; both are one transition). A repeated `deliveryId` is a
   * `duplicate`. `SignalReceived` carries the operator.
   */
  signal(
    source: TransactionSource<Tx>,
    args: { readonly runId: string; readonly name: string; readonly deliveryId: string; readonly payload: unknown },
    op: JobOperationInput,
  ): Promise<SignalOutcome | SchemaFailure>;
  /** Cancels a run of any workflow, for an operator: the same transition as `def.cancel`. `CancelRequested` carries the operator. */
  cancel(
    source: TransactionSource<Tx>,
    args: { readonly runId: string; readonly reason: string },
    op: JobOperationInput,
  ): Promise<CancelOutcome | SchemaFailure>;
  /**
   * Whether `resolveStep` would take `result` for step `path`: the step's `output` schema of the run's own version
   * checks it, and nothing is written. A step `resolveStep` could never resolve throws `STEP_NOT_RESOLVABLE`.
   */
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
    cancelledAt: runs.cancelledAt,
    cancelReason: runs.cancelReason,
    startedAt: runs.startedAt,
    finishedAt: runs.finishedAt,
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
      .select({ ...getTableColumns(runs), stuck: stuckSql })
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

  return { runs: runsPage, run, counts, stranded, history };
}
