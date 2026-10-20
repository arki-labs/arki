/**
 * The Foreman control-plane module for durable workflows: find a stuck run, read it, and move it under an approved
 * permit (retry a dead step, give a signal that never came, resolve a step by hand, skip a failed undo, cancel a run).
 * Mirrors `journalJobsModule`: every action previews what it will do with a `revision`, and refuses with E010 when the
 * run changed since. Every verb writes who did it onto the run's events. Requires the optional peer `@arki/admin`.
 */
import { z } from 'zod';

import type { Permit } from '@arki/admin/module';
import type { SchemaInput, StandardSchemaV1 } from '@arki/schema';
import {
  canonicalJson,
  defineAction,
  defineModule,
  defineRead,
  jsonValueSchema,
  moduleError,
  redactSecrets,
} from '@arki/admin/module';
import { findCause, isFailure, orThrow } from '@arki/failure';

import type { DbHandle, Journal, RootDb, TransactionSource } from '../index.js';
import type { RunDetail } from '../workflow/read.js';
import { CommandConflict, CommandInvalid, CommandNotFound, JournalError } from '../index.js';

/**
 * The coded refusals of the workflow actions. They are module errors, so the dispatcher answers them with the status
 * written here. A refusal never surfaces as a 500.
 */
export const JOURNAL_WORKFLOWS_ERROR_CODES = {
  /** The run changed since the preview the approval pinned. HTTP 409. */
  staleRevision: 'ARKI_JOURNAL_E010',
  /** The run is over: completed, failed or cancelled. HTTP 409. */
  finished: 'ARKI_JOURNAL_E011',
  /** The step is not dead (or never ran), so there is nothing to retry, resolve or skip. HTTP 409. */
  stepNotDead: 'ARKI_JOURNAL_E012',
  /** The signal name is unknown to the run's version, or its payload does not match the signal's schema. HTTP 400. */
  badSignal: 'ARKI_JOURNAL_E013',
  /** The run is already undoing its work. HTTP 409. */
  compensating: 'ARKI_JOURNAL_E014',
  /** The step cannot be resolved by hand: no `output` schema, not a step, or the run is not running. 409; 400 for a result that does not match the schema. */
  stepNotResolvable: 'ARKI_JOURNAL_E015',
  /** No run has this id. HTTP 404. */
  notFound: 'ARKI_JOURNAL_E016',
  /** The run's code is not registered on this journal, or has other nodes, so nothing can move it. HTTP 409. */
  stranded: 'ARKI_JOURNAL_E017',
} as const;

const MAX_PAGE = 200;

// ---- options ----------------------------------------------------------------------------------------------------

export type JournalWorkflowsModuleOptions<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = {
  /** The app's composed journal, with the workflows registered. */
  journal: Journal<Meta, Tx, AppDb>;
  /** The root database the reads run on. The verbs run on it too, so it is also the journal's transaction source. */
  db: DbHandle & TransactionSource<Tx>;
  /**
   * What reads show of a run's input, results, output, signal payloads and event data.
   * `hidden` (default): nothing. `redacted`: canonical JSON with secrets removed, capped. Errors always have secrets removed.
   */
  payload?: 'hidden' | 'redacted';
  /** The meta of the commands the module runs for an approved permit. Its `actorId` is also written on the run's events as the actor. */
  meta: (permit: Permit) => SchemaInput<Meta> & { readonly actorId: string };
};

// ---- output schemas ---------------------------------------------------------------------------------------------

const RunState = z.enum(['running', 'parked', 'compensating', 'completed', 'failed', 'cancelled']);
const StrandedCode = z.enum(['WORKFLOW_UNKNOWN', 'WORKFLOW_SHAPE_CHANGED']);
const timeOrNull = z.iso.datetime().nullable();

const RunSummary = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.number().int(),
    state: RunState,
    node: z.string().nullable(),
    waitingFor: z.string().nullable(),
    wakeAt: timeOrNull,
    deadlineAt: timeOrNull,
    parentId: z.string().nullable(),
    parentPath: z.string().nullable(),
    cancelledAt: timeOrNull,
    cancelReason: z.string().nullable(),
    startedAt: z.iso.datetime(),
    finishedAt: timeOrNull,
    stuck: z.boolean(),
    stranded: StrandedCode.nullable(),
  })
  .strict();

const StepSummary = z
  .object({
    path: z.string(),
    phase: z.enum(['do', 'undo']),
    attempt: z.number().int(),
    key: z.string().nullable(),
    jobId: z.string().nullable(),
    status: z.enum(['scheduled', 'running', 'done', 'skipped', 'failed']),
    stuck: z.boolean(),
    error: z.string().nullable(),
    reason: z.string().nullable(),
    startedAt: timeOrNull,
    finishedAt: timeOrNull,
    result: z.string().optional(),
  })
  .strict();

