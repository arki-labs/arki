/**
 * The runner core: how a run starts, how one node runs as a journal effect job, and the checkpoint
 * that moves the run on.
 *
 *   start (command)  -> RunStarted + NodeScheduled(first)          one transaction
 *   workflow.step    -> one job per node attempt, `run_id` set      runs the body under the lease
 *   checkpoint (cmd) -> NodeCompleted | NodeSkipped | NodeFailed    through the fence of `ctx.run`,
 *                       + NodeScheduled(next) | RunCompleted         so a stale owner commits nothing
 *
 * A step is at-least-once: a crash after the body and before the checkpoint runs the body again with
 * the same `ctx.key`. The checkpoint itself commits at most once per node attempt. A command node is
 * exactly-once: its command runs in a savepoint of the transaction that holds the checkpoint, so both commit or
 * neither does.
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AsyncSchemaFailure, Failure } from '@arki/failure';
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { Deadline } from '@arki/async';
import { TransactionDefect } from '@arki/db/contract';
import {
  defineFailure,
  InvalidInput,
  isAsyncSchemaFailure,
  isFailure,
  isSchemaFailure,
  orThrow,
  revive,
  serialize,
  UnexpectedDefect,
  ValidatorDefect,
} from '@arki/failure';
import { ensure, is, parseAsync } from '@arki/schema';

import type { CommandContext, JournalDefinitions, LimitOps, RootCommandRunner, WorkflowCommandRunner } from '../api.js';
import type { CommandFailure } from '../errors.js';
import type { createEventDecoder } from '../history.js';
import type { OwnedEffectContext } from '../internal-context.js';
import type { JournalTables, StoredEventRow } from '../pg.js';
import type { JobRetention, ResolvedRetention, RetentionAge } from '../retention.js';
import type {
  AnyEntity,
  AnyEventDef,
  DbHandle,
  Needed,
  Needs,
  Recorded,
  RecordedOf,
  RootDb,
  Services,
  StepHookContext,
  TransactionSource,
} from '../types.js';
import type { EventStart } from '../write.js';
import type {
  AnyResults,
  AnySignals,
  ErasedContext,
  ErasedStartOn,
  RunEnding,
  WorkflowDef,
  WorkflowNode,
} from './define.js';
import type { HeldLimit, KnownLimit, LimitBlock, LimitView } from './limit-types.js';
import type { PromoteSkip } from './limits.js';
import type { RunDetail } from './read.js';
import type { MetadataChange, MetadataOutcome, RunFields, RunOverrides, RunTiming, TagsOutcome } from './run-fields.js';
import type {
  CancelArgs,
  CancelOutcome,
  CancelSchema,
  ReadOutcome,
  RescheduleOutcome,
  SignalOutcome,
  SignalSchema,
  StartArgs,
  StartBatchOutcome,
  StartBatchSchema,
  StartOutcome,
  StartSchema,
} from './run-types.js';
import type { RUN_STATES, SignalStatus, StepPhase } from './states.js';
import { callbackDefect } from '../callback.js';
import { debugWorkflow } from '../debug.js';
import {
  CommandConflict,
  CommandInvalid,
  CommandNotFound,
  isJournalError,
  JournalError,
  WorkflowBusy,
  WorkflowReadMismatch,
  WorkflowTransitionLimit,
} from '../errors.js';
import { givenServices, ownedEffectFor } from '../handlers.js';
import { createHookPoint } from '../hooks.js';
import { workflowBatchId, workflowRunId, workflowSignalId } from '../id.js';
import { unwatchedRun } from '../internal-context.js';
import { createManagedJobOps } from '../outbox.js';
import { parseAge, resolveRetention, runKeepFor, runKeepUntil } from '../retention.js';
import { isPlainObject, sameValue } from '../storage.js';
import { withJournalSpan } from '../telemetry.js';
import { defaultEffectRetry } from '../worker.js';
import { storedEventRowSchema } from '../zod.js';
import { isCheckedRead, resultSchemaOf, taskOf, workflowWith } from './define.js';
import { LIMIT_BOUNDS, LIMIT_KEY_TTL, workflowLimitName } from './limit-types.js';
import { createLimitGate, expiredKeys, limitLockId, limitMachine, lockExclusive } from './limits.js';
import { workflowMachine } from './machine.js';
import { createWorkflowReads } from './read.js';
import {
  addedTagsSchema,
  delayAgeSchema,
  metadataChangeSchema,
  runFieldsSchema,
  runOverridesSchema,
  runTimingSchema,
  storedWaitResultSchema,
  ttlAgeSchema,
  waitPointerSchema,
} from './run-field-schemas.js';
import { BATCH_LIMIT, changedMetadata, metadataRefusal, newTags, RUN_FIELD_LIMITS } from './run-fields.js';
import { STEP_PHASES } from './states.js';
import { codeOf, isStrandedError, strandedFailure } from './stranded.js';
import { withWaitEvents } from './wait-results.js';

/** The library-owned effect that runs one node attempt. */
export const STEP_EFFECT = 'workflow.step';
/** The library-owned effect that fires a park's wake time, a run's deadline and a queued run's ttl. */
export const TIMER_EFFECT = 'workflow.timer';
/** The library-owned effect that looks at a limit's queued runs again when a key's `perKey` override runs out. */
export const LIMIT_TIMER_EFFECT = 'workflow.limitTimer';
/** The library-owned effects that start a run from a journal event (`startOn`): `workflow.start:<workflow name>`. */
export const START_EFFECT = 'workflow.start';
/** The library-owned effect that runs a definition's lifecycle hooks (`on`) when a run ends. */
export const LIFECYCLE_EFFECT = 'workflow.on';
/** The library-owned effects that wake event waits: `workflow.wake:<entity kind>`. Mounted for each entity a wait watches. */
export const WAKE_EFFECT = 'workflow.wake';
/** The actor on the job operation rows the runner writes, such as the timer it cancels when a signal wins. */
const WORKFLOW_ACTOR = 'system:workflow';
/** The command that finds the runs parked on an event, under the key's lock. Internal: only the wake effect runs it. */
const WAITERS_COMMAND = 'workflow.waiters';
/** The command that wakes one parked run on an event. Internal: only the wake effect runs it. */
const WAKE_COMMAND = 'workflow.wake';
/** The command that moves a run on after a node attempt. Internal: only the step effect runs it. */
const CHECKPOINT_COMMAND = 'workflow.checkpoint';
/** The command that runs one attempt of a command node, and moves the run on in the same transaction. Internal. */
const COMMAND_NODE_COMMAND = 'workflow.commandNode';
/** The savepoint inside it, around a node's command and all that must hold for its result. Internal. */
const COMMAND_SAVEPOINT_COMMAND = 'workflow.commandSavepoint';
const commandNodeSchema = z.object({
  runId: z.string().min(1),
  path: z.string().min(1),
  phase: z.enum(STEP_PHASES),
  attempt: z.int().positive(),
  key: z.string().min(1),
});
/** The command the limit timer runs to start the queued runs that fit once a key override ran out. Internal. */
const PROMOTE_COMMAND = 'workflow.promoteQueued';
const promoteSchema = z.object({ name: z.string().min(1) });
/** The command a parent's checkpoint runs to start one child run. Internal. */
const START_CHILD_COMMAND = 'workflow.startChild';
const startChildSchema = z.object({
  def: z.object({ name: z.string().min(1), version: z.int().positive() }),
  id: z.string().min(1),
  input: z.unknown(),
  parent: z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    rootId: z.string().min(1),
    scope: z.string().min(1).nullable(),
  }),
});

/** The operator verbs. Internal: `journal.workflows` runs them. */
const RETRY_STEP_COMMAND = 'workflow.retryStep';
const RESOLVE_STEP_COMMAND = 'workflow.resolveStep';
const SKIP_UNDO_COMMAND = 'workflow.skipUndo';
const SIGNAL_COMMAND = 'workflow.signal';
const CANCEL_COMMAND = 'workflow.cancel';
const SET_METADATA_COMMAND = 'workflow.setMetadata';
const ADD_TAGS_COMMAND = 'workflow.addTags';
const RESCHEDULE_COMMAND = 'workflow.reschedule';
const REPLAY_COMMAND = 'workflow.replay';
/** The limit verbs. Internal: `journal.limits` runs them. */
const LIMIT_OVERRIDE_COMMAND = 'limit.override';
const LIMIT_RESET_COMMAND = 'limit.reset';
const LIMIT_PAUSE_COMMAND = 'limit.pause';
const LIMIT_RESUME_COMMAND = 'limit.resume';
/** The same changes, made by a step or undo body through `ctx.metadata` and `ctx.tags`. Internal. */
const STEP_METADATA_COMMAND = 'workflow.stepMetadata';
const STEP_TAGS_COMMAND = 'workflow.stepTags';
/** Who asked, why, and from which Foreman execution: the `op` of every operator verb, as the job verbs take it. */
export const operationSchema = z
  .object({
    actor: z.string(),
    reason: z.string().optional(),
    executionId: z.string().optional(),
  })
  .readonly();
type OperationInput = z.infer<typeof operationSchema>;
/** The node a job's event names: `path` on a step, `node` on a park, neither on the deadline. */
const jobNodeSchema = z
  .object({ path: z.string().optional(), node: z.string().optional() })
  .transform(data => data.path ?? data.node ?? null);
const nodeVerbSchema = z.object({ runId: z.string().min(1), path: z.string().min(1), op: operationSchema });
export const retryStepSchema = nodeVerbSchema.extend({ phase: z.enum(STEP_PHASES) }).readonly();
export const resolveStepSchema = nodeVerbSchema.extend({ result: z.unknown() }).readonly();
export const skipUndoSchema = nodeVerbSchema.readonly();
/** The operator's signal: the payload is unknown here and checked by the run's own version. */
export const operatorSignalSchema = z
  .object({
    runId: z.string().min(1),
    name: z.string().min(1),
    deliveryId: z.string().min(1),
    payload: z.unknown(),
    op: operationSchema,
  })
  .readonly();
export const operatorCancelSchema = z
  .object({ runId: z.string().min(1), reason: z.string().min(1), op: operationSchema })
  .readonly();
const stepMetadataSchema = z.object({ runId: z.string().min(1), change: metadataChangeSchema });
const stepTagsSchema = z.object({ runId: z.string().min(1), tags: addedTagsSchema });
export const setMetadataSchema = stepMetadataSchema.extend({ op: operationSchema }).readonly();
export const addTagsSchema = stepTagsSchema.extend({ op: operationSchema }).readonly();
/** `reschedule` takes the new start as a wait from now (`delay`) or a time (`at`), never both. */
export const rescheduleSchema = z.union([
  z.strictObject({ runId: z.string().min(1), delay: delayAgeSchema, op: operationSchema }).readonly(),
  z.strictObject({ runId: z.string().min(1), at: z.date(), op: operationSchema }).readonly(),
]);
/** A limit name as the verbs take it: a `j.limit` name or `workflow/<name>`, as long as the `journal_limits` key. */
const limitNameSchema = z.string().min(1).max(256);
const limitKeySchema = z.string().min(1).max(256);
const limitCountSchema = z.int().nonnegative();
/**
 * `journal.limits.override`: the `perKey` of one key for a `ttl` up to `LIMIT_KEY_TTL.max`, or the limit's own
 * `total` and `perKey`, at least one. The type is the source (`LimitOverrideArgs`); `schemas.test-d.ts` locks this
 * schema to it both ways.
 */
export const limitOverrideSchema = z.union([
  z
    .strictObject({
      name: limitNameSchema,
      key: limitKeySchema,
      perKey: limitCountSchema,
      ttl: ttlAgeSchema
        .refine(age => parseAge(age) <= parseAge(LIMIT_KEY_TTL.max), {
          message: `a key override lasts at most ${LIMIT_KEY_TTL.max}`,
        })
        .optional(),
      op: operationSchema,
    })
    .readonly(),
  z
    .strictObject({
      name: limitNameSchema,
      total: limitCountSchema.optional(),
      perKey: limitCountSchema.optional(),
      op: operationSchema,
    })
    .refine(args => args.total !== undefined || args.perKey !== undefined, {
      message: 'an override needs total, perKey or both',
    })
    .readonly(),
]);
export const limitResetSchema = z
  .object({ name: limitNameSchema, key: limitKeySchema.optional(), op: operationSchema })
  .readonly();
export const limitNameArgsSchema = z.object({ name: limitNameSchema, op: operationSchema }).readonly();
/** Checks `ReplayArgs` plus the operation. The type is the source; `schemas.test-d.ts` locks this schema to it both ways. */
export const replaySchema = z
  .object({
    runId: z.string().min(1),
    overrides: z
      .object({
        input: z.unknown().optional(),
        ...runFieldsSchema.unwrap().shape,
        ...runTimingSchema.unwrap().shape,
        ...runOverridesSchema.unwrap().shape,
      })
      .readonly()
      .optional(),
    op: operationSchema,
  })
  .readonly();
/**
 * One item of `def.startBatch`, already checked by the batch's schema: the input as the workflow's schema gave it, and
 * the run fields, timing and overrides checked again by their own schemas. Internal.
 */
const batchItemSchema = z.object({
  batchId: z.string().min(1),
  item: z.object({ input: z.unknown(), id: z.string().min(1).optional() }),
  fields: runFieldsSchema,
  timing: runTimingSchema,
  overrides: runOverridesSchema,
});
/** The shape of `def.startBatch`'s arguments, before each item is checked by the workflow's start schema. */
const batchShapeSchema = z.object({
  items: z.array(z.unknown()).min(1).max(BATCH_LIMIT),
  batchId: z.string().min(1).max(256).optional(),
});
/** The text before a retried child's `~n`: `run/fan[2]~3` came from `run/fan[2]`. */
const RETRIED_CHILD = /^(.*)~(\d+)$/;

const assertOperator = (op: OperationInput) => {
  if (op.actor.trim() === '') {
    throw new JournalError(
      'BAD_ARGUMENT',
      'workflow',
      'actor',
      'every operation names who did it; `actor` must not be empty',
    );
  }
};
/** The fields an event written for an operator carries. */
const operatorOf = (op: OperationInput) => ({
  actorId: op.actor,
  ...(op.reason === undefined ? {} : { reason: op.reason }),
  ...(op.executionId === undefined ? {} : { executionId: op.executionId }),
});
/** The same operator, as the job verbs take it. */
const jobOperatorOf = (op: OperationInput) => ({
  actor: op.actor,
  ...(op.reason === undefined ? {} : { reason: op.reason }),
  ...(op.executionId === undefined ? {} : { executionId: op.executionId }),
});
/** The id a failed child run is started again under: the old id with `~2`, then `~3`. A repeat of the same retry computes the same id. */
const retriedChildId = (runId: string, id: string) => {
  const was = RETRIED_CHILD.exec(id);
  const next = `${was?.[1] ?? id}~${Number(was?.[2] ?? 1) + 1}`;
  if (next.length > MAX_RUN_ID_LENGTH) {
    throw new JournalError(
      'WORKFLOW_LIMIT',
      'workflow',
      runId,
      `the child run id "${next}" is longer than ${MAX_RUN_ID_LENGTH} characters`,
    );
  }
  return next;
};

/** What a step's last attempt returns to the worker when the step is dead: the job dies at once and an operator can revive it.
 * @fix Inspect the dead step and its private failure, repair the cause, then retry or resolve the step through workflow operations.
 * @verify bun run test -- src/workflow/runner.test.ts
 */
const StepDead = defineFailure('journal.workflow.step_dead', {
  status: 500,
  data: z.object({ detail: z.string() }),
  message: '{detail}',
  remediation: 'Inspect the workflow checkpoint, repair the cause, then retry or resolve the step.',
});

function startSchema<Input extends StandardSchemaV1>(input: Input): StartSchema<Input> {
  return {
    '~standard': {
      version: 1,
      vendor: 'arki',
      validate: async value => {
        if (!isPlainObject(value)) {
          return {
            issues: [
              {
                message:
                  'start takes { input, id?, scope?, tags?, metadata?, delay?, ttl?, maxAttempts?, timeout?, priority? }',
              },
            ],
          };
        }
        const { id } = value;
        if (id !== undefined && (typeof id !== 'string' || id === '')) {
          return { issues: [{ message: 'id must be a non-empty string', path: ['id'] }] };
        }
        const parsed = await parseAsync<SchemaOutput<Input>>(input, value.input);
        if (InvalidInput.is(parsed)) {
          return { issues: parsed.data.issues.map(issue => ({ ...issue, path: ['input', ...(issue.path ?? [])] })) };
        }
        // Standard Schema's validate callback is an exception-based foreign contract.
        if (ValidatorDefect.is(parsed)) orThrow(parsed);
        const fields = await parseAsync(runFieldsSchema, {
          scope: value.scope,
          tags: value.tags,
          metadata: value.metadata,
        });
        if (InvalidInput.is(fields)) return { issues: fields.data.issues };
        if (ValidatorDefect.is(fields)) orThrow(fields);
        const timing = await parseAsync(runTimingSchema, { delay: value.delay, ttl: value.ttl });
        if (InvalidInput.is(timing)) return { issues: timing.data.issues };
        if (ValidatorDefect.is(timing)) orThrow(timing);
        const overrides = await parseAsync(runOverridesSchema, {
          maxAttempts: value.maxAttempts,
          timeout: value.timeout,
          priority: value.priority,
        });
        if (InvalidInput.is(overrides)) return { issues: overrides.data.issues };
        if (ValidatorDefect.is(overrides)) orThrow(overrides);
        const args = { input: parsed, ...fields, ...timing, ...overrides };
        return { value: id === undefined ? args : { ...args, id } };
      },
    },
  };
}

function startBatchSchema<Input extends StandardSchemaV1>(input: Input): StartBatchSchema<Input> {
  const itemSchema = startSchema(input);
  return {
    '~standard': {
      version: 1,
      vendor: 'arki',
      validate: async value => {
        const shape = await parseAsync(batchShapeSchema, value);
        if (InvalidInput.is(shape)) return { issues: shape.data.issues };
        // Standard Schema's validate callback is an exception-based foreign contract.
        if (ValidatorDefect.is(shape)) return orThrow(shape);
        const items: StartArgs<SchemaOutput<Input>>[] = [];
        for (const [index, entry] of shape.items.entries()) {
          const item = await itemSchema['~standard'].validate(entry);
          if (item.issues !== undefined) {
            return { issues: item.issues.map(issue => ({ ...issue, path: ['items', index, ...(issue.path ?? [])] })) };
          }
          items.push(item.value);
        }
        return { value: shape.batchId === undefined ? { items } : { items, batchId: shape.batchId } };
      },
    },
  };
}

/** Checks `CancelArgs`. The type is the source; `schemas.test-d.ts` locks this schema to it both ways. */
export const cancelArgsSchema = z
  .object({
    runId: z.string().min(1),
    reason: z.string().min(1),
    executionId: z.string().min(1).optional(),
  })
  .readonly();
/** `cancelArgsSchema` with the type `def.cancel` shows: a Standard Schema, not zod's own. */
const cancelSchema: CancelSchema = cancelArgsSchema;

const isoTime = z.iso.datetime();
/** Where a run goes after a node: to another node, or to its end with the output already worked out. */
const routeSchema = z.discriminatedUnion('go', [
  z.object({ go: z.literal('node'), name: z.string().min(1) }),
  z.object({ go: z.literal('finish'), output: z.unknown(), keepUntil: isoTime.nullable() }),
]);
type Route = z.infer<typeof routeSchema>;
/** The child runs of one visit of a child or map node. */
const waitKeySchema = z.object({
  label: z.string().min(1),
  entityKind: z.string().min(1),
  entityId: z.string().min(1),
  types: z.array(z.string().min(1)).min(1),
});
type WaitKey = z.infer<typeof waitKeySchema>;
const childrenPlanSchema = z.object({
  /** The node path, with the visit of a loop appended (`fan`, `fan:2`): the `parentPath` of every child. */
  base: z.string().min(1),
  def: z.object({ name: z.string().min(1), version: z.int().positive() }),
  children: z.array(z.object({ id: z.string().min(1), input: z.unknown() })).min(1),
});
type ChildrenPlan = z.infer<typeof childrenPlanSchema>;
const nodeCheckpointSchema = z.object({
  runId: z.string().min(1),
  path: z.string().min(1),
  phase: z.enum(STEP_PHASES),
  /** The attempt of the node this checkpoint answers. A checkpoint for any other attempt is stale. */
  attempt: z.int().positive(),
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('completed'),
      result: z.unknown(),
      route: routeSchema,
      /** Set when an operator gave the result (`resolveStep`): the worker only routed it. */
      by: z
        .object({ actorId: z.string(), reason: z.string().optional(), executionId: z.string().optional() })
        .optional(),
    }),
    z.object({ kind: z.literal('skipped'), reason: z.string().min(1), route: routeSchema }),
    /** The attempt failed and the step retries: the same key, the next attempt, due at `at`. */
    z.object({ kind: z.literal('retry'), error: z.string().min(1), key: z.string().min(1), at: isoTime }),
    /** The attempt failed and the step is out of retries: it waits for an operator, or the run compensates (`onDeadStep`). */
    z.object({ kind: z.literal('dead'), error: z.string().min(1) }),
    /** An undo ran. */
    z.object({ kind: z.literal('undone'), result: z.unknown() }),
    /** A `waitFor` or `sleep` node has nothing to run: the run parks until the signal or `wakeAt`. */
    z.object({
      kind: z.literal('park'),
      waitingFor: z.string().min(1).nullable(),
      wakeAt: isoTime.nullable(),
      /** An event wait's keys, worked out once per visit. The checkpoint locks each one before it reads the log. */
      waits: z.array(waitKeySchema).optional(),
    }),
    /** A `child` or `map` node worked out its child runs (ids and checked inputs): the run parks and starts them. */
    z.object({ kind: z.literal('children'), plan: childrenPlanSchema }),
    /** The first node's first try found the run's `ttl` passed: the run ends `expired` if the database agrees. */
    z.object({ kind: z.literal('expired') }),
    /** A command node found the run compensating before its command ran: the node is dropped, and the undos go on. */
    z.object({ kind: z.literal('dropped') }),
    /** The node was about to make more transitions than `limits.transitions`: the run compensates, then fails with `error`. */
    z.object({ kind: z.literal('transition-limit'), error: z.string().min(1) }),
  ]),
});
/** A timer job fired: the wake time of a park, or the deadline of the run. */
const timerCheckpointSchema = z.object({
  runId: z.string().min(1),
  fired: z.discriminatedUnion('kind', [
    /** `parkSeq`: the seq of the `Parked` event that made this timer. A later park of the same node is another wait. */
    z.object({ kind: z.literal('wake'), node: z.string().min(1), parkSeq: z.int().positive() }),
    z.object({ kind: z.literal('deadline') }),
    /** The `ttl` of a queued run: it ends `expired` if it is still queued and its `ttl_at` has passed. */
    z.object({ kind: z.literal('ttl') }),
  ]),
});
const checkpointSchema = z.union([nodeCheckpointSchema, timerCheckpointSchema]);

/** The arguments of `def.signal(name)`. `deliveryId` is the sender's own id: a repeat of it changes nothing. */
export const signalEnvelope = z
  .object({
    runId: z.string().min(1),
    deliveryId: z.string().min(1),
    payload: z.unknown(),
  })
  .readonly();
/** Checks `runId` and `deliveryId` and passes the payload on: the command's handler checks it with the node's schema. */
function signalSchemaFor<Payload extends StandardSchemaV1>(): SignalSchema<Payload> {
  return {
    '~standard': { version: 1, vendor: 'arki', validate: value => signalEnvelope['~standard'].validate(value) },
  };
}

/** The arguments of the two commands of the wake effect. */
const waitersSchema = z.object({
  entityKind: z.string().min(1),
  entityId: z.string().min(1),
  type: z.string().min(1),
  seq: z.int().positive(),
});
const wakeWaitSchema = z.object({ runId: z.string().min(1), node: z.string().min(1) });
/** What the wait rules read of a `WaitEventTaken` event. */
const takenEventSchema = z.object({ node: z.string().min(1), seq: z.int().positive() });
type TakenEvent = z.infer<typeof takenEventSchema>;
/** What a wait reads of `RunStarted`: the event that started the run, when one did. */
const triggerSchema = z.object({ triggerSeq: z.int().positive().optional() });
/** The lock of one correlation key. Park and wake both take it, so whichever commits second sees the other. */
const waitLockId = (entityKind: string, entityId: string) => `workflow-wait:${entityKind}:${entityId}`;
/** How many log rows a wait reads at a time, while `where` keeps refusing what it finds. */
const WAIT_READ_BATCH = 100;

type Verdict =
  | {
      readonly kind: 'park';
      readonly waitingFor: string | null;
      readonly wakeAt: string | null;
      readonly waits?: WaitKey[];
    }
  | { readonly kind: 'skipped'; readonly reason: string; readonly route: Route }
  | {
      readonly kind: 'completed';
      readonly result: unknown;
      readonly route: Route;
      readonly by?: { readonly actorId: string; readonly reason?: string; readonly executionId?: string };
    }
  | { readonly kind: 'undone'; readonly result: unknown }
  | { readonly kind: 'children'; readonly plan: ChildrenPlan }
  | { readonly kind: 'dropped' }
  | FailedVerdict;
type FailedVerdict = {
  readonly kind: 'failed';
  /** What the step's error stores: a throw as its `UnexpectedDefect`. */
  readonly reason: unknown;
  /** What the retry judges: the error the step threw, as is, or the failure it returned. */
  readonly retryReason: unknown;
  readonly retryable: boolean;
};

const failed = (reason: unknown, retryable = true): FailedVerdict => ({
  kind: 'failed',
  reason: isFailure(reason) || isJournalError(reason) ? reason : callbackDefect(reason),
  retryReason: reason,
  retryable,
});

/**
 * A command node's failure, as the attempt judges it. A command that threw comes back as `TransactionDefect`: it is
 * judged as the throw it was, so it is retried. A failure the command returned is final, like a step's.
 */
function commandFailed(outcome: Failure): FailedVerdict {
  if (!TransactionDefect.is(outcome)) return failed(outcome);
  let thrown: unknown = outcome;
  while (isFailure<unknown>(thrown) && thrown.cause !== undefined) thrown = thrown.cause;
  return failed(thrown, !isJournalError(thrown, 'BAD_DEFINITION'));
}

