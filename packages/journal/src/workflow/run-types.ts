/**
 * The types of starting, replaying, rescheduling, signalling and cancelling a run, with no runtime schema: the public
 * signatures (`WorkflowStarter`, `journal.workflows`) name these, so their declarations stay free of Zod (A-43) and
 * this file imports nothing that reaches a schema. The schemas that check them are in `runner.ts`, and
 * `schemas.test-d.ts` locks each pair both ways.
 */
import type { ValidatorDefect } from '@arki/failure';
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';

import type { Command } from '../api.js';
import type {
  CommandConflict,
  CommandFailure,
  CommandInvalid,
  CommandNotFound,
  WorkflowBusy,
  WorkflowReadMismatch,
} from '../errors.js';
import type { RetentionAge } from '../retention.js';
import type { DbHandle, TransactionSource } from '../types.js';
import type { AnySignals, DefExtension } from './define.js';
import type { RunDetail } from './read.js';
import type { RunFields, RunOverrides, RunTiming } from './run-fields.js';
import type { CANCEL_STATES, SignalStatus } from './states.js';

/**
 * What `replay` may change: the input, the run fields, the timing and the overrides. A field or override left out keeps
 * the old run's; timing starts fresh.
 */
export type ReplayOverrides = { readonly [K in keyof ReplayOverridable]: ReplayOverridable[K] };
/** Flattened above, so the type compares equal to `replaySchema`'s output (`runner.ts`). */
type ReplayOverridable = { readonly input?: unknown } & RunFields & RunTiming & RunOverrides;
/** `replay` takes the run to start again, and what to change. */
export type ReplayArgs = { readonly runId: string; readonly overrides?: ReplayOverrides | undefined };

/** What `def.read` gives: the run, typed, or why it cannot be. A throwing validator is a `ValidatorDefect`. */
export type ReadOutcome<Input, ReadOutput, ReadResults> =
  RunDetail<Input, ReadOutput, ReadResults> | WorkflowReadMismatch | ReturnType<typeof ValidatorDefect> | undefined;

/**
 * The arguments of `def.start`: the input, the run id, the run fields (`scope`, `tags`, `metadata`), its timing
 * (`delay`, `ttl`) and its overrides (`maxAttempts`, `timeout`, `priority`).
 */
export type StartArgs<Input> = { readonly input: Input; readonly id?: string } & RunFields & RunTiming & RunOverrides;
/**
 * The schema of `def.start`: `{ input, id?, scope?, tags?, metadata?, delay?, ttl?, maxAttempts?, timeout?, priority? }`,
 * with `input` checked by the workflow's own input schema, the run fields by `runFieldsSchema`, the timing by
 * `runTimingSchema` and the overrides by `runOverridesSchema`.
 */
export type StartSchema<Input extends StandardSchemaV1> = StandardSchemaV1<
  StartArgs<SchemaInput<Input>>,
  StartArgs<SchemaOutput<Input>>
>;
/**
 * What `def.start` returns: the run id, or a refusal when the id is taken by another run or the input is too large
 * (`CommandConflict`), the concurrency key is busy (`WorkflowBusy`), or the metadata is too large (`CommandInvalid`).
 */
export type StartOutcome = { readonly runId: string } | CommandConflict | WorkflowBusy | CommandInvalid;
/** The arguments of `def.startBatch`: up to `BATCH_LIMIT` starts of one workflow, and the batch id (made when left out). */
export type StartBatchArgs<Input> = {
  readonly items: readonly StartArgs<Input>[];
  readonly batchId?: string | undefined;
};
/** The schema of `def.startBatch`: every item is checked by the workflow's start schema, so one bad item refuses the batch. */
export type StartBatchSchema<Input extends StandardSchemaV1> = StandardSchemaV1<
  StartBatchArgs<SchemaInput<Input>>,
  StartBatchArgs<SchemaOutput<Input>>
>;
/** What `def.startBatch` returns: the batch id, and for each item, in order, what its own `def.start` would have returned. */
export type StartBatchOutcome = { readonly batchId: string; readonly runs: readonly StartOutcome[] };
/** What a journal adds to a finished definition. */
export type WorkflowStarter<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  Input extends StandardSchemaV1,
  Signals extends AnySignals,
  ReadOutput,
  ReadResults,