const ChildSummary = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.number().int(),
    state: RunState,
    parentPath: z.string().nullable(),
    startedAt: z.iso.datetime(),
    finishedAt: timeOrNull,
  })
  .strict();

const SignalSummary = z
  .object({
    id: z.string(),
    name: z.string(),
    deliveryId: z.string(),
    receivedAt: z.iso.datetime(),
    payload: z.string().optional(),
  })
  .strict();

const HistoryEntry = z
  .object({
    seq: z.number().int(),
    id: z.string(),
    version: z.number().int(),
    type: z.string(),
    recordedAt: z.iso.datetime(),
    /** Who did it, for the events an operator or a Foreman action wrote. */
    actorId: z.string().optional(),
    reason: z.string().optional(),
    executionId: z.string().optional(),
    data: z.string().optional(),
  })
  .strict();

const operatorFields = z.object({
  actorId: z.string().optional(),
  reason: z.string().optional(),
  executionId: z.string().optional(),
});

// ---- helpers ----------------------------------------------------------------------------------------------------

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date === null ? null : date.toISOString());
const errorOrNull = (error: string | null) => (error === null ? null : redactSecrets(error));

/** A payload as the option allows it: absent while `hidden`, and for a value that is not there. */
function shown(mode: 'hidden' | 'redacted', value: unknown): { text?: string } {
  if (mode === 'hidden' || value === null || value === undefined) return {};
  return { text: redactSecrets(canonicalJson(jsonValueSchema.parse(value))) };
}

const reasonField = z.string().min(1).max(500);
const optionalReason = reasonField.optional();
const pageLimit = z.number().int().min(1).max(MAX_PAGE).default(50);
const cursor = z.string().min(1).optional();
const emptyInput = z.object({}).strict();
const runIdField = z.string().min(1);
const pathField = z.string().min(1);

const notFound = (runId: string) =>
  moduleError(
    JOURNAL_WORKFLOWS_ERROR_CODES.notFound,
    404,
    `No workflow run has the id "${runId}".`,
    'List the runs and pick an id from the list.',
  );

const stale = (runId: string) =>
  moduleError(
    JOURNAL_WORKFLOWS_ERROR_CODES.staleRevision,
    409,
    `Run ${runId} changed since the preview.`,
    'Preview the action again and approve the new revision.',
  );

const finished = (runId: string, state: string) =>
  moduleError(
    JOURNAL_WORKFLOWS_ERROR_CODES.finished,
    409,
    `Run ${runId} is over (${state}), so no action can move it.`,
    'Read the run for its history.',
  );

const stepNotDead = (runId: string, detail: string) =>
  moduleError(
    JOURNAL_WORKFLOWS_ERROR_CODES.stepNotDead,
    409,
    `${detail} (run ${runId}).`,
    'Read the run and pick a step that is stuck.',
  );

const badSignal = (runId: string, detail: string) =>
  moduleError(
    JOURNAL_WORKFLOWS_ERROR_CODES.badSignal,
    400,
    `${detail} (run ${runId}).`,
    "Send a signal the run's version waits for, with a payload that matches its schema.",
  );

const compensating = (runId: string) =>
  moduleError(
    JOURNAL_WORKFLOWS_ERROR_CODES.compensating,
    409,
    `Run ${runId} is undoing its work now.`,
    'Wait for the undo to finish. A failed undo can be retried or skipped.',
  );

const notResolvable = (runId: string, why: string, status = 409) =>
  moduleError(
    JOURNAL_WORKFLOWS_ERROR_CODES.stepNotResolvable,
    status,
    `The step cannot be resolved by hand on run ${runId}: ${why}.`,
    'Retry the step instead, or give a result that matches the declared output.',
  );

const stranded = (runId: string, why: string) =>
  moduleError(
    JOURNAL_WORKFLOWS_ERROR_CODES.stranded,
    409,
    `Run ${runId} cannot move: ${why}.`,
    "Register the run's workflow version again (compose({ workflows })) and retry.",
  );

/** A journal refusal as the coded error an operator sees. Anything else passes through as an app failure. */
function asModuleError(error: unknown, runId: string): unknown {
  const refusal = findCause(error, JournalError);
  if (refusal === undefined) return error;
  if (refusal.code === 'WORKFLOW_NOT_FOUND') return notFound(runId);
  if (refusal.code === 'WORKFLOW_FINISHED') return finished(runId, refusal.message);
  if (refusal.code === 'WORKFLOW_COMPENSATING') return compensating(runId);
  if (refusal.code === 'STEP_NOT_DEAD') return stepNotDead(runId, refusal.message);
  if (refusal.code === 'STEP_NOT_RESOLVABLE') return notResolvable(runId, refusal.message);
  if (refusal.code === 'WORKFLOW_UNKNOWN' || refusal.code === 'WORKFLOW_SHAPE_CHANGED') {
    return stranded(runId, refusal.message);
  }
  if (refusal.code === 'BAD_ARGUMENT') return notResolvable(runId, refusal.message, 400);
  return error;
}