/** What a failed attempt turns into: the next attempt with the same key, or a dead step. */
function failureOutcome(
  node: WorkflowNode,
  maxAttempts: number | null,
  verdict: FailedVerdict,
  attempt: number,
  key: string,
) {
  const error = reasonText(verdict.reason);
  const own = (node.kind === 'step' || node.kind === 'command' ? node.options.retry : undefined) ?? defaultEffectRetry;
  // A run's `maxAttempts` only narrows the step's retry: `upTo` counts retries, and the first try is not one.
  const policy = maxAttempts === null ? own : own.upTo(maxAttempts - 1);
  const wait = verdict.retryable ? policy.delay(attempt, verdict.retryReason) : undefined;
  return wait === undefined
    ? ({ kind: 'dead', error } as const)
    : ({ kind: 'retry', error, key, at: inMs(wait) } as const);
}

/**
 * How a command node stores an accepted failure. The key says it is one, so a success can never be read as a failure
 * and a failure can never fail the `output` schema. The value is the failure's own envelope (`serialize`).
 */
const REFUSED = '~refused';
const refusedResultSchema = z.strictObject({ [REFUSED]: z.looseObject({ code: z.string().min(1) }) });
type CommandNode = Extract<WorkflowNode, { readonly kind: 'command' }>;
type EventWaitNode = Extract<WorkflowNode, { readonly kind: 'eventWait' }>;
/** `decodeEvent`, as the plain functions below use it: they pass its result on and check only for a failure. */
type DecodeEvent = (row: StoredEventRow, def: AnyEventDef | undefined, id: string) => unknown;

/** The failure a command node stored, real again, or `undefined` when its `accept` list no longer names it. */
function revivedRefusal(node: CommandNode, stored: unknown): Failure | undefined {
  const revived = revive(ensure(stored, refusedResultSchema)[REFUSED], node.accept);
  return isFailure<unknown>(revived) && node.accept.some(known => known.is(revived)) ? revived : undefined;
}

/** An event wait's stored result as a body gets it: the event decoded as a job's event is, so its upcasters apply. */
function liveWaitResult(node: EventWaitNode, stored: unknown, decode: DecodeEvent) {
  const { via, event } = ensure(stored, storedWaitResultSchema);
  const source = node.on.find(candidate => candidate.label === via);
  const decoded = decode(event, source?.entity.events.get(event.type), event.entityId);
  return isFailure(decoded) ? decoded : { via, event: decoded };
}

/**
 * `results` as a body reads them: an accepted failure is a real failure again, so `PaymentDeclined.is(results.pay)`
 * works, and an event wait's event has its `Date`s and its current schema. The stored JSON stays as it is. A value that
 * is live already is left alone, so this may run on a row a worker has made live.
 */
function liveResults(def: WorkflowDef, runId: string, stored: AnyResults, decode: DecodeEvent): AnyResults {
  const live = { ...stored };
  for (const node of def.nodes) {
    if (node.kind === 'eventWait' && is(stored[node.name], storedWaitResultSchema)) {
      const result = liveWaitResult(node, stored[node.name], decode);
      if (isFailure(result)) throw new JournalError('REPLAY_FAILED', 'workflow', runId, reasonText(result));
      live[node.name] = result;
    }
    if (node.kind !== 'command' || !is(stored[node.name], refusedResultSchema)) continue;
    const failure = revivedRefusal(node, stored[node.name]);
    if (failure === undefined) {
      throw new JournalError(
        'BAD_DEFINITION',
        'workflow',
        runId,
        `command '${node.name}' stored a failure its accept list does not name`,
      );
    }
    live[node.name] = failure;
  }
  return live;
}

/** Readable text of whatever failed a step: an error, a returned failure, or anything thrown. */
function reasonText(reason: unknown): string {
  if (isFailure(reason)) return JSON.stringify(reason);
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  return text === '' ? 'the step failed without a message' : text;
}

/** `JSON.stringify` says `string`, but it gives `undefined` for a function or a symbol. */
const jsonOf = (value: unknown): string | undefined => JSON.stringify(value);

/**
 * A value a run may keep: it survives JSON storage unchanged and fits `limit` bytes. `undefined` is stored as `null`,
 * so a step that returns nothing has the result `null`. Returns the value to store, or the error that refuses it.
 */
function storable(
  value: unknown,
  limit: number,
  what: string,
  runId: string,
  limitName = 'limits.payload',
): { readonly value: unknown } | JournalError {
  const normal = value === undefined ? null : value;
  let json: string | undefined;
  try {
    json = jsonOf(normal);
  } catch (error) {
    return new JournalError('UNSTABLE_SCHEMA', 'workflow', runId, `${what} cannot be written as JSON`, {
      cause: error,
    });
  }
  if (json === undefined) return new JournalError('UNSTABLE_SCHEMA', 'workflow', runId, `${what} has no JSON form`);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > limit) {
    return new JournalError('WORKFLOW_LIMIT', 'workflow', runId, `${what} is ${bytes} bytes; ${limitName} is ${limit}`);
  }
  const back: unknown = JSON.parse(json);
  if (!sameValue(normal, back)) {
    return new JournalError('UNSTABLE_SCHEMA', 'workflow', runId, `${what} changes across JSON storage`);
  }
  return { value: normal };
}

const nowIso = () => new Date().toISOString();
/**
 * What a write ended: a park ends when its node completes or the run starts compensating; the deadline when the run is
 * over or compensating; the wait of a queued run when it is dequeued or over.
 */
const endedBy = (written: readonly { readonly type: string }[]) => ({
  park: written.some(event => event.type === 'NodeCompleted' || event.type === 'CompensationStarted'),
  deadline: written.some(event =>
    ['RunCompleted', 'RunFailed', 'RunCancelled', 'RunExpired', 'CompensationStarted'].includes(event.type),
  ),
  queue: written.some(event =>
    ['RunDequeued', 'RunCompleted', 'RunFailed', 'RunCancelled', 'RunExpired'].includes(event.type),
  ),
});

/** Why the node a run was on is dropped when the run begins to compensate. */
const COMPENSATING = 'the run began compensating';
/** `path` and `phase` (and the result of a completed node) in the data of a settled node event. */
const settledNodeSchema = z.object({
  path: z.string().min(1),
  phase: z.enum(STEP_PHASES),
  result: z.unknown().optional(),
});
const failedNodeSchema = z.object({ error: z.string().min(1) });
/** A completed `do` node (step, child or map) that an undo may still have to answer: its path, which visit of the node it was, and its result. */
type Done = { readonly path: string; readonly visit: number; readonly result: unknown };

/**
 * The completed steps still to undo, newest first. Undo goes in reverse order of completion, one undo per completed
 * visit. Each settled undo (done or skipped) takes the newest one away, so the list is the same after a crash.
 * `doneNow` and `undoneNow` are what the write in progress adds: its events are not in the table yet.
 */
function remainingUndos(
  def: WorkflowDef,
  settled: readonly { readonly type: string; readonly data: unknown }[],
  doneNow?: { readonly path: string; readonly result: unknown },
  undoneNow = 0,
): Done[] {
  const visits = new Map<string, number>();
  const done: Done[] = [];
  let undone = undoneNow;
  const isUndoable = (path: string) =>
    def.nodes.some(
      node =>
        node.name === path &&
        (node.kind === 'step' || node.kind === 'child' || node.kind === 'map' || node.kind === 'command'),
    );
  const see = (path: string, completed: boolean, result: unknown) => {
    const visit = (visits.get(path) ?? 0) + 1;
    visits.set(path, visit);
    if (completed && isUndoable(path)) done.push({ path, visit, result });
  };
  for (const event of settled) {
    const data = settledNodeSchema.parse(event.data);
    if (data.phase === 'undo') undone++;
    else see(data.path, event.type === 'NodeCompleted', data.result);
  }
  if (doneNow !== undefined) see(doneNow.path, true, doneNow.result);
  return done.slice(0, Math.max(done.length - undone, 0)).reverse();
}

/** A run may have at most this many ancestors: a start any deeper is refused with `WORKFLOW_LIMIT`. */
const MAX_CHILD_DEPTH = 8;
/** `workflow_runs.id` is a `varchar(256)`. */
const MAX_RUN_ID_LENGTH = 256;
/** The id stem of a node visit's children: the node path, and `:2`, `:3` when a `next` loop comes back to it. */
const childBase = (path: string, visit: number) => (visit === 1 ? path : `${path}:${visit}`);
/** The child or map node a `parentPath` (a `childBase`) belongs to. */
function nodeOfBase(def: WorkflowDef, base: string): WorkflowNode | undefined {
  const exact = def.nodes.find(node => node.name === base);
  if (exact !== undefined) return exact;
  const looped = /^(.*):\d+$/.exec(base);
  return looped?.[1] === undefined ? undefined : def.nodes.find(node => node.name === looped[1]);
}
/** A cancel of the parent leaves a detached child running, and compensation does not wait for it. */
/** The index `target` names after node `index`: `'next'` is the following node, anything else must be an earlier one. */
function jumpTarget(def: WorkflowDef, index: number, target: string, runId: string) {
  if (target === 'next') return index + 1;
  const targetIndex = def.nodes.findIndex(candidate => candidate.name === target);
  if (targetIndex === -1 || targetIndex >= index) {
    throw new JournalError(
      'BAD_DEFINITION',
      'workflow',
      runId,
      `node '${def.nodes[index]?.name}' routed to '${target}', which is not an earlier node; next may only jump back`,
    );
  }
  return targetIndex;
}

const isDetached = (node: WorkflowNode | undefined) => node?.kind === 'child' && node.onCancel === 'detach';
/** The step key of a run's first node: its first visit, so a promoted queued run gets the key a start would give it. */
const firstKeyOf = (runId: string, path: string) => `${runId}:${path}:do`;
/** A run a cancel stops: queued, running or parked. One that compensates is stopping already; one that ended is over. */
const isLive = (state: (typeof RUN_STATES)[number]) => state === 'queued' || state === 'running' || state === 'parked';

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
/** The reason on the first node of a run that expired: it never ran. */
const EXPIRED = 'the run expired before its first node started';

/**
 * When a run's first node is due and when the run expires, from `delay` and `ttl` at `now`. A delay that ends now or
 * earlier is no delay (`startAt` null). The ttl clock starts when the run is due, so a delayed run gets its whole ttl.
 */
function startTiming(timing: RunTiming, now: Date) {
  const { delay, ttl } = timing;
  const wanted = delay === undefined ? now : delay instanceof Date ? delay : new Date(now.getTime() + parseAge(delay));
  const startAt = wanted.getTime() > now.getTime() ? wanted : null;
  const ttlMs = ttl === undefined ? null : parseAge(ttl);
  const due = startAt ?? now;
  return { startAt, due, ttlAt: ttlMs === null ? null : new Date(due.getTime() + ttlMs), ttlMs };
}

/**
 * The overrides a run's `RunStarted` stores, each left out when unset so a plain start's event stays as it was. The
 * timeout is whole ms, at least 1: an age in seconds can name less.
 */
function storedOverrides({ maxAttempts, timeout, priority }: RunOverrides) {
  return {
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(timeout === undefined ? {} : { stepTimeoutMs: Math.max(1, Math.round(parseAge(timeout))) }),
    ...(priority === undefined ? {} : { priority }),
  };
}

/** The `priority` a run's `NodeScheduled` and `Parked` carry for their jobs: the run's, left out when it has none. */
const priorityOn = (priority: number | null | undefined) =>
  priority === null || priority === undefined ? {} : { priority };

/** A step attempt's time limit in ms: the step's own `timeout`, narrowed by its run's (`start({ timeout })`). */
function attemptTimeoutMs(own: RetentionAge | undefined, run: number | null): number | undefined {
  const ownMs = own === undefined ? undefined : parseAge(own);
  if (run === null) return ownMs;
  return ownMs === undefined ? run : Math.min(ownMs, run);
}

type Definitions<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = Pick<JournalDefinitions<Meta, Tx, AppDb>, 'event' | 'entity' | 'projection' | 'command'>;

/** The body of one node attempt, bounded by the step's timeout. A timeout aborts `signal` and fails the attempt. */
/**
 * The concurrency key of a start. A key is the app's own text (a tenant, an account): one that is empty or longer than
 * the column (256) is a bug in the key function, so it throws.
 */
function concurrencyKeyOf(def: WorkflowDef, input: unknown): string | null {
  const keyOf = def.concurrency?.key;
  if (keyOf === undefined) return null;
  const key = keyOf(input);
  if (typeof key !== 'string' || key === '' || key.length > 256) {
    throw new JournalError(
      'BAD_DEFINITION',
      'workflow',
      def.name,
      `concurrency.key must return a non-empty string of at most 256 characters, got ${JSON.stringify(key)}`,
    );
  }
  return key;
}

/** The attributes of a `journal.step` span: which run, which node, which try. Never the input or a result. */
function stepSpan(
  row: { readonly id: string; readonly name: string; readonly workflowVersion: number },
  data: { readonly path: string; readonly attempt: number },
  phase: StepPhase,
) {
  return {
    'journal.workflow.name': row.name,
    'journal.workflow.version': row.workflowVersion,
    'journal.workflow.run_id': row.id,
    'journal.step.name': data.path,
    'journal.step.attempt': data.attempt,
    'journal.step.phase': phase,
  };
}

/** What a step hook sees: the same facts as the `journal.step` span, and no more. */
function stepHookContext(
  row: { readonly id: string; readonly name: string; readonly workflowVersion: number },
  data: { readonly path: string; readonly attempt: number },
  phase: StepPhase,
): StepHookContext {
  return {
    workflow: row.name,
    version: row.workflowVersion,
    runId: row.id,
    step: data.path,
    attempt: data.attempt,
    phase,
  };
}

