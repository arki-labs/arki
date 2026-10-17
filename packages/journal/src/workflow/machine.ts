/**
 * The `workflow.run` entity: its events, its reducers (the run row) and the step projection
 * (`workflow_steps`). Pure state shape; the runner, builder and verbs come in later steps.
 * A run's stored state is one of six values. `stuck`, `stranded` and `residual` are derived
 * from the step rows, so no event names them.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { JournalDefinitions } from '../api.js';
import type { JournalTables } from '../pg.js';
import type { DbHandle, TransactionSource } from '../types.js';
import type { WorkflowShape } from './shape.js';

const at = z.iso.datetime();
const phase = z.enum(['do', 'undo']);
const nodePath = z.string().min(1);
const shapeSchema: z.ZodType<WorkflowShape> = z.object({
  nodes: z.array(
    z.object({
      name: z.string().min(1),
      kind: z.enum(['step', 'waitFor', 'sleep', 'child', 'map']),
      undo: z.boolean(),
    }),
  ),
});
/** When the run row is pruned; null keeps it. Resolved by the runner from `retention.workflows`. */
const keepUntil = z.iso.datetime().nullable();

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
      at,
    }),
  );
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
    }),
  );
  const NodeSkipped = j.event(
    'NodeSkipped',
    z.object({
      path: nodePath,
      phase,
      reason: z.string().min(1),
      actorId: z.string().nullable(),
      at,
    }),
  );
  const NodeFailed = j.event(
    'NodeFailed',
    z.object({ path: nodePath, phase, attempt: z.int().positive(), error: z.string().min(1), at }),
  );
  const Parked = j.event(
    'Parked',
    z.object({ node: nodePath, waitingFor: z.string().nullable(), wakeAt: at.nullable(), at }),
  );
  const SignalReceived = j.event(
    'SignalReceived',
    z.object({ name: z.string().min(1), deliveryId: z.string().min(1), at }),
  );
  const TimerFired = j.event('TimerFired', z.object({ node: nodePath, at }));
  const DeadlineReached = j.event('DeadlineReached', z.object({ at }));
  const CancelRequested = j.event(
    'CancelRequested',
    z.object({ reason: z.string().min(1), actorId: z.string().nullable(), at }),
  );
  const CompensationStarted = j.event('CompensationStarted', z.object({ at }));
  const RunCompleted = j.event('RunCompleted', z.object({ output: z.unknown(), at, keepUntil }));
  const RunFailed = j.event('RunFailed', z.object({ error: z.string().min(1), at, keepUntil }));
  const RunCancelled = j.event('RunCancelled', z.object({ at, keepUntil }));

  const finished = (data: { readonly at: string; readonly keepUntil: string | null }) => ({
    node: null,
    wakeAt: null,
    waitingFor: null,
    finishedAt: new Date(data.at),
    keepUntil: data.keepUntil === null ? null : new Date(data.keepUntil),
  });

  const run = j
    .entity('workflow.run', workflowRuns)
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
      startedAt: new Date(e.data.at),
    }))
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
    // A `when`-skipped `do` node is `null` in results. A skipped undo changes nothing on the row.
    .on(NodeSkipped, (row, e) => (e.data.phase === 'do' ? { results: { ...row.results, [e.data.path]: null } } : {}))
    // A dead step leaves the run where it is: `stuck` is derived from the step row.
    .on(NodeFailed, () => ({}))
    .on(Parked, (_row, e) => ({
      state: 'parked',
      node: e.data.node,
      waitingFor: e.data.waitingFor,
      wakeAt: e.data.wakeAt === null ? null : new Date(e.data.wakeAt),
    }))
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
    .on(CompensationStarted, () => ({ state: 'compensating', wakeAt: null, waitingFor: null }))
    .on(RunCompleted, (_row, e) => ({ state: 'completed', output: e.data.output, ...finished(e.data) }))
    .on(RunFailed, (_row, e) => ({ state: 'failed', ...finished(e.data) }))
    .on(RunCancelled, (_row, e) => ({ state: 'cancelled', ...finished(e.data) }));

  const stepRow = (runId: string, path: string, stepPhase: 'do' | 'undo') => ({ runId, path, phase: stepPhase });

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
      NodeScheduled,
      NodeCompleted,
      NodeSkipped,
      NodeFailed,
      Parked,
      SignalReceived,
      TimerFired,
      DeadlineReached,
      CancelRequested,
      CompensationStarted,
      RunCompleted,
      RunFailed,
      RunCancelled,
    },
  };
}

/** What a step row stores, plus `running`, which is never stored: it is derived from the step's job. */
export type StepStatus = JournalTables['workflowSteps']['$inferSelect']['status'] | 'running';

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