async function guarded<T>(runId: string, run: () => Promise<T>): Promise<T> {
  try {
    const value = await run();
    if (isFailure<unknown>(value)) {
      const mapped = asModuleError(value, runId);
      if (mapped !== value) throw mapped;
    }
    return value;
  } catch (error) {
    throw asModuleError(error, runId);
  }
}

const isOver = (detail: RunDetail) => detail.run.finishedAt !== null;
const revisionOf = (detail: RunDetail) => String(detail.run.version);
/** The revision of a retry of dead jobs: the run's version and the exact jobs, so the approval covers what is retried. */
const deadJobsRevision = (detail: RunDetail, ids: readonly string[]) => `${revisionOf(detail)}:${ids.join(',')}`;

/** How many of a failed child node's children are failed now: the latest try of each child, `~2` after `~1`. */
function failedChildren(children: RunDetail['children'], path: string): number {
  const latest = new Map<string, { retry: number; state: string }>();
  for (const child of children) {
    if (child.parentPath !== path) continue;
    const [base = child.id, retry = '1'] = child.id.split('~');
    const kept = latest.get(base);
    if (kept === undefined || Number(retry) > kept.retry)
      latest.set(base, { retry: Number(retry), state: child.state });
  }
  return [...latest.values()].filter(child => child.state === 'failed' || child.state === 'cancelled').length;
}

/**
 * The node manifest the run pinned at start, refused when the run is stranded: an action needs the run's code, and
 * the manifest of a stranded run may describe code this journal does not have.
 */
function nodesOf(detail: RunDetail): RunDetail['run']['shape']['nodes'] {
  const { run } = detail;
  if (run.stranded !== null) {
    throw stranded(run.id, `no registered code has the nodes of ${run.name} v${run.workflowVersion}`);
  }
  return run.shape.nodes;
}

/** The `waitFor` node of the run's manifest that waits for `name`, or the bad-signal refusal. */
function waitOf(detail: RunDetail, name: string) {
  const wait = nodesOf(detail).find(node => node.kind === 'waitFor' && node.signal === name);
  if (wait === undefined) {
    throw badSignal(
      detail.run.id,
      `${detail.run.name} v${detail.run.workflowVersion} has no wait for a signal named "${name}"`,
    );
  }
  return wait;
}

/** The delivery id a Foreman execution gives its signal: one execution is one delivery, however often it runs. */
const deliveryOf = (permit: Permit) => `foreman:${permit.executionId}`;

/** `a, b and c`, for a short list in a sentence. */
const listOf = (names: readonly string[]) => names.map(name => `"${name}"`).join(', ');

// ---- the module -------------------------------------------------------------------------------------------------