async function runBody(
  node: { readonly name: string; readonly timeoutMs: number | undefined },
  invoke: (ctx: ErasedContext) => unknown,
  build: (signal: AbortSignal) => ErasedContext,
  signal: AbortSignal,
  runId: string,
) {
  const { timeoutMs } = node;
  if (timeoutMs === undefined) return invoke(build(signal));
  const timeout = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<ReturnType<typeof Deadline>>(resolve => {
    timer = setTimeout(() => {
      const error = new JournalError(
        'STEP_TIMEOUT',
        'workflow',
        runId,
        `step '${node.name}' ran longer than ${timeoutMs} ms`,
      );
      const deadline = Deadline({ cause: error });
      timeout.abort(deadline);
      resolve(deadline);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(build(AbortSignal.any([signal, timeout.signal])))),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The workflow runner of one `initJournal()`: `workflow` builds definitions with `start`; `register`, called by
 * `compose`, returns the step effect and the step projection. The `workflow.run` entity is built here from the
 * journal tables `initJournal` was given, like any entity of the app.
 */
export function createWorkflows<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(
  j: Definitions<Meta, Tx, AppDb>,
  tables: JournalTables,
  retention: JobRetention | undefined,
  decodeEvent: ReturnType<typeof createEventDecoder<Meta>>,
) {
  type MetaOut = SchemaOutput<Meta>;
  const policy = resolveRetention(retention);
  const machine = workflowMachine<Meta, Tx>(j, tables);
  const { run, events } = machine;
  const { workflowRuns, workflowSteps, workflowSignals, workflowWaits } = tables;
  const limits = limitMachine<Meta, Tx>(j, tables);
  const limitGate = createLimitGate(tables);
  /**
   * What the commands that move a run may write. They share `RunCtx` and the helpers that take it, so a command
   * declares every event of the run entity: which one it writes depends on the state it finds. A limit verb adds the
   * limit's events, because a raised limit can promote queued runs.
   */
  const runEvents = Object.values(events);
  const limitVerbEvents = [...runEvents, ...Object.values(limits.events)];
  /** The limits the registered workflows hold, by name. `register` fills it; `journal.limits` knows no other name. */
  const knownLimits = new Map<string, KnownLimit>();
  /** `journal.hooks.step`: they wrap each step body and undo, inside its `journal.step` span. */
  const stepHooks = createHookPoint<StepHookContext>('step');

  /** Which visit of a node the run is on: 1 the first time, 2 when a `next` loop comes back to it, and so on. */
  const visitOf = async (db: Pick<Tx, 'select'>, runId: string, path: string) => {
    const [seen] = await db
      .select({ n: count() })
      .from(tables.events)
      .where(
        and(
          eq(tables.events.kind, 'workflow.run'),
          eq(tables.events.entityId, runId),
          inArray(tables.events.type, ['NodeCompleted', 'NodeSkipped']),
          sql`${tables.events.data} ->> 'path' = ${path}`,
          sql`${tables.events.data} ->> 'phase' = 'do'`,
        ),
      );
    return (seen?.n ?? 0) + 1;
  };
  /**
   * The step key of a node's next visit: `<run>:<path>:do`, and `…:do:2`, `…:do:3` when a `next` loop comes back to
   * it. A retry of the same visit keeps the key, so a provider that dedupes on it dedupes the retry; a new visit gets a new one.
   */
  const keyOfNextVisit = async (tx: Tx, runId: string, path: string) => {
    const visit = await visitOf(tx, runId, path);
    return visit === 1 ? `${runId}:${path}:do` : `${runId}:${path}:do:${visit}`;
  };

  /**
   * Gives the step jobs a write just queued their `run_id`, and the step rows their `job_id`. In the write's own
   * transaction, so a worker never sees a step job that does not belong to its run.
   */
  const linkJobs = async (
    tx: Tx,
    runId: string,
    scheduled: readonly { readonly seq: number; readonly path: string; readonly phase: StepPhase }[],
  ) => {
    if (scheduled.length === 0) return;
    const queued = await tx
      .update(tables.jobs)
      .set({ runId })
      .where(
        and(
          inArray(
            tables.jobs.eventSeq,
            scheduled.map(entry => entry.seq),
          ),
          eq(tables.jobs.effect, STEP_EFFECT),
        ),
      )
      .returning({ id: tables.jobs.id, eventSeq: tables.jobs.eventSeq });
    for (const job of queued) {
      const owner = scheduled.find(entry => entry.seq === job.eventSeq);
      if (owner === undefined) continue;
      await tx
        .update(workflowSteps)
        .set({ jobId: job.id })
        .where(
          and(eq(workflowSteps.runId, runId), eq(workflowSteps.path, owner.path), eq(workflowSteps.phase, owner.phase)),
        );
    }
  };

  type Row = typeof workflowRuns.$inferSelect;

  /** Every definition a `compose({ workflows })` of this `initJournal()` registered, by `name@version`. A start of any other has no step effect to queue its job for. */
  const started = new Map<string, WorkflowDef>();
  /** The code of the run's own pinned `(name, version)`, never another version. A stranded run throws: it is never run with other code. */
  const definitionOf = (row: Row): WorkflowDef => {
    const code = codeOf(row, started);
    if (code instanceof JournalError) throw code;
    return code;
  };
  const newestVersionOf = (name: string) =>
    Math.max(0, ...[...started.values()].filter(def => def.name === name).map(def => def.version));
  /** A stranded job is seen on every retry; the warning is given once per `(name, version)` per process. */
  const warnedStranded = new Set<string>();
  const warnStranded = (row: Row, error: JournalError) => {
    const id = `${row.name}@${row.workflowVersion}`;
    if (warnedStranded.has(id)) return;
    warnedStranded.add(id);
    debugWorkflow.warn(
      '{name} v{version}: run {runId} is stranded ({code}); its jobs are dead until the code is back',
      {
        name: row.name,
        version: row.workflowVersion,
        runId: row.id,
        code: error.code,
      },
    );
  };

  /**
   * The job verbs, for the one thing the runner cancels: the timer of a park the run has left. They write
   * the operation row and archive the job under the retention given to `initJournal`.
   */
  const jobOps = createManagedJobOps({
    tables,
    retention: policy,
    wake: () => {
      // No worker to wake here; the caller polls.
    },
  });

  /**
   * The failure that stops a run whose node is about to make more transitions than `limits.transitions` allows, or
   * `undefined` while it is within the limit. `row.transitions` already counts the node that is starting.
   */
  const transitionLimitFailure = (def: WorkflowDef, row: Row) =>
    row.transitions <= def.limits.transitions
      ? undefined
      : WorkflowTransitionLimit({
          runId: row.id,
          name: def.name,
          limit: def.limits.transitions,
          transitions: row.transitions,
          detail: `workflow '${def.name}' run ${row.id} would make transition ${row.transitions}; limits.transitions is ${def.limits.transitions}`,
        });

  /** `node` index `targetIndex` is next; past the last node the run is over and its output is worked out here. */
  async function routeAt(
    def: WorkflowDef,
    targetIndex: number,
    row: Row,
    lastPath: string,
    lastResult: unknown,
  ): Promise<Route | AsyncSchemaFailure> {
    const target = def.nodes[targetIndex];
    if (target !== undefined) return { go: 'node', name: target.name };
    const produced =
      def.finish === undefined
        ? lastResult
        : await def.finish({
            runId: row.id,
            input: row.input,
            results: liveResults(def, row.id, { ...row.results, [lastPath]: lastResult }, decodeEvent),
          });
    if (isFailure(produced)) {
      throw new JournalError(
        'BAD_DEFINITION',
        'workflow',
        row.id,
        `finish returned a failure: ${JSON.stringify(produced)}`,
      );
    }
    const parsed = def.output === undefined ? produced : await parseAsync(def.output, produced);
    if (InvalidInput.is(parsed) || ValidatorDefect.is(parsed)) return parsed;
    const kept = storable(parsed, def.limits.payload, 'the output', row.id);
    if (kept instanceof JournalError) throw kept;
    return { go: 'finish', output: kept.value, keepUntil: keepUntilFor(def, 'completed') };
  }

  /** When the row of a run that just ended as `outcome` may be pruned: the workflow's own retention, else the journal's. */
  const keepUntilFor = (def: WorkflowDef, outcome: keyof ResolvedRetention['workflows']): string | null =>
    runKeepUntil(runKeepFor(policy, def.retention, outcome, def.name), new Date())?.toISOString() ?? null;

  /** A run has not started while it is `running` with no node result: its first node has not run yet. */
  const notStarted = (row: Row) =>
    row.finishedAt === null && row.state === 'running' && Object.keys(row.results).length === 0;
  /**
   * Whether a run ends `expired` now: it has not started, `node` is its first node's first try, and its `ttl_at` has
   * passed by the database clock, the one clock every worker shares. A run that started never expires.
   */
  const expiresNow = async (
    tx: Tx,
    row: Row,
    node: { readonly path: string; readonly phase: StepPhase; readonly attempt: number },
  ) => {
    if (row.ttlAt === null || !notStarted(row)) return false;
    if (node.path !== row.shape.nodes[0]?.name || node.phase !== 'do' || node.attempt !== 1) return false;
    const past = await tx
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, row.id), lt(workflowRuns.ttlAt, sql`now()`)));
    return past.length > 0;
  };

  /** The run's deadline has passed, whether or not its timer has fired yet: a late signal or park cannot defeat it. */
  const pastDeadline = (row: Row) => row.deadlineAt !== null && row.deadlineAt.getTime() <= Date.now();
  const runFailed = (def: WorkflowDef, error: string, at: string) =>
    events.RunFailed({ error, at, keepUntil: keepUntilFor(def, 'failed') });

  /** The completed events of a run and its undo events, oldest first: what `remainingUndos` reads. */
  const settledOf = (runId: string) =>
    and(
      eq(tables.events.kind, 'workflow.run'),
      eq(tables.events.entityId, runId),
      inArray(tables.events.type, ['NodeCompleted', 'NodeSkipped']),
    );
  /** The text of the failure that made a run compensate: the deadline, or the last `do` node that failed. */
  const causeOf = async (tx: Tx, runId: string) => {
    const [last] = await tx
      .select({ type: tables.events.type, data: tables.events.data })
      .from(tables.events)
      .where(
        and(
          eq(tables.events.kind, 'workflow.run'),
          eq(tables.events.entityId, runId),
          or(
            eq(tables.events.type, 'DeadlineReached'),
            and(eq(tables.events.type, 'NodeFailed'), sql`${tables.events.data} ->> 'phase' = 'do'`),
          ),
        ),
      )
      .orderBy(desc(tables.events.seq))
      .limit(1);
    if (last === undefined) return 'the run failed';
    return last.type === 'DeadlineReached'
      ? 'the run deadline passed before it finished'
      : failedNodeSchema.parse(last.data).error;
  };

  /** The child runs of a run: which are unfinished, which completed, and which node visit each belongs to. */
  const kidsOf = (tx: Tx, runId: string) =>
    tx
      .select({
        id: workflowRuns.id,
        state: workflowRuns.state,
        parentPath: workflowRuns.parentPath,
        finishedAt: workflowRuns.finishedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.parentId, runId));
  /** A step whose attempt is in flight, or whose undo is: the run is not between two nodes, so a child ending must not move it. */
  const hasScheduledStep = async (tx: Tx, runId: string) => {
    const [open] = await tx
      .select({ n: count() })
      .from(workflowSteps)
      .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.status, 'scheduled')));
    return (open?.n ?? 0) > 0;
  };

  type CompensateOptions = {
    /** The text of `RunFailed`; null looks it up from the events (after an undo settles). */
    readonly cause: string | null;
    /** A `CancelRequested` is in the write in progress. */
    readonly cancelling?: boolean;
    /** A `do` step the write in progress completes: it is the newest to undo. */
    readonly doneNow?: { readonly path: string; readonly result: unknown };
    /** An undo the write in progress settles. */
    readonly undoneNow?: number;
  };

  /**
   * One step of compensation: the undo of the newest completed `do` step not yet undone, or the end of the run when
   * none is left. A step without an `undo` is recorded as skipped (the `residual` of the run) and the next is tried.
   * Nodes that are not steps (waitFor, sleep) have nothing to undo and leave no row. The undo of a loop's second visit
   * gets its own key: `<run>:<path>:undo:2`.
   *
   * A child or map node is undone by its `undo` (a child node only), else through its child runs: a completed child is
   * reopened and undoes itself (`driveChildren` does that), and the node's undo is settled once none is left completed.
   * While a child that the run must wait for is unfinished (cancelled with the run, or being reopened), nothing moves.
   */
  const compensate = async (tx: Tx, def: WorkflowDef, row: Row, at: string, options: CompensateOptions) => {
    const settled = await tx
      .select({ type: tables.events.type, data: tables.events.data })
      .from(tables.events)
      .where(settledOf(row.id))
      .orderBy(asc(tables.events.seq));
    const out: (
      | ReturnType<typeof events.NodeScheduled>
      | ReturnType<typeof events.NodeCompleted>
      | ReturnType<typeof events.NodeSkipped>
      | ReturnType<typeof events.RunCancelled>
      | ReturnType<typeof events.RunFailed>
    )[] = [];
    const kids = await kidsOf(tx, row.id);
    const waitedFor = (kid: (typeof kids)[number]) =>
      kid.finishedAt === null && !isDetached(nodeOfBase(def, kid.parentPath ?? ''));
    if (kids.some(kid => waitedFor(kid))) return out;
    for (const item of remainingUndos(def, settled, options.doneNow, options.undoneNow)) {
      const node = def.nodes.find(candidate => candidate.name === item.path);
      // An accepted failure: the command was refused and rolled back, so it did nothing to undo.
      if (node?.kind === 'command' && is(item.result, refusedResultSchema)) {
        out.push(
          events.NodeSkipped({
            path: item.path,
            phase: 'undo',
            cause: 'no-undo',
            reason: 'the command was refused, so it did nothing to undo',
            actorId: null,
            at,
          }),
        );
        continue;
      }
      const hasUndo =
        (node?.kind === 'step' && node.options.undo !== undefined) ||
        ((node?.kind === 'child' || node?.kind === 'command') && node.undo);
      if (hasUndo) {
        const key = `${row.id}:${item.path}:undo${item.visit === 1 ? '' : `:${item.visit}`}`;
        out.push(
          events.NodeScheduled({
            path: item.path,
            phase: 'undo',
            attempt: 1,
            key,
            jobId: null,
            at,
            ...priorityOn(row.priority),
          }),
        );
        return out;
      }
      if (node?.kind === 'child' || node?.kind === 'map') {
        if (isDetached(node)) {
          out.push(
            events.NodeSkipped({
              path: item.path,
              phase: 'undo',
              cause: 'detached',
              reason: 'the child was detached, so it is left running',
              actorId: null,
              at,
            }),
          );
          continue;
        }
        const base = childBase(item.path, item.visit);
        if (kids.some(kid => kid.parentPath === base && kid.state === 'completed')) return out;
        out.push(events.NodeCompleted({ path: item.path, phase: 'undo', result: null, resolvedBy: null, at }));
        continue;
      }
      out.push(
        events.NodeSkipped({
          path: item.path,
          phase: 'undo',
          cause: 'no-undo',
          reason: 'the step declares no undo',
          actorId: null,
          at,
        }),
      );
    }
    if (row.cancelledAt !== null || options.cancelling === true) {
      out.push(events.RunCancelled({ at, keepUntil: keepUntilFor(def, 'cancelled') }));
    } else {
      out.push(runFailed(def, options.cause ?? (await causeOf(tx, row.id)), at));
    }
    return out;
  };

  /**
   * The node a run is on, when compensation starts and the events so far do not close it. A parked wait is dropped. A
   * step job nobody holds is cancelled so it never runs. A step job a worker holds may already have done its work (a
   * charge): it stays, and its checkpoint settles it later. Returns the events that drop the node, and whether it is
   * still in flight.
   */
  const dropCurrentNode = async (tx: Tx, row: Row, at: string, executionId: string | undefined) => {
    const none = { events: [], inFlight: false };
    if (row.node === null) return none;
    const [step] = await tx
      .select({ status: workflowSteps.status, jobId: workflowSteps.jobId, attempt: workflowSteps.attempt })
      .from(workflowSteps)
      .where(and(eq(workflowSteps.runId, row.id), eq(workflowSteps.path, row.node), eq(workflowSteps.phase, 'do')));
    if (step === undefined || step.status !== 'scheduled') return none;
    const dropped = {
      events: [
        events.NodeSkipped({
          path: row.node,
          phase: 'do',
          cause: 'compensating',
          reason: COMPENSATING,
          actorId: null,
          at,
        }),
      ],
      inFlight: false,
    };
    // A parked wait has no work in flight: the job that parked it is only finishing.
    if (row.state === 'parked') return dropped;
    if (step.jobId === null) return { events: [], inFlight: true };
    // Only a job that never started may be skipped. A retry (an earlier attempt of this step, or a crashed try of this
    // job) may have acted on a provider before it failed, so it runs once more and settles like a step in flight.
    const [tried] = await tx
      .select({ n: count() })
      .from(tables.jobAttempts)
      .where(eq(tables.jobAttempts.jobId, step.jobId));
    if (step.attempt > 1 || (tried?.n ?? 0) > 0) return { events: [], inFlight: true };
    try {
      const cancelled = await jobOps.cancel(tx, step.jobId, {
        actor: WORKFLOW_ACTOR,
        reason: COMPENSATING,
        ...(executionId === undefined ? {} : { executionId }),
      });
      if (isFailure(cancelled)) return cancelled;
    } catch (error) {
      if (isJournalError(error, 'JOB_RUNNING')) return { events: [], inFlight: true };
      throw error;
    }
    return dropped;
  };

  /**
   * The run starts compensating: `head` (the event that caused it) is followed by `CompensationStarted`, the drop of
   * the node it is on (unless `head` already closes that node), and the first undo. While a step is in flight, no undo
   * is scheduled: that step's checkpoint schedules it.
   */
  const beginCompensation = async (
    tx: Tx,
    def: WorkflowDef,
    row: Row,
    at: string,
    head: readonly (
      | ReturnType<typeof events.NodeFailed>
      | ReturnType<typeof events.NodeSkipped>
      | ReturnType<typeof events.DeadlineReached>
      | ReturnType<typeof events.CancelRequested>
      | ReturnType<typeof events.TimerFired>
      | ReturnType<typeof events.SignalReceived>
    )[],
    options: {
      readonly closed: boolean;
      readonly cause: string | null;
      readonly cancelling?: boolean;
      readonly executionId?: string | undefined;
    },
  ) => {
    // A queued run never ran: it has no node, no step and no child, so it ends at once with no compensation.
    if (row.state === 'queued') {
      const ended = await compensate(tx, def, row, at, {
        cause: options.cause,
        cancelling: options.cancelling === true,
      });
      return [...head, ...ended];
    }
    const dropped = options.closed
      ? { events: [], inFlight: false }
      : await dropCurrentNode(tx, row, at, options.executionId);
    if (isFailure(dropped)) return dropped;
    const next = dropped.inFlight
      ? []
      : await compensate(tx, def, row, at, { cause: options.cause, cancelling: options.cancelling === true });
    return [...head, events.CompensationStarted({ at }), ...dropped.events, ...next];
  };

  /** The run deadline passed: the run compensates, then fails. `closed`: the events so far already close the current node. */
  const deadlineEvents = (tx: Tx, def: WorkflowDef, row: Row, at: string) =>
    beginCompensation(tx, def, row, at, [events.DeadlineReached({ at })], {
      closed: false,
      cause: 'the run deadline passed before it finished',
    });

  /** Where a run goes: the next node's schedule, or its completion. */
  const eventsAfter = async (tx: Tx, row: Row, route: Route, at: string) =>
    route.go === 'node'
      ? [
          events.NodeScheduled({
            path: route.name,
            phase: 'do',
            attempt: 1,
            key: await keyOfNextVisit(tx, row.id, route.name),
            jobId: null,
            at,
            ...priorityOn(row.priority),
          }),
        ]
      : [events.RunCompleted({ output: route.output, at, keepUntil: route.keepUntil })];

  /** A wait that cannot go on: the node is marked failed and the run compensates, then fails with the same text. */
  const failWait = async (tx: Tx, def: WorkflowDef, row: Row, path: string, error: string, at: string) => {
    const [step] = await tx
      .select({ attempt: workflowSteps.attempt })
      .from(workflowSteps)
      .where(and(eq(workflowSteps.runId, row.id), eq(workflowSteps.path, path), eq(workflowSteps.phase, 'do')));
    const failedNode = events.NodeFailed({ path, phase: 'do', attempt: Math.max(step?.attempt ?? 1, 1), error, at });
    return beginCompensation(tx, def, row, at, [failedNode], { closed: true, cause: error });
  };

  /** Where a run goes after the wait node `index`: the next node, or where a sleep's `next` says. */
  const indexAfterWait = (def: WorkflowDef, index: number, row: Row, result: unknown) => {
    const node = def.nodes[index];
    if (node?.kind !== 'sleep' || node.next === undefined) return index + 1;
    if (typeof node.next === 'string') return jumpTarget(def, index, node.next, row.id);
    const results = liveResults(def, row.id, { ...row.results, [node.name]: result }, decodeEvent);
    return jumpTarget(def, index, node.next({ runId: row.id, input: row.input, results }), row.id);
  };

  /** The wait node `index` is over with `result`: it completes and the run goes on. */
  const completeWait = async (tx: Tx, def: WorkflowDef, index: number, row: Row, result: unknown, at: string) => {
    const path = def.nodes[index]?.name ?? '';
    // An event wait's `result` is a pointer. Routing reads results as a body does, so it reads them with the events.
    const results = await withWaitEvents(tx, tables, row.id, def.nodes, { ...row.results, [path]: result });
    const live = { ...row, results };
    let route: Route;
    try {
      const routed = await routeAt(def, indexAfterWait(def, index, live, results[path]), live, path, results[path]);
      if (isFailure(routed)) return failWait(tx, def, row, path, reasonText(routed), at);
      route = routed;
    } catch (error) {
      // No step is left to retry: a finish or output that fails now would fail again.
      return failWait(tx, def, row, path, reasonText(error), at);
    }
    return [
      events.NodeCompleted({ path, phase: 'do', result, resolvedBy: null, at }),
      ...(await eventsAfter(tx, row, route, at)),
    ];
  };

  /** The oldest signal of this name nobody has taken, now taken by `path`. */
  const takeSignal = async (tx: Tx, runId: string, name: string, path: string) => {
    const [early] = await tx
      .select()
      .from(workflowSignals)
      .where(and(eq(workflowSignals.runId, runId), eq(workflowSignals.name, name), isNull(workflowSignals.consumedAt)))
      .orderBy(asc(workflowSignals.receivedAt), asc(workflowSignals.id))
      .limit(1);
    if (early === undefined) return;
    await tx
      .update(workflowSignals)
      .set({ consumedAt: new Date(), consumedBy: path })
      .where(eq(workflowSignals.id, early.id));
    return early;
  };

  /** A `waitFor` node got its signal: the payload is checked with the node's schema and becomes the node's result. */
  const wakeOnSignal = async (tx: Tx, def: WorkflowDef, index: number, row: Row, payload: unknown, at: string) => {
    const node = def.nodes[index];
    if (node === undefined || node.kind !== 'waitFor') {
      throw new JournalError('BAD_DEFINITION', 'workflow', row.id, `node ${index} of "${def.name}" is not a waitFor`);
    }
    // The door checked this payload with the signal's one schema, so it parses here too.
    const parsed = await parseAsync(node.schema, payload);
    if (isFailure(parsed)) return failWait(tx, def, row, node.name, reasonText(parsed), at);
    const stored = storable(parsed, def.limits.payload, `the payload of '${node.name}'`, row.id);
    if (stored instanceof JournalError) {
      return failWait(tx, def, row, node.name, `waitFor '${node.name}': ${reasonText(stored)}`, at);
    }
    return completeWait(tx, def, index, row, stored.value, at);
  };

  /** What the run's event waits took so far, oldest first: their cursors, and the events no other wait may take. */
  const takenBy = async (tx: Tx, runId: string): Promise<TakenEvent[]> => {
    const rows = await tx
      .select({ data: tables.events.data })
      .from(tables.events)
      .where(
        and(
          eq(tables.events.kind, 'workflow.run'),
          eq(tables.events.entityId, runId),
          eq(tables.events.type, 'WaitEventTaken'),
        ),
      )
      .orderBy(asc(tables.events.seq));
    return rows.map(taken => takenEventSchema.parse(taken.data));
  };

  /**
   * Where a visit of the event wait `node` starts counting: after the last event it took, or, on its first take, after
   * the event that started the run, or after `RunStarted` for a run with no such event. A deadline moves nothing, so an
   * event recorded while the run was between two visits of a loop is still there for the next visit.
   */
  const waitStartOf = async (tx: Tx, runId: string, node: string, taken: readonly TakenEvent[]) => {
    const own = taken.findLast(event => event.node === node);
    if (own !== undefined) return own.seq;
    const [startedRun] = await tx
      .select({ seq: tables.events.seq, data: tables.events.data })
      .from(tables.events)
      .where(
        and(
          eq(tables.events.kind, 'workflow.run'),
          eq(tables.events.entityId, runId),
          eq(tables.events.type, 'RunStarted'),
        ),
      );
    if (startedRun === undefined) {
      throw new JournalError('HISTORY_GAP', 'workflow', runId, 'an event wait found no RunStarted event for its run');
    }
    return triggerSchema.parse(startedRun.data).triggerSeq ?? startedRun.seq;
  };

  /**
   * The oldest event in the log that the wait `node` may take, read in `seq` order, which is commit order. An event
   * belongs to the first label that wants it. One that any wait of this run took already is passed over.
   */
  const oldestEligible = async (
    tx: Tx,
    def: WorkflowDef,
    node: EventWaitNode,
    row: Row,
    waits: readonly (WaitKey & { readonly afterSeq: number })[],
    taken: readonly TakenEvent[],
  ) => {
    const used = new Set(taken.map(event => event.seq));
    const view = {
      runId: row.id,
      input: row.input,
      results: liveResults(def, row.id, await withWaitEvents(tx, tables, row.id, def.nodes, row.results), decodeEvent),
    };
    // The labels of one visit share one start: a wait's cursor is the node's, not the label's.
    let readTo = Math.min(...waits.map(wait => wait.afterSeq));
    while (true) {
      const found = await tx
        .select()
        .from(tables.events)
        .where(
          and(
            gt(tables.events.seq, readTo),
            or(
              ...waits.map(wait =>
                and(
                  eq(tables.events.kind, wait.entityKind),
                  eq(tables.events.entityId, wait.entityId),
                  inArray(tables.events.type, wait.types),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(tables.events.seq))
        .limit(WAIT_READ_BATCH);
      for (const stored of found) {
        readTo = stored.seq;
        if (used.has(stored.seq)) continue;
        for (const source of node.on) {
          const wait = waits.find(candidate => candidate.label === source.label);
          if (
            wait === undefined ||
            stored.kind !== wait.entityKind ||
            stored.entityId !== wait.entityId ||
            !wait.types.includes(stored.type)
          ) {
            continue;
          }
          // The log row is untyped JSON: the event's own schema, with its upcasters, makes it a recorded event.
          const event = decodeEvent(stored, source.entity.events.get(stored.type), stored.entityId);
          if (isFailure(event)) return event;
          if (source.where === undefined || source.where({ ...view, event })) {
            return { label: source.label, stored };
          }
        }
      }
      if (found.length < WAIT_READ_BATCH) return;
    }
  };

  /** The wait node `index` takes `stored`: the taking is recorded, and the stored row is the node's result. */
  const takeEvent = async (
    tx: Tx,
    def: WorkflowDef,
    index: number,
    row: Row,
    found: { readonly label: string; readonly stored: StoredEventRow },
    at: string,
  ) => {
    const path = def.nodes[index]?.name ?? '';
    const { label, stored } = found;
    // The event as a body reads it must fit `limits.payload`, though the run stores only its pointer.
    const held = storable(
      storedWaitResultSchema.encode({ via: label, event: stored }),
      def.limits.payload,
      `the event '${path}' took`,
      row.id,
    );
    if (held instanceof JournalError) return failWait(tx, def, row, path, reasonText(held), at);
    const pointer = waitPointerSchema.encode({ via: label, seq: stored.seq });
    const completed = await completeWait(tx, def, index, row, pointer, at);
    if (isFailure(completed)) return completed;
    return [
      events.WaitEventTaken({ node: path, label, seq: stored.seq, deliveryId: stored.id, at }),
      ...completed,
    ];
  };

  /** The run is parked on the event wait `index`: it takes what the log holds for it now, or the events stay `[]`. */
  const wakeOnEvent = async (tx: Tx, def: WorkflowDef, index: number, node: EventWaitNode, row: Row, at: string) => {
    const waits = await tx
      .select()
      .from(workflowWaits)
      .where(and(eq(workflowWaits.runId, row.id), eq(workflowWaits.node, node.name)));
    const found = await oldestEligible(tx, def, node, row, waits, await takenBy(tx, row.id));
    if (isFailure(found)) return failWait(tx, def, row, node.name, reasonText(found), at);
    return found === undefined ? [] : takeEvent(tx, def, index, row, found, at);
  };

  /** A timer fired. It acts only if the run is still parked on the very park the timer was made for. */
  const onTimer = async (tx: Tx, row: Row, fired: z.infer<typeof timerCheckpointSchema>['fired'], at: string) => {
    const def = definitionOf(row);
    if (fired.kind === 'deadline') return row.state === 'compensating' ? [] : deadlineEvents(tx, def, row, at);
    if (fired.kind === 'ttl') {
      // Checked by the database clock, as the first node's own check is: a reschedule may have moved `ttl_at`.
      if (row.state !== 'queued' || row.ttlAt === null) return [];
      const past = await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.id, row.id), lt(workflowRuns.ttlAt, sql`now()`)));
      return past.length === 0 ? [] : [events.RunExpired({ at, keepUntil: keepUntilFor(def, 'expired') })];
    }
    // A timer of a park the run already left finds the run elsewhere and does nothing. A run in a loop can park on
    // the same node again: only the timer of its latest park may end that wait.
    if (row.state !== 'parked' || row.node !== fired.node) return [];
    const [latestPark] = await tx
      .select({ seq: tables.events.seq })
      .from(tables.events)
      .where(and(eq(tables.events.entityId, row.id), eq(tables.events.type, 'Parked')))
      .orderBy(desc(tables.events.seq))
      .limit(1);
    if (latestPark?.seq !== fired.parkSeq) return [];
    if (pastDeadline(row)) return deadlineEvents(tx, def, row, at);
    const index = def.nodes.findIndex(candidate => candidate.name === fired.node);
    const node = def.nodes[index];
    if (node === undefined || (node.kind !== 'waitFor' && node.kind !== 'eventWait' && node.kind !== 'sleep')) {
      throw new JournalError('BAD_DEFINITION', 'workflow', row.id, `"${def.name}" has no wait node '${fired.node}'`);
    }
    // An event that committed before this deadline wins, even when its wake job has not run yet.
    if (node.kind === 'eventWait') {
      const woke = await wakeOnEvent(tx, def, index, node, row, at);
      if (isFailure(woke) || woke.length > 0) return woke;
    }
    const timerFired = events.TimerFired({ node: fired.node, at });
    if (node.kind === 'eventWait' && node.onTimeout === 'fail') {
      const failed = await failWait(tx, def, row, node.name, `waitFor '${node.name}' got no event in time`, at);
      if (isFailure(failed)) return failed;
      return [timerFired, ...failed];
    }
    if (node.kind === 'waitFor' && node.onTimeout === 'fail') {
      const error = `waitFor '${node.name}' got no '${node.signal}' signal in time`;
      const failed = await failWait(tx, def, row, node.name, error, at);
      if (isFailure(failed)) return failed;
      return [timerFired, ...failed];
    }
    // `sleep` is over, or `waitFor` goes on without a payload.
    const completed = await completeWait(tx, def, index, row, null, at);
    if (isFailure(completed)) return completed;
    return [timerFired, ...completed];
  };

  /** Gives the timer jobs a write just queued their `run_id`, in the same transaction, before any worker can see them. */
  const linkTimers = async (tx: Tx, runId: string, seqs: readonly number[]) => {
    if (seqs.length === 0) return;
    await tx
      .update(tables.jobs)
      .set({ runId })
      .where(and(eq(tables.jobs.effect, TIMER_EFFECT), inArray(tables.jobs.eventSeq, [...seqs])));
  };

  /**
   * Cancels the timers a run no longer needs, in the transaction that moved it: the wake timer of a park it left,
   * and the deadline timer of a run that ended. A timer a worker holds is left alone: it finds nothing to do.
   */
  const cancelTimers = async (
    tx: Tx,
    runId: string,
    gone: { readonly park: boolean; readonly deadline: boolean; readonly queue: boolean },
  ) => {
    const types = [
      ...(gone.park ? ['Parked'] : []),
      ...(gone.deadline ? ['RunStarted'] : []),
      ...(gone.queue ? ['RunQueued'] : []),
    ];
    if (types.length === 0) return;
    // The event type is read from the job's own event copy, so this needs no `journal_events` row.
    const pending = await tx
      .select({ id: tables.jobs.id })
      .from(tables.jobs)
      .where(
        and(
          eq(tables.jobs.runId, runId),
          eq(tables.jobs.effect, TIMER_EFFECT),
          isNull(tables.jobs.deadAt),
          or(isNull(tables.jobs.leaseUntil), lte(tables.jobs.leaseUntil, sql`now()`)),
          inArray(sql`${tables.jobs.args}->>'type'`, types),
        ),
      );
    for (const job of pending) {
      try {
        const cancelled = await jobOps.cancel(tx, job.id, { actor: WORKFLOW_ACTOR, reason: 'the run moved on' });
        if (isFailure(cancelled)) return cancelled;
      } catch (error) {
        // A worker claimed it between the read and the cancel: it runs, finds the run moved, and writes nothing.
        if (!isJournalError(error, 'JOB_RUNNING') && !isJournalError(error, 'JOB_NOT_PENDING')) throw error;
      }
    }
    return;
  };

  type RunEvent = {
    [Name in keyof typeof events]: RecordedOf<(typeof events)[Name], MetaOut, string>;
  }[keyof typeof events];
  /** After a write: the step jobs and the timer jobs it queued get their run, and the step rows their job. */
  const queueJobs = async (tx: Tx, runId: string, written: readonly RunEvent[]) => {
    await linkJobs(
      tx,
      runId,
      written.flatMap(event =>
        event.type === 'NodeScheduled' ? [{ seq: event.seq, path: event.data.path, phase: event.data.phase }] : [],
      ),
    );
    await linkTimers(
      tx,
      runId,
      written.map(event => event.seq),
    );
  };

  type RunCtx = Pick<CommandContext<MetaOut, Tx, (typeof runEvents)[number]>, 'write' | 'run' | 'accept' | 'tx'>;
  type Written = { readonly row: Row | null; readonly events: readonly RunEvent[] };
  const ENDS = new Set(['RunCompleted', 'RunFailed', 'RunCancelled', 'RunExpired']);
  const plannedSchema = childrenPlanSchema.extend({ path: z.string().min(1) });
  type Planned = z.infer<typeof plannedSchema>;

  /** The newest plan of a run's children, or the one of this `base`. */
  const plannedOf = async (tx: Tx, runId: string, base?: string): Promise<Planned | undefined> => {
    const [latest] = await tx
      .select({ data: tables.events.data })
      .from(tables.events)
      .where(
        and(
          eq(tables.events.kind, 'workflow.run'),
          eq(tables.events.entityId, runId),
          eq(tables.events.type, 'ChildrenPlanned'),
          base === undefined ? undefined : sql`${tables.events.data} ->> 'base' = ${base}`,
        ),
      )
      .orderBy(desc(tables.events.seq))
      .limit(1);
    return latest === undefined ? undefined : plannedSchema.parse(latest.data);
  };

  /** A node whose work cannot go on and cannot be retried: `NodeFailed`, then `onDeadStep` decides (wait for an operator, or compensate). */
  const deadNode = async (tx: Tx, def: WorkflowDef, row: Row, path: string, error: string, at: string) => {
    const [step] = await tx
      .select({ attempt: workflowSteps.attempt })
      .from(workflowSteps)
      .where(and(eq(workflowSteps.runId, row.id), eq(workflowSteps.path, path), eq(workflowSteps.phase, 'do')));
    const failedNode = events.NodeFailed({ path, phase: 'do', attempt: Math.max(step?.attempt ?? 1, 1), error, at });
    if (def.onDeadStep === 'wait') return [failedNode];
    return beginCompensation(tx, def, row, at, [failedNode], { closed: true, cause: error });
  };

  /** The children node `index` is over: the outputs of `ids`, checked with the child workflow's output schema, are its result. */
  const completeChildren = async (
    tx: Tx,
    def: WorkflowDef,
    index: number,
    parent: Row,
    plan: Planned,
    ids: readonly string[],
    list: boolean,
    at: string,
  ) => {
    const stored = await tx
      .select({ id: workflowRuns.id, output: workflowRuns.output })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.parentId, parent.id), inArray(workflowRuns.id, [...ids])));
    const outputOf = new Map(stored.map(kid => [kid.id, kid.output]));
    const childDef = started.get(`${plan.def.name}@${plan.def.version}`);
    try {
      const checked: unknown[] = [];
      for (const id of ids) {
        const raw = outputOf.get(id);
        const parsed = childDef?.output === undefined ? raw : await parseAsync(childDef.output, raw);
        if (isFailure(parsed)) return deadNode(tx, def, parent, plan.path, reasonText(parsed), at);
        checked.push(parsed);
      }
      const kept = storable(list ? checked : checked[0], def.limits.payload, `the result of '${plan.path}'`, parent.id);
      if (kept instanceof JournalError) return deadNode(tx, def, parent, plan.path, reasonText(kept), at);
      return completeWait(tx, def, index, parent, kept.value, at);
    } catch (error) {
      return deadNode(tx, def, parent, plan.path, reasonText(error), at);
    }
  };

  /** What a write to a run asks of the other runs, done after it: children to start, and children to stop. */
  type Moves = {
    starts: { readonly plan: Planned; readonly children: Planned['children'] } | undefined;
    readonly stops: string[];
  };

  /** A child run of the node this parent waits on has ended (or the parent looks again): the parent's node may be over. */
  const onChildEnded = async (tx: Tx, parent: Row, base: string, at: string, moves: Moves) => {
    const def = definitionOf(parent);
    if (parent.state === 'compensating') {
      const plan = await plannedOf(tx, parent.id, base);
      const node = def.nodes.find(candidate => candidate.name === plan?.path);
      // A detached child is not waited for; a run that is between two nodes in flight moves on its own checkpoint.
      if (plan === undefined || isDetached(node) || (await hasScheduledStep(tx, parent.id))) return [];
      return compensate(tx, def, parent, at, { cause: null });
    }
    if (parent.state !== 'parked') return [];
    const plan = await plannedOf(tx, parent.id);
    if (plan === undefined || plan.base !== base || parent.node !== plan.path) return [];
    const index = def.nodes.findIndex(candidate => candidate.name === plan.path);
    const node = def.nodes[index];
    if (node === undefined || (node.kind !== 'child' && node.kind !== 'map')) {
      throw new JournalError('BAD_DEFINITION', 'workflow', parent.id, `"${def.name}" has no child node '${plan.path}'`);
    }
    // A node that is dead already waits for an operator: a later child end changes nothing.
    const [step] = await tx
      .select({ status: workflowSteps.status })
      .from(workflowSteps)
      .where(and(eq(workflowSteps.runId, parent.id), eq(workflowSteps.path, plan.path), eq(workflowSteps.phase, 'do')));
    if (step?.status === 'failed') return [];
    if (pastDeadline(parent)) return deadlineEvents(tx, def, parent, at);

    const allKids = await kidsOf(tx, parent.id);
    // The kids of the plan, not of the base: a retried child (`retryStep`) leaves its failed predecessor under the same base.
    const planned = new Set(plan.children.map(child => child.id));
    const kids = allKids.filter(kid => planned.has(kid.id));
    const known = new Set(kids.map(kid => kid.id));
    const unfinished = kids.filter(kid => kid.finishedAt === null);
    const ended = kids.filter(kid => kid.finishedAt !== null);
    const pending = plan.children.filter(child => !known.has(child.id));
    const free =
      node.kind === 'map' && node.concurrency !== undefined ? node.concurrency - unfinished.length : pending.length;
    const startNext = () => {
      if (pending.length > 0 && free > 0) moves.starts = { plan, children: pending.slice(0, free) };
      return [];
    };
    const describe = (kid: (typeof kids)[number]) => `child run ${kid.id} ${kid.state}`;

    if (node.kind === 'map' && node.wait === 'any') {
      const winner = ended
        .filter(kid => kid.state === 'completed')
        .sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0) || a.id.localeCompare(b.id))[0];
      if (winner === undefined) {
        if (unfinished.length === 0 && pending.length === 0) {
          return deadNode(tx, def, parent, plan.path, `no child of map '${plan.path}' completed`, at);
        }
        return startNext();
      }
      // The first to complete wins. The others are cancelled, and the node completes once each has cleaned up.
      moves.stops.push(...unfinished.filter(kid => isLive(kid.state)).map(kid => kid.id));
      if (unfinished.length > 0) return [];
      return completeChildren(tx, def, index, parent, plan, [winner.id], false, at);
    }

    const bad = ended.find(kid => kid.state !== 'completed');
    if (bad !== undefined) return deadNode(tx, def, parent, plan.path, describe(bad), at);
    if (ended.length === plan.children.length) {
      return completeChildren(
        tx,
        def,
        index,
        parent,
        plan,
        plan.children.map(child => child.id),
        node.kind === 'map',
        at,
      );
    }
    return startNext();
  };

  /** Moves a child run into compensation: a live one is cancelled, a completed one is reopened to undo its own work. */
  const compensateChild = async (
    ctx: RunCtx,
    childId: string,
    reason: string,
    reopen: boolean,
  ): Promise<void | CommandFailure> => {
    const before = { parked: false };
    const written = await ctx.write(run, childId, async (row, inside) => {
      if (row === null) return [];
      const eligible = reopen ? row.state === 'completed' : isLive(row.state);
      if (!eligible) return [];
      before.parked = row.state === 'parked';
      const at = nowIso();
      return beginCompensation(
        inside.tx,
        definitionOf(row),
        row,
        at,
        [events.CancelRequested({ reason, actorId: null, at })],
        { closed: false, cause: null, cancelling: true },
      );
    });
    if (isFailure(written)) return written;
    return settle(ctx, childId, written, before.parked);
  };

  /**
   * What a compensating run asks of its child runs. Live children it waits for are cancelled. When none is live and no
   * step is in flight, the newest node to undo may be a child node: its completed children are reopened to undo
   * themselves. Both read the database, so a repeat finds the work done and does nothing.
   */
  const driveChildren = async (ctx: RunCtx, row: Row): Promise<void | CommandFailure> => {
    const kids = await kidsOf(ctx.tx, row.id);
    if (kids.length === 0) return;
    const def = definitionOf(row);
    const waitedFor = kids.filter(kid => kid.finishedAt === null && !isDetached(nodeOfBase(def, kid.parentPath ?? '')));
    const live = waitedFor.filter(kid => isLive(kid.state));
    for (const kid of live) {
      const moved = await compensateChild(ctx, kid.id, `its parent run ${row.id} is stopping`, false);
      if (isFailure(moved)) return moved;
    }
    if (waitedFor.length > 0 || (await hasScheduledStep(ctx.tx, row.id))) return;
    const settled = await ctx.tx
      .select({ type: tables.events.type, data: tables.events.data })
      .from(tables.events)
      .where(settledOf(row.id))
      .orderBy(asc(tables.events.seq));
    const [top] = remainingUndos(def, settled);
    const node = def.nodes.find(candidate => candidate.name === top?.path);
    if (top === undefined || (node?.kind !== 'child' && node?.kind !== 'map') || isDetached(node)) return;
    if (node.kind === 'child' && node.undo) return;
    const base = childBase(top.path, top.visit);
    for (const kid of kids.filter(candidate => candidate.parentPath === base && candidate.state === 'completed')) {
      const moved = await compensateChild(ctx, kid.id, `its parent run ${row.id} is undoing it`, true);
      if (isFailure(moved)) return moved;
    }
    return;
  };

  /** After a write to a run: its jobs and timers, the children a compensating run must move, and the parent an ended run wakes. */
  async function settle(
    ctx: RunCtx,
    runId: string,
    written: Written,
    wasParked: boolean,
  ): Promise<void | CommandFailure> {
    await queueJobs(ctx.tx, runId, written.events);
    const ended = endedBy(written.events);
    const cancelled = await cancelTimers(ctx.tx, runId, {
      park: wasParked && ended.park,
      deadline: ended.deadline,
      queue: ended.queue,
    });
    if (isFailure(cancelled)) return cancelled;
    const { row } = written;
    // Only a run whose shape has an event wait touches the table, so an app that uses none needs no migration for it.
    if (wasParked && ended.park && row?.shape.nodes.some(node => node.kind === 'eventWait')) {
      await ctx.tx.delete(workflowWaits).where(eq(workflowWaits.runId, runId));
    }
    if (row === null || written.events.length === 0) return;
    if (row.state === 'compensating') {
      const moved = await driveChildren(ctx, row);
      if (isFailure(moved)) return moved;
    }
    const over = written.events.some(event => ENDS.has(event.type));
    if (over) {
      const promoted = await promoteAfterEnd(ctx, row);
      if (isFailure(promoted)) return promoted;
    }
    if (row.parentId !== null && row.parentPath !== null && over) {
      return wakeParent(ctx, row.parentId, row.parentPath);
    }
    return;
  }

  /** The parent of an ended child looks at its node again, in the same transaction as the child's end. */
  async function wakeParent(ctx: RunCtx, parentId: string, base: string): Promise<void | CommandFailure> {
    const before = { parked: false };
    const moves: Moves = { starts: undefined, stops: [] };
    const written = await ctx.write(run, parentId, async (parent, inside) => {
      if (parent === null || parent.finishedAt !== null) return [];
      before.parked = parent.state === 'parked';
      return onChildEnded(inside.tx, parent, base, nowIso(), moves);
    });
    if (isFailure(written)) return written;
    const settled = await settle(ctx, parentId, written, before.parked);
    if (isFailure(settled)) return settled;
    for (const id of moves.stops) {
      const moved = await compensateChild(
        ctx,
        id,
        `the join of its parent run ${parentId} was won by another child`,
        false,
      );
      if (isFailure(moved)) return moved;
    }
    // The parent row is there whenever children were planned: the planning ran on it.
    if (moves.starts !== undefined && written.row !== null) {
      return startChildren(ctx, written.row, moves.starts.plan, moves.starts.children);
    }
    return;
  }

  /** The node cannot go on after a child failed to start: it is dead, and `onDeadStep` decides. */
  const failChildrenNode = async (
    ctx: RunCtx,
    parentId: string,
    path: string,
    error: string,
  ): Promise<void | CommandFailure> => {
    const before = { parked: false };
    const written = await ctx.write(run, parentId, async (parent, inside) => {
      if (parent === null || parent.finishedAt !== null || parent.state !== 'parked' || parent.node !== path) return [];
      before.parked = true;
      return deadNode(inside.tx, definitionOf(parent), parent, path, error, nowIso());
    });
    if (isFailure(written)) return written;
    return settle(ctx, parentId, written, before.parked);
  };

  /**
   * Starts the planned children, by the same command `start` uses, in the transaction of the parent's own write.
   * A child that already exists (its id was started before) is attached, not started again; the parent then looks at
   * its node once, because that child may have ended already.
   */
  async function startChildren(
    ctx: RunCtx,
    parent: Pick<Row, 'id' | 'scope' | 'rootId'>,
    plan: Planned,
    children: Planned['children'],
  ): Promise<void | CommandFailure> {
    const parentId = parent.id;
    let attached = false;
    for (const child of children) {
      // A child belongs to its parent's tenant and to the tree its parent is in: the root is the run with no parent.
      const startedRun = await ctx.run(startChild, {
        def: plan.def,
        id: child.id,
        input: child.input,
        parent: { id: parentId, path: plan.base, rootId: parent.rootId ?? parentId, scope: parent.scope },
      });
      if (CommandConflict.is(startedRun) || WorkflowBusy.is(startedRun) || CommandInvalid.is(startedRun)) {
        ctx.accept(startedRun);
        return failChildrenNode(
          ctx,
          parentId,
          plan.path,
          `child run ${child.id} could not start: ${JSON.stringify(startedRun)}`,
        );
      }
      if (isFailure(startedRun)) return startedRun;
      if (!startedRun.created) attached = true;
    }
    if (attached) return wakeParent(ctx, parentId, plan.base);
    return;
  }

  const checkpoint = j.command(
    CHECKPOINT_COMMAND,
    checkpointSchema,
    { writes: runEvents },
    async (input, context): Promise<{ readonly status: 'checkpointed' | 'already' | 'settled' } | CommandFailure> => {
      const { write } = context;
      // Before `write` takes the append lock: the wake effect takes a key's lock first too, so the two cannot deadlock.
      if ('outcome' in input && input.outcome.kind === 'park') {
        const keys = (input.outcome.waits ?? []).map(wait => waitLockId(wait.entityKind, wait.entityId));
        for (const key of [...new Set(keys)].sort()) await lockExclusive(context.tx, key);
      }
      const before = { parked: false };
      const settled = { value: false };
      const planned: { value: { readonly plan: Planned; readonly room: number } | undefined } = { value: undefined };
      const written = await write(run, input.runId, async (row, inside) => {
        if (row === null || row.finishedAt !== null) return [];
        before.parked = row.state === 'parked';
        const at = nowIso();
        if ('fired' in input) return onTimer(inside.tx, row, input.fired, at);
        const [step] = await inside.tx
          .select()
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.runId, input.runId),
              eq(workflowSteps.path, input.path),
              eq(workflowSteps.phase, input.phase),
            ),
          );
        // Another checkpoint already moved this node on, or a later attempt replaced the one this answers.
        if (
          step === undefined ||
          step.attempt !== input.attempt ||
          (step.status !== 'scheduled' && step.status !== 'failed')
        ) {
          return [];
        }
        const { outcome, path, phase } = input;
        const def = definitionOf(row);
        const compensating = row.state === 'compensating';
        /** A `do` attempt that ends badly while the run compensates is not retried: the step is settled and the undos go on. */
        const failedWhileCompensating = async (error: string) => {
          settled.value = true;
          return [
            events.NodeFailed({ path, phase, attempt: input.attempt, error, at }),
            ...(await compensate(inside.tx, def, row, at, { cause: null })),
          ];
        };
        switch (outcome.kind) {
          case 'completed': {
            const completed = events.NodeCompleted({
              path,
              phase,
              result: outcome.result,
              resolvedBy: outcome.by?.actorId ?? null,
              at,
              ...(outcome.by?.reason === undefined ? {} : { reason: outcome.by.reason }),
              ...(outcome.by?.executionId === undefined ? {} : { executionId: outcome.by.executionId }),
            });
            if (compensating) {
              // A step in flight when the run began compensating: it did its work, so it is undone like the rest.
              return [
                completed,
                ...(await compensate(inside.tx, def, row, at, {
                  cause: null,
                  doneNow: { path, result: outcome.result },
                })),
              ];
            }
            return [completed, ...(await eventsAfter(inside.tx, row, outcome.route, at))];
          }
          case 'skipped': {
            if (compensating) {
              return [
                events.NodeSkipped({ path, phase, cause: 'when', reason: outcome.reason, actorId: null, at }),
                ...(await compensate(inside.tx, def, row, at, { cause: null })),
              ];
            }
            return [
              events.NodeSkipped({ path, phase, cause: 'when', reason: outcome.reason, actorId: null, at }),
              ...(await eventsAfter(inside.tx, row, outcome.route, at)),
            ];
          }
          case 'undone': {
            return [
              events.NodeCompleted({ path, phase, result: outcome.result, resolvedBy: null, at }),
              ...(await compensate(inside.tx, def, row, at, { cause: null, undoneNow: 1 })),
            ];
          }
          case 'retry': {
            if (compensating && phase === 'do') return failedWhileCompensating(outcome.error);
            return [
              events.NodeFailed({ path, phase, attempt: input.attempt, error: outcome.error, at }),
              events.NodeScheduled({
                path,
                phase,
                attempt: input.attempt + 1,
                key: outcome.key,
                jobId: null,
                at: outcome.at,
                ...priorityOn(row.priority),
              }),
            ];
          }
          case 'dead': {
            if (compensating && phase === 'do') return failedWhileCompensating(outcome.error);
            const failedNode = events.NodeFailed({ path, phase, attempt: input.attempt, error: outcome.error, at });
            // An undo that keeps failing, or a dead step under `onDeadStep: 'wait'`, leaves the run for an operator.
            if (phase === 'undo' || def.onDeadStep === 'wait') return [failedNode];
            settled.value = true;
            return beginCompensation(inside.tx, def, row, at, [failedNode], { closed: true, cause: outcome.error });
          }
          case 'transition-limit': {
            if (compensating && phase === 'do') return failedWhileCompensating(outcome.error);
            const failedNode = events.NodeFailed({ path, phase, attempt: input.attempt, error: outcome.error, at });
            // Whatever `onDeadStep` says: a run that loops past its limit must end, not wait for an operator.
            settled.value = true;
            return beginCompensation(inside.tx, def, row, at, [failedNode], { closed: true, cause: outcome.error });
          }
          case 'children': {
            if (row.state === 'parked') return [];
            const node = def.nodes.find(candidate => candidate.name === path);
            if (node === undefined || (node.kind !== 'child' && node.kind !== 'map')) {
              throw new JournalError('BAD_DEFINITION', 'workflow', row.id, `"${def.name}" has no child node '${path}'`);
            }
            const dropped = events.NodeSkipped({
              path,
              phase: 'do',
              cause: 'compensating',
              reason: COMPENSATING,
              actorId: null,
              at,
            });
            // The run began compensating while the children were being worked out: no child is started.
            if (compensating) return [dropped, ...(await compensate(inside.tx, def, row, at, { cause: null }))];
            if (pastDeadline(row)) {
              return beginCompensation(inside.tx, def, row, at, [events.DeadlineReached({ at }), dropped], {
                closed: true,
                cause: 'the run deadline passed before it finished',
              });
            }
            const room =
              node.kind === 'map' && node.concurrency !== undefined ? node.concurrency : outcome.plan.children.length;
            planned.value = { plan: { path, ...outcome.plan }, room };
            return [events.ChildrenPlanned({ path, ...outcome.plan, at })];
          }
          case 'park': {
            // The park of this attempt is already in: the step row stays `scheduled` while a run is parked.
            if (row.state === 'parked') return [];
            const index = def.nodes.findIndex(candidate => candidate.name === path);
            const node = def.nodes[index];
            if (node === undefined || (node.kind !== 'waitFor' && node.kind !== 'eventWait' && node.kind !== 'sleep')) {
              throw new JournalError('BAD_DEFINITION', 'workflow', row.id, `"${def.name}" has no wait node '${path}'`);
            }
            const dropped = events.NodeSkipped({
              path,
              phase: 'do',
              cause: 'compensating',
              reason: COMPENSATING,
              actorId: null,
              at,
            });
            // The run began compensating while this wait was starting: the wait is dropped, not parked.
            if (compensating) return [dropped, ...(await compensate(inside.tx, def, row, at, { cause: null }))];
            if (pastDeadline(row)) {
              return beginCompensation(inside.tx, def, row, at, [events.DeadlineReached({ at }), dropped], {
                closed: true,
                cause: 'the run deadline passed before it finished',
              });
            }
            if (node.kind === 'waitFor') {
              // The signal came before the run got here: it was kept, and this wait takes it.
              const early = await takeSignal(inside.tx, row.id, node.signal, node.name);
              if (early !== undefined) return wakeOnSignal(inside.tx, def, index, row, early.payload, at);
            }
            if (node.kind === 'eventWait') {
              // Under the key's lock: an event that committed before this read is found here, and one that commits
              // after it runs its wake job after this commit, which finds the rows written below.
              const taken = await takenBy(inside.tx, row.id);
              const afterSeq = await waitStartOf(inside.tx, row.id, node.name, taken);
              const waits = (outcome.waits ?? []).map(wait => ({ ...wait, afterSeq }));
              const found = await oldestEligible(inside.tx, def, node, row, waits, taken);
              if (isFailure(found)) return failWait(inside.tx, def, row, node.name, reasonText(found), at);
              if (found !== undefined) return takeEvent(inside.tx, def, index, row, found, at);
              await inside.tx
                .insert(workflowWaits)
                .values(waits.map(wait => ({ ...wait, runId: row.id, node: node.name })));
            }
            return [
              events.Parked({
                node: path,
                waitingFor: outcome.waitingFor,
                wakeAt: outcome.wakeAt,
                ...priorityOn(row.priority),
                at,
              }),
            ];
          }
          case 'dropped': {
            settled.value = true;
            return [
              events.NodeSkipped({ path, phase, cause: 'compensating', reason: COMPENSATING, actorId: null, at }),
              ...(await compensate(inside.tx, def, row, at, { cause: null })),
            ];
          }
          case 'expired': {
            // Checked again under the run's lock: a reschedule or a cancel may have come between.
            if (!(await expiresNow(inside.tx, row, { path, phase, attempt: input.attempt }))) return [];
            settled.value = true;
            return [
              events.NodeSkipped({ path, phase, cause: 'expired', reason: EXPIRED, actorId: null, at }),
              events.RunExpired({ at, keepUntil: keepUntilFor(def, 'expired') }),
            ];
          }
        }
      });
      if (isFailure(written)) return written;
      const settlement = await settle(context, input.runId, written, before.parked);
      if (isFailure(settlement)) return settlement;
      // The run row is there whenever children were planned: the planning ran on it.
      if (planned.value !== undefined && written.row !== null) {
        const { plan, room } = planned.value;
        const started = await startChildren(context, written.row, plan, plan.children.slice(0, room));
        if (isFailure(started)) return started;
      }
      if (written.events.length === 0) return { status: 'already' };
      return { status: settled.value ? 'settled' : 'checkpointed' };
    },
  );

  /** The limits a start of `def` holds, sorted by name, the order the gate locks them in: its own and the shared ones. */
  const heldLimitsOf = (def: WorkflowDef): HeldLimit[] =>
    [
      {
        name: workflowLimitName(def.name),
        total: def.concurrency?.total,
        perKey: def.concurrency?.limit,
        workflow: def.name,
      },
      ...(def.concurrency?.shared ?? []).map(shared => ({
        name: shared.name,
        total: shared.total,
        perKey: shared.perKey,
        workflow: undefined,
      })),
    ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  /**
   * Starts the oldest queued runs that hold one of `among` (with `key`, when given) and now fit, in the transaction of
   * the change that may have freed a slot. Each candidate passes the same gate a start passes (`limitGate.blocking`,
   * with its locks), oldest first by when it was queued. One that does not fit stays queued, and the queued runs the
   * same busy limit blocks (of the same key, for a `perKey`) are left out of the next look: FIFO holds per key, and
   * other keys go on. At most `LIMIT_BOUNDS.promoteTries` candidates are checked per call; the rest wait for the next
   * run end or operator change. A promoted run is dequeued and its first node is due at its `start_at`, or now.
   */
  const promoteQueued = async (
    ctx: RunCtx,
    among: readonly HeldLimit[],
    key: string | null,
    skips: PromoteSkip[],
  ): Promise<void | CommandFailure> => {
    for (let tried = 0; tried < LIMIT_BOUNDS.promoteTries; tried++) {
      const id = await limitGate.oldestQueued(ctx.tx, among, key, skips);
      if (id === undefined) return;
      const blocked: { value: PromoteSkip } = { value: { id } };
      const written = await ctx.write(run, id, async (row, inside) => {
        if (row === null || row.state !== 'queued') return [];
        // A stranded run has no code to check its limits with: it stays queued until its code is back.
        const code = codeOf(row, started);
        const first = row.shape.nodes[0]?.name;
        if (code instanceof JournalError || first === undefined) return [];
        const held = heldLimitsOf(code);
        // Lock order: this transaction already holds the locks of the run that ended (or of the verb's limit), and the
        // candidate's other locks may sort before them. So they are only tried, never waited for: one that another
        // transaction holds leaves the candidate queued (skipped by id), and a later change or the limit timer
        // promotes it. Waiting could deadlock with a transaction that holds that lock and waits for one of ours.
        const block = await limitGate.tryBlocking(inside.tx, { held, key: row.concurrencyKey, gated: true });
        if (block === 'locked') return [];
        if (block !== undefined) {
          blocked.value = { limit: block.limit, key: block.scale === 'perKey' ? row.concurrencyKey : null };
          return [];
        }
        const now = new Date();
        const due = row.startAt !== null && row.startAt.getTime() > now.getTime() ? row.startAt : now;
        return [
          events.RunDequeued({ at: now.toISOString() }),
          events.NodeScheduled({
            path: first,
            phase: 'do',
            attempt: 1,
            key: firstKeyOf(row.id, first),
            jobId: null,
            at: due.toISOString(),
            ...priorityOn(row.priority),
          }),
        ];
      });
      if (isFailure(written)) return written;
      if (written.events.length === 0) {
        skips.push(blocked.value);
        continue;
      }
      debugWorkflow.debug('run {runId} dequeued: its limits have room', { runId: id });
      const settled = await settle(ctx, id, written, false);
      if (isFailure(settled)) return settled;
    }
    return;
  };

  /**
   * A run ended, so the slots it held are free: the queued runs of its key go first (its `perKey` slot is theirs),
   * then any that hold one of its limits (a `total` slot). It first takes the locks a start of its workflow and key
   * takes, so a start that queues at the same moment either finds the slot free or is seen here.
   */
  const promoteAfterEnd = async (ctx: RunCtx, row: Row): Promise<void | CommandFailure> => {
    // With no workflow that queues, no run can be queued: an app that never queues pays nothing at a run end. A
    // `with-event` start queues too, whatever its `onBusy`, because nothing may refuse the business transaction.
    if (
      ![...started.values()].some(def => def.concurrency?.onBusy === 'queue' || def.startOn?.timing === 'with-event')
    ) {
      return;
    }
    const code = codeOf(row, started);
    // A run of a workflow without `concurrency` holds no slot, so its end frees none.
    if (code instanceof JournalError || code.concurrency === undefined) return;
    const among = heldLimitsOf(code);
    await limitGate.blocking(ctx.tx, { held: among, key: row.concurrencyKey, gated: true });
    const skips: PromoteSkip[] = [];
    if (row.concurrencyKey !== null) {
      const sameKey = await promoteQueued(ctx, among, row.concurrencyKey, skips);
      if (isFailure(sameKey)) return sameKey;
    }
    return promoteQueued(ctx, among, null, skips);
  };

  /**
   * The start gate. `limitGate.blocking` says which limit, if any, blocks the start (see there for the locks): a
   * paused one, or one whose `total` or `perKey` is full; parked runs count, they hold their slot until they end, and
   * queued runs do not. No block gives `undefined`: the start goes on. It runs inside the start's write, after the
   * append lock every journal write takes first, so its limit locks come after it as they do for a run end that frees
   * a slot (`promoteAfterEnd`): the two never wait on each other in opposite orders. A start of a run that already
   * exists never gets here: the write finds its row. When the workflow's own `perKey` is full, `onBusy: 'join'`
   * answers the oldest running run of that key; anything else is `WorkflowBusy`. A child always gets `WorkflowBusy`:
   * the run it would join reports to another parent. A pause offers no join. With `onBusy: 'queue'`, any block (full
   * or paused, a top run or a child) gives `{ queue }`: the run is created `queued` and waits for a slot. So does any
   * block that would refuse a `with-event` start (`refusal: 'queue'`): that start sits in the business transaction.
   * A limit counts every run that holds it, whatever its scope: an app may cap a key across tenants. What the caller
   * gets back never crosses its scope: it joins only a run of its own scope (else `WorkflowBusy`), and
   * `WorkflowBusy.running` lists only its own scope's runs, since the key comes from input another tenant can share.
   */
  type AdmissionRefusal = 'refuse' | 'queue';
  const admit = async (
    tx: Tx,
    def: WorkflowDef,
    key: string | null,
    parent: { readonly id: string; readonly path: string } | undefined,
    scope: string | null,
    refusal: AdmissionRefusal,
  ): Promise<
    { readonly runId: string; readonly created: false } | { readonly queue: LimitBlock } | WorkflowBusy | undefined
  > => {
    const block = await limitGate.blocking(tx, { held: heldLimitsOf(def), key, gated: def.concurrency !== undefined });
    if (block === undefined) return undefined;
    if (def.concurrency?.onBusy === 'queue') return { queue: block };
    const limitName = block.limit.name;
    if (block.reason === 'paused') {
      if (refusal === 'queue') return { queue: block };
      return WorkflowBusy({
        name: def.name,
        key,
        limit: 0,
        running: [],
        limitName,
        reason: 'paused',
        detail: `limit "${limitName}" is paused; it admits no new run of workflow "${def.name}" until it is resumed`,
      });
    }
    const ownScope = await limitGate.holdersIn(tx, block, key, scope);
    const oldest = ownScope[0];
    const ownPerKey = block.scale === 'perKey' && block.limit.workflow !== undefined;
    if (ownPerKey && def.concurrency?.onBusy === 'join' && parent === undefined && oldest !== undefined) {
      debugWorkflow.debug('{name}: key {key} is busy; the start joins run {runId}', {
        name: def.name,
        key,
        runId: oldest,
      });
      return { runId: oldest, created: false };
    }
    if (refusal === 'queue') return { queue: block };
    const keyed = block.scale === 'perKey' ? ` with concurrency key "${key ?? ''}"` : '';
    return WorkflowBusy({
      name: def.name,
      key,
      limit: block.value,
      running: ownScope,
      limitName,
      reason: 'full',
      detail: ownPerKey
        ? `workflow "${def.name}" already has ${block.value} unfinished run(s)${keyed}`
        : `limit "${limitName}" already has ${block.value} unfinished run(s)${keyed}`,
    });
  };

  /**
   * Starts a run of `def` with an input that is already checked. The id is the key: the same start again is the same
   * run (`created` is false); another workflow or another input under that id is a refusal. A child run is started by
   * its parent's checkpoint, with `parent` set: it takes the parent's `scope` and tree (`rootId`), and no tags,
   * metadata, delay, ttl or overrides of its own. A delay makes the first node due later; the deadline counts from then.
   * `batchId` is set by `startBatch`, and `replayOf` with the operator (`by`) by `replay`. `refusal` says what a limit
   * that would refuse does instead (`admit`).
   */
  const startRun = async (
    def: WorkflowDef,
    { write, tx }: Pick<RunCtx, 'write' | 'tx'>,
    args: { readonly input: unknown; readonly id?: string | undefined } & RunFields &
      RunTiming &
      RunOverrides & {
        readonly batchId?: string;
        readonly replayOf?: string;
        readonly by?: ReturnType<typeof operatorOf>;
      },
    how: {
      readonly parent?: {
        readonly id: string;
        readonly path: string;
        readonly rootId: string;
        readonly scope: string | null;
      };
      readonly refusal?: AdmissionRefusal;
      /** The seq of the event that started the run, for a `startOn` start. */
      readonly trigger?: number;
    } = {},
  ): Promise<
    | { readonly runId: string; readonly created: boolean }
    | CommandConflict
    | WorkflowBusy
    | CommandInvalid
    | CommandFailure
  > => {
    const { parent, refusal = 'refuse', trigger } = how;
    if (!started.has(`${def.name}@${def.version}`)) {
      throw new JournalError(
        'WORKFLOW_UNKNOWN',
        'workflow',
        def.name,
        `workflow "${def.name}" v${def.version} is not registered; pass it to compose({ workflows })`,
      );
    }
    // A new run starts the newest version. A child starts the version its parent's code names, so a parent of an older version keeps working.
    if (parent === undefined && def.version < newestVersionOf(def.name)) {
      throw new JournalError(
        'WORKFLOW_VERSION_RETIRED',
        'workflow',
        def.name,
        `workflow "${def.name}" v${def.version} no longer starts runs: v${newestVersionOf(def.name)} is registered`,
      );
    }
    const first = def.nodes[0];
    if (first === undefined) throw new JournalError('BAD_DEFINITION', 'workflow', def.name, 'a workflow needs a node');
    const stored = storable(args.input, def.limits.payload, 'the input', def.name);
    if (stored instanceof JournalError) return CommandConflict({ detail: stored.message });
    const metadata = storable(
      args.metadata ?? {},
      RUN_FIELD_LIMITS.metadataBytes,
      'the metadata',
      def.name,
      'the metadata limit',
    );
    if (metadata instanceof JournalError) {
      return CommandInvalid({ detail: metadata.message });
    }
    const scope = parent === undefined ? (args.scope ?? null) : parent.scope;
    const runId = args.id ?? workflowRunId();
    if (isFailure(runId)) return runId;
    const concurrencyKey = concurrencyKeyOf(def, args.input);
    // What the gate said, read after the write: the run it joins, or the limit it queues on.
    const gate: { joined?: string; queuedOn?: LimitBlock } = {};
    const sharedLimits = (def.concurrency?.shared ?? []).map(shared => shared.name);
    const now = new Date();
    const at = now.toISOString();
    // A child starts when its parent gets to it, so only a top run has a delay or a ttl.
    const timing = startTiming(parent === undefined ? args : {}, now);
    // Overrides belong to the run that was started with them: a child runs as its definition says.
    const overrides = storedOverrides(parent === undefined ? args : {});
    const written = await write(machine.run, runId, async (row, inside) => {
      if (row !== null) return [];
      const admitted = await admit(inside.tx, def, concurrencyKey, parent, scope, refusal);
      if (WorkflowBusy.is(admitted)) return admitted;
      if (admitted !== undefined && 'runId' in admitted) {
        gate.joined = admitted.runId;
        return [];
      }
      const queuedOn = admitted?.queue;
      gate.queuedOn = queuedOn;
      return [
        machine.events.RunStarted({
          name: def.name,
          workflowVersion: def.version,
          shape: def.shape,
          shapeHash: def.shapeHash,
          input: stored.value,
          deadlineAt:
            def.deadline === undefined ? null : new Date(timing.due.getTime() + parseAge(def.deadline)).toISOString(),
          parentId: parent?.id ?? null,
          parentPath: parent?.path ?? null,
          concurrencyKey,
          scope,
          tags: args.tags ?? [],
          metadata: args.metadata ?? {},
          rootId: parent?.rootId ?? null,
          startAt: timing.startAt?.toISOString() ?? null,
          ttlAt: timing.ttlAt?.toISOString() ?? null,
          ttlMs: timing.ttlMs,
          ...overrides,
          // Left out when unset, so a plain start's event stays as it was before batches, replays and limits.
          ...(sharedLimits.length === 0 ? {} : { limits: sharedLimits }),
          ...(trigger === undefined ? {} : { triggerSeq: trigger }),
          ...(args.batchId === undefined ? {} : { batchId: args.batchId }),
          ...(args.replayOf === undefined ? {} : { replayOf: args.replayOf }),
          ...args.by,
          at,
        }),
        // A queued run schedules no node: a freed slot dequeues it and schedules its first node then.
        queuedOn === undefined
          ? // `at` is when the node is due, so its job waits out the delay.
            machine.events.NodeScheduled({
              path: first.name,
              phase: 'do',
              attempt: 1,
              key: firstKeyOf(runId, first.name),
              jobId: null,
              at: timing.due.toISOString(),
              ...priorityOn(overrides.priority),
            })
          : machine.events.RunQueued({
              limitName: queuedOn.limit.name,
              reason: queuedOn.reason,
              ttlAt: timing.ttlAt?.toISOString() ?? null,
              ...priorityOn(overrides.priority),
              at,
            }),
      ];
    });
    if (isFailure(written)) return written;
    if (gate.joined !== undefined) return { runId: gate.joined, created: false };
    const { row } = written;
    const { queuedOn } = gate;
    // The id is taken. The same start again is the same run; another workflow or another input is not.
    if (written.events.length === 0) {
      if (
        row === null ||
        row.name !== def.name ||
        row.workflowVersion !== def.version ||
        !sameValue(row.input, stored.value) ||
        row.parentId !== (parent?.id ?? null) ||
        row.parentPath !== (parent?.path ?? null) ||
        row.scope !== scope
      ) {
        return CommandConflict({ detail: `run id "${runId}" already belongs to another run` });
      }
      return { runId, created: false };
    }
    await queueJobs(tx, runId, written.events);
    if (queuedOn !== undefined) {
      debugWorkflow.debug('{name} v{version}: run {runId} queued: limit {limitName} is {reason}', {
        name: def.name,
        version: def.version,
        runId,
        limitName: queuedOn.limit.name,
        reason: queuedOn.reason,
      });
      return { runId, created: true };
    }
    debugWorkflow.debug('{name} v{version}: run {runId} started', { name: def.name, version: def.version, runId });
    return { runId, created: true };
  };

  const startCommandFor = <Input extends StandardSchemaV1>(def: WorkflowDef<Input>) =>
    j.command(
      `${def.name}.start`,
      startSchema(def.input),
      { writes: runEvents },
      async (args, context): Promise<StartOutcome | CommandFailure> => {
        const outcome = await startRun(def, context, args);
        return isFailure(outcome) ? outcome : { runId: outcome.runId };
      },
    );

  /**
   * The start a `startOn` job runs: `def.start`, and the seq of the event that started the run, where its event waits
   * begin to count. Not on the definition: only the event knows that seq.
   */
  const startOnCommandFor = (def: WorkflowDef) =>
    j.command(
      `${def.name}.startOn`,
      z.object({ trigger: z.int().positive(), start: z.unknown() }),
      { writes: runEvents },
      async ({ trigger, start }, context): Promise<StartOutcome | AsyncSchemaFailure | CommandFailure> => {
        const args = await parseAsync(startSchema(def.input), start);
        if (isFailure(args)) return args;
        const outcome = await startRun(def, context, args, { trigger });
        return isFailure(outcome) ? outcome : { runId: outcome.runId };
      },
    );

  /**
   * `def.startBatch`. Each item runs as its own command (`ctx.run`), so it has its own savepoint: a refused item rolls
   * back only what it wrote, is accepted here, and is that item's outcome. The items take turns, in order.
   */
  const startBatchCommandFor = <Input extends StandardSchemaV1>(def: WorkflowDef<Input>) => {
    const startItem = j.command(
      `${def.name}.startBatchItem`,
      batchItemSchema,
      { writes: runEvents },
      async (args, context): Promise<StartOutcome | CommandFailure> => {
        const outcome = await startRun(def, context, {
          ...args.item,
          ...args.fields,
          ...args.timing,
          ...args.overrides,
          batchId: args.batchId,
        });
        return isFailure(outcome) ? outcome : { runId: outcome.runId };
      },
    );
    return j.command(
      `${def.name}.startBatch`,
      startBatchSchema(def.input),
      { writes: [] },
      async (args, context): Promise<StartBatchOutcome | CommandFailure> => {
        const batchId = args.batchId ?? workflowBatchId();
        if (isFailure(batchId)) return batchId;
        const runs: StartOutcome[] = [];
        for (const { input, id, scope, tags, metadata, delay, ttl, maxAttempts, timeout, priority } of args.items) {
          const outcome = await context.run(startItem, {
            batchId,
            item: { input, id },
            fields: { scope, tags, metadata },
            timing: { delay, ttl },
            overrides: { maxAttempts, timeout, priority },
          });
          // A refused item is that item's outcome: its savepoint rolled back, and the other items stand. Any other
          // failure is not about the item, and ends the batch.
          if (WorkflowBusy.is(outcome) || CommandConflict.is(outcome) || CommandInvalid.is(outcome)) {
            context.accept(outcome);
          } else if (isFailure(outcome)) {
            return outcome;
          }
          runs.push(outcome);
        }
        return { batchId, runs };
      },
    );
  };

  /** The command a parent's checkpoint runs for each child: `start` with the parent recorded. Internal. */
  const startChild = j.command(
    START_CHILD_COMMAND,
    startChildSchema,
    { writes: runEvents },
    async (
      args,
      context,
    ): Promise<
      | { readonly runId: string; readonly created: boolean }
      | CommandConflict
      | WorkflowBusy
      | CommandInvalid
      | CommandFailure
    > => {
      const def = started.get(`${args.def.name}@${args.def.version}`);
      if (def === undefined) {
        throw new JournalError(
          'WORKFLOW_UNKNOWN',
          'workflow',
          args.def.name,
          `no registered workflow "${args.def.name}" v${args.def.version}`,
        );
      }
      return startRun(def, context, { input: args.input, id: args.id }, { parent: args.parent });
    },
  );

  /** What `def.signal(name)` and `journal.workflows.signal` run with. */
  type DoorContext = RunCtx & Pick<CommandContext<MetaOut, Tx>, 'meta'>;

  /**
   * Delivers signal `name` to a run: the body of `def.signal(name)` and of the operator verb `journal.workflows.signal`.
   * `workflowName` is the name of the caller's definition: for it, a run that does not exist or belongs to another
   * workflow is `no-run` (a webhook names runs that are gone; a refusal would be resent forever). The operator door
   * passes null and names a specific run, so an unknown run is a refusal. Either way the run's own version checks the payload.
   */
  async function deliverSignal(
    context: DoorContext,
    args: { readonly runId: string; readonly deliveryId: string; readonly payload: unknown },
    name: string,
    workflowName: string | null,
    operator: OperationInput | null,
  ): Promise<SignalOutcome | CommandFailure> {
    const { write } = context;
    const result: { status: SignalStatus } = { status: 'kept' };
    const before = { parked: false };
    const written = await write(run, args.runId, async (row, inside) => {
      if (workflowName !== null && (row === null || row.name !== workflowName)) {
        result.status = 'no-run';
        return [];
      }
      if (row === null) return CommandNotFound({ detail: `no workflow run "${args.runId}"` });
      // A signal for a finished run is dropped: a late webhook is not an error the sender should retry.
      if (row.finishedAt !== null) {
        result.status = 'finished';
        return [];
      }
      // The run's own version handles the signal, whichever version's `signal` command the caller used.
      const own = definitionOf(row);
      const ownWait = own.nodes.find(node => node.kind === 'waitFor' && node.signal === name);
      if (ownWait === undefined || ownWait.kind !== 'waitFor') {
        return CommandConflict({
          detail: `run "${args.runId}" is v${row.workflowVersion}, which has no wait for signal '${name}'`,
        });
      }
      // A payload the wait would refuse is refused at the door, so a bad webhook cannot fail the run.
      const stored = storable(args.payload, own.limits.payload, `the payload of signal '${name}'`, args.runId);
      if (stored instanceof JournalError) return CommandInvalid({ detail: stored.message });
      const parsed = await parseAsync(ownWait.schema, stored.value);
      if (InvalidInput.is(parsed)) {
        return CommandInvalid({ detail: `signal '${name}' payload: ${reasonText(parsed)}` });
      }
      if (ValidatorDefect.is(parsed)) return parsed;
      const signalId = workflowSignalId();
      if (isFailure(signalId)) return signalId;
      const [inserted] = await inside.tx
        .insert(workflowSignals)
        .values({
          id: signalId,
          runId: row.id,
          name,
          deliveryId: args.deliveryId,
          payload: stored.value,
        })
        .onConflictDoNothing()
        .returning({ id: workflowSignals.id });
      if (inserted === undefined) {
        result.status = 'duplicate';
        return [];
      }
      before.parked = row.state === 'parked';
      const at = nowIso();
      const received = events.SignalReceived({
        name,
        deliveryId: args.deliveryId,
        at,
        ...(operator === null ? {} : operatorOf(operator)),
      });
      if (pastDeadline(row) && row.state !== 'compensating') {
        const expired = await deadlineEvents(inside.tx, own, row, at);
        if (isFailure(expired)) return expired;
        return [received, ...expired];
      }
      const index =
        row.state === 'parked' && row.waitingFor === name ? own.nodes.findIndex(n => n.name === row.node) : -1;
      const node = own.nodes[index];
      if (node === undefined || node.kind !== 'waitFor' || node.signal !== name) return [received];
      // The run waits for this signal: it is taken now, and the run moves on in this same commit.
      await takeSignal(inside.tx, row.id, name, node.name);
      result.status = 'woke';
      const woke = await wakeOnSignal(inside.tx, own, index, row, stored.value, at);
      if (isFailure(woke)) return woke;
      return [received, ...woke];
    });
    if (isFailure(written)) return written;
    const settlement = await settle(context, args.runId, written, before.parked);
    if (isFailure(settlement)) return settlement;
    return result;
  }

  /**
   * The runs parked on an event, read under the key's lock: a park holds that lock until it commits, so a park this read
   * misses reads the log after this lock is free, and finds the event there. `seq` leaves out the waits that start
   * after it, such as a run this very event started.
   */
  const waitersOf = j.command(WAITERS_COMMAND, waitersSchema, { writes: [] }, async (input, context) => {
    await lockExclusive(context.tx, waitLockId(input.entityKind, input.entityId));
    const rows = await context.tx
      .select({ runId: workflowWaits.runId, node: workflowWaits.node })
      .from(workflowWaits)
      .where(
        and(
          eq(workflowWaits.entityKind, input.entityKind),
          eq(workflowWaits.entityId, input.entityId),
          sql`${input.type} = any(${workflowWaits.types})`,
          lt(workflowWaits.afterSeq, input.seq),
        ),
      );
    // Two labels of one wait can watch one entity: the run is woken once.
    return [...new Map(rows.map(row => [`${row.runId}:${row.node}`, row])).values()];
  });

  /**
   * Wakes one parked run on what the log holds for its wait. It contends on the run row with the wait's timer, so one of
   * them moves the run and the other finds it moved. A repeat of the event's job finds the event taken.
   */
  const wakeWait = j.command(
    WAKE_COMMAND,
    wakeWaitSchema,
    { writes: runEvents },
    async (input, context): Promise<void | CommandFailure> => {
      const before = { parked: false };
      const written = await context.write(run, input.runId, async (row, inside) => {
        if (row === null || row.state !== 'parked' || row.node !== input.node) return [];
        const def = definitionOf(row);
        const index = def.nodes.findIndex(candidate => candidate.name === input.node);
        const node = def.nodes[index];
        if (node?.kind !== 'eventWait') {
          throw new JournalError('BAD_DEFINITION', 'workflow', row.id, `"${def.name}" has no event wait '${input.node}'`);
        }
        before.parked = true;
        const at = nowIso();
        if (pastDeadline(row)) return deadlineEvents(inside.tx, def, row, at);
        return wakeOnEvent(inside.tx, def, index, node, row, at);
      });
      if (isFailure(written)) return written;
      return settle(context, input.runId, written, before.parked);
    },
  );

  /** `def.signal(name)`: the command that delivers one of the definition's signals. */
  const signalCommandFor = <Signals extends AnySignals>(def: WorkflowDef<StandardSchemaV1, unknown, Signals>) =>
    function signal<Name extends keyof Signals & string>(name: Name) {
      // One signal name has one payload schema, which `define` enforces: the first node that waits for it has it.
      const waiting = def.nodes.find(node => node.kind === 'waitFor' && node.signal === name);
      if (waiting === undefined || waiting.kind !== 'waitFor') {
        throw new JournalError('BAD_DEFINITION', 'workflow', def.name, `no waitFor node waits for signal '${name}'`);
      }
      return j.command(
        `${def.name}.signal.${name}`,
        signalSchemaFor<Signals[Name]>(),
        { writes: runEvents },
        (args, context) => deliverSignal(context, args, name, def.name, null),
      );
    };

  /**
   * Cancels a run: the body of `def.cancel` and of the operator verb `journal.workflows.cancel`. `workflowName` as for
   * `deliverSignal`; `actorId` is who asked (the meta's `actorId` for `def.cancel`, `op.actor` for the verb).
   */
  async function cancelRun(
    context: DoorContext,
    args: CancelArgs,
    workflowName: string | null,
    actorId: string | null,
  ): Promise<CancelOutcome | CommandFailure> {
    const { write } = context;
    const before = { parked: false };
    const written = await write(run, args.runId, async (row, inside) => {
      if (row === null) return CommandNotFound({ detail: `no workflow run "${args.runId}"` });
      if (workflowName !== null && row.name !== workflowName) {
        return CommandConflict({ detail: `run "${args.runId}" belongs to another workflow` });
      }
      if (row.finishedAt !== null) {
        return CommandConflict({ detail: `run "${args.runId}" is already ${row.state}` });
      }
      if (row.state === 'compensating') {
        return CommandConflict({ detail: `run "${args.runId}" is already compensating` });
      }
      // The run's own version undoes its work. A stranded run has no code to do that: the cancel is refused, not half done.
      const own = definitionOf(row);
      before.parked = row.state === 'parked';
      const at = nowIso();
      return beginCompensation(
        inside.tx,
        own,
        row,
        at,
        [
          events.CancelRequested({
            reason: args.reason,
            actorId,
            ...(args.executionId === undefined ? {} : { executionId: args.executionId }),
            at,
          }),
        ],
        { closed: false, cause: null, cancelling: true, executionId: args.executionId },
      );
    });
    if (isFailure(written)) return written;
    const settlement = await settle(context, args.runId, written, before.parked);
    if (isFailure(settlement)) return settlement;
    debugWorkflow.debug('run {runId} cancel requested', { runId: args.runId });
    return { state: written.events.some(event => event.type === 'RunCancelled') ? 'cancelled' : 'compensating' };
  }

  /** `def.cancel`: stops a run, undoes what it completed, newest first, and ends it `cancelled`. */
  const cancelCommandFor = (def: WorkflowDef) =>
    j.command(`${def.name}.cancel`, cancelSchema, { writes: runEvents }, (args, context) =>
      cancelRun(context, args, def.name, typeof context.meta['actorId'] === 'string' ? context.meta['actorId'] : null),
    );

  // ---- metadata and tags --------------------------------------------------------------------------------------

  /**
   * Changes a run's metadata: the body of `ctx.metadata` and of the operator verb `journal.workflows.setMetadata`.
   * Allowed while the run is unfinished (running, parked or compensating); the run does not move. The changed metadata
   * must survive JSON and fit `RUN_FIELD_LIMITS.metadataBytes`. `operator` is null for a body's change: its event then
   * carries no operator, and its meta is the `workflowMeta`.
   */
  async function changeMetadata(
    context: Pick<CommandContext<MetaOut, Tx, typeof events.MetadataChanged>, 'write'>,
    runId: string,
    change: MetadataChange,
    operator: OperationInput | null,
  ): Promise<MetadataOutcome | CommandFailure> {
    const written = await context.write(run, runId, row => {
      if (row === null) return CommandNotFound({ detail: `no workflow run "${runId}"` });
      if (row.finishedAt !== null) return CommandConflict({ detail: `run "${runId}" is already ${row.state}` });
      const refusal = metadataRefusal(row.metadata, change);
      if (refusal !== null) return CommandInvalid({ detail: `run "${runId}": ${refusal}` });
      const kept = storable(
        changedMetadata(row.metadata, change),
        RUN_FIELD_LIMITS.metadataBytes,
        'the changed metadata',
        runId,
        'the metadata limit',
      );
      if (kept instanceof JournalError) return CommandInvalid({ detail: kept.message });
      return [events.MetadataChanged({ change, at: nowIso(), ...(operator === null ? {} : operatorOf(operator)) })];
    });
    if (isFailure(written)) return written;
    if (written.row === null) throw new JournalError('WORKFLOW_NOT_FOUND', 'workflow', runId);
    return { metadata: written.row.metadata };
  }

  /**
   * Adds tags to a run: the body of `ctx.tags.add` and of the operator verb `journal.workflows.addTags`. Tags the run
   * has already change nothing, and a call that adds none writes no event. More than `RUN_FIELD_LIMITS.tags` in all is
   * refused. `operator` as for `changeMetadata`.
   */
  async function addRunTags(
    context: Pick<CommandContext<MetaOut, Tx, typeof events.RunTagged>, 'write'>,
    runId: string,
    tags: readonly string[],
    operator: OperationInput | null,
  ): Promise<TagsOutcome | CommandFailure> {
    const written = await context.write(run, runId, row => {
      if (row === null) return CommandNotFound({ detail: `no workflow run "${runId}"` });
      if (row.finishedAt !== null) return CommandConflict({ detail: `run "${runId}" is already ${row.state}` });
      const added = newTags(row.tags, tags);
      if (added.length === 0) return [];
      const total = row.tags.length + added.length;
      if (total > RUN_FIELD_LIMITS.tags) {
        return CommandInvalid({
          detail: `run "${runId}" would have ${total} tags; the limit is ${RUN_FIELD_LIMITS.tags}`,
        });
      }
      return [events.RunTagged({ tags: added, at: nowIso(), ...(operator === null ? {} : operatorOf(operator)) })];
    });
    if (isFailure(written)) return written;
    if (written.row === null) throw new JournalError('WORKFLOW_NOT_FOUND', 'workflow', runId);
    return { tags: written.row.tags };
  }

  /** The command behind `ctx.metadata`. Internal: only a node attempt runs it, on its own run. */
  const stepMetadata = j.command(
    STEP_METADATA_COMMAND,
    stepMetadataSchema,
    { writes: [events.MetadataChanged] },
    (args, context) => changeMetadata(context, args.runId, args.change, null),
  );
  /** The command behind `ctx.tags.add`. Internal, like `stepMetadata`. */
  const stepTags = j.command(STEP_TAGS_COMMAND, stepTagsSchema, { writes: [events.RunTagged] }, (args, context) =>
    addRunTags(context, args.runId, args.tags, null),
  );

  // ---- operator verbs -----------------------------------------------------------------------------------------

  /** The locked run row, or the refusal that says why no verb applies: it does not exist, or it is over. */
  const openRun = (row: Row | null, runId: string): Row => {
    if (row === null) throw new JournalError('WORKFLOW_NOT_FOUND', 'workflow', runId);
    if (row.finishedAt !== null) {
      throw new JournalError('WORKFLOW_FINISHED', 'workflow', runId, `the run is ${row.state}`);
    }
    return row;
  };
  const stepRowOf = async (tx: Tx, runId: string, path: string, phase: StepPhase) => {
    const [step] = await tx
      .select()
      .from(workflowSteps)
      .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.path, path), eq(workflowSteps.phase, phase)));
    return step;
  };
  /**
   * Every dead job of a run, with the node it belongs to (a step, a park, or none for the deadline). A stranded run's
   * jobs die at once, so this is how an operator finds what to retry.
   */
  const deadJobsOf = async (tx: Tx, runId: string) => {
    const rows = await tx
      .select({ id: tables.jobs.id, args: tables.jobs.args })
      .from(tables.jobs)
      .where(and(eq(tables.jobs.runId, runId), sql`${tables.jobs.deadAt} IS NOT NULL`))
      .orderBy(asc(tables.jobs.deadAt), asc(tables.jobs.id));
    // The node is in the event copy the job carries; a workflow job is always an effect job.
    return rows.map(row => ({
      id: row.id,
      node: jobNodeSchema.parse(
        row.args === null
          ? {}
          : (ensure(row.args, storedEventRowSchema, { at: `journal: job ${row.id} args` }).data ?? {}),
      ),
    }));
  };
  /**
   * One savepoint around a node's command and all that must hold for its result. A failure it returns, or a throw,
   * rolls the command back too, so a failed attempt wrote nothing and the next one runs the command once. The result
   * cannot be checked before the command, so the check needs this savepoint: the command's own closed when it returned.
   */
  const inSavepoint = async (
    context: Pick<RunCtx, 'run' | 'accept'>,
    body: (inner: Pick<RunCtx, 'run' | 'accept'>) => Promise<Verdict | Failure>,
  ): Promise<Verdict> => {
    const savepoint = j.command(COMMAND_SAVEPOINT_COMMAND, z.object({}), { writes: [] }, (_args, inner) => body(inner));
    const outcome = await context.run(savepoint, {});
    if (!isFailure(outcome)) return outcome;
    // eslint-disable-next-line failure/no-blind-accept -- whatever refused the node, its failure transition commits here.
    context.accept(outcome);
    return commandFailed(outcome);
  };

  /** The `do` of a command node, on the locked run. `row.results` are live (`liveResults`). */
  const doCommand = async (
    context: Pick<RunCtx, 'run' | 'accept'>,
    def: WorkflowDef,
    index: number,
    node: CommandNode,
    row: Row,
    key: string,
  ): Promise<Verdict> => {
    // The run began compensating while this job waited: nothing ran yet, so nothing runs.
    if (row.state === 'compensating') return { kind: 'dropped' };
    const view = { runId: row.id, key, input: row.input, results: row.results };
    try {
      if (node.options.when !== undefined && !node.options.when(view)) {
        const route = await routeAt(def, index + 1, row, node.name, null);
        return isFailure(route) ? failed(route, false) : { kind: 'skipped', reason: 'when', route };
      }
    } catch (error) {
      return failed(error);
    }
    return inSavepoint(context, async inner => {
      const outcome = await inner.run(node.command, node.input(view));
      let stored: unknown;
      let live: unknown;
      if (isFailure(outcome)) {
        if (!node.accept.some(known => known.is(outcome))) return outcome;
        // The command's savepoint is rolled back and stays so: only this node goes on from the refusal.
        // eslint-disable-next-line failure/no-blind-accept -- the app's own list, checked with each `is` just above.
        inner.accept(outcome);
        const envelope = serialize(outcome, node.accept);
        if (isFailure(envelope)) return envelope;
        stored = { [REFUSED]: envelope };
        live = outcome;
      } else {
        const { output } = node.command;
        const parsed = output === undefined ? null : await parseAsync(output, outcome);
        if (isFailure(parsed)) return parsed;
        stored = parsed;
        live = parsed;
      }
      const kept = storable(stored, def.limits.payload, `the result of command '${node.name}'`, row.id);
      if (kept instanceof JournalError) throw kept;
      const route = await routeAt(def, index + 1, row, node.name, live);
      if (isFailure(route)) return route;
      return { kind: 'completed', result: kept.value, route };
    });
  };

  /** The `undo` of a command node, on the locked run. Its `result` is what the node stored, checked by its schema. */
  const undoCommand = async (
    context: Pick<RunCtx, 'run' | 'accept' | 'tx'>,
    def: WorkflowDef,
    node: CommandNode,
    row: Row,
    key: string,
  ): Promise<Verdict> => {
    const { undo } = node.options;
    if (undo === undefined) {
      throw new JournalError('BAD_DEFINITION', 'workflow', row.id, `node '${node.name}' has no undo to run`);
    }
    const settled = await context.tx
      .select({ type: tables.events.type, data: tables.events.data })
      .from(tables.events)
      .where(settledOf(row.id))
      .orderBy(asc(tables.events.seq));
    // This undo is not settled yet, so the newest step still to undo is the one it answers.
    const [done] = remainingUndos(def, settled);
    if (done === undefined || done.path !== node.name) {
      throw new JournalError('BAD_DEFINITION', 'workflow', row.id, `no completed step '${node.name}' to undo`);
    }
    const { output } = node.command;
    const result = output === undefined ? done.result : await parseAsync(output, done.result);
    if (isFailure(result)) return failed(result, false);
    const view = { runId: row.id, key, input: row.input, results: row.results, result };
    return inSavepoint(context, async inner => {
      const outcome = await inner.run(undo.command, undo.input(view));
      if (isFailure(outcome)) return outcome;
      const undoOutput = undo.command.output;
      const parsed = undoOutput === undefined ? null : await parseAsync(undoOutput, outcome);
      if (isFailure(parsed)) return parsed;
      const kept = storable(parsed, def.limits.payload, `the undo result of command '${node.name}'`, row.id);
      if (kept instanceof JournalError) throw kept;
      return { kind: 'undone', result: kept.value };
    });
  };

  /**
   * One attempt of a command node: one transaction, opened through the job's fence, holding the run's lock, the
   * command's savepoint and the checkpoint. So the command and the node's move commit together, exactly once: a crash
   * before the commit leaves neither, and a job that runs again after the commit finds the node settled. A refused
   * command rolls back its savepoint, and the failure transition commits here all the same. `dead` is the reason when
   * the node died, for the job to report.
   */
  const commandNode = j.command(
    COMMAND_NODE_COMMAND,
    commandNodeSchema,
    { writes: runEvents },
    async (
      { runId, path, phase, attempt, key },
      context,
    ): Promise<
      { readonly status: 'checkpointed' | 'already' | 'settled'; readonly dead: unknown } | CommandFailure
    > => {
      const open: { row?: Row } = {};
      // Writes nothing: it takes the run's lock, which stays until the commit, and looks at this attempt under it.
      const locked = await context.write(run, runId, async (row, inside) => {
        if (row === null || row.finishedAt !== null) return [];
        const step = await stepRowOf(inside.tx, runId, path, phase);
        if (step?.attempt === attempt && (step.status === 'scheduled' || step.status === 'failed')) open.row = row;
        return [];
      });
      if (isFailure(locked)) return locked;
      if (open.row === undefined) return { status: 'already', dead: undefined };
      const def = definitionOf(open.row);
      const index = def.nodes.findIndex(candidate => candidate.name === path);
      const node = def.nodes[index];
      if (node?.kind !== 'command') {
        throw new JournalError('BAD_DEFINITION', 'workflow', runId, `"${def.name}" has no command node '${path}'`);
      }
      const waited = await withWaitEvents(context.tx, tables, runId, def.nodes, open.row.results);
      const row = { ...open.row, results: liveResults(def, runId, waited, decodeEvent) };
      const verdict =
        phase === 'undo'
          ? await undoCommand(context, def, node, row, key)
          : await doCommand(context, def, index, node, row, key);
      if (verdict.kind === 'failed') {
        const outcome = failureOutcome(node, row.maxAttempts, verdict, attempt, key);
        const moved = await context.run(checkpoint, { runId, path, phase, attempt, outcome });
        if (isFailure(moved)) return moved;
        return { status: moved.status, dead: outcome.kind === 'dead' ? verdict.reason : undefined };
      }
      const moved = await context.run(checkpoint, { runId, path, phase, attempt, outcome: verdict });
      return isFailure(moved) ? moved : { status: moved.status, dead: undefined };
    },
  );

  /**
   * `retryStep`: a dead step runs again. A failed `do` or `undo` row gets its next attempt with the same key. A failed
   * child or map node starts its failed children again under new ids (`<id>~2`); the old runs stay as history. A step
   * whose job died because the run is stranded gets that job back, once the code is registered again.
   */
  const retryStep = j.command(
    RETRY_STEP_COMMAND,
    retryStepSchema,
    { writes: runEvents },
    async (
      args,
      context,
    ): Promise<{ readonly how: 'rescheduled' | 'childrenRestarted' | 'jobRetried' } | CommandFailure> => {
      assertOperator(args.op);
      const before = { parked: false };
      const moved: { how: 'rescheduled' | 'childrenRestarted' | 'jobRetried'; base: string | undefined } = {
        how: 'rescheduled',
        base: undefined,
      };
      const written = await context.write(run, args.runId, async (locked, inside) => {
        const row = openRun(locked, args.runId);
        before.parked = row.state === 'parked';
        const at = nowIso();
        const by = operatorOf(args.op);
        const step = await stepRowOf(inside.tx, row.id, args.path, args.phase);
        if (step === undefined) {
          throw new JournalError(
            'STEP_NOT_DEAD',
            'workflow',
            row.id,
            `step '${args.path}' (${args.phase}) has not run`,
          );
        }
        const code = codeOf(row, started);
        if (step.status === 'scheduled') {
          const dead = await deadJobsOf(inside.tx, row.id);
          if (dead.length === 0) {
            throw new JournalError(
              'STEP_NOT_DEAD',
              'workflow',
              row.id,
              `step '${args.path}' (${args.phase}) is scheduled and the run has no dead job`,
            );
          }
          if (code instanceof JournalError) throw code;
          // The code is back: every job that died with the run (steps, parks, deadline, undos) goes again.
          for (const job of dead) {
            const retried = await jobOps.retry(inside.tx, job.id, jobOperatorOf(args.op));
            if (isFailure(retried)) return retried;
          }
          moved.how = 'jobRetried';
          return dead.map(job => events.JobRetried({ jobId: job.id, node: job.node, at, ...by }));
        }
        if (step.status !== 'failed') {
          throw new JournalError(
            'STEP_NOT_DEAD',
            'workflow',
            row.id,
            `step '${args.path}' (${args.phase}) is ${step.status}`,
          );
        }
        if (code instanceof JournalError) throw code;
        if (args.phase === 'do' && row.state === 'compensating') {
          throw new JournalError(
            'WORKFLOW_COMPENSATING',
            'workflow',
            row.id,
            `step '${args.path}' failed while the run undoes its work`,
          );
        }
        if (args.phase === 'undo' && row.state !== 'compensating') {
          throw new JournalError('STEP_NOT_DEAD', 'workflow', row.id, `the run is ${row.state}, so no undo is waiting`);
        }
        const node = code.nodes.find(candidate => candidate.name === args.path);
        const plan = node?.kind === 'child' || node?.kind === 'map' ? await plannedOf(inside.tx, row.id) : undefined;
        // A child or map node that failed after its children were planned: the failed children start again.
        if (args.phase === 'do' && row.state === 'parked' && plan !== undefined && plan.path === args.path) {
          const known = await kidsOf(inside.tx, row.id);
          const kids = new Map(known.map(kid => [kid.id, kid]));
          const children = plan.children.map(child => {
            const kid = kids.get(child.id);
            const failed = kid !== undefined && kid.finishedAt !== null && kid.state !== 'completed';
            return failed ? { id: retriedChildId(row.id, child.id), input: child.input } : child;
          });
          moved.how = 'childrenRestarted';
          moved.base = plan.base;
          return [events.ChildrenPlanned({ path: args.path, base: plan.base, def: plan.def, children, at, ...by })];
        }
        if (step.key === null) {
          throw new JournalError(
            'STEP_NOT_DEAD',
            'workflow',
            row.id,
            `step '${args.path}' (${args.phase}) was never scheduled`,
          );
        }
        return [
          events.NodeScheduled({
            path: args.path,
            phase: args.phase,
            attempt: step.attempt + 1,
            key: step.key,
            jobId: null,
            at,
            ...priorityOn(row.priority),
            ...by,
          }),
        ];
      });
      if (isFailure(written)) return written;
      const settlement = await settle(context, args.runId, written, before.parked);
      if (isFailure(settlement)) return settlement;
      if (moved.base !== undefined) {
        const woken = await wakeParent(context, args.runId, moved.base);
        if (isFailure(woken)) return woken;
      }
      return { how: moved.how };
    },
  );

  /**
   * `resolveStep`: an operator gives the result of a failed `do` step, and the run carries on as if the step had
   * returned it. The result is checked with the step's `output` schema, or a command node's command's, so a node
   * without one cannot be resolved.
   * It schedules the step once more with the result in the event; the worker routes it and sends the usual
   * completed checkpoint, without running the body.
   * A step that routes with a function cannot be resolved either: the function needs the worker's services.
   */
  const resolveStep = j.command(
    RESOLVE_STEP_COMMAND,
    resolveStepSchema,
    { writes: runEvents },
    async (args, context): Promise<{ readonly runId: string } | CommandFailure> => {
      assertOperator(args.op);
      const before = { parked: false };
      const written = await context.write(run, args.runId, async (locked, inside) => {
        const row = openRun(locked, args.runId);
        before.parked = row.state === 'parked';
        if (row.state === 'compensating') {
          throw new JournalError(
            'WORKFLOW_COMPENSATING',
            'workflow',
            row.id,
            'a result cannot be given while the run undoes its work',
          );
        }
        const step = await stepRowOf(inside.tx, row.id, args.path, 'do');
        if (step?.status !== 'failed') {
          throw new JournalError(
            'STEP_NOT_DEAD',
            'workflow',
            row.id,
            `step '${args.path}' is ${step?.status ?? 'not run yet'}, not failed`,
          );
        }
        const def = definitionOf(row);
        const index = def.nodes.findIndex(candidate => candidate.name === args.path);
        const node = def.nodes[index];
        const notResolvable = (why: string) =>
          new JournalError('STEP_NOT_RESOLVABLE', 'workflow', row.id, `step '${args.path}' ${why}`);
        if (node?.kind !== 'step' && node?.kind !== 'command') throw notResolvable('is not a step');
        const output = node.kind === 'step' ? node.options.output : node.command.output;
        if (output === undefined) throw notResolvable('declares no output schema to check a result with');
        if (row.state !== 'running') throw notResolvable(`cannot be resolved while the run is ${row.state}`);
        const parsed = await parseAsync(output, args.result);
        if (isAsyncSchemaFailure(parsed)) return parsed;
        const kept = storable(parsed, def.limits.payload, `the result of step '${args.path}'`, row.id);
        if (kept instanceof JournalError) throw kept;
        const at = nowIso();
        // The worker routes: `next` may need services only it has. The result is checkpointed as a normal completion.
        if (step.key === null) throw notResolvable('was never scheduled');
        return [
          events.NodeScheduled({
            path: args.path,
            phase: 'do',
            attempt: step.attempt + 1,
            key: step.key,
            jobId: null,
            at,
            resolution: { result: kept.value },
            ...priorityOn(row.priority),
            ...operatorOf(args.op),
          }),
        ];
      });
      if (isFailure(written)) return written;
      const settlement = await settle(context, args.runId, written, before.parked);
      if (isFailure(settlement)) return settlement;
      return { runId: args.runId };
    },
  );

  /** `skipUndo`: a failed undo is given up, with the reason. The run goes on with the next undo, and the step is `residual`. */
  const skipUndo = j.command(
    SKIP_UNDO_COMMAND,
    skipUndoSchema,
    { writes: runEvents },
    async (args, context): Promise<{ readonly runId: string } | CommandFailure> => {
      assertOperator(args.op);
      const reason = args.op.reason?.trim() ?? '';
      if (reason === '') {
        throw new JournalError(
          'BAD_ARGUMENT',
          'workflow',
          'reason',
          'giving up an undo needs a `reason`: it is written on the run',
        );
      }
      const before = { parked: false };
      const written = await context.write(run, args.runId, async (locked, inside) => {
        const row = openRun(locked, args.runId);
        before.parked = row.state === 'parked';
        const step = await stepRowOf(inside.tx, row.id, args.path, 'undo');
        if (row.state !== 'compensating' || step?.status !== 'failed') {
          throw new JournalError(
            'STEP_NOT_DEAD',
            'workflow',
            row.id,
            `no failed undo of '${args.path}' is waiting on this run`,
          );
        }
        const def = definitionOf(row);
        const at = nowIso();
        return [
          events.NodeSkipped({
            path: args.path,
            phase: 'undo',
            cause: 'operator',
            reason,
            actorId: args.op.actor,
            at,
            ...(args.op.executionId === undefined ? {} : { executionId: args.op.executionId }),
          }),
          ...(await compensate(inside.tx, def, row, at, { cause: null, undoneNow: 1 })),
        ];
      });
      if (isFailure(written)) return written;
      const settlement = await settle(context, args.runId, written, before.parked);
      if (isFailure(settlement)) return settlement;
      return { runId: args.runId };
    },
  );

  /** `journal.workflows.signal`: the operator's door to `deliverSignal`, for a run of any workflow. */
  const operatorSignal = j.command(SIGNAL_COMMAND, operatorSignalSchema, { writes: runEvents }, (args, context) => {
    assertOperator(args.op);
    return deliverSignal(context, args, args.name, null, args.op);
  });

  /** `journal.workflows.cancel`: the operator's door to `cancelRun`, for a run of any workflow. */
  const operatorCancel = j.command(CANCEL_COMMAND, operatorCancelSchema, { writes: runEvents }, (args, context) => {
    assertOperator(args.op);
    const cancel = {
      runId: args.runId,
      reason: args.reason,
      ...(args.op.executionId === undefined ? {} : { executionId: args.op.executionId }),
    };
    return cancelRun(context, cancel, null, args.op.actor);
  });

  /** `journal.workflows.setMetadata`: the operator's door to `changeMetadata`. `MetadataChanged` carries the operator. */
  const setMetadata = j.command(
    SET_METADATA_COMMAND,
    setMetadataSchema,
    { writes: [events.MetadataChanged] },
    (args, context) => {
      assertOperator(args.op);
      return changeMetadata(context, args.runId, args.change, args.op);
    },
  );

  /** `journal.workflows.addTags`: the operator's door to `addRunTags`. `RunTagged` carries the operator. */
  const addTags = j.command(ADD_TAGS_COMMAND, addTagsSchema, { writes: [events.RunTagged] }, (args, context) => {
    assertOperator(args.op);
    return addRunTags(context, args.runId, args.tags, args.op);
  });

  /**
   * `journal.workflows.reschedule`: moves the start of a run whose first node has not started. The first node's job
   * becomes due at the new start, and the run's `ttl_at` and deadline move with it. `RunRescheduled` carries the
   * operator.
   */
  const reschedule = j.command(
    RESCHEDULE_COMMAND,
    rescheduleSchema,
    { writes: runEvents },
    async (args, context): Promise<RescheduleOutcome | CommandFailure> => {
      assertOperator(args.op);
      const now = new Date();
      const wanted = 'at' in args ? args.at : new Date(now.getTime() + parseAge(args.delay));
      const startAt = wanted.getTime() > now.getTime() ? wanted : now;
      const written = await context.write(run, args.runId, async (row, inside) => {
        if (row === null) return CommandNotFound({ detail: `no workflow run "${args.runId}"` });
        const started = CommandConflict({
          detail: `run "${args.runId}" has started (it is ${row.state}); only a run whose first node has not started moves`,
        });
        const first = row.shape.nodes[0]?.name;
        // A queued run has no node job yet: a freed slot schedules its first node at the new `start_at`.
        const queued = row.state === 'queued';
        if ((!queued && !notStarted(row)) || first === undefined) return started;
        if (!queued) {
          const [step] = await inside.tx
            .select({ status: workflowSteps.status, attempt: workflowSteps.attempt, jobId: workflowSteps.jobId })
            .from(workflowSteps)
            .where(and(eq(workflowSteps.runId, row.id), eq(workflowSteps.path, first), eq(workflowSteps.phase, 'do')));
          if (step?.status !== 'scheduled' || step.attempt !== 1 || step.jobId === null) return started;
          // Only a job no worker has claimed moves: one a worker holds, or has tried, may have done the node's work.
          const moved = await inside.tx
            .update(tables.jobs)
            .set({ availableAt: startAt })
            .where(
              and(
                eq(tables.jobs.id, step.jobId),
                isNull(tables.jobs.deadAt),
                isNull(tables.jobs.leaseUntil),
                eq(tables.jobs.attempts, 0),
              ),
            )
            .returning({ id: tables.jobs.id });
          if (moved.length === 0) return started;
        }
        // The deadline counts from the start, so it moves by as much. A deadline timer a worker holds is firing now.
        const shift = startAt.getTime() - (row.startAt ?? row.startedAt).getTime();
        const deadlineAt = row.deadlineAt === null ? null : new Date(row.deadlineAt.getTime() + shift);
        if (deadlineAt !== null) {
          await inside.tx
            .update(tables.jobs)
            .set({ availableAt: deadlineAt })
            .where(
              and(
                eq(tables.jobs.runId, row.id),
                eq(tables.jobs.effect, TIMER_EFFECT),
                isNull(tables.jobs.deadAt),
                isNull(tables.jobs.leaseUntil),
                sql`${tables.jobs.args}->>'type' = 'RunStarted'`,
              ),
            );
        }
        const ttlAt = row.ttlMs === null ? null : new Date(startAt.getTime() + row.ttlMs);
        // A queued run's ttl timer moves with its ttl; one a worker holds is firing now and reads `ttl_at` again.
        if (queued && ttlAt !== null) {
          await inside.tx
            .update(tables.jobs)
            .set({ availableAt: ttlAt })
            .where(
              and(
                eq(tables.jobs.runId, row.id),
                eq(tables.jobs.effect, TIMER_EFFECT),
                isNull(tables.jobs.deadAt),
                isNull(tables.jobs.leaseUntil),
                sql`${tables.jobs.args}->>'type' = 'RunQueued'`,
              ),
            );
        }
        return [
          events.RunRescheduled({
            startAt: startAt.toISOString(),
            ttlAt: ttlAt?.toISOString() ?? null,
            deadlineAt: deadlineAt?.toISOString() ?? null,
            at: now.toISOString(),
            ...operatorOf(args.op),
          }),
        ];
      });
      if (isFailure(written)) return written;
      return { startAt: startAt.toISOString() };
    },
  );

  /** A limit the registered workflows hold, or `CommandNotFound`: `journal.limits` knows no other name. */
  const limitOf = (name: string) =>
    knownLimits.get(name) ??
    CommandNotFound({
      detail: `no limit "${name}"; journal.limits.list shows the limits the registered workflows hold`,
    });

  /**
   * Writes one limit verb's events. Inside the write, after the append lock every journal write takes first, it takes
   * the limit's lock exclusive, so it waits for the starts that read the limit; once it returns, every start sees the
   * change. A change other than a pause may make room (a higher value, a reset, a resume), so the queued runs that now
   * fit start, under the same locks. It returns the limit after it.
   */
  const changeLimit = async (
    context: Pick<CommandContext<MetaOut, Tx, (typeof limitVerbEvents)[number]>, keyof RunCtx>,
    known: KnownLimit,
    op: OperationInput,
    eventsOf: (
      row: typeof tables.limits.$inferSelect | null,
      now: Date,
    ) => ReturnType<(typeof limits.events)[keyof typeof limits.events]>[],
  ): Promise<LimitView | CommandFailure> => {
    assertOperator(op);
    const now = new Date();
    const written = await context.write(limits.limit, known.name, async (row, inside) => {
      await lockExclusive(inside.tx, limitLockId(known.name));
      return eventsOf(row, now);
    });
    if (isFailure(written)) return written;
    if (written.events.some(event => event.type !== 'LimitPaused')) {
      const promoted = await promoteQueued(context, [known], null, []);
      if (isFailure(promoted)) return promoted;
    }
    return limitGate.view(context.tx, known);
  };

  /**
   * `journal.limits.override`: the `perKey` of one key until its `ttl` runs out, or the limit's own `total` and
   * `perKey` until `reset`. A workflow without `concurrency` has nothing to override, and a `perKey` needs a start with
   * a key: an override that could not apply is `CommandInvalid`, never kept and ignored.
   */
  const overrideLimit = j.command(
    LIMIT_OVERRIDE_COMMAND,
    limitOverrideSchema,
    { writes: limitVerbEvents },
    async (args, context) => {
      const known = limitOf(args.name);
      if (CommandNotFound.is(known)) return known;
      if (!known.gated) {
        return CommandInvalid({
          detail: `workflow "${known.workflow ?? known.name}" has no concurrency, so only pause and resume apply to "${known.name}"`,
        });
      }
      if (('key' in args || args.perKey !== undefined) && !known.keyed) {
        return CommandInvalid({
          detail: `no start that holds "${known.name}" has a concurrency key, so a perKey cannot apply to it`,
        });
      }
      return changeLimit(context, known, args.op, (row, now) => {
        const at = now.toISOString();
        if ('key' in args) {
          const ttl = parseAge(args.ttl ?? LIMIT_KEY_TTL.default);
          return [
            limits.events.LimitKeyOverridden({
              key: args.key,
              perKey: args.perKey,
              until: new Date(now.getTime() + ttl).toISOString(),
              expired: expiredKeys(row?.keys, now),
              at,
              ...operatorOf(args.op),
            }),
          ];
        }
        return [
          limits.events.LimitOverridden({
            ...(args.total === undefined ? {} : { total: args.total }),
            ...(args.perKey === undefined ? {} : { perKey: args.perKey }),
            at,
            ...operatorOf(args.op),
          }),
        ];
      });
    },
  );

  /** `journal.limits.reset`: the code values again, for one key or (without `key`) the whole limit. The pause stays. */
  const resetLimit = j.command(
    LIMIT_RESET_COMMAND,
    limitResetSchema,
    { writes: limitVerbEvents },
    async (args, context) => {
      const known = limitOf(args.name);
      if (CommandNotFound.is(known)) return known;
      return changeLimit(context, known, args.op, (row, now) => {
        // Nothing to reset is no change, so no event.
        if (row === null || (args.key !== undefined && row.keys[args.key] === undefined)) return [];
        return [
          limits.events.LimitReset({
            ...(args.key === undefined ? {} : { key: args.key }),
            at: now.toISOString(),
            ...operatorOf(args.op),
          }),
        ];
      });
    },
  );

  /** `journal.limits.pause`: no new run holds the limit until `resume`; the runs that hold it go on to their end. */
  const pauseLimit = j.command(
    LIMIT_PAUSE_COMMAND,
    limitNameArgsSchema,
    { writes: limitVerbEvents },
    async (args, context) => {
      const known = limitOf(args.name);
      if (CommandNotFound.is(known)) return known;
      return changeLimit(context, known, args.op, (row, now) =>
        row?.paused === true ? [] : [limits.events.LimitPaused({ at: now.toISOString(), ...operatorOf(args.op) })],
      );
    },
  );

  /** `journal.limits.resume`: the limit admits runs again, by its values. */
  const resumeLimit = j.command(
    LIMIT_RESUME_COMMAND,
    limitNameArgsSchema,
    { writes: limitVerbEvents },
    async (args, context) => {
      const known = limitOf(args.name);
      if (CommandNotFound.is(known)) return known;
      return changeLimit(context, known, args.op, (row, now) =>
        row?.paused === true ? [limits.events.LimitResumed({ at: now.toISOString(), ...operatorOf(args.op) })] : [],
      );
    },
  );

  /**
   * Run by the limit timer when a key's `perKey` override runs out: that may make room with no event of its own, so the
   * queued runs of the limit that now fit start. Each candidate is checked inside its own write, under the same locks
   * a start takes; a run queued after the override ran out was judged without it, so the look needs no lock first.
   */
  const promoteLimit = j.command(PROMOTE_COMMAND, promoteSchema, { writes: runEvents }, async (args, context) => {
    const known = knownLimits.get(args.name);
    // A limit no registered workflow holds any more has no queued run this code can check.
    if (known === undefined || !known.gated) return { name: args.name };
    const promoted = await promoteQueued(context, [known], null, []);
    return isFailure(promoted) ? promoted : { name: args.name };
  });

  /** `journal.limits.list` and `get`: the limits the registered workflows hold, as an operator sees them. */
  const limitReads: Pick<LimitOps<Tx>, 'list' | 'get'> = {
    list: db =>
      Promise.all(
        [...knownLimits.values()]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map(known => limitGate.view(db, known)),
      ),
    get: async (db, name) => {
      const known = limitOf(name);
      return CommandNotFound.is(known) ? known : limitGate.view(db, known);
    },
  };

  /**
   * `journal.workflows.replay`: a new run of the old run's workflow at the newest registered version, with the old
   * run's input, scope, tags and metadata unless `overrides` gives them. It is a start like any other: the input is
   * checked by the newest input schema (`InvalidInput` when it no longer fits), and it goes through the concurrency
   * gate. Its `RunStarted` carries `replayOf` and the operator. Children are not copied: the new run starts its own.
   */
  const replay = j.command(
    REPLAY_COMMAND,
    replaySchema,
    { writes: runEvents },
    async (args, context): Promise<StartOutcome | CommandNotFound | CommandFailure> => {
      assertOperator(args.op);
      const [row] = await context.tx.select().from(workflowRuns).where(eq(workflowRuns.id, args.runId));
      if (row === undefined) return CommandNotFound({ detail: `no workflow run "${args.runId}"` });
      const def = started.get(`${row.name}@${newestVersionOf(row.name)}`);
      if (def === undefined) {
        throw new JournalError(
          'WORKFLOW_UNKNOWN',
          'workflow',
          row.name,
          `workflow "${row.name}" is not registered; pass it to compose({ workflows }) to replay its runs`,
        );
      }
      const { overrides } = args;
      // The stored input is the old version's output; the newest version must take it as its input.
      const input = await parseAsync(def.input, overrides?.input === undefined ? row.input : overrides.input);
      if (ValidatorDefect.is(input)) return orThrow(input);
      if (InvalidInput.is(input)) return input;
      const outcome = await startRun(def, context, {
        input,
        scope: overrides?.scope ?? row.scope ?? undefined,
        tags: overrides?.tags ?? row.tags,
        metadata: overrides?.metadata ?? row.metadata,
        delay: overrides?.delay,
        ttl: overrides?.ttl,
        maxAttempts: overrides?.maxAttempts ?? row.maxAttempts ?? undefined,
        // The stored timeout is in ms, and an age in seconds names it back.
        timeout: overrides?.timeout ?? (row.stepTimeoutMs === null ? undefined : row.stepTimeoutMs / 1000),
        priority: overrides?.priority ?? row.priority ?? undefined,
        replayOf: row.id,
        by: operatorOf(args.op),
      });
      return isFailure(outcome) ? outcome : { runId: outcome.runId };
    },
  );

  /**
   * Whether `resolveStep` would take `result` for step `path` of the run: the step's `output` schema of the run's own
   * version checks it. Writes nothing. The refusals `resolveStep` would give for the step itself are thrown the same.
   */
  const checkResult = async (
    db: DbHandle,
    args: { readonly runId: string; readonly path: string; readonly result: unknown },
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly issues: string } | AsyncSchemaFailure> => {
    const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, args.runId));
    if (row === undefined) throw new JournalError('WORKFLOW_NOT_FOUND', 'workflow', args.runId);
    const node = definitionOf(row).nodes.find(candidate => candidate.name === args.path);
    if (node?.kind !== 'step' && node?.kind !== 'command') {
      throw new JournalError('STEP_NOT_RESOLVABLE', 'workflow', row.id, `step '${args.path}' is not a step`);
    }
    const output = node.kind === 'step' ? node.options.output : node.command.output;
    if (output === undefined) {
      throw new JournalError(
        'STEP_NOT_RESOLVABLE',
        'workflow',
        row.id,
        `step '${args.path}' declares no output schema to check a result with`,
      );
    }
    const parsed = await parseAsync(output, args.result);
    if (InvalidInput.is(parsed)) return { ok: false, issues: reasonText(parsed) };
    if (ValidatorDefect.is(parsed)) return parsed;
    return { ok: true };
  };

  /** The same reads as `journal.workflows`; `started` is filled by `register`, so `stranded` is right after compose. */
  const reads = createWorkflowReads({ tables, registry: started });

  /** A stored value checked with its schema: the value the schema gives, or the failure that names `field`. */
  const checkStored = async <Output>(
    schema: StandardSchemaV1<unknown, Output>,
    stored: unknown,
    runId: string,
    field: string,
  ) => {
    const parsed = await parseAsync(schema, stored);
    if (InvalidInput.is(parsed)) {
      const { message } = new JournalError(
        'WORKFLOW_READ_MISMATCH',
        'workflow',
        runId,
        `${field}: ${reasonText(parsed)}`,
      );
      return WorkflowReadMismatch({ runId, field, detail: message }, { cause: parsed });
    }
    if (ValidatorDefect.is(parsed)) return parsed;
    return { value: parsed };
  };

  /** An event wait's stored result as `def.read` gives it. A row its current schema refuses is an error to report. */
  const readWaitResult = (node: EventWaitNode, stored: unknown) => {
    try {
      return liveWaitResult(node, stored, decodeEvent);
    } catch (error) {
      if (isJournalError(error, 'REPLAY_FAILED')) return error;
      throw error;
    }
  };

  /** `def.read`: one run of `def`, its stored values checked by the schemas `def` declares. */
  const readFor =
    <Input extends StandardSchemaV1, ReadOutput, ReadResults extends AnyResults>(
      def: WorkflowDef<Input, unknown, AnySignals, Needs, ReadOutput, ReadResults>,
    ) =>
    async (db: DbHandle, runId: string): Promise<ReadOutcome<SchemaOutput<Input>, ReadOutput, ReadResults>> => {
      const detail = await reads.run(db, runId);
      if (detail === undefined || detail.run.name !== def.name) return undefined;
      const input = await checkStored<SchemaOutput<Input>>(def.input, detail.run.input, runId, 'input');
      if (WorkflowReadMismatch.is(input) || ValidatorDefect.is(input)) return input;
      /** What this read checked, for `isCheckedRead`: `output` and `results.<node>`. */
      const checkedFields = new Set<string>();
      let { output } = detail.run;
      if (def.output !== undefined && detail.run.state === 'completed') {
        const checked = await checkStored(def.output, output, runId, 'output');
        if (WorkflowReadMismatch.is(checked) || ValidatorDefect.is(checked)) return checked;
        output = checked.value;
        checkedFields.add('output');
      }
      const results: Record<string, unknown> = { ...detail.run.results };
      for (const node of def.nodes) {
        const own = resultSchemaOf(node);
        if (own === undefined || !Object.hasOwn(results, node.name)) continue;
        const field = `results.${node.name}`;
        const stored = results[node.name];
        // An accepted failure is checked by its own definition's schema, and read as a real failure.
        if (node.kind === 'command' && is(stored, refusedResultSchema)) {
          const refusal = revivedRefusal(node, stored);
          if (refusal === undefined) {
            const detail = `${field}: a failure the command's accept list does not name`;
            return WorkflowReadMismatch({ runId, field, detail });
          }
          results[node.name] = refusal;
          checkedFields.add(field);
          continue;
        }
        if (stored !== null || !own.nullable) {
          const checked = await checkStored(own.schema, stored, runId, field);
          if (WorkflowReadMismatch.is(checked) || ValidatorDefect.is(checked)) return checked;
          results[node.name] = checked.value;
          if (node.kind === 'eventWait') {
            const live = readWaitResult(node, stored);
            if (isFailure(live) || live instanceof JournalError) {
              return WorkflowReadMismatch({ runId, field, detail: `${field}: ${reasonText(live)}` });
            }
            results[node.name] = live;
          }
        }
        checkedFields.add(field);
      }
      const read: RunDetail<SchemaOutput<Input>> = {
        ...detail,
        run: { ...detail.run, input: input.value, output, results },
      };
      if (!isCheckedRead(def, read, checkedFields)) {
        throw new Error(`journal: def.read of "${def.name}" left a schema of the definition unchecked`);
      }
      return read;
    };

  /** `j.workflow`: the step-2 builder, with `start`, `signal`, `cancel` and `read` on the finished definition. */
  const workflow: JournalDefinitions<Meta, Tx, AppDb>['workflow'] = (name, options) =>
    workflowWith(name, options, def => ({
      start: startCommandFor(def),
      startBatch: startBatchCommandFor(def),
      signal: signalCommandFor(def),
      cancel: cancelCommandFor(def),
      read: readFor(def),
    }));

  /** `j.task`: `j.workflow(name, options)` with one step, `run`. */
  const task: JournalDefinitions<Meta, Tx, AppDb>['task'] = (name, options, run) =>
    taskOf(workflow(name, options), options, run);

  type StepEffectContext = OwnedEffectContext<AppDb, RootCommandRunner<Meta, Tx>> & Needed<Needs>;
  /** Every effect below runs the engine's own commands, so the worker gives it the owned context. */
  const ownedEffect = ownedEffectFor<MetaOut, AppDb, RootCommandRunner<Meta, Tx>>();

  /** How many ancestors a run has: its parent, that one's parent, and so on, counted up to the depth limit. */
  async function ancestorsOf(db: StepEffectContext['db'], row: { readonly parentId: string | null }): Promise<number> {
    let depth = 0;
    let parentId = row.parentId;
    while (parentId !== null && depth <= MAX_CHILD_DEPTH) {
      const [parent] = await db
        .select({ parentId: workflowRuns.parentId })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, parentId));
      depth++;
      parentId = parent?.parentId ?? null;
    }
    return depth;
  }

  /**
   * The limits `journal.limits` knows: every registered workflow's own (a workflow without `concurrency` can still be
   * paused), with the code values of its newest version, and every shared limit its definitions list. Two `j.limit`s
   * of one name with other values would make one count by values the other does not say, so that throws.
   */
  function registerLimits(defs: readonly WorkflowDef[]) {
    for (const def of defs) {
      if (def.version !== newestVersionOf(def.name)) continue;
      knownLimits.set(workflowLimitName(def.name), {
        name: workflowLimitName(def.name),
        total: def.concurrency?.total,
        perKey: def.concurrency?.limit,
        workflow: def.name,
        workflows: [def.name],
        gated: def.concurrency !== undefined,
        keyed: def.concurrency?.key !== undefined,
      });
    }
    for (const def of defs) {
      for (const shared of def.concurrency?.shared ?? []) {
        const known = knownLimits.get(shared.name);
        if (known !== undefined && (known.total !== shared.total || known.perKey !== shared.perKey)) {
          throw new JournalError(
            'BAD_DEFINITION',
            'limit',
            shared.name,
            `two limits are named "${shared.name}" with other values; define it once with j.limit and share that one`,
          );
        }
        const keyed = def.concurrency?.key !== undefined;
        knownLimits.set(shared.name, {
          name: shared.name,
          total: shared.total,
          perKey: shared.perKey,
          workflow: undefined,
          workflows:
            known?.workflows.includes(def.name) === true ? known.workflows : [...(known?.workflows ?? []), def.name],
          gated: true,
          keyed: keyed || known?.keyed === true,
        });
      }
    }
  }

  const runExists = async (db: DbHandle, runId: string) => {
    const rows = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, runId));
    return rows.length > 0;
  };
  const startsNothing = (def: WorkflowDef, runId: string, seq: number) =>
    debugWorkflow.debug('{name}: run {runId} exists, so event {seq} starts nothing', { name: def.name, runId, seq });

  /**
   * Registers the definitions: the step effect that runs their nodes, and the projection that keeps `workflow_steps`.
   * `meta` is the actor recorded on every checkpoint the library commits.
   */
  function register(defs: readonly WorkflowDef[], meta: SchemaInput<Meta>) {
    // The commands (`start`, `signal`, `cancel`) find a run's code in `started`, the worker in this compose's
    // registry: one compose with workflows per `initJournal()` keeps the two the same.
    if (started.size > 0) {
      throw new JournalError(
        'BAD_DEFINITION',
        'workflow',
        defs[0]?.name ?? 'workflows',
        'this initJournal() already composed a journal with workflows; compose workflows once per initJournal()',
      );
    }
    const registry = new Map<string, WorkflowDef>();
    for (const def of defs) {
      const id = `${def.name}@${def.version}`;
      const twin = registry.get(id);
      if (twin !== undefined) {
        throw new JournalError(
          'BAD_DEFINITION',
          'workflow',
          def.name,
          twin.shapeHash === def.shapeHash
            ? `workflow "${def.name}" v${def.version} is registered twice`
            : `workflow "${def.name}" v${def.version} is registered twice with different nodes; bump the version for a changed shape`,
        );
      }
      registry.set(id, def);
      started.set(id, def);
    }
    // A child workflow named in the definition itself must be registered too: its runs are started by the parent's checkpoint.
    for (const def of defs) {
      for (const node of def.nodes) {
        const child = node.kind === 'map' ? node.def : node.kind === 'child' ? node.def : undefined;
        if (child === undefined || typeof child === 'function') continue;
        if (!started.has(`${child.name}@${child.version}`)) {
          throw new JournalError(
            'BAD_DEFINITION',
            'workflow',
            def.name,
            `${node.kind} '${node.name}' runs workflow "${child.name}" v${child.version}, which is not registered; pass it to compose({ workflows })`,
          );
        }
      }
    }
    // One `startOn` per workflow name: two versions with their own would start two runs, or the wrong one.
    for (const def of defs) {
      const newest = newestVersionOf(def.name);
      if (def.startOn !== undefined && def.version < newest) {
        throw new JournalError(
          'BAD_DEFINITION',
          'workflow',
          def.name,
          `workflow "${def.name}" v${def.version} declares startOn, but v${newest} is registered; only the highest version may declare startOn, so move it there`,
        );
      }
    }
    registerLimits(defs);
    const needs: Needs = Object.fromEntries(defs.flatMap(def => Object.entries(def.needs)));

    /**
     * Stores the key the body will see, so a retry keeps it. The attempt is not marked running: a step is running
     * while its job holds a live lease (`stepStatusSql`).
     */
    const recordKey = (ctx: StepEffectContext, runId: string, path: string, attempt: number, key: string) =>
      ctx.db
        .update(workflowSteps)
        .set({ key })
        .where(
          and(
            eq(workflowSteps.runId, runId),
            eq(workflowSteps.path, path),
            eq(workflowSteps.phase, 'do'),
            eq(workflowSteps.attempt, attempt),
            inArray(workflowSteps.status, ['scheduled', 'failed']),
          ),
        );

    type NodeScheduledEvent = RecordedOf<typeof machine.events.NodeScheduled, MetaOut, string>;
    type StepNode = Extract<WorkflowNode, { readonly kind: 'step' }>;

    /** Where the run goes after `index`, once its result is `result`. A `next` that is not an earlier node is a bad definition. */
    async function routeFrom(
      def: WorkflowDef,
      index: number,
      node: StepNode | CommandNode,
      row: Row,
      result: unknown,
      build: (signal: AbortSignal) => ErasedContext,
      signal: AbortSignal,
    ): Promise<Route | AsyncSchemaFailure> {
      const next = node.kind === 'step' ? node.options.next : undefined;
      const target = typeof next === 'function' ? next({ ...build(signal), result }) : (next ?? 'next');
      return routeAt(def, jumpTarget(def, index, target, row.id), row, node.name, result);
    }

    /**
     * `ctx.metadata` and `ctx.tags` of a node attempt on run `runId`. Each call runs its own command through the
     * attempt's unwatched runner (`unwatchedRun`, which only this effect gets): it commits at once, under the attempt's
     * fence (a stale attempt writes nothing), with the `workflowMeta`. The refusal tracker never sees it, so a refusal
     * is only the value the call returns: it needs no `accept` and never changes the step's outcome, even when it
     * arrives after the step settled. Nothing here rejects: a call that is not awaited must not become an unhandled
     * rejection, so a throw is returned as a failure too. The fenced runner already returns a database failure or a
     * lost fence as a value.
     */
    const runChangesOf = (ctx: StepEffectContext, runId: string): Pick<ErasedContext, 'metadata' | 'tags'> => {
      const runner = ctx[unwatchedRun];
      const settled = async <Result>(call: () => Promise<Result>) => {
        try {
          return await call();
        } catch (error) {
          return UnexpectedDefect({ cause: error });
        }
      };
      const changed = (change: MetadataChange) => settled(() => runner(stepMetadata, { runId, change }, meta));
      return {
        metadata: {
          set: patch => changed({ kind: 'set', patch }),
          increment: (key, by = 1) => changed({ kind: 'increment', key, by }),
          append: (key, value) => changed({ kind: 'append', key, value }),
          remove: key => changed({ kind: 'remove', key }),
        },
        tags: {
          add: (...tags) => settled(() => runner(stepTags, { runId, tags }, meta)),
        },
      };
    };

    /** Runs one attempt of a node: key, `when`, body, result checks, routing. Never throws for a failure of the step itself. */
    async function attemptNode(
      def: WorkflowDef,
      index: number,
      node: StepNode,
      row: Row,
      event: NodeScheduledEvent,
      ctx: StepEffectContext,
    ): Promise<Verdict> {
      const { data } = event;
      const build =
        (key: string) =>
        (signal: AbortSignal): ErasedContext => ({
          ...ctx,
          ...runChangesOf(ctx, row.id),
          runId: row.id,
          path: data.path,
          attempt: data.attempt,
          input: row.input,
          results: row.results,
          key,
          signal,
        });
      let key = data.key;
      try {
        if (node.options.key !== undefined) key = node.options.key(build(data.key)(ctx.signal));
        if (typeof key !== 'string' || key === '')
          throw new Error('the step key function must return a non-empty string');
      } catch (error) {
        return failed(error, false);
      }
      await recordKey(ctx, row.id, data.path, data.attempt, key);
      const make = build(key);

      try {
        if (node.options.when !== undefined && !node.options.when(make(ctx.signal))) {
          const route = await routeAt(def, index + 1, row, node.name, null);
          return isFailure(route) ? failed(route, false) : { kind: 'skipped', reason: 'when', route };
        }
      } catch (error) {
        return failed(error);
      }

      let result: unknown;
      try {
        result = await withJournalSpan('journal.step', stepSpan(row, data, 'do'), () =>
          stepHooks.run(stepHookContext(row, data, 'do'), () =>
            runBody(
              { name: node.name, timeoutMs: attemptTimeoutMs(node.options.timeout, row.stepTimeoutMs) },
              node.run,
              make,
              ctx.signal,
              row.id,
            ),
          ),
        );
      } catch (error) {
        return failed(error);
      }
      // A returned Failure is a decision, not an accident: the step is dead at once, with no retry.
      if (isFailure(result)) return failed(result);

      try {
        const parsed = node.options.output === undefined ? result : await parseAsync(node.options.output, result);
        if (isFailure(parsed)) return failed(parsed, false);
        const kept = storable(parsed, def.limits.payload, `the result of step '${node.name}'`, row.id);
        if (kept instanceof JournalError) return failed(kept);
        const route = await routeFrom(def, index, node, row, kept.value, make, ctx.signal);
        if (isFailure(route)) return failed(route, false);
        return { kind: 'completed', result: kept.value, route };
      } catch (error) {
        // A router, a `finish` or an output schema that fails will fail again: no retry, the definition needs a fix.
        return failed(error, !(error instanceof JournalError && error.code === 'BAD_DEFINITION'));
      }
    }

    /**
     * The route of a step an operator resolved (`resolveStep`): `next` runs here, with the worker's services, on the
     * operator's result, and the body does not run. A router that fails is not retried: a retry would run the body.
     */
    async function routeResolved(
      def: WorkflowDef,
      index: number,
      node: StepNode | CommandNode,
      row: Row,
      event: NodeScheduledEvent,
      ctx: StepEffectContext,
      result: unknown,
    ): Promise<Verdict> {
      const { data } = event;
      const build = (signal: AbortSignal): ErasedContext => ({
        ...ctx,
        ...runChangesOf(ctx, row.id),
        runId: row.id,
        path: data.path,
        attempt: data.attempt,
        input: row.input,
        results: row.results,
        key: data.key,
        signal,
      });
      try {
        const route = await routeFrom(def, index, node, row, result, build, ctx.signal);
        if (isFailure(route)) return failed(route, false);
        const by =
          data.actorId === undefined
            ? {}
            : {
                by: {
                  actorId: data.actorId,
                  ...(data.reason === undefined ? {} : { reason: data.reason }),
                  ...(data.executionId === undefined ? {} : { executionId: data.executionId }),
                },
              };
        return { kind: 'completed', result, route, ...by };
      } catch (error) {
        return failed(error, false);
      }
    }

    /** Runs one attempt of the undo of a step or a child node. Its context is the node's, plus `result`: what the node stored. */
    async function attemptUndo(
      def: WorkflowDef,
      node: StepNode | Extract<WorkflowNode, { readonly kind: 'child' }>,
      row: Row,
      event: NodeScheduledEvent,
      ctx: StepEffectContext,
      done: Done,
    ): Promise<Verdict> {
      const { undo } = node.options;
      if (undo === undefined) {
        throw new JournalError('BAD_DEFINITION', 'workflow', row.id, `node '${node.name}' has no undo to run`);
      }
      const build = (signal: AbortSignal): ErasedContext => ({
        ...ctx,
        ...runChangesOf(ctx, row.id),
        runId: row.id,
        path: event.data.path,
        attempt: event.data.attempt,
        input: row.input,
        results: row.results,
        key: event.data.key,
        signal,
      });
      try {
        const result = await withJournalSpan('journal.step', stepSpan(row, event.data, 'undo'), () =>
          stepHooks.run(stepHookContext(row, event.data, 'undo'), () =>
            runBody(
              {
                name: node.name,
                timeoutMs: attemptTimeoutMs(node.kind === 'step' ? node.options.timeout : undefined, row.stepTimeoutMs),
              },
              step => undo({ ...step, result: done.result }),
              build,
              ctx.signal,
              row.id,
            ),
          ),
        );
        if (isFailure(result)) return failed(result);
        const kept = storable(result, def.limits.payload, `the undo result of step '${node.name}'`, row.id);
        if (kept instanceof JournalError) return failed(kept);
        return { kind: 'undone', result: kept.value };
      } catch (error) {
        return failed(error);
      }
    }

    /**
     * The park of a `waitFor` or `sleep` node: when it wakes by itself, and for which signal it waits. A `waitFor`
     * whose `when` returns false is skipped instead, like a step: the run does not park and the result is `null`.
     */
    async function attemptWait(
      def: WorkflowDef,
      index: number,
      node: Extract<WorkflowNode, { readonly kind: 'waitFor' | 'eventWait' | 'sleep' }>,
      row: Row,
      event: NodeScheduledEvent,
      ctx: StepEffectContext,
    ): Promise<Verdict> {
      const wakeAtOf = (due: Date) => {
        if (!(due instanceof Date) || Number.isNaN(due.getTime())) {
          throw new TypeError(`node '${node.name}' needs a valid Date to wake at`);
        }
        return due.toISOString();
      };
      const body: ErasedContext = {
        ...ctx,
        ...runChangesOf(ctx, row.id),
        runId: row.id,
        path: event.data.path,
        attempt: event.data.attempt,
        input: row.input,
        results: row.results,
        key: event.data.key,
        signal: ctx.signal,
      };
      try {
        if (node.kind === 'eventWait') {
          // Plain data, as the type says: these run again wherever a wake needs them, with no worker behind them.
          const view = { runId: row.id, input: row.input, results: row.results };
          if (node.when !== undefined && !node.when(view)) {
            const route = await routeAt(def, index + 1, row, node.name, null);
            return isFailure(route) ? failed(route, false) : { kind: 'skipped', reason: 'when', route };
          }
          const waits = node.on.map(source => ({
            label: source.label,
            entityKind: source.entity.kind,
            entityId: source.match(view),
            types: source.events.map(known => known.type),
          }));
          const timeoutAt = node.timeout === undefined ? null : inMs(parseAge(node.timeout));
          return {
            kind: 'park',
            // The column holds 128 characters, and this is for people to read: `node` names the wait exactly.
            waitingFor: waits.map(wait => wait.label).join(' | ').slice(0, 128),
            wakeAt: node.until === undefined ? timeoutAt : wakeAtOf(node.until(view)),
            waits,
          };
        }
        if (node.kind === 'waitFor') {
          if (node.when !== undefined && !node.when(body)) {
            const route = await routeAt(def, index + 1, row, node.name, null);
            return isFailure(route) ? failed(route, false) : { kind: 'skipped', reason: 'when', route };
          }
          const wakeAt = node.timeout === undefined ? null : inMs(parseAge(node.timeout));
          return { kind: 'park', waitingFor: node.signal, wakeAt };
        }
        const { until } = node;
        const due = typeof until === 'function' ? until(body) : new Date(Date.now() + parseAge(until));
        return { kind: 'park', waitingFor: null, wakeAt: wakeAtOf(due) };
      } catch (error) {
        return failed(error);
      }
    }

    type FanNode = Extract<WorkflowNode, { readonly kind: 'child' | 'map' }>;

    /**
     * The work of a child or map node: which workflow, and the id and checked input of each child run. Nothing is
     * started here: the checkpoint starts the children in the same transaction that parks this run, so a crash leaves
     * no child behind. A throw from `def`, `items` or `input` is a failure of the node, like a throw from a step body.
     */
    async function attemptChildren(
      def: WorkflowDef,
      index: number,
      node: FanNode,
      row: Row,
      event: NodeScheduledEvent,
      ctx: StepEffectContext,
    ): Promise<Verdict> {
      const { data } = event;
      const context: ErasedContext = {
        ...ctx,
        ...runChangesOf(ctx, row.id),
        runId: row.id,
        path: data.path,
        attempt: data.attempt,
        input: row.input,
        results: row.results,
        key: data.key,
        signal: ctx.signal,
      };
      let childDef: WorkflowDef;
      let inputs: { readonly index: number | null; readonly input: unknown }[];
      try {
        childDef = typeof node.def === 'function' ? node.def(context) : node.def;
        if (node.kind === 'child') {
          inputs = [{ index: null, input: node.input(context) }];
        } else {
          const items = node.items(context);
          if (items.length > def.limits.children) {
            return failed(
              new JournalError(
                'WORKFLOW_LIMIT',
                'workflow',
                row.id,
                `map '${node.name}' has ${items.length} items; limits.children is ${def.limits.children}`,
              ),
              false,
            );
          }
          inputs = items.map((item, at) => ({ index: at, input: node.input(context, item, at) }));
        }
      } catch (error) {
        return failed(error);
      }
      try {
        if (!started.has(`${childDef.name}@${childDef.version}`)) {
          throw new JournalError(
            'WORKFLOW_UNKNOWN',
            'workflow',
            row.id,
            `${node.kind} '${node.name}' runs workflow "${childDef.name}" v${childDef.version}, which is not registered`,
          );
        }
        if (inputs.length === 0) {
          // An empty map is already done: nothing to wait for. With `wait: 'any'` no child can ever win.
          if (node.kind === 'map' && node.wait === 'any') {
            throw new JournalError(
              'BAD_DEFINITION',
              'workflow',
              row.id,
              `map '${node.name}' has no items, so no child can win`,
            );
          }
          const route = await routeAt(def, index + 1, row, node.name, []);
          return isFailure(route) ? failed(route, false) : { kind: 'completed', result: [], route };
        }
        if ((await ancestorsOf(ctx.db, row)) >= MAX_CHILD_DEPTH) {
          throw new JournalError(
            'WORKFLOW_LIMIT',
            'workflow',
            row.id,
            `${node.kind} '${node.name}' would nest runs deeper than ${MAX_CHILD_DEPTH} levels`,
          );
        }
        const base = childBase(node.name, await visitOf(ctx.db, row.id, node.name));
        const stem = `${row.id}/${base}`;
        const children: { id: string; input: unknown }[] = [];
        for (const { index: at, input } of inputs) {
          const id = at === null ? stem : `${stem}[${at}]`;
          if (id.length > MAX_RUN_ID_LENGTH) {
            throw new JournalError(
              'WORKFLOW_LIMIT',
              'workflow',
              row.id,
              `the child run id "${id}" is longer than ${MAX_RUN_ID_LENGTH} characters`,
            );
          }
          const parsed = await parseAsync(childDef.input, input);
          if (isFailure(parsed)) return failed(parsed, false);
          const kept = storable(parsed, childDef.limits.payload, `the input of child run ${id}`, row.id);
          if (kept instanceof JournalError) throw kept;
          children.push({ id, input: kept.value });
        }
        return { kind: 'children', plan: { base, def: { name: childDef.name, version: childDef.version }, children } };
      } catch (error) {
        // A limit, a schema or a definition that is wrong will be wrong again: no retry.
        return failed(error, !(error instanceof JournalError || InvalidInput.is(error)));
      }
    }

    /** A dead step that waits for an operator: the job ends with this failure, and says so in its log. */
    const stepDead = (runId: string, data: NodeScheduledEvent['data'], reason: unknown) => {
      debugWorkflow.warn('{runId} {path}: dead after {attempt} attempts, waiting for an operator', {
        runId,
        path: data.path,
        attempt: data.attempt,
      });
      return StepDead(
        { detail: 'A workflow step exhausted its retry policy and needs operator attention.' },
        { cause: reason },
      );
    };

    /**
     * Runs one attempt of a command node as its one transaction (`commandNode`). A transaction that did not commit left
     * nothing behind, so a failure here is thrown: the job runs again, and a repeat is safe.
     */
    async function attemptCommandNode(row: Row, event: NodeScheduledEvent, ctx: StepEffectContext) {
      const { data } = event;
      const args = { runId: row.id, path: data.path, phase: data.phase, attempt: data.attempt, key: data.key };
      const attempted = await withJournalSpan('journal.step', stepSpan(row, data, data.phase), () =>
        stepHooks.run(stepHookContext(row, data, data.phase), () => ctx.run(commandNode, args, meta)),
      );
      const { status, dead } = orThrow(attempted);
      debugWorkflow.debug('{runId} {path}: command node {status}', { runId: row.id, path: data.path, status });
      // Settled: the run compensates (or already was), so no operator is needed and the job ends normally.
      return dead === undefined || status !== 'checkpointed' ? undefined : stepDead(row.id, data, dead);
    }

    async function runNode(
      event: NodeScheduledEvent,
      outer: OwnedEffectContext<AppDb, RootCommandRunner<Meta, Tx>>,
      servicesById: ReadonlyMap<string, Services> | undefined,
    ): Promise<unknown> {
      const { data } = event;
      const runId = event.entityId;
      const [stored] = await outer.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      if (stored === undefined || stored.finishedAt !== null) return undefined;
      const [step] = await outer.db
        .select()
        .from(workflowSteps)
        .where(
          and(eq(workflowSteps.runId, runId), eq(workflowSteps.path, data.path), eq(workflowSteps.phase, data.phase)),
        );
      // Already checkpointed, or replaced by a later attempt: this job has nothing left to do.
      if (step === undefined || step.attempt !== data.attempt || step.status === 'done' || step.status === 'skipped') {
        return undefined;
      }
      const def = codeOf(stored, registry);
      if (def instanceof JournalError) {
        warnStranded(stored, def);
        return strandedFailure(stored, def);
      }
      const row = {
        ...stored,
        results: liveResults(
          def,
          runId,
          await withWaitEvents(outer.db, tables, runId, def.nodes, stored.results),
          decodeEvent,
        ),
      };
      // A body's command without a meta records the app's `workflowMeta`; one with a meta records that one.
      const run: WorkflowCommandRunner<Meta, Tx> = (command, input, given, call) =>
        outer.run(command, input, given === undefined ? meta : given, call);
      // This definition's own services win over the flat set the effect was bound with.
      const ctx: StepEffectContext = { ...outer, run, ...servicesById?.get(`${def.name}@${def.version}`) };
      const index = def.nodes.findIndex(candidate => candidate.name === data.path);
      const node = def.nodes[index];
      if (node === undefined) {
        throw new JournalError(
          'BAD_DEFINITION',
          'workflow',
          runId,
          `"${row.name}" has no runnable node '${data.path}'`,
        );
      }

      // The first try of a run's first node, with a ttl: when the ttl has passed, the run expires and nothing runs. A
      // job tried before (a crash) may have run the body already, so only the job's first attempt asks.
      const firstTry = index === 0 && data.phase === 'do' && data.attempt === 1 && outer.attempt === 1;
      if (firstTry && row.ttlAt !== null && data.resolution === undefined) {
        const outcome = { kind: 'expired' } as const;
        const expired = await ctx.run(checkpoint, { runId, path: data.path, phase: 'do', attempt: 1, outcome }, meta);
        if (isFailure(expired)) return expired;
        if (expired.status === 'settled') return undefined;
      }

      // A node past `limits.transitions` is not run: the run stops before its body, so no work is done and lost. Only a
      // first try is asked: an operator who raised the limit retries the dead node, and that retry is allowed.
      const overLimit =
        data.phase === 'do' && data.attempt === 1 && data.resolution === undefined
          ? transitionLimitFailure(def, row)
          : undefined;
      if (overLimit !== undefined) {
        const stopped = await ctx.run(
          checkpoint,
          {
            runId,
            path: data.path,
            phase: 'do',
            attempt: data.attempt,
            outcome: { kind: 'transition-limit', error: reasonText(overLimit) },
          },
          meta,
        );
        return isFailure(stopped) ? stopped : undefined;
      }
      let verdict: Verdict;
      if (node.kind === 'command') {
        if (data.resolution === undefined) return attemptCommandNode(stored, event, ctx);
        verdict = await routeResolved(def, index, node, row, event, ctx, data.resolution.result);
      } else if (data.phase === 'undo') {
        if (node.kind !== 'step' && !(node.kind === 'child' && node.undo)) {
          throw new JournalError('BAD_DEFINITION', 'workflow', runId, `"${row.name}" has no undo for '${data.path}'`);
        }
        const settled = await ctx.db
          .select({ type: tables.events.type, data: tables.events.data })
          .from(tables.events)
          .where(settledOf(runId))
          .orderBy(asc(tables.events.seq));
        // This undo is not settled yet, so the newest step still to undo is the one it answers.
        const [done] = remainingUndos(def, settled);
        if (done === undefined || done.path !== data.path) {
          throw new JournalError('BAD_DEFINITION', 'workflow', runId, `no completed step '${data.path}' to undo`);
        }
        verdict = await attemptUndo(def, node, row, event, ctx, done);
      } else {
        if (node.kind === 'step') {
          verdict =
            data.resolution === undefined
              ? await attemptNode(def, index, node, row, event, ctx)
              : await routeResolved(def, index, node, row, event, ctx, data.resolution.result);
        } else if (node.kind === 'child' || node.kind === 'map') {
          verdict = await attemptChildren(def, index, node, row, event, ctx);
        } else verdict = await attemptWait(def, index, node, row, event, ctx);
      }

      const at = { runId, path: data.path, phase: data.phase, attempt: data.attempt };
      if (verdict.kind !== 'failed') {
        const checkpointed = await ctx.run(checkpoint, { ...at, outcome: verdict }, meta);
        if (isFailure(checkpointed)) return checkpointed;
        debugWorkflow.debug('{runId} {path}: {kind}, checkpoint {status}', {
          runId,
          path: data.path,
          kind: verdict.kind,
          status: checkpointed.status,
        });
        return undefined;
      }
      // A stop or a lost lease aborts the body too. That is not the step failing: leave the job to be run again.
      if (ctx.signal.aborted) {
        throw new Error(`journal: the worker stopped or lost its lease during step '${data.path}'`, {
          cause: ctx.signal.reason,
        });
      }
      const outcome = failureOutcome(node, row.maxAttempts, verdict, data.attempt, step.key ?? data.key);
      const checkpointed = await ctx.run(checkpoint, { ...at, outcome }, meta);
      if (isFailure(checkpointed)) return checkpointed;
      // Settled: the run compensates (or already was), so no operator is needed and the job ends normally.
      if (outcome.kind === 'retry' || checkpointed.status !== 'checkpointed') return undefined;
      return stepDead(runId, data, verdict.reason);
    }

    /**
     * The retry of the step and timer jobs: the worker's default, except that a stranded run's job is dead at once.
     * Retrying cannot help until the code is back, and then an operator retries the dead job. A returned failure
     * (a dead step) is not retried either, as before.
     */
    const strandedRetry = defaultEffectRetry.while(reason => !isFailure(reason) && !isStrandedError(reason));

    const stepEffect = <N extends Needs>(needsOf: N, servicesById: ReadonlyMap<string, Services> | undefined) =>
      ownedEffect(STEP_EFFECT, machine.run, needsOf, {
        NodeScheduled: (event, ctx) => runNode(event, ctx, servicesById),
      }).withSchedule({
        // A retry is due at the time its event names; a first try is due now.
        runAt: event => new Date(dueAtOf(event.data)),
        priority: event => jobPriorityOf(event.data),
        retry: strandedRetry,
      });
    const effect = {
      ...stepEffect(needs, undefined),
      // Each workflow reads the services of its own feature (or the one flat set a static `services` gives).
      bindPerWorkflow: (servicesOf: (workflow: string) => Services) =>
        stepEffect(
          {},
          new Map(
            defs.map(def => {
              const id = `${def.name}@${def.version}`;
              return [
                id,
                givenServices('effect', { name: `${STEP_EFFECT} of ${id}`, needs: def.needs }, servicesOf(id)),
              ];
            }),
          ),
        ),
    };

    /** A stranded timer returns the same permanent diagnostic as a step, without changing the pinned run. */
    const refuseStranded = async (runId: string, db: StepEffectContext['db']) => {
      const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      if (row === undefined || row.finishedAt !== null) return;
      const code = codeOf(row, registry);
      if (!(code instanceof JournalError)) return;
      warnStranded(row, code);
      return strandedFailure(row, code);
    };

    /**
     * A park's wake time and a run's deadline. The job is due at the event's time; when it fires, the checkpoint
     * command acts only if the run is still parked on that park (or unfinished, for the deadline).
     */
    const timer = ownedEffect(
      TIMER_EFFECT,
      machine.run,
      {},
      {
        Parked: async (event, ctx) => {
          const stranded = await refuseStranded(event.entityId, ctx.db);
          if (stranded !== undefined) return stranded;
          return ctx.run(
            checkpoint,
            { runId: event.entityId, fired: { kind: 'wake', node: event.data.node, parkSeq: event.seq } },
            meta,
          );
        },
        RunStarted: async (event, ctx) => {
          const stranded = await refuseStranded(event.entityId, ctx.db);
          if (stranded !== undefined) return stranded;
          return ctx.run(checkpoint, { runId: event.entityId, fired: { kind: 'deadline' } }, meta);
        },
        RunQueued: async (event, ctx) => {
          const stranded = await refuseStranded(event.entityId, ctx.db);
          if (stranded !== undefined) return stranded;
          return ctx.run(checkpoint, { runId: event.entityId, fired: { kind: 'ttl' } }, meta);
        },
      },
    ).withSchedule({
      // Only a park with a wake time, a run with a deadline and a queued run with a ttl have anything to time.
      when: event => timerAt(event.data) !== null,
      runAt: event => timerDueAt(event.data),
      priority: event => jobPriorityOf(event.data),
      retry: strandedRetry,
    });

    /**
     * The effect of a workflow's `startOn`: `def.start` with the app's `workflowMeta`. Its job is written in the
     * transaction that records the event, so the run starts once, even when the command that recorded it is retried.
     * An id that already has a run, whatever its input or version, starts nothing: a later deploy or another input for
     * the same id ends the job as done, never dead. A `with-event` start queues no job (`eventStartFor` writes its run),
     * but its effect stays, so jobs queued before the workflow moved to `with-event` still start their runs.
     */
    const startEffectFor = (def: WorkflowDef, startOn: ErasedStartOn) => {
      const start = startOnCommandFor(def);
      return ownedEffect(
        `${START_EFFECT}:${def.name}`,
        startOn.entity,
        {},
        {
          [startOn.event.type]: async (event, ctx) => {
            const runId = startOn.id(event);
            if (await runExists(ctx.db, runId)) return void startsNothing(def, runId, event.seq);
            const startArgs = { id: runId, input: startOn.input(event) };
            const outcome = await ctx.run(start, { trigger: event.seq, start: startArgs }, meta);
            // Another start took the id between the look-up and this one: the run exists, so the job is done. The row
            // decides, not the refusal: a conflict for an id with no run (a payload over the limit) still fails the job.
            if (CommandConflict.is(outcome) && (await runExists(ctx.db, runId))) {
              ctx.accept(outcome);
              return void startsNothing(def, runId, event.seq);
            }
            return outcome;
          },
        },
      ).withSchedule(startOn.timing === 'with-event' ? { when: () => false } : {});
    };
    const starts = defs.flatMap(def => (def.startOn === undefined ? [] : [startEffectFor(def, def.startOn)]));

    /**
     * A `with-event` `startOn`: the run, its first node and that node's job are written in the event's transaction, so
     * they commit or roll back with the event, and no body runs here. The same id rule as `startEffectFor` holds. A
     * limit never refuses this start (`admit`). A bad `input` refuses the write as its schema failure; what is left (an
     * input over `limits.payload`) is a bug in the mapping, so it throws, and the write rolls back with it.
     */
    const eventStartFor = (def: WorkflowDef, startOn: ErasedStartOn): EventStart<SchemaInput<Meta>, MetaOut, Tx> => ({
      kind: startOn.entity.kind,
      type: startOn.event.type,
      meta,
      start: async (host, event) => {
        const runId = startOn.id(event);
        const args = await parseAsync(startSchema(def.input), { id: runId, input: startOn.input(event) });
        if (isFailure(args)) return args;
        const outcome = await startRun(def, host, args, { refusal: 'queue', trigger: event.seq });
        if (CommandConflict.is(outcome) && (await runExists(host.tx, runId))) {
          return void startsNothing(def, runId, event.seq);
        }
        return isSchemaFailure(outcome) ? outcome : void orThrow(outcome);
      },
    });
    const eventStarts = defs.flatMap(def =>
      def.startOn?.timing === 'with-event' ? [eventStartFor(def, def.startOn)] : [],
    );

    /**
     * The hooks of `on` for one run end, from the run's own version: the specific hook, then `complete`. A stranded run
     * has no code to call: the job is dead at once, and an operator retries it once the code is back. A definition with
     * no hook for this end has nothing to do. An effect's `when` sees only the event, and an end event does not name
     * its workflow, so that job is queued all the same and ends as done.
     */
    async function runLifecycle(
      runId: string,
      ending: RunEnding<unknown>,
      outer: OwnedEffectContext<AppDb, RootCommandRunner<Meta, Tx>>,
      servicesById: ReadonlyMap<string, Services> | undefined,
    ): Promise<unknown> {
      const [row] = await outer.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      // Pruned by retention before the job ran: there is no run left to tell anyone about.
      if (row === undefined) return undefined;
      const def = codeOf(row, registry);
      if (def instanceof JournalError) {
        warnStranded(row, def);
        return strandedFailure(row, def);
      }
      const hooks = def.on;
      if (hooks === undefined) return undefined;
      // The output as `def.read` gives it: checked again by the `output` schema, so its type holds.
      let seen = ending;
      if (ending.state === 'completed' && def.output !== undefined) {
        const checked = await checkStored(def.output, ending.output, runId, 'output');
        if (WorkflowReadMismatch.is(checked) || ValidatorDefect.is(checked)) return checked;
        seen = { state: 'completed', output: checked.value };
      }
      // A hook's command without a meta records the app's `workflowMeta`, as a step's does.
      const run: WorkflowCommandRunner<Meta, Tx> = (command, input, given, call) =>
        outer.run(command, input, given === undefined ? meta : given, call);
      const base = {
        ...outer,
        ...servicesById?.get(`${def.name}@${def.version}`),
        run,
        runId: row.id,
        workflow: row.name,
        version: row.workflowVersion,
        scope: row.scope,
        tags: row.tags,
        metadata: row.metadata,
        input: row.input,
      };
      let specific: unknown;
      switch (seen.state) {
        case 'completed': {
          specific = await hooks.success?.({ ...base, ...seen });
          break;
        }
        case 'failed': {
          specific = await hooks.failure?.({ ...base, ...seen });
          break;
        }
        case 'cancelled': {
          specific = await hooks.cancel?.({ ...base, ...seen });
          break;
        }
        case 'expired': {
          specific = await hooks.expired?.({ ...base, ...seen });
          break;
        }
      }
      if (isFailure(specific)) return specific;
      const complete = await hooks.complete?.({ ...base, ...seen });
      return isFailure(complete) ? complete : undefined;
    }
    /** Bound per workflow, each definition's own services by `name@version`; otherwise the flat set the effect was bound with. */
    const lifecycleEffect = <N extends Needs>(needsOf: N, servicesById?: ReadonlyMap<string, Services>) =>
      ownedEffect(LIFECYCLE_EFFECT, machine.run, needsOf, {
        RunCompleted: (event, ctx) =>
          runLifecycle(event.entityId, { state: 'completed', output: event.data.output }, ctx, servicesById),
        RunFailed: (event, ctx) =>
          runLifecycle(event.entityId, { state: 'failed', error: event.data.error }, ctx, servicesById),
        RunCancelled: (event, ctx) => runLifecycle(event.entityId, { state: 'cancelled' }, ctx, servicesById),
        RunExpired: (event, ctx) => runLifecycle(event.entityId, { state: 'expired' }, ctx, servicesById),
      });
    /** Only a compose with a definition that declares `on` gets the effect: without one, a run end queues nothing. */
    const hooked = defs.filter(def => def.on !== undefined);
    const lifecycle =
      hooked.length === 0
        ? []
        : [
            {
              ...lifecycleEffect(Object.fromEntries(hooked.flatMap(def => Object.entries(def.needs)))),
              // Each definition's hooks read the services of its own feature, as its steps do.
              bindPerWorkflow: (servicesOf: (workflow: string) => Services) =>
                lifecycleEffect(
                  {},
                  new Map(
                    hooked.map(def => {
                      const id = `${def.name}@${def.version}`;
                      return [
                        id,
                        givenServices(
                          'effect',
                          { name: `${LIFECYCLE_EFFECT} of ${id}`, needs: def.needs },
                          servicesOf(id),
                        ),
                      ];
                    }),
                  ),
                ),
            },
          ];

    /**
     * The wake of the event waits on one entity kind: one job per recorded event of a type some wait watches, written
     * with the event. Each run is woken in its own transaction, so a run that fails holds up no other. A stranded run
     * comes back as a failure once the others are woken: the job is dead until its code is back.
     */
    const wakeEffectFor = (entity: AnyEntity, types: ReadonlySet<string>) => {
      const wake = async (
        event: Recorded<string, unknown, MetaOut>,
        ctx: OwnedEffectContext<AppDb, RootCommandRunner<Meta, Tx>>,
      ) => {
        const lookup = { entityKind: event.kind, entityId: event.entityId, type: event.type, seq: event.seq };
        const waiters = await ctx.run(waitersOf, lookup, meta);
        if (isFailure(waiters)) return waiters;
        let stranded: ReturnType<typeof strandedFailure> | undefined;
        for (const waiter of waiters) {
          const refused = await refuseStranded(waiter.runId, ctx.db);
          if (refused !== undefined) {
            stranded ??= refused;
            continue;
          }
          const woke = await ctx.run(wakeWait, waiter, meta);
          if (isFailure(woke)) return woke;
        }
        return stranded;
      };
      return ownedEffect(
        `${WAKE_EFFECT}:${entity.kind}`,
        entity,
        {},
        Object.fromEntries([...types].map(type => [type, wake])),
      ).withSchedule({ retry: strandedRetry });
    };
    /** Each entity some registered wait watches, with every event type a wait of any version takes. */
    const watched = new Map<string, { readonly entity: AnyEntity; readonly types: Set<string> }>();
    for (const def of defs) {
      for (const node of def.nodes) {
        if (node.kind !== 'eventWait') continue;
        for (const source of node.on) {
          const entry = watched.get(source.entity.kind) ?? { entity: source.entity, types: new Set() };
          for (const known of source.events) entry.types.add(known.type);
          watched.set(source.entity.kind, entry);
        }
      }
    }
    const wakes = [...watched.values()].map(({ entity, types }) => wakeEffectFor(entity, types));

    /**
     * A key's `perKey` override runs out with no event of its own, so each one gets a timer at its `until`: then the
     * queued runs of the limit that now fit start. One replaced or reset before then finds nothing new to start.
     */
    const limitTimer = ownedEffect(
      LIMIT_TIMER_EFFECT,
      limits.limit,
      {},
      {
        LimitKeyOverridden: (event, ctx) => ctx.run(promoteLimit, { name: event.entityId }, meta),
      },
    ).withSchedule({ runAt: event => untilOf(event.data) });

    return { effects: [effect, timer, limitTimer, ...starts, ...wakes, ...lifecycle], steps: machine.steps, eventStarts };
  }

  return {
    workflow,
    task,
    register,
    started,
    stepHooks,
    operate: {
      retryStep,
      resolveStep,
      skipUndo,
      signal: operatorSignal,
      cancel: operatorCancel,
      setMetadata,
      addTags,
      reschedule,
      replay,
      checkResult,
    },
    limits: {
      ...limitReads,
      override: overrideLimit,
      reset: resetLimit,
      pause: pauseLimit,
      resume: resumeLimit,
    },
  };
}

