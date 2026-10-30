/**
 * The `workflow.run` entity: its events, its reducers (the run row) and the step projection
 * (`workflow_steps`). Pure state shape; the runner, builder and verbs come in later steps.
 * A run's stored state is one of eight values (`RUN_STATES`). `stuck`, `stranded` and `residual` are derived
 * from the step rows, so no event names them.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { StandardSchemaV1 } from '@arki/schema';

import type { JournalDefinitions } from '../api.js';
import type { JournalTables } from '../pg.js';
import type { DbHandle, TransactionSource } from '../types.js';
import type { StepPhase, StepStatus } from './states.js';
import { changedMetadata } from './run-fields.js';
import { metadataChangeSchema } from './run-field-schemas.js';
import { LIMIT_BUSY_REASONS, SKIP_CAUSES, STEP_PHASES } from './states.js';

const at = z.iso.datetime();
const phase = z.enum(STEP_PHASES);
const nodePath = z.string().min(1);
/** Checks a stored `WorkflowShape`. The type is the source; `schemas.test-d.ts` locks this schema to it both ways. */
export const shapeSchema = z
  .object({
    nodes: z
      .array(
        z
          .object({
            name: z.string().min(1),
            kind: z.enum(['step', 'waitFor', 'sleep', 'child', 'map', 'command']),
            undo: z.boolean(),
            onCancel: z.enum(['cancel', 'detach']).optional(),
            signal: z.string().min(1).optional(),
            command: z.string().min(1).optional(),
            undoCommand: z.string().min(1).optional(),
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();
/** When the run row is pruned; null keeps it. Resolved by the runner from `retention.workflows`. */
const keepUntil = z.iso.datetime().nullable();
/** Who asked, why, and from which Foreman execution, on an event an operator verb wrote. The run's events are the audit. */
export const byOperator = {
  actorId: z.string().optional(),
  reason: z.string().optional(),
  executionId: z.string().optional(),
};

export function workflowMachine<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx> = DbHandle,
>(
  j: Pick<JournalDefinitions<Meta, Tx>, 'event' | 'entity' | 'projection'>,
  tables: Pick<JournalTables, 'workflowRuns' | 'workflowSteps'>,
) {
  const { workflowRuns, workflowSteps } = tables;

  const RunStarted = j.event(
    'RunStarted',
    z.object({
      name: z.string().min(1),
      workflowVersion: z.int().positive(),
      shape: shapeSchema,
      shapeHash: z.string().min(1),
      input: z.unknown(),
      deadlineAt: at.nullable(),
      parentId: z.string().nullable(),
      parentPath: z.string().nullable(),
      concurrencyKey: z.string().nullable(),
      // The run fields came later: a run started before them has none of these, and its row gets the defaults.
      scope: z.string().nullable().optional(),
      tags: z.array(z.string()).readonly().optional(),
      metadata: z.record(z.string(), z.unknown()).readonly().optional(),
      rootId: z.string().nullable().optional(),
      // Start timing came later still, the same way: an older run has no delay and no ttl.
      startAt: at.nullable().optional(),
      ttlAt: at.nullable().optional(),
      ttlMs: z.int().positive().nullable().optional(),
      // Set by `start` only when given, as are the overrides below: an older or plain run has none of them.
      maxAttempts: z.int().positive().optional(),
      stepTimeoutMs: z.int().positive().optional(),
      priority: z.int32().optional(),
      // The shared limits the run holds, left out when it holds none: an older run holds none.
      limits: z.array(z.string().min(1)).readonly().optional(),
      // Set by `startBatch` and by `replay` only; `replay` also records its operator.
      batchId: z.string().optional(),
      replayOf: z.string().optional(),
      ...byOperator,
      at,
    }),
  );
  /**
   * A limit the start holds was busy and the workflow's `onBusy` is `'queue'`: the run waits, with no node scheduled,
   * until a slot frees. `limitName` and `reason` say what blocked it then. `ttlAt` and `priority` are for the timer
   * job that ends the run `expired` if it is still queued at its `ttl`.
   */
  const RunQueued = j.event(
    'RunQueued',
    z.object({
      limitName: z.string().min(1),
      reason: z.enum(LIMIT_BUSY_REASONS),
      ttlAt: at.nullable(),
      priority: z.int32().optional(),
      at,
    }),
  );
  /** A slot freed and the queued run fits every limit it holds: it runs, and its first node is scheduled next. */
  const RunDequeued = j.event('RunDequeued', z.object({ at }));
  /** `at` is when the node is due: now for a first try, later for a retry that waits out its backoff. */
  const NodeScheduled = j.event(
    'NodeScheduled',
    z.object({
      path: nodePath,
      phase,
      attempt: z.int().positive(),
      key: z.string().min(1),
      jobId: z.string().nullable(),
      at,
      /** Set by `resolveStep`: the operator's result. The worker routes it and does not run the step body. */
      resolution: z.object({ result: z.unknown() }).optional(),
      /** The run's `priority`, for the job this event makes. Left out for a run without one. */
      priority: z.int32().optional(),
      ...byOperator,
    }),
  );
  const NodeCompleted = j.event(
    'NodeCompleted',
    z.object({
      path: nodePath,
      phase,
      result: z.unknown(),
      /** Set when an operator supplied the result (`resolveStep`). */
      resolvedBy: z.string().nullable(),
      at,
      reason: byOperator.reason,
      executionId: byOperator.executionId,
    }),
  );
  const NodeSkipped = j.event(
    'NodeSkipped',
    z.object({
      path: nodePath,
      phase,
      cause: z.enum(SKIP_CAUSES),
      reason: z.string().min(1),
      actorId: z.string().nullable(),
      at,
      executionId: byOperator.executionId,
    }),
  );
  const NodeFailed = j.event(
    'NodeFailed',
    z.object({ path: nodePath, phase, attempt: z.int().positive(), error: z.string().min(1), at }),
  );
  const Parked = j.event(
    'Parked',
    // `priority`: the run's, for the timer job, as on `NodeScheduled`.
    z.object({
      node: nodePath,
      waitingFor: z.string().nullable(),
      wakeAt: at.nullable(),
      priority: z.int32().optional(),
      at,
    }),
  );
  /**
   * A child or map node reached its work: the child runs it will start, in order, each with its stored input, and the
   * run parks until they end. `base` is the node path with the visit of a loop appended (`fan`, `fan:2`); every child's
   * `parentPath` is it. Children that wait for a free slot (`concurrency`) are started later, from this list.
   */
  const ChildrenPlanned = j.event(
    'ChildrenPlanned',
    z.object({
      path: nodePath,
      base: z.string().min(1),
      def: z.object({ name: z.string().min(1), version: z.int().positive() }),
      children: z.array(z.object({ id: z.string().min(1), input: z.unknown() })).min(1),
      at,
      ...byOperator,
    }),
  );
  /** An operator retried the dead job of a stranded run (its code is back). The job is the one retried; `node` is the step or park it belongs to. */
  const JobRetried = j.event(
    'JobRetried',
    z.object({ jobId: z.string().min(1), node: nodePath.nullable(), at, ...byOperator }),
  );
  const SignalReceived = j.event(
    'SignalReceived',
    z.object({ name: z.string().min(1), deliveryId: z.string().min(1), at, ...byOperator }),
  );
  const TimerFired = j.event('TimerFired', z.object({ node: nodePath, at }));
  const DeadlineReached = j.event('DeadlineReached', z.object({ at }));
  const CancelRequested = j.event(
    'CancelRequested',
    z.object({ reason: z.string().min(1), actorId: z.string().nullable(), executionId: byOperator.executionId, at }),
  );
  const CompensationStarted = j.event('CompensationStarted', z.object({ at }));
  /** A step (`ctx.metadata`) or an operator (`setMetadata`) changed the run's metadata. The reducer applies `change`. */
  const MetadataChanged = j.event('MetadataChanged', z.object({ change: metadataChangeSchema, at, ...byOperator }));
  /** A step (`ctx.tags.add`) or an operator (`addTags`) added `tags`: only those the run did not have, each once. */
  const RunTagged = j.event(
    'RunTagged',
    z.object({ tags: z.array(z.string().min(1)).min(1).readonly(), at, ...byOperator }),
  );
  const RunCompleted = j.event('RunCompleted', z.object({ output: z.unknown(), at, keepUntil }));
  const RunFailed = j.event('RunFailed', z.object({ error: z.string().min(1), at, keepUntil }));
  const RunCancelled = j.event('RunCancelled', z.object({ at, keepUntil }));
  /** The run's `ttl` passed before its first node started, so the worker ran nothing. */
  const RunExpired = j.event('RunExpired', z.object({ at, keepUntil }));
  /**
   * An operator moved the start of a run whose first node had not started (`reschedule`). `ttlAt` and `deadlineAt`
   * move with it, as `start` worked them out from the start time.
   */
  const RunRescheduled = j.event(
    'RunRescheduled',
    z.object({ startAt: at, ttlAt: at.nullable(), deadlineAt: at.nullable(), at, ...byOperator }),
  );

  /** A stored time, or null for none (and for an older event that has no such field). */
  const date = (value: string | null | undefined) => (value === null || value === undefined ? null : new Date(value));

  const finished = (data: { readonly at: string; readonly keepUntil: string | null }) => ({
    node: null,
    wakeAt: null,
    waitingFor: null,
    finishedAt: new Date(data.at),
    keepUntil: data.keepUntil === null ? null : new Date(data.keepUntil),
  });

  const run = j
    // Always stored, whatever the journal default: the runner replays these events to resume a run.
    .entity('workflow.run', workflowRuns, { events: 'stored' })
    .create(RunStarted, e => ({
      name: e.data.name,
      workflowVersion: e.data.workflowVersion,
      shape: e.data.shape,
      shapeHash: e.data.shapeHash,
      input: e.data.input,
      state: 'running',
      results: {},
      deadlineAt: e.data.deadlineAt === null ? null : new Date(e.data.deadlineAt),
      parentId: e.data.parentId,
      parentPath: e.data.parentPath,
      concurrencyKey: e.data.concurrencyKey,
      scope: e.data.scope ?? null,
      tags: [...(e.data.tags ?? [])],
      metadata: e.data.metadata ?? {},
      rootId: e.data.rootId ?? null,
      fieldChanges: 0,
      startAt: date(e.data.startAt),
      ttlAt: date(e.data.ttlAt),
      ttlMs: e.data.ttlMs ?? null,
      batchId: e.data.batchId ?? null,
      replayOf: e.data.replayOf ?? null,
      maxAttempts: e.data.maxAttempts ?? null,
      stepTimeoutMs: e.data.stepTimeoutMs ?? null,
      priority: e.data.priority ?? null,
      limits: [...(e.data.limits ?? [])],
      startedAt: new Date(e.data.at),
    }))
    // Written with `RunStarted`, so a run that never queued has neither event and starts `running`.
    .on(RunQueued, () => ({ state: 'queued', node: null }))
    .on(RunDequeued, () => ({ state: 'running' }))
    // A scheduled node ends a park. A run that is compensating stays compensating.
    .on(NodeScheduled, (row, e) => ({
      node: e.data.path,
      state: row.state === 'compensating' ? 'compensating' : 'running',
      wakeAt: null,
      waitingFor: null,
    }))
    // Only a `do` result is a result of the run; an undo has none to keep.
    .on(NodeCompleted, (row, e) =>
      e.data.phase === 'do' ? { results: { ...row.results, [e.data.path]: e.data.result } } : {},
    )
    // A `when`-skipped `do` node is `null` in results. A node dropped by compensation (a wait that never got its
    // signal) or by expiry never ran, so it leaves no key. A skipped undo changes nothing on the row.
    .on(NodeSkipped, (row, e) =>
      e.data.phase === 'do' && e.data.cause !== 'compensating' && e.data.cause !== 'expired'
        ? { results: { ...row.results, [e.data.path]: null } }
        : {},
    )
    // A dead step leaves the run where it is: `stuck` is derived from the step row.
    .on(NodeFailed, () => ({}))
    .on(Parked, (_row, e) => ({
      state: 'parked',
      node: e.data.node,
      waitingFor: e.data.waitingFor,
      wakeAt: e.data.wakeAt === null ? null : new Date(e.data.wakeAt),
    }))
    // The run waits for its children: the wake is `NodeCompleted` when they have all (or the first) ended well.
    .on(ChildrenPlanned, (_row, e) => ({
      state: 'parked',
      node: e.data.path,
      waitingFor: null,
      wakeAt: null,
    }))
    // Audit only: the retried job is back in the queue, and the step row has not changed.
    .on(JobRetried, () => ({}))
    // The signal row is written by the signal command; the wake that follows is NodeCompleted.
    .on(SignalReceived, () => ({}))
    .on(TimerFired, row => ({
      state: row.state === 'parked' ? 'running' : row.state,
      wakeAt: null,
      waitingFor: null,
    }))
    // The failure or compensation that follows is its own event.
    .on(DeadlineReached, () => ({}))
    // The first request wins: a second cancel does not move the time or the reason.
    .on(CancelRequested, (row, e) => ({
      cancelledAt: row.cancelledAt ?? new Date(e.data.at),
      cancelReason: row.cancelReason ?? e.data.reason,
    }))
    // A completed child run is reopened by its parent to undo its work: it is unfinished again until it ends cancelled.
    .on(CompensationStarted, () => ({
      state: 'compensating',
      wakeAt: null,
      waitingFor: null,
      finishedAt: null,
      keepUntil: null,
    }))
    // Neither moves the run: they change only what describes it, and `fieldChanges` counts them.
    .on(MetadataChanged, (row, e) => ({
      metadata: changedMetadata(row.metadata, e.data.change),
      fieldChanges: row.fieldChanges + 1,
    }))
    .on(RunTagged, (row, e) => ({ tags: [...row.tags, ...e.data.tags], fieldChanges: row.fieldChanges + 1 }))
    // A new start moves the run, so it is not a field change: an approval taken before it no longer holds.
    .on(RunRescheduled, (_row, e) => ({
      startAt: new Date(e.data.startAt),
      ttlAt: date(e.data.ttlAt),
      deadlineAt: date(e.data.deadlineAt),
    }))
    .on(RunCompleted, (_row, e) => ({ state: 'completed', output: e.data.output, ...finished(e.data) }))
    .on(RunFailed, (_row, e) => ({ state: 'failed', ...finished(e.data) }))
    .on(RunCancelled, (_row, e) => ({ state: 'cancelled', ...finished(e.data) }))
    .on(RunExpired, (_row, e) => ({ state: 'expired', ...finished(e.data) }));

  const stepRow = (runId: string, path: string, stepPhase: StepPhase) => ({ runId, path, phase: stepPhase });

  /** Keeps `workflow_steps` equal to what the events say. Inline, so a read in the same transaction is exact. */
  const steps = j.projection('workflow-steps', run, {
    NodeScheduled: (tx, e) =>
      tx
        .insert(workflowSteps)
        .values({
          ...stepRow(e.entityId, e.data.path, e.data.phase),
          status: 'scheduled',
          attempt: e.data.attempt,
          key: e.data.key,
          jobId: e.data.jobId,
          startedAt: new Date(e.data.at),
        })
        .onConflictDoUpdate({
          target: [workflowSteps.runId, workflowSteps.path, workflowSteps.phase],
          // A retry or a re-schedule: back to scheduled with a clean slate. `started_at` keeps the first time.
          set: {
            status: 'scheduled',
            attempt: e.data.attempt,
            key: e.data.key,
            jobId: e.data.jobId,
            error: null,
            reason: null,
            finishedAt: null,
          },
        }),
    NodeCompleted: (tx, e) =>
      tx
        .insert(workflowSteps)
        .values({
          ...stepRow(e.entityId, e.data.path, e.data.phase),
          status: 'done',
          result: e.data.result ?? null,
          finishedAt: new Date(e.data.at),
        })
        .onConflictDoUpdate({
          target: [workflowSteps.runId, workflowSteps.path, workflowSteps.phase],
          set: { status: 'done', result: e.data.result ?? null, error: null, finishedAt: new Date(e.data.at) },
        }),
    NodeSkipped: (tx, e) =>
      tx
        .insert(workflowSteps)
        .values({
          ...stepRow(e.entityId, e.data.path, e.data.phase),
          status: 'skipped',
          reason: e.data.reason,
          finishedAt: new Date(e.data.at),
        })
        .onConflictDoUpdate({
          target: [workflowSteps.runId, workflowSteps.path, workflowSteps.phase],
          set: { status: 'skipped', reason: e.data.reason, error: null, finishedAt: new Date(e.data.at) },
        }),
    // A new plan puts a node whose children failed back to waiting for them (`retryStep`); a first plan finds it scheduled already.
    ChildrenPlanned: (tx, e) =>
      tx
        .update(workflowSteps)
        .set({ status: 'scheduled', error: null, finishedAt: null })
        .where(
          and(
            eq(workflowSteps.runId, e.entityId),
            eq(workflowSteps.path, e.data.path),
            eq(workflowSteps.phase, 'do'),
            eq(workflowSteps.status, 'failed'),
          ),
        ),
    NodeFailed: (tx, e) =>
      tx
        .insert(workflowSteps)
        .values({
          ...stepRow(e.entityId, e.data.path, e.data.phase),
          status: 'failed',
          attempt: e.data.attempt,
          error: e.data.error,
          finishedAt: new Date(e.data.at),
        })
        .onConflictDoUpdate({
          target: [workflowSteps.runId, workflowSteps.path, workflowSteps.phase],
          set: { status: 'failed', attempt: e.data.attempt, error: e.data.error, finishedAt: new Date(e.data.at) },
        }),
  });

  return {
    run,
    steps,
    events: {
      RunStarted,
      RunQueued,
      RunDequeued,
      NodeScheduled,
      NodeCompleted,
      NodeSkipped,
      NodeFailed,
      Parked,
      ChildrenPlanned,
      JobRetried,
      SignalReceived,
      TimerFired,
      DeadlineReached,
      CancelRequested,
      CompensationStarted,
      MetadataChanged,
      RunTagged,
      RunCompleted,
      RunFailed,
      RunCancelled,
      RunExpired,
      RunRescheduled,
    },
  };
}


/**
 * The status of a step as a SQL expression, for a query on `workflow_steps`. A `scheduled` step is `running` while
 * its current job (`job_id`) is alive and holds a lease, the same test `outbox.ts` uses for a running job. Any other
 * stored status is returned as it is. Nothing writes `running` to the step row, so a crashed worker's step is
 * `scheduled` again as soon as its lease runs out.
 */
export const stepStatusSql = (tables: Pick<JournalTables, 'workflowSteps' | 'jobs'>) => {
  const { workflowSteps, jobs } = tables;
  return sql<StepStatus>`
    CASE
        WHEN ${workflowSteps.status} = 'scheduled' AND EXISTS (
          SELECT 1 FROM ${jobs}
          WHERE ${jobs.id} = ${workflowSteps.jobId} AND ${jobs.deadAt} IS NULL AND ${jobs.leaseUntil} > now()
        ) THEN 'running'
        ELSE ${workflowSteps.status} END
  `;
};