export function journalWorkflowsModule<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(options: JournalWorkflowsModuleOptions<Meta, Tx, AppDb>) {
  const { journal, db } = options;
  const payloadMode = options.payload ?? 'hidden';

  const actorOf = (permit: Permit) => options.meta(permit).actorId;
  const operationOf = (permit: Permit, reason: string | undefined) => ({
    actor: actorOf(permit),
    executionId: permit.executionId,
    ...(reason === undefined ? {} : { reason }),
  });

  /** The run, or the refusal that says why no action applies: it is gone, or it is over. */
  async function openRun(runId: string): Promise<RunDetail> {
    const detail = await journal.workflows.run(db, runId);
    if (detail === undefined) throw notFound(runId);
    if (isOver(detail)) throw finished(runId, detail.run.state);
    return detail;
  }

  /** The dead jobs of one run: what an operator retries when the run's code came back after the jobs died. */
  async function deadJobsOfRun(runId: string): Promise<readonly string[]> {
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await journal.jobs(db, {
        status: 'dead',
        limit: MAX_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      ids.push(...page.jobs.filter(job => job.runId === runId).map(job => job.id));
      if (page.next === null) return ids.toSorted();
      after = page.next;
    }
  }

  /** A change of the run's journal version since the preview voids the approval. */
  async function assertUnchanged(runId: string, permit: Permit): Promise<RunDetail> {
    const detail = await openRun(runId);
    if (revisionOf(detail) !== permit.expectedRevision) throw stale(runId);
    return detail;
  }

  // ---- reads --------------------------------------------------------------------------------------------------

  const runs = defineRead({
    id: 'workflow.runs',
    summary: 'Workflow runs, newest first, with whether each is stuck or stranded',
    permission: 'workflow:read',
    input: z
      .object({
        state: RunState.optional(),
        name: z.string().min(1).optional(),
        version: z.number().int().positive().optional(),
        parentId: z.string().min(1).optional(),
        stuck: z.boolean().optional(),
        limit: pageLimit,
        after: cursor,
      })
      .strict(),
    output: z.object({ runs: z.array(RunSummary), next: z.string().nullable() }).strict(),
    load: async ({ state, name, version, parentId, stuck, limit, after }, _ctx: Record<string, never>) => {
      const page = await journal.workflows.runs(db, {
        limit,
        ...(state === undefined ? {} : { state }),
        ...(name === undefined ? {} : { name }),
        ...(version === undefined ? {} : { version }),
        ...(parentId === undefined ? {} : { parentId }),
        ...(stuck === undefined ? {} : { stuck }),
        ...(after === undefined ? {} : { after }),
      });
      return {
        runs: page.runs.map(run => ({
          id: run.id,
          name: run.name,
          version: run.workflowVersion,
          state: run.state,
          node: run.node,
          waitingFor: run.waitingFor,
          wakeAt: isoOrNull(run.wakeAt),
          deadlineAt: isoOrNull(run.deadlineAt),
          parentId: run.parentId,
          parentPath: run.parentPath,
          cancelledAt: isoOrNull(run.cancelledAt),
          cancelReason: run.cancelReason === null ? null : redactSecrets(run.cancelReason),
          startedAt: iso(run.startedAt),
          finishedAt: isoOrNull(run.finishedAt),
          stuck: run.stuck,
          stranded: run.stranded,
        })),
        next: page.next,
      };
    },
  });

  const run = defineRead({
    id: 'workflow.run',
    summary: 'One run with its steps, children, waiting signals and whether it is stranded',
    permission: 'workflow:read',
    input: z.object({ runId: runIdField }).strict(),
    output: z
      .object({
        run: RunSummary,
        steps: z.array(StepSummary),
        /** Paths whose undo was skipped: the work they did stays done. */
        residual: z.array(z.string()),
        children: z.array(ChildSummary),
        signals: z.array(SignalSummary),
        input: z.string().optional(),
        results: z.string().optional(),
        output: z.string().optional(),
      })
      .strict(),
    load: async ({ runId }, _ctx: Record<string, never>) => {
      const detail = await journal.workflows.run(db, runId);
      if (detail === undefined) throw notFound(runId);
      const { run: row } = detail;
      const input = shown(payloadMode, row.input);
      const results = shown(payloadMode, row.results);
      const output = shown(payloadMode, row.output);
      return {
        run: {
          id: row.id,
          name: row.name,
          version: row.workflowVersion,
          state: row.state,
          node: row.node,
          waitingFor: row.waitingFor,
          wakeAt: isoOrNull(row.wakeAt),
          deadlineAt: isoOrNull(row.deadlineAt),
          parentId: row.parentId,
          parentPath: row.parentPath,
          cancelledAt: isoOrNull(row.cancelledAt),
          cancelReason: row.cancelReason === null ? null : redactSecrets(row.cancelReason),
          startedAt: iso(row.startedAt),
          finishedAt: isoOrNull(row.finishedAt),
          stuck: row.stuck,
          stranded: row.stranded,
        },
        steps: detail.steps.map(step => {
          const result = shown(payloadMode, step.result);
          return {
            path: step.path,
            phase: step.phase,
            attempt: step.attempt,
            key: step.key,
            jobId: step.jobId,
            status: step.status,
            stuck: step.stuck,
            error: errorOrNull(step.error),
            reason: step.reason === null ? null : redactSecrets(step.reason),
            startedAt: isoOrNull(step.startedAt),
            finishedAt: isoOrNull(step.finishedAt),
            ...(result.text === undefined ? {} : { result: result.text }),
          };
        }),
        residual: [...detail.residual],
        children: detail.children.map(child => ({
          id: child.id,
          name: child.name,
          version: child.workflowVersion,
          state: child.state,
          parentPath: child.parentPath,
          startedAt: iso(child.startedAt),
          finishedAt: isoOrNull(child.finishedAt),
        })),
        signals: detail.signals.map(signal => {
          const payload = shown(payloadMode, signal.payload);
          return {
            id: signal.id,
            name: signal.name,
            deliveryId: signal.deliveryId,
            receivedAt: iso(signal.receivedAt),
            ...(payload.text === undefined ? {} : { payload: payload.text }),
          };
        }),
        ...(input.text === undefined ? {} : { input: input.text }),
        ...(results.text === undefined ? {} : { results: results.text }),
        ...(output.text === undefined ? {} : { output: output.text }),
      };
    },
  });

  const counts = defineRead({
    id: 'workflow.counts',
    summary: 'How many runs there are per workflow name, version and state',
    permission: 'workflow:read',
    input: emptyInput,
    output: z
      .object({
        counts: z.array(
          z.object({ name: z.string(), version: z.number().int(), state: RunState, runs: z.number().int() }).strict(),
        ),
      })
      .strict(),
    load: async (_input, _ctx: Record<string, never>) => {
      const rows = await journal.workflows.counts(db);
      return { counts: rows.map(row => ({ ...row })) };
    },
  });

  const strandedRuns = defineRead({
    id: 'workflow.stranded',
    summary: 'Unfinished runs whose code is missing or has other nodes, oldest first',
    permission: 'workflow:read',
    input: z.object({ limit: pageLimit }).strict(),
    output: z
      .object({
        stranded: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              version: z.number().int(),
              state: RunState,
              startedAt: z.iso.datetime(),
              code: StrandedCode,
            })
            .strict(),
        ),
      })
      .strict(),
    load: async ({ limit }, _ctx: Record<string, never>) => {
      const rows = await journal.workflows.stranded(db, { limit });
      return {
        stranded: rows.map(row => ({
          id: row.id,
          name: row.name,
          version: row.workflowVersion,
          state: row.state,
          startedAt: iso(row.startedAt),
          code: row.code,
        })),
      };
    },
  });

  const history = defineRead({
    id: 'workflow.history',
    summary: "A run's events, oldest first, with who acted on the ones an operator wrote",
    permission: 'workflow:read',
    input: z.object({ runId: runIdField, limit: pageLimit, after: cursor }).strict(),
    output: z.object({ events: z.array(HistoryEntry), next: z.string().nullable() }).strict(),
    load: async ({ runId, limit, after }, _ctx: Record<string, never>) => {
      if ((await journal.workflows.run(db, runId)) === undefined) throw notFound(runId);
      const page = await journal.workflows.history(db, runId, {
        limit,
        ...(after === undefined ? {} : { after }),
      });
      return {
        events: page.events.map(event => {
          const by = operatorFields.safeParse(event.data);
          const data = shown(payloadMode, event.data);
          return {
            seq: event.seq,
            id: event.id,
            version: event.version,
            type: event.type,
            recordedAt: iso(event.recordedAt),
            ...(by.success && by.data.actorId !== undefined ? { actorId: by.data.actorId } : {}),
            ...(by.success && by.data.reason !== undefined ? { reason: redactSecrets(by.data.reason) } : {}),
            ...(by.success && by.data.executionId !== undefined ? { executionId: by.data.executionId } : {}),
            ...(data.text === undefined ? {} : { data: data.text }),
          };
        }),
        next: page.next,
      };
    },
  });

  // ---- retryStep ----------------------------------------------------------------------------------------------

  const retryStep = defineAction({
    id: 'workflow.retryStep',
    summary: 'Run a dead step again, restart its failed children, or retry the dead jobs of a run',
    permission: 'journal:retry',
    // A retry runs the step's side effects once more, under the same idempotency key. It never deletes data.
    risk: 'low',
    input: z
      .object({
        runId: runIdField,
        path: pathField,
        phase: z.enum(['do', 'undo']).default('do'),
        reason: optionalReason,
      })
      .strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        runId: z.string(),
        path: z.string(),
        phase: z.enum(['do', 'undo']),
        how: z.enum(['rescheduled', 'childrenRestarted', 'jobRetried']),
        /** The number of children restarted, or of dead jobs retried. 1 for a step. */
        count: z.number().int(),
        lastError: z.string().nullable(),
        consequence: z.string(),
      })
      .strict(),
    output: z.object({ runId: z.string(), how: z.enum(['rescheduled', 'childrenRestarted', 'jobRetried']) }).strict(),
    preview: async ({ runId, path, phase }, _ctx: Record<string, never>) => {
      const detail = await openRun(runId);
      const step = detail.steps.find(candidate => candidate.path === path && candidate.phase === phase);
      if (step === undefined) throw stepNotDead(runId, `Step "${path}" (${phase}) has not run`);
      const base = { revision: revisionOf(detail), runId, path, phase, lastError: errorOrNull(step.error) };
      // A step whose job died while the run was stranded: every dead job of the run goes again.
      if (step.status === 'scheduled') {
        const dead = await deadJobsOfRun(runId);
        if (dead.length === 0) {
          throw stepNotDead(runId, `Step "${path}" (${phase}) is waiting and the run has no dead job`);
        }
        if (detail.run.stranded !== null) throw stranded(runId, 'its code is not registered');
        return {
          ...base,
          revision: deadJobsRevision(detail, dead),
          how: 'jobRetried' as const,
          count: dead.length,
          consequence: `${dead.length} dead job(s) of this run go back to pending and run again. If they ran side effects before they died, those may repeat.`,
        };
      }
      if (step.status !== 'failed') throw stepNotDead(runId, `Step "${path}" (${phase}) is ${step.status}, not failed`);
      const nodes = nodesOf(detail);
      if (phase === 'do' && detail.run.state === 'compensating') throw compensating(runId);
      if (phase === 'undo' && detail.run.state !== 'compensating') {
        throw stepNotDead(runId, `The run is ${detail.run.state}, so no undo is waiting`);
      }
      const node = nodes.find(candidate => candidate.name === path);
      if (phase === 'do' && detail.run.state === 'parked' && (node?.kind === 'child' || node?.kind === 'map')) {
        const failed = failedChildren(detail.children, path);
        if (failed > 0) {
          return {
            ...base,
            how: 'childrenRestarted' as const,
            count: failed,
            consequence: `${failed} failed child run(s) of "${path}" start again under new ids. The old runs stay as history.`,
          };
        }
      }
      return {
        ...base,
        how: 'rescheduled' as const,
        count: 1,
        consequence: `Step "${path}" (${phase}) runs again as attempt ${step.attempt + 1}, with the same idempotency key. If it ran side effects before it failed, they may repeat.`,
      };
    },
    execute: async ({ runId, path, phase, reason }, _ctx: Record<string, never>, permit) => {
      const detail = await openRun(runId);
      const step = detail.steps.find(candidate => candidate.path === path && candidate.phase === phase);
      // A job's death writes no event, so the run's version alone would not see one more dead job since the preview.
      const revision =
        step?.status === 'scheduled' ? deadJobsRevision(detail, await deadJobsOfRun(runId)) : revisionOf(detail);
      if (revision !== permit.expectedRevision) throw stale(runId);
      const done = await guarded(runId, () =>
        journal.workflows.retryStep(db, { runId, path, phase }, operationOf(permit, reason)),
      );
      return { runId, how: orThrow(done).how };
    },
  });

  // ---- resolveStep --------------------------------------------------------------------------------------------

  /** The `do` step the operator names, when it is failed and the run is running: what `resolveStep` can resolve. */
  async function resolvable(runId: string, path: string, result: unknown) {
    const detail = await openRun(runId);
    if (detail.run.state === 'compensating') throw compensating(runId);
    const step = detail.steps.find(candidate => candidate.path === path && candidate.phase === 'do');
    if (step?.status !== 'failed') {
      throw stepNotDead(runId, `Step "${path}" is ${step?.status ?? 'not run yet'}, not failed`);
    }
    nodesOf(detail);
    if (detail.run.state !== 'running') {
      throw notResolvable(runId, `the run is ${detail.run.state}, and a step is resolved only while it is running`);
    }
    // The run's own version checks the result: a step that declares no output schema is refused here too.
    const checked = await guarded(runId, () => journal.workflows.checkResult(db, { runId, path, result }));
    if (!orThrow(checked).ok) throw notResolvable(runId, `the result does not match the output of "${path}"`, 400);
    return detail;
  }

  const resolveStep = defineAction({
    id: 'workflow.resolveStep',
    summary: 'Give the result of a failed step by hand, so the run carries on without running it again',
    permission: 'workflow:resolve',
    // The run goes on as if the step succeeded with this result. Nothing checks that the work really happened.
    risk: 'high',
    input: z.object({ runId: runIdField, path: pathField, result: jsonValueSchema, reason: reasonField }).strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        runId: z.string(),
        path: z.string(),
        lastError: z.string().nullable(),
        consequence: z.string(),
      })
      .strict(),
    output: z.object({ runId: z.string() }).strict(),
    preview: async ({ runId, path, result }, _ctx: Record<string, never>) => {
      const detail = await resolvable(runId, path, result);
      const step = detail.steps.find(candidate => candidate.path === path && candidate.phase === 'do');
      return {
        revision: revisionOf(detail),
        runId,
        path,
        lastError: errorOrNull(step?.error ?? null),
        consequence: `Step "${path}" counts as done with the result you gave. The run routes it and moves on. The step does not run again, so any work it should have done is not done.`,
      };
    },
    execute: async ({ runId, path, result, reason }, _ctx: Record<string, never>, permit) => {
      await assertUnchanged(runId, permit);
      return orThrow(
        await guarded(runId, () =>
          journal.workflows.resolveStep(db, { runId, path, result }, operationOf(permit, reason)),
        ),
      );
    },
  });

  // ---- skipUndo -----------------------------------------------------------------------------------------------

  const skipUndo = defineAction({
    id: 'workflow.skipUndo',
    summary: 'Give up a failed undo of a compensating run, so the run goes on undoing the rest',
    permission: 'workflow:resolve',
    // The step's work stays done and is never undone. The run lists the path as residual.
    risk: 'high',
    input: z.object({ runId: runIdField, path: pathField, reason: reasonField }).strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        runId: z.string(),
        path: z.string(),
        lastError: z.string().nullable(),
        consequence: z.string(),
      })
      .strict(),
    output: z.object({ runId: z.string() }).strict(),
    preview: async ({ runId, path }, _ctx: Record<string, never>) => {
      const detail = await openRun(runId);
      const step = detail.steps.find(candidate => candidate.path === path && candidate.phase === 'undo');
      if (detail.run.state !== 'compensating' || step?.status !== 'failed') {
        throw stepNotDead(runId, `No failed undo of "${path}" is waiting on this run`);
      }
      return {
        revision: revisionOf(detail),
        runId,
        path,
        lastError: errorOrNull(step.error),
        consequence: `The undo of "${path}" is given up. What the step did stays done and is listed as residual on the run. The run goes on with the next undo.`,
      };
    },
    execute: async ({ runId, path, reason }, _ctx: Record<string, never>, permit) => {
      await assertUnchanged(runId, permit);
      return orThrow(
        await guarded(runId, () => journal.workflows.skipUndo(db, { runId, path }, operationOf(permit, reason))),
      );
    },
  });

  // ---- cancel -------------------------------------------------------------------------------------------------

  const PlanEntry = z
    .object({
      path: z.string(),
      /** `undo`: the step's undo runs. `none`: no undo, skipped. `ownUndo`: a child node's own undo replaces undoing the child. `detached`: the child keeps its work. `compensated`: the child run undoes its own work. */
      action: z.enum(['undo', 'none', 'ownUndo', 'detached', 'compensated']),
    })
    .strict();

  const cancel = defineAction({
    id: 'workflow.cancel',
    summary: 'Stop a run and undo the steps it completed, newest first',
    permission: 'workflow:cancel',
    // The run never finishes its work, and its completed steps are undone.
    risk: 'high',
    input: z.object({ runId: runIdField, reason: reasonField }).strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        runId: z.string(),
        name: z.string(),
        /** Newest completed step first: the order the undos run in. */
        plan: z.array(PlanEntry),
        /** Children still running that the cancel stops (`cancelled`) or leaves (`detached`). */
        running: z.array(
          z
            .object({ path: z.string(), children: z.number().int(), action: z.enum(['cancelled', 'detached']) })
            .strict(),
        ),
        consequence: z.string(),
      })
      .strict(),
    output: z.object({ runId: z.string(), state: z.enum(['compensating', 'cancelled']) }).strict(),
    preview: async ({ runId }, _ctx: Record<string, never>) => {
      const detail = await openRun(runId);
      if (detail.run.state === 'compensating') throw compensating(runId);
      // The plan comes from the node manifest the run pinned at start: the same nodes its compensation follows.
      const nodes = nodesOf(detail);
      const plan: z.infer<typeof PlanEntry>[] = [];
      for (const step of detail.steps.toReversed()) {
        if (step.phase !== 'do' || step.status !== 'done') continue;
        const node = nodes.find(candidate => candidate.name === step.path);
        if (node?.kind === 'step') plan.push({ path: step.path, action: node.undo ? 'undo' : 'none' });
        if (node?.kind === 'child') {
          plan.push({
            path: step.path,
            action: node.undo ? 'ownUndo' : node.onCancel === 'detach' ? 'detached' : 'compensated',
          });
        }
      }
      const running = nodes.flatMap(node => {
        if (node.kind !== 'child' && node.kind !== 'map') return [];
        const live = detail.children.filter(child => child.parentPath === node.name && child.finishedAt === null);
        if (live.length === 0) return [];
        return [
          {
            path: node.name,
            children: live.length,
            action:
              node.kind === 'child' && node.onCancel === 'detach' ? ('detached' as const) : ('cancelled' as const),
          },
        ];
      });
      const undone = plan.filter(
        entry => entry.action === 'undo' || entry.action === 'ownUndo' || entry.action === 'compensated',
      );
      const skipped = plan.filter(entry => entry.action === 'none').map(entry => entry.path);
      const kept = plan.filter(entry => entry.action === 'detached').map(entry => entry.path);
      const parts = [
        undone.length === 0
          ? 'Nothing was completed that needs an undo, so the run ends cancelled at once.'
          : `${undone.length} step(s) will be undone, newest first: ${undone.map(entry => entry.path).join(', ')}.`,
        ...(skipped.length === 0
          ? []
          : [
              `${skipped.join(', ')} ${skipped.length === 1 ? 'has' : 'have'} no undo and ${skipped.length === 1 ? 'is' : 'are'} skipped.`,
            ]),
        ...(plan.some(entry => entry.action === 'ownUndo')
          ? [
              `${listOf(plan.filter(entry => entry.action === 'ownUndo').map(entry => entry.path))} run their own undo instead of undoing the child.`,
            ]
          : []),
        ...(plan.some(entry => entry.action === 'compensated')
          ? [
              `${listOf(plan.filter(entry => entry.action === 'compensated').map(entry => entry.path))}: the child run undoes its own work.`,
            ]
          : []),
        ...(kept.length === 0 ? [] : [`${listOf(kept)}: the child keeps its work (detached).`]),
        ...running.map(
          entry =>
            `${entry.children} running child run(s) of "${entry.path}" ${entry.action === 'detached' ? 'keep running (detached)' : 'are cancelled'}.`,
        ),
      ];
      return {
        revision: revisionOf(detail),
        runId,
        name: detail.run.name,
        plan,
        running,
        consequence: parts.join(' '),
      };
    },
    execute: async ({ runId, reason }, _ctx: Record<string, never>, permit) => {
      const detail = await assertUnchanged(runId, permit);
      if (detail.run.state === 'compensating') throw compensating(runId);
      nodesOf(detail);
      const outcome = await guarded(runId, () =>
        journal.workflows.cancel(db, { runId, reason }, operationOf(permit, reason)),
      );
      if (isFailure(outcome)) {
        if (CommandNotFound.is(outcome)) throw notFound(runId);
        // A conflict: the run moved between the check and the command. Say how it moved.
        const now = await journal.workflows.run(db, runId);
        if (now !== undefined && isOver(now)) throw finished(runId, now.run.state);
        if (now?.run.state === 'compensating') throw compensating(runId);
        throw stale(runId);
      }
      return { runId, state: outcome.state };
    },
  });

  // ---- signal -------------------------------------------------------------------------------------------------

  /** Whether the run already took this delivery: the same execution ran before and changed the run's version. */
  async function alreadyDelivered(runId: string, deliveryId: string): Promise<boolean> {
    const delivered = z.object({ deliveryId: z.literal(deliveryId) });
    let after: string | undefined;
    for (;;) {
      const page = await journal.workflows.history(db, runId, {
        limit: MAX_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      if (page.events.some(event => event.type === 'SignalReceived' && delivered.safeParse(event.data).success)) {
        return true;
      }
      if (page.next === null) return false;
      after = page.next;
    }
  }

  const signal = defineAction({
    id: 'workflow.signal',
    summary: 'Give a run a signal its sender never delivered, such as a webhook that did not come',
    permission: 'workflow:signal',
    // The run moves on as if the outside event happened. A wrong signal lets the run act on something that did not occur.
    risk: 'medium',
    input: z
      .object({ runId: runIdField, name: z.string().min(1), payload: jsonValueSchema, reason: reasonField })
      .strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        runId: z.string(),
        name: z.string(),
        /** The run waits for this signal now, so it wakes. Otherwise the signal is kept for a later wait. */
        wakesNow: z.boolean(),
        consequence: z.string(),
      })
      .strict(),
    output: z.object({ runId: z.string(), status: z.enum(['kept', 'woke', 'duplicate', 'finished']) }).strict(),
    preview: async ({ runId, name }, _ctx: Record<string, never>) => {
      const detail = await openRun(runId);
      const wait = waitOf(detail, name);
      const wakesNow = detail.run.state === 'parked' && detail.run.waitingFor === name;
      return {
        revision: revisionOf(detail),
        runId,
        name,
        wakesNow,
        consequence: `${
          wakesNow
            ? `The run waits for "${name}" now: it takes this payload and moves on from "${wait.name}".`
            : `The run is not waiting for "${name}" now. The signal is kept and the next wait for it takes it.`
        } The run's own version checks the payload when this runs; a payload it would refuse changes nothing.`,
      };
    },
    execute: async ({ runId, name, payload, reason }, _ctx: Record<string, never>, permit) => {
      const deliveryId = deliveryOf(permit);
      const current = await journal.workflows.run(db, runId);
      if (current === undefined) throw notFound(runId);
      if (isOver(current) || revisionOf(current) !== permit.expectedRevision) {
        // The same execution ran before and moved the run, or ended it: this is that delivery again, not another change.
        if (await alreadyDelivered(runId, deliveryId)) return { runId, status: 'duplicate' as const };
        if (isOver(current)) throw finished(runId, current.run.state);
        throw stale(runId);
      }
      waitOf(current, name);
      const outcome = await guarded(runId, () =>
        journal.workflows.signal(db, { runId, name, deliveryId, payload }, operationOf(permit, reason)),
      );
      if (isFailure(outcome)) {
        if (CommandNotFound.is(outcome)) throw notFound(runId);
        if (CommandInvalid.is(outcome) || CommandConflict.is(outcome)) throw badSignal(runId, outcome.data.detail);
        throw stale(runId);
      }
      return { runId, status: outcome.status };
    },
  });

  return defineModule({
    id: '@arki/journal-workflows',
    version: '1.0.0',
    reads: { runs, run, counts, strandedRuns, history },
    actions: { retryStep, signal, resolveStep, skipUndo, cancel },
  });
}