const dueSchema = z.object({ at: isoTime });
/** `at` of a `NodeScheduled` event, from the untyped data an effect schedule sees. */
function dueAtOf(data: unknown): string {
  return dueSchema.parse(data).at;
}

const prioritySchema = z.object({ priority: z.int32().optional() });
/** The run's priority a `NodeScheduled`, `Parked` or `RunStarted` event carries for its job; 0 when it has none. */
function jobPriorityOf(data: unknown): number {
  return prioritySchema.parse(data).priority ?? 0;
}

// `RunStarted` has a `ttlAt` too, so `deadlineAt` comes first: its timer is the deadline.
const timerDueSchema = z.union([
  z.object({ wakeAt: isoTime.nullable() }),
  z.object({ deadlineAt: isoTime.nullable() }),
  z.object({ ttlAt: isoTime.nullable() }),
]);
/**
 * The time of a timer, from the untyped data of a `Parked`, `RunStarted` or `RunQueued` event; null when the event
 * has nothing to time.
 */
function timerAt(data: unknown): Date | null {
  const parsed = timerDueSchema.parse(data);
  const at = 'wakeAt' in parsed ? parsed.wakeAt : 'deadlineAt' in parsed ? parsed.deadlineAt : parsed.ttlAt;
  return at === null ? null : new Date(at);
}

const untilSchema = z.object({ until: isoTime });
/** When a key override runs out, from the untyped data of a `LimitKeyOverridden` event. */
function untilOf(data: unknown): Date {
  return new Date(untilSchema.parse(data).until);
}
/** When a timer job is due. `when` lets only timed events through, so an untimed one here is a bug. */
function timerDueAt(data: unknown): Date {
  const at = timerAt(data);
  if (at === null) {
    throw new JournalError(
      'BAD_DEFINITION',
      'workflow',
      '',
      'journal: the timer effect got an event with no time to wait for',
    );
  }
  return at;
}
