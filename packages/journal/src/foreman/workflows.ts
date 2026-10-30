/**
 * The Foreman control-plane module for durable workflows: find a stuck run, read it, and move it under an approved
 * permit (retry a dead step, give a signal that never came, resolve a step by hand, skip a failed undo, cancel a run,
 * change its metadata or tags, move its start, replay it), and read and change the limits runs hold (pause, resume,
 * override, reset). Mirrors `journalJobsModule`: every action previews what it will do with a `revision`, and refuses
 * with E010 when the run or limit changed since. Every verb writes who did it onto the run's or limit's events.
 * Requires the optional peer `@arki/admin`.
 */
import { z } from 'zod';

import type { Permission, Permit } from '@arki/admin/module';
import type { IdGenerationFailure } from '@arki/contracts';
import type { Failure } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import {
  canonicalJson,
  defineAction,
  defineModule,
  defineRead,
  jsonValueSchema,
  moduleError,
  redactSecrets,
} from '@arki/admin/module';
import { ID_GENERATION_FAILURES } from '@arki/contracts';
import { findCause, InvalidInput, isFailure, orThrow, UnexpectedFailure } from '@arki/failure';

import type { LimitView, RootDb, TransactionSource } from '../index.js';
import type { RunDetail } from '../workflow/read.js';
import type { JournalWorkflowsModuleOptions } from './shapes.js';
import { CommandConflict, CommandInvalid, CommandNotFound, JournalError, WorkflowBusy } from '../index.js';
import { parseAge } from '../retention.js';
import { LIMIT_KEY_TTL } from '../workflow/limit-types.js';
import {
  addedTagsSchema,
  delayAgeSchema,
  metadataChangeSchema,
  runFieldsSchema,
  runOverridesSchema,
  ttlAgeSchema,
} from '../workflow/run-field-schemas.js';
import { RUN_FIELD_LIMITS } from '../workflow/run-fields.js';
import { limitNameArgsSchema, limitOverrideSchema, limitResetSchema } from '../workflow/runner.js';
import { CANCEL_STATES, RUN_STATES, SIGNAL_STATUSES, STEP_PHASES, STEP_VIEW_STATUSES } from '../workflow/states.js';
import { JOURNAL_WORKFLOWS_ERROR_CODES } from './shapes.js';

const isIdGenerationFailure = <Value>(value: Value): value is Extract<Value, IdGenerationFailure> =>
  ID_GENERATION_FAILURES.some(definition => definition.is(value));

/**
 * The permission each read and action needs, written once: one per verb (founder, 2026-10-23), so an operator can be
 * let tag runs without being let replay them or pause a limit. Every read needs `read`.
 */
export const WORKFLOW_PERMISSIONS = {
  read: 'workflow:read',
  retry: 'journal:retry',
  resolve: 'workflow:resolve',
  cancel: 'workflow:cancel',
  signal: 'workflow:signal',
  metadata: 'workflow:metadata',
  reschedule: 'workflow:reschedule',
  replay: 'workflow:replay',
  limits: 'workflow:limits',
} as const satisfies Record<string, Permission>;

/**
 * The journal refusals the newer verbs return as values: the dispatcher answers each with its own code, status and
 * data (a `WorkflowBusy` names the limit, the key and why it is busy), and records it on the receipt.
 */
const VERB_FAILURES = [
  ...ID_GENERATION_FAILURES,
  CommandNotFound,
  CommandInvalid,
  CommandConflict,
  WorkflowBusy,
  InvalidInput,
] as const;
type VerbFailure = ReturnType<(typeof VERB_FAILURES)[number]>;
const isVerbFailure = <Value>(value: Value): value is Extract<Value, VerbFailure> =>
  VERB_FAILURES.some(definition => definition.is(value));

/** A journal refusal met in a preview, as the module error the operator sees: the code and status execute returns it with. */
const refusal = (failure: Failure) =>
  moduleError(
    failure.code,
    failure.status,
    failure.message,
    failure.remediation ?? 'Read the run or limit again and preview the action again.',
  );

const MAX_PAGE = 200;

// ---- options ----------------------------------------------------------------------------------------------------

// ---- output schemas ---------------------------------------------------------------------------------------------