> = {
  readonly start: Command<StartSchema<Input>, Promise<StartOutcome | CommandFailure>, SchemaOutput<Meta>, Tx>;
  /**
   * The command that starts many runs in one transaction, all with one `batchId`. Each item is the arguments of
   * `start`, and `runs[i]` is item i's outcome: a refused item (`WorkflowBusy`, `CommandConflict`, ...) rolls back
   * only its own savepoint. An item that does not fit the start schema refuses the whole batch with `InvalidInput`.
   */
  readonly startBatch: Command<
    StartBatchSchema<Input>,
    Promise<StartBatchOutcome | CommandFailure>,
    SchemaOutput<Meta>,
    Tx
  >;
  /**
   * The command that delivers the signal `name` to a run. `name` is one of the signals the workflow's `waitFor`
   * nodes declare, and `payload` is the input of that signal's schema.
   */
  readonly signal: <Name extends keyof Signals & string>(
    name: Name,
  ) => Command<SignalSchema<Signals[Name]>, Promise<SignalOutcome | CommandFailure>, SchemaOutput<Meta>, Tx>;
  /** The command that cancels a run: it stops, undoes its completed steps newest first, and ends `cancelled`. */
  readonly cancel: Command<CancelSchema, Promise<CancelOutcome | CommandFailure>, SchemaOutput<Meta>, Tx>;
  /**
   * One run of this workflow, as `journal.workflows.run` reads it, typed by the definition. `undefined` when there is
   * no such run, or the run belongs to another workflow.
   *
   * Values with a schema are checked when read, and typed by that schema: the input; the output when the workflow
   * declares an `output` schema (`null` until the run completes); the result of each step with an `output` schema
   * (the schema's output, not what the step returned) and of each `waitFor`. Any other result is `unknown`, and a
   * node that has not run is missing. A run whose stored values no longer fit
   * returns `WORKFLOW_READ_MISMATCH` (failure code `journal.workflow_read_mismatch`); read it untyped with
   * `journal.workflows.run`. A run started on an older version is checked the same way.
   *
   * The stored input is the input schema's output, so a schema whose output is not a valid input (a transform)
   * makes `read` refuse.
   */
  readonly read: (db: DbHandle, runId: string) => Promise<ReadOutcome<SchemaOutput<Input>, ReadOutput, ReadResults>>;
};
/** What `j.workflow` adds to a definition: a `WorkflowStarter` for the signals the finished definition declares. */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- `this['signals']` is only available in an interface
export interface StarterOf<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  Input extends StandardSchemaV1,
> extends DefExtension {
  readonly out: WorkflowStarter<
    Meta,
    Tx,
    Input,
    Extract<this['signals'], AnySignals>,
    this['readOutput'],
    this['results']
  >;
}

/** The arguments of `def.cancel`. `executionId` is the Foreman execution that asked, kept on the job operation of a step job the cancel stops. */
export type CancelArgs = { readonly runId: string; readonly reason: string; readonly executionId?: string | undefined };
export type CancelSchema = StandardSchemaV1<CancelArgs>;
/** Where `reschedule` moves a run's start: a wait from now (`delay`), or a time (`at`). A time in the past is now. */
export type RescheduleArgs =
  { readonly runId: string; readonly delay: RetentionAge } | { readonly runId: string; readonly at: Date };
/**
 * What `reschedule` returns: the new start (ISO time), or why not. `CommandNotFound`: no such run. `CommandConflict`:
 * its first node has started (a worker holds or has tried its job, or the run moved on), or it has finished.
 */
export type RescheduleOutcome = { readonly startAt: string } | CommandNotFound | CommandConflict;

/** `compensating`: the run is undoing its steps now (or waits for a step in flight). `cancelled`: there was nothing to undo, so it ended at once. */
export type CancelOutcome = { readonly state: (typeof CANCEL_STATES)[number] } | CommandNotFound | CommandConflict;

/** The arguments of `def.signal(name)`. `deliveryId` is the sender's own id: a repeat of it changes nothing. */
export type SignalArgs<Payload> = { readonly runId: string; readonly deliveryId: string; readonly payload: Payload };
/** The schema of a signal command. `payload` is typed with the input of the signal's schema; the handler checks it. */
export type SignalSchema<Payload extends StandardSchemaV1> = StandardSchemaV1<
  SignalArgs<SchemaInput<Payload>>,
  SignalArgs<unknown>
>;
/** The result of a signal. `SIGNAL_STATUSES` says what each status means. */
export type SignalOutcome = { readonly status: SignalStatus } | CommandNotFound | CommandInvalid | CommandConflict;