const RunState = z.enum(RUN_STATES);
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
    scope: z.string().nullable(),
    tags: z.array(z.string()),
    rootId: z.string().nullable(),
    /** The `def.startBatch` that started the run; null for a run started on its own. */
    batchId: z.string().nullable(),
    /** The run this one replays; null for a run that is no replay. */
    replayOf: z.string().nullable(),
    cancelledAt: timeOrNull,
    cancelReason: z.string().nullable(),
    startedAt: z.iso.datetime(),
    finishedAt: timeOrNull,
    /** When the run's first node is due, from `delay` or `reschedule`; null when it was due at once. */
    startAt: timeOrNull,
    /** When a delayed run's first node is due, while it is still ahead; null otherwise. */
    delayedUntil: timeOrNull,
    /** When a run whose first node has not started ends `expired`; null when it has no ttl. */
    ttlAt: timeOrNull,
    /** The overrides the run started with; null where each step's own setting applies. */
    maxAttempts: z.number().int().nullable(),
    stepTimeoutMs: z.number().int().nullable(),
    priority: z.number().int().nullable(),
    stuck: z.boolean(),
    stranded: StrandedCode.nullable(),
  })
  .strict();

const StepSummary = z
  .object({
    path: z.string(),
    phase: z.enum(STEP_PHASES),
    attempt: z.number().int(),
    key: z.string().nullable(),
    jobId: z.string().nullable(),
    status: z.enum(STEP_VIEW_STATUSES),
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

const LimitValues = z.object({ total: z.number().int().nullable(), perKey: z.number().int().nullable() }).strict();

/** A limit as an operator sees it: the code values, what an operator changed, what applies now, and who holds it. */
const LimitSummary = z
  .object({
    name: z.string(),
    workflows: z.array(z.string()),
    code: LimitValues,
    /** The `total` and `perKey` an operator set, which replace the code values until `reset`. */
    override: LimitValues,
    /** The `perKey` overrides of single keys that have not expired. */
    keys: z.array(z.object({ key: z.string(), perKey: z.number().int(), until: z.iso.datetime() }).strict()),
    /** The values a start is checked against now. A key override is not in it. */
    effective: LimitValues,
    paused: z.boolean(),
    running: z.number().int(),
    queued: z.number().int(),
    version: z.number().int(),
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
/** A limit as the reads and the limit actions show it: the journal's view, with plain arrays. */
const limitShown = (limit: LimitView) => ({
  ...limit,
  workflows: [...limit.workflows],
  keys: limit.keys.map(key => ({ ...key })),
});

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

const staleLimit = (name: string) =>
  moduleError(
    JOURNAL_WORKFLOWS_ERROR_CODES.staleRevision,
    409,
    `Limit "${name}" changed since the preview.`,
    'Preview the action again and approve the new revision.',
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
/**
 * The revision an approval is taken on: the run's events that moved it. A metadata or tag change (`fieldChanges`)
 * does not count, so a step that reports progress does not void an approval to act on its run.
 */
const revisionOf = (detail: RunDetail) => String(detail.run.version - detail.run.fieldChanges);
/**
 * The revision an approval to change a limit is taken on: the limit entity's version, which every operator change
 * moves. Runs that take or free a slot do not, so a busy limit does not void the approval.
 */
const revisionOfLimit = (limit: LimitView) => String(limit.version);
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

/**
 * A newer run verb's failure: a run that is gone maps to its code, a journal refusal goes back as the failure it is
 * (`VERB_FAILURES`), and any other failure is a bug that throws.
 */
function refusedRun<Value extends Failure>(runId: string, failure: Value): Extract<Value, VerbFailure> {
  if (CommandNotFound.is(failure)) throw notFound(runId);
  if (isVerbFailure(failure)) return failure;
  throw new UnexpectedFailure(failure);
}

/** Whether the run's first node has not started: it is queued, or its first step waits for its first try. */
function notStarted(detail: RunDetail): boolean {
  if (detail.run.state === 'queued') return true;
  if (detail.run.state !== 'running') return false;
  const first = detail.run.shape.nodes[0]?.name;
  const step = detail.steps.find(candidate => candidate.path === first && candidate.phase === 'do');
  return step?.status === 'scheduled' && step.attempt === 1;
}

/** `n run(s)`, or what 0 means: no run at all. */
const admits = (count: number | null) =>
  count === null ? 'no cap' : count === 0 ? 'no run' : `${count} run(s) at once`;

// ---- the module -------------------------------------------------------------------------------------------------

export function workflowsModule<
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

  /** A change of the run's revision since the preview voids the approval: an event that moved the run, not a metadata change. */
  async function assertUnchanged(runId: string, permit: Permit): Promise<RunDetail> {
    const detail = await openRun(runId);
    if (revisionOf(detail) !== permit.expectedRevision) throw stale(runId);
    return detail;
  }

  /** The limit as the journal shows it now, or the refusal for a name no registered workflow holds. */
  async function openLimit(name: string): Promise<LimitView> {
    const limit = await journal.limits.get(db, name);
    if (isFailure(limit)) throw refusal(limit);
    return limit;
  }

  /** An operator change of the limit since the preview voids the approval; runs that take or free a slot do not. */
  async function assertLimitUnchanged(name: string, permit: Permit): Promise<LimitView> {
    const limit = await openLimit(name);
    if (revisionOfLimit(limit) !== permit.expectedRevision) throw staleLimit(name);
    return limit;
  }

  // ---- reads --------------------------------------------------------------------------------------------------

  const runs = defineRead({
    id: 'workflow.runs',
    summary: 'Workflow runs, newest first, with whether each is stuck or stranded',
    permission: WORKFLOW_PERMISSIONS.read,
    input: z
      .object({
        state: RunState.optional(),
        name: z.string().min(1).optional(),
        version: z.number().int().positive().optional(),
        parentId: z.string().min(1).optional(),
        stuck: z.boolean().optional(),
        tag: z.string().min(1).optional(),
        scope: z.string().min(1).optional(),
        rootId: z.string().min(1).optional(),
        batchId: z.string().min(1).optional(),
        from: z.iso.datetime().optional(),
        to: z.iso.datetime().optional(),
        limit: pageLimit,
        after: cursor,
      })
      .strict(),
    output: z.object({ runs: z.array(RunSummary), next: z.string().nullable() }).strict(),
    load: async (
      { state, name, version, parentId, stuck, tag, scope, rootId, batchId, from, to, limit, after },
      _ctx: Record<string, never>,
    ) => {
      const page = await journal.workflows.runs(db, {
        limit,
        ...(state === undefined ? {} : { state }),
        ...(name === undefined ? {} : { name }),
        ...(version === undefined ? {} : { version }),
        ...(parentId === undefined ? {} : { parentId }),
        ...(stuck === undefined ? {} : { stuck }),
        ...(tag === undefined ? {} : { tag }),
        ...(scope === undefined ? {} : { scope }),
        ...(rootId === undefined ? {} : { rootId }),
        ...(batchId === undefined ? {} : { batchId }),
        ...(from === undefined ? {} : { from: new Date(from) }),
        ...(to === undefined ? {} : { to: new Date(to) }),
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
          scope: run.scope,
          tags: run.tags,
          rootId: run.rootId,
          batchId: run.batchId,
          replayOf: run.replayOf,
          cancelledAt: isoOrNull(run.cancelledAt),
          cancelReason: run.cancelReason === null ? null : redactSecrets(run.cancelReason),
          startedAt: iso(run.startedAt),
          finishedAt: isoOrNull(run.finishedAt),
          startAt: isoOrNull(run.startAt),
          delayedUntil: isoOrNull(run.delayedUntil),
          ttlAt: isoOrNull(run.ttlAt),
          maxAttempts: run.maxAttempts,
          stepTimeoutMs: run.stepTimeoutMs,
          priority: run.priority,
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
    permission: WORKFLOW_PERMISSIONS.read,
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
        metadata: z.string().optional(),
      })
      .strict(),
    load: async ({ runId }, _ctx: Record<string, never>) => {
      const detail = await journal.workflows.run(db, runId);
      if (detail === undefined) throw notFound(runId);
      const { run: row } = detail;
      const input = shown(payloadMode, row.input);
      const results = shown(payloadMode, row.results);
      const output = shown(payloadMode, row.output);
      // Metadata is the app's own data, like the input: shown only as the payload option allows.
      const metadata = shown(payloadMode, row.metadata);
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
          scope: row.scope,
          tags: row.tags,
          rootId: row.rootId,
          batchId: row.batchId,
          replayOf: row.replayOf,
          cancelledAt: isoOrNull(row.cancelledAt),
          cancelReason: row.cancelReason === null ? null : redactSecrets(row.cancelReason),
          startedAt: iso(row.startedAt),
          finishedAt: isoOrNull(row.finishedAt),
          startAt: isoOrNull(row.startAt),
          delayedUntil: isoOrNull(row.delayedUntil),
          ttlAt: isoOrNull(row.ttlAt),
          maxAttempts: row.maxAttempts,
          stepTimeoutMs: row.stepTimeoutMs,
          priority: row.priority,
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
        ...(metadata.text === undefined ? {} : { metadata: metadata.text }),
      };
    },
  });

  const counts = defineRead({
    id: 'workflow.counts',
    summary: 'How many runs there are per workflow name, version and state',
    permission: WORKFLOW_PERMISSIONS.read,
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
    permission: WORKFLOW_PERMISSIONS.read,
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
    permission: WORKFLOW_PERMISSIONS.read,
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
    failures: ID_GENERATION_FAILURES,
    id: 'workflow.retryStep',
    summary: 'Run a dead step again, restart its failed children, or retry the dead jobs of a run',
    permission: WORKFLOW_PERMISSIONS.retry,
    // A retry runs the step's side effects once more, under the same idempotency key. It never deletes data.
    risk: 'low',
    input: z
      .object({
        runId: runIdField,
        path: pathField,
        phase: z.enum(STEP_PHASES).default('do'),
        reason: optionalReason,
      })
      .strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        runId: z.string(),
        path: z.string(),
        phase: z.enum(STEP_PHASES),
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
      if (isFailure(done) && isIdGenerationFailure(done)) return done;
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
    failures: ID_GENERATION_FAILURES,
    id: 'workflow.resolveStep',
    summary: 'Give the result of a failed step by hand, so the run carries on without running it again',
    permission: WORKFLOW_PERMISSIONS.resolve,
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
      const outcome = await guarded(runId, () =>
        journal.workflows.resolveStep(db, { runId, path, result }, operationOf(permit, reason)),
      );
      if (isFailure(outcome) && isIdGenerationFailure(outcome)) return outcome;
      return orThrow(outcome);
    },
  });

  // ---- skipUndo -----------------------------------------------------------------------------------------------

  const skipUndo = defineAction({
    failures: ID_GENERATION_FAILURES,
    id: 'workflow.skipUndo',
    summary: 'Give up a failed undo of a compensating run, so the run goes on undoing the rest',
    permission: WORKFLOW_PERMISSIONS.resolve,
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
      const outcome = await guarded(runId, () =>
        journal.workflows.skipUndo(db, { runId, path }, operationOf(permit, reason)),
      );
      if (isFailure(outcome) && isIdGenerationFailure(outcome)) return outcome;
      return orThrow(outcome);
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
    failures: ID_GENERATION_FAILURES,
    id: 'workflow.cancel',
    summary: 'Stop a run and undo the steps it completed, newest first',
    permission: WORKFLOW_PERMISSIONS.cancel,
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
    output: z.object({ runId: z.string(), state: z.enum(CANCEL_STATES) }).strict(),
    preview: async ({ runId }, _ctx: Record<string, never>) => {
      const detail = await openRun(runId);
      if (detail.run.state === 'compensating') throw compensating(runId);
      // The plan comes from the node manifest the run pinned at start: the same nodes its compensation follows.
      const nodes = nodesOf(detail);
      const plan: z.infer<typeof PlanEntry>[] = [];
      for (const step of detail.steps.toReversed()) {
        if (step.phase !== 'do' || step.status !== 'done') continue;
        const node = nodes.find(candidate => candidate.name === step.path);
        if (node?.kind === 'step' || node?.kind === 'command') {
          plan.push({ path: step.path, action: node.undo ? 'undo' : 'none' });
        }
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
        if (isIdGenerationFailure(outcome)) return outcome;
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
    failures: ID_GENERATION_FAILURES,
    id: 'workflow.signal',
    summary: 'Give a run a signal its sender never delivered, such as a webhook that did not come',
    permission: WORKFLOW_PERMISSIONS.signal,
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
    output: z.object({ runId: z.string(), status: z.enum(SIGNAL_STATUSES) }).strict(),
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
        if (isIdGenerationFailure(outcome)) return outcome;
        if (CommandNotFound.is(outcome)) throw notFound(runId);
        if (CommandInvalid.is(outcome) || CommandConflict.is(outcome)) throw badSignal(runId, outcome.data.detail);
        throw stale(runId);
      }
      return { runId, status: outcome.status };
    },
  });

  // ---- setMetadata and addTags ---------------------------------------------------------------------------------

  /**
   * A metadata or tag change does not move the run, so it is checked against the run's revision like any action (the
   * run must still be where the operator saw it), and it never voids another approval: two metadata actions in a row
   * both apply, and a cancel approved before a tag still runs.
   */
  const setMetadata = defineAction({
    failures: VERB_FAILURES,
    id: 'workflow.setMetadata',
    summary: "Change a run's metadata: set keys, add to a number, append to a list, or remove a key",
    permission: WORKFLOW_PERMISSIONS.metadata,
    // The app's own notes on the run change. Its state, steps and jobs do not.
    risk: 'low',
    input: z.object({ runId: runIdField, change: metadataChangeSchema, reason: optionalReason }).strict(),
    previewOutput: z
      .object({ revision: z.string(), runId: z.string(), keys: z.array(z.string()), consequence: z.string() })
      .strict(),
    output: z.object({ runId: z.string(), keys: z.array(z.string()) }).strict(),
    preview: async ({ runId, change }, _ctx: Record<string, never>) => {
      const detail = await openRun(runId);
      const keys = change.kind === 'set' ? Object.keys(change.patch) : [change.key];
      // The values stay out of the preview: metadata is the app's data, shown only as the payload option allows.
      const what =
        change.kind === 'set'
          ? `${listOf(keys)} ${keys.length === 1 ? 'is' : 'are'} set; the other keys stay.`
          : change.kind === 'increment'
            ? `${change.by} is added to "${change.key}".`
            : change.kind === 'append'
              ? `A value is appended to the list "${change.key}".`
              : `"${change.key}" is removed.`;
      return {
        revision: revisionOf(detail),
        runId,
        keys,
        consequence: `${what} The run does not move, so approvals taken on it stay valid.`,
      };
    },
    execute: async ({ runId, change, reason }, _ctx: Record<string, never>, permit) => {
      await assertUnchanged(runId, permit);
      const outcome = await guarded(runId, () =>
        journal.workflows.setMetadata(db, { runId, change }, operationOf(permit, reason)),
      );
      if (isFailure(outcome)) return refusedRun(runId, outcome);
      return { runId, keys: Object.keys(outcome.metadata) };
    },
  });

  const addTags = defineAction({
    failures: VERB_FAILURES,
    id: 'workflow.addTags',
    summary: 'Add tags to a run, so it can be found by them',
    permission: WORKFLOW_PERMISSIONS.metadata,
    // A tag only labels the run. Tags are never removed, so a wrong one stays on the run.
    risk: 'low',
    input: z.object({ runId: runIdField, tags: addedTagsSchema, reason: optionalReason }).strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        runId: z.string(),
        /** The tags the run does not have yet: only these change it. */
        added: z.array(z.string()),
        consequence: z.string(),
      })
      .strict(),
    output: z.object({ runId: z.string(), tags: z.array(z.string()) }).strict(),
    preview: async ({ runId, tags }, _ctx: Record<string, never>) => {
      const detail = await openRun(runId);
      const added = [...new Set(tags)].filter(tag => !detail.run.tags.includes(tag));
      if (detail.run.tags.length + added.length > RUN_FIELD_LIMITS.tags) {
        throw refusal(
          CommandInvalid({
            detail: `run "${runId}" has ${detail.run.tags.length} tags, and a run holds at most ${RUN_FIELD_LIMITS.tags}`,
          }),
        );
      }
      return {
        revision: revisionOf(detail),
        runId,
        added,
        consequence:
          added.length === 0
            ? 'The run has every one of these tags, so nothing changes.'
            : `The run gets ${listOf(added)}. Tags are never removed. The run does not move, so approvals taken on it stay valid.`,
      };
    },
    execute: async ({ runId, tags, reason }, _ctx: Record<string, never>, permit) => {
      await assertUnchanged(runId, permit);
      const outcome = await guarded(runId, () =>
        journal.workflows.addTags(db, { runId, tags }, operationOf(permit, reason)),
      );
      if (isFailure(outcome)) return refusedRun(runId, outcome);
      return { runId, tags: [...outcome.tags] };
    },
  });

  // ---- reschedule ---------------------------------------------------------------------------------------------

  const rescheduleInput = z.union([
    z.object({ runId: runIdField, delay: delayAgeSchema, reason: reasonField }).strict(),
    z.object({ runId: runIdField, at: z.iso.datetime(), reason: reasonField }).strict(),
  ]);
  /** The new start a reschedule asks for, from now: a time in the past is now, as the verb does it. */
  const wantedStart = (input: z.output<typeof rescheduleInput>, now: Date) => {
    const wanted = 'at' in input ? new Date(input.at) : new Date(now.getTime() + parseAge(input.delay));
    return wanted.getTime() > now.getTime() ? wanted : now;
  };

  const reschedule = defineAction({
    failures: VERB_FAILURES,
    id: 'workflow.reschedule',
    summary: 'Move the start of a delayed or queued run that has not started its first step',
    permission: WORKFLOW_PERMISSIONS.reschedule,
    // The run's work happens at another time, and its ttl and deadline move with it. Nothing runs twice.
    risk: 'medium',
    input: rescheduleInput,
    previewOutput: z
      .object({
        revision: z.string(),
        runId: z.string(),
        /** When the first node is due now. */
        startAt: z.iso.datetime(),
        /** When it will be due, as of the preview: a `delay` counts from when the action runs. */
        newStartAt: z.iso.datetime(),
        consequence: z.string(),
      })
      .strict(),
    output: z.object({ runId: z.string(), startAt: z.iso.datetime() }).strict(),
    preview: async (input, _ctx: Record<string, never>) => {
      const detail = await openRun(input.runId);
      if (!notStarted(detail)) {
        throw refusal(
          CommandConflict({
            detail: `run "${input.runId}" has started (it is ${detail.run.state}); only a run whose first node has not started moves`,
          }),
        );
      }
      const newStartAt = wantedStart(input, new Date());
      const { run: row } = detail;
      return {
        revision: revisionOf(detail),
        runId: input.runId,
        startAt: iso(row.startAt ?? row.startedAt),
        newStartAt: iso(newStartAt),
        consequence: [
          `The run's first node becomes due at ${iso(newStartAt)}${'delay' in input ? ' (counted from when this runs)' : ''}.`,
          ...(row.ttlAt === null ? [] : ['Its ttl counts from the new start.']),
          ...(row.deadlineAt === null ? [] : ['Its deadline moves by as much.']),
        ].join(' '),
      };
    },
    execute: async (input, _ctx: Record<string, never>, permit) => {
      const { runId, reason } = input;
      await assertUnchanged(runId, permit);
      const when = 'at' in input ? { at: new Date(input.at) } : { delay: input.delay };
      const outcome = await guarded(runId, () =>
        journal.workflows.reschedule(db, { runId, ...when }, operationOf(permit, reason)),
      );
      if (isFailure(outcome)) return refusedRun(runId, outcome);
      return { runId, startAt: outcome.startAt };
    },
  });

  // ---- replay -------------------------------------------------------------------------------------------------

  const replay = defineAction({
    failures: VERB_FAILURES,
    id: 'workflow.replay',
    summary: "Start a run again under a new id, at the workflow's newest version, with its input or a new one",
    permission: WORKFLOW_PERMISSIONS.replay,
    // Every step of the new run runs again: what the old run did, such as a charge or an email, happens again.
    risk: 'medium',
    input: z
      .object({
        runId: runIdField,
        overrides: z
          .object({
            input: jsonValueSchema.optional(),
            ...runFieldsSchema.unwrap().shape,
            delay: delayAgeSchema.optional(),
            ttl: ttlAgeSchema.optional(),
            ...runOverridesSchema.unwrap().shape,
          })
          .strict()
          .optional(),
        reason: reasonField,
      })
      .strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        runId: z.string(),
        name: z.string(),
        /** The old run's state: a replay of an unfinished run leaves it running. */
        state: RunState,
        /** The overrides given, by name. The rest is copied from the old run. */
        overridden: z.array(z.string()),
        consequence: z.string(),
      })
      .strict(),
    output: z.object({ runId: z.string(), replayOf: z.string(), state: RunState }).strict(),
    // A finished run is replayed as well, so this reads the run without `openRun`, which refuses one.
    preview: async ({ runId, overrides }, _ctx: Record<string, never>) => {
      const detail = await journal.workflows.run(db, runId);
      if (detail === undefined) throw notFound(runId);
      const overridden = Object.keys(overrides ?? {});
      return {
        revision: revisionOf(detail),
        runId,
        name: detail.run.name,
        state: detail.run.state,
        overridden,
        consequence: [
          `A new run of ${detail.run.name} starts under a new id, at the newest registered version, with this run's input, scope, tags and metadata${overridden.length === 0 ? '' : ` except ${listOf(overridden)}`}.`,
          'Every step runs again, so their side effects happen again.',
          isOver(detail) ? 'This run stays as it ended.' : 'This run is not changed and goes on.',
          'A busy concurrency key refuses, joins or queues the new run, as the workflow says.',
        ].join(' '),
      };
    },
    execute: async ({ runId, overrides, reason }, _ctx: Record<string, never>, permit) => {
      const detail = await journal.workflows.run(db, runId);
      if (detail === undefined) throw notFound(runId);
      if (revisionOf(detail) !== permit.expectedRevision) throw stale(runId);
      const outcome = await guarded(runId, () =>
        journal.workflows.replay(
          db,
          { runId, ...(overrides === undefined ? {} : { overrides }) },
          operationOf(permit, reason),
        ),
      );
      if (isFailure(outcome)) return refusedRun(runId, outcome);
      const started = await journal.workflows.run(db, outcome.runId);
      if (started === undefined) throw notFound(outcome.runId);
      // With `onBusy: 'join'` the id is the running run's, which is no replay of this one.
      return { runId: outcome.runId, replayOf: runId, state: started.run.state };
    },
  });

  // ---- limits -------------------------------------------------------------------------------------------------

  const limitNameField = limitNameArgsSchema.unwrap().shape.name;

  const limits = defineRead({
    id: 'workflow.limits.list',
    summary: 'Every limit the registered workflows hold, with what applies now and who holds it',
    permission: WORKFLOW_PERMISSIONS.read,
    input: emptyInput,
    output: z.object({ limits: z.array(LimitSummary) }).strict(),
    load: async (_input, _ctx: Record<string, never>) => {
      const all = await journal.limits.list(db);
      return { limits: all.map(each => limitShown(each)) };
    },
  });

  const limit = defineRead({
    id: 'workflow.limits.get',
    summary: 'One limit, with its code values, the overrides, whether it is paused, and the runs it holds and queues',
    permission: WORKFLOW_PERMISSIONS.read,
    input: z.object({ name: limitNameField }).strict(),
    output: LimitSummary,
    load: async ({ name }, _ctx: Record<string, never>) => limitShown(await openLimit(name)),
  });

  const limitPreview = z.object({ revision: z.string(), limit: LimitSummary, consequence: z.string() }).strict();

  const pauseLimit = defineAction({
    failures: VERB_FAILURES,
    id: 'workflow.limits.pause',
    summary: 'Pause a limit: no new run that holds it starts until it is resumed; the running ones finish',
    permission: WORKFLOW_PERMISSIONS.limits,
    // Every workflow that holds the limit stops taking work, for every caller, until someone resumes it.
    risk: 'high',
    input: z.object({ name: limitNameField, reason: reasonField }).strict(),
    previewOutput: limitPreview,
    output: LimitSummary,
    preview: async ({ name }, _ctx: Record<string, never>) => {
      const now = await openLimit(name);
      return {
        revision: revisionOfLimit(now),
        limit: limitShown(now),
        consequence: now.paused
          ? `"${name}" is paused already, so nothing changes.`
          : `New starts of ${listOf(now.workflows)} are refused (paused), or queued where the workflow queues. The ${now.running} running run(s) go on to their end.`,
      };
    },
    execute: async ({ name, reason }, _ctx: Record<string, never>, permit) => {
      await assertLimitUnchanged(name, permit);
      const done = await journal.limits.pause(db, { name }, operationOf(permit, reason));
      if (isFailure(done) && isVerbFailure(done)) return done;
      return limitShown(orThrow(done));
    },
  });

  const resumeLimit = defineAction({
    failures: VERB_FAILURES,
    id: 'workflow.limits.resume',
    summary: 'Resume a paused limit: runs start again by its values, and the queued ones that fit start now',
    permission: WORKFLOW_PERMISSIONS.limits,
    // Work held back by the pause starts at once, all of it that fits.
    risk: 'high',
    input: z.object({ name: limitNameField, reason: reasonField }).strict(),
    previewOutput: limitPreview,
    output: LimitSummary,
    preview: async ({ name }, _ctx: Record<string, never>) => {
      const now = await openLimit(name);
      return {
        revision: revisionOfLimit(now),
        limit: limitShown(now),
        consequence: now.paused
          ? `New starts of ${listOf(now.workflows)} are admitted again. Of the ${now.queued} queued run(s), those that fit start now.`
          : `"${name}" is not paused, so nothing changes.`,
      };
    },
    execute: async ({ name, reason }, _ctx: Record<string, never>, permit) => {
      await assertLimitUnchanged(name, permit);
      const done = await journal.limits.resume(db, { name }, operationOf(permit, reason));
      if (isFailure(done) && isVerbFailure(done)) return done;
      return limitShown(orThrow(done));
    },
  });

  // The fields as the verb's own schema checks them, so the bounds (a ttl of at most 30 days) are written once.
  const keyOverrideShape = limitOverrideSchema.options[0].unwrap().shape;
  const valuesOverrideShape = limitOverrideSchema.options[1].unwrap().shape;
  const overrideInput = z.union([
    z
      .object({
        name: limitNameField,
        key: keyOverrideShape.key,
        perKey: keyOverrideShape.perKey,
        ttl: keyOverrideShape.ttl,
        reason: reasonField,
      })
      .strict(),
    z
      .object({
        name: limitNameField,
        total: valuesOverrideShape.total,
        perKey: valuesOverrideShape.perKey,
        reason: reasonField,
      })
      .strict()
      .refine(args => args.total !== undefined || args.perKey !== undefined, {
        message: 'an override needs total, perKey or both',
      }),
  ]);
  const overrideLimit = defineAction({
    failures: VERB_FAILURES,
    id: 'workflow.limits.override',
    summary: 'Replace a limit’s total or perKey until reset, or the perKey of one key for a while',
    permission: WORKFLOW_PERMISSIONS.limits,
    // A higher value lets more work run at once against whatever the limit protects; 0 stops new work.
    risk: 'high',
    input: overrideInput,
    previewOutput: limitPreview,
    output: LimitSummary,
    preview: async (input, _ctx: Record<string, never>) => {
      const now = await openLimit(input.name);
      // A workflow's own limit without `concurrency` caps nothing: only a pause applies to it.
      if (now.code.total === null && now.code.perKey === null) {
        throw refusal(
          CommandInvalid({
            detail: `"${input.name}" has no total or perKey in code, so only pause and resume apply to it`,
          }),
        );
      }
      const consequence =
        'key' in input
          ? `Key "${input.key}" admits ${admits(input.perKey)} for ${input.ttl ?? LIMIT_KEY_TTL.default}, instead of ${admits(now.effective.perKey)}.`
          : [
              ...(input.total === undefined
                ? []
                : [`In all, "${input.name}" admits ${admits(input.total)} (now ${admits(now.effective.total)}).`]),
              ...(input.perKey === undefined
                ? []
                : [`Per key it admits ${admits(input.perKey)} (now ${admits(now.effective.perKey)}).`]),
              'This lasts until reset.',
            ].join(' ');
      return {
        revision: revisionOfLimit(now),
        limit: limitShown(now),
        consequence: `${consequence} Queued runs that fit then start now; running runs over the new value finish.`,
      };
    },
    execute: async (input, _ctx: Record<string, never>, permit) => {
      await assertLimitUnchanged(input.name, permit);
      const args =
        'key' in input
          ? { name: input.name, key: input.key, perKey: input.perKey, ttl: input.ttl }
          : { name: input.name, total: input.total, perKey: input.perKey };
      const done = await journal.limits.override(db, args, operationOf(permit, input.reason));
      if (isFailure(done) && isVerbFailure(done)) return done;
      return limitShown(orThrow(done));
    },
  });

  const resetLimit = defineAction({
    failures: VERB_FAILURES,
    id: 'workflow.limits.reset',
    summary: 'Drop the overrides of a limit, or of one key, so the code values apply again. A pause stays',
    permission: WORKFLOW_PERMISSIONS.limits,
    // The limit goes back to the code values at once: lower or higher than what ran during the incident.
    risk: 'high',
    input: z.object({ name: limitNameField, key: limitResetSchema.unwrap().shape.key, reason: reasonField }).strict(),
    previewOutput: limitPreview,
    output: LimitSummary,
    preview: async ({ name, key }, _ctx: Record<string, never>) => {
      const now = await openLimit(name);
      const overridden = now.override.total !== null || now.override.perKey !== null || now.keys.length > 0;
      const consequence =
        key === undefined
          ? overridden
            ? `Every override of "${name}" is dropped: in all it admits ${admits(now.code.total)}, per key ${admits(now.code.perKey)}, as the code says. ${now.paused ? 'It stays paused.' : ''}`.trim()
            : `"${name}" has no override, so nothing changes.`
          : now.keys.some(held => held.key === key)
            ? `The override of key "${key}" is dropped: it admits ${admits(now.effective.perKey)} again.`
            : `Key "${key}" has no override, so nothing changes.`;
      return { revision: revisionOfLimit(now), limit: limitShown(now), consequence };
    },
    execute: async ({ name, key, reason }, _ctx: Record<string, never>, permit) => {
      await assertLimitUnchanged(name, permit);
      const done = await journal.limits.reset(db, { name, key }, operationOf(permit, reason));
      if (isFailure(done) && isVerbFailure(done)) return done;
      return limitShown(orThrow(done));
    },
  });

  return defineModule({
    id: '@arki/journal-workflows',
    version: '1.0.0',
    reads: { runs, run, counts, strandedRuns, history, limits, limit },
    actions: {
      retryStep,
      signal,
      resolveStep,
      skipUndo,
      cancel,
      setMetadata,
      addTags,
      reschedule,
      replay,
      pauseLimit,
      resumeLimit,
      overrideLimit,
      resetLimit,
    },
  });
}
