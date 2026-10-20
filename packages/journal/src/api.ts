/**
 * The public declarations: the `Journal` object, commands and their context, the
 * definition helpers `initJournal` returns, and the input, option and result types.
 * Types only, no runtime code. May import `entity`, `types`, `pg`, `outbox` and `retention` (types); nothing else.
 */
import type { IdGenerationFailure } from '@arki/contracts';
import type { Failure, SchemaFailure } from '@arki/failure';
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';

import type { EntityBuilder } from './entity.js';
import type { CommandFailure } from './errors.js';
import type { HookPoint } from './hooks.js';
import type { JobOps } from './outbox.js';
import type { ResolvedRetention } from './retention.js';
import type {
  AcceptFailure,
  AnyEntity,
  AnyEventDef,
  CommandHookContext,
  DbHandle,
  Effect,
  EffectHandlers,
  EffectHookContext,
  EntityDef,
  EntityId,
  EntityInfo,
  EntityTable,
  EventDef,
  EventOptions,
  HandlerServices,
  IdTable,
  JobRunner,
  JournalWorker,
  KeyName,
  Needs,
  NoNeeds,
  PendingOf,
  Projection,
  ProjectionHandlers,
  ProjectionOptions,
  RecordedOf,
  ReducerRow,
  RootDb,
  Row,
  Services,
  ServicesFor,
  SingleKey,
  StrandedJobs,
  Tap,
  TapHandlers,
  TransactionSource,
  WakeListener,
} from './types.js';
import type { NoResults, WorkflowBuilder, WorkflowDef, WorkflowOptions } from './workflow/define.js';
import type { WorkflowOps } from './workflow/read.js';
import type { StarterOf } from './workflow/runner.js';

/**
 * Looks at the locked row, checks the rules, and returns the events to append.
 * Runs after the row is locked, inside the write's savepoint. `tx` is that
 * savepoint: reads through it see the locked row's transaction. Return a failure
 * (`@arki/failure`) when a rule says no: the savepoint rolls back, nothing is
 * written, and the write returns that failure.
 */
export type NextEvents<
  Tbl extends EntityTable,
  E extends AnyEventDef,
  Tx = DbHandle,
  Returned extends readonly (PendingOf<E> | SchemaFailure)[] | Failure = readonly (PendingOf<E> | SchemaFailure)[],
> = (row: Row<Tbl> | null, ctx: { readonly tx: Tx }) => Returned | Promise<Returned>;
/** Options of a write, from `journal.write` or a command's `write`. */
export type WriteOptions = {
  /**
   * The row version the caller saw. If the stored version differs (0 for no row), the
   * write is refused with `CONFLICT` before `events` runs, so a client that edited a
   * stale copy learns it instead of overwriting a newer one.
   */
  readonly expectedVersion?: number;
};
export type WriteInput<
  Tbl extends EntityTable,
  E extends AnyEventDef,
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx = DbHandle,
  Returned extends readonly (PendingOf<E> | SchemaFailure)[] | Failure = readonly (PendingOf<E> | SchemaFailure)[],
> = WriteOptions & {
  readonly meta: SchemaInput<Meta>;
  readonly events: NextEvents<Tbl, E, Tx, Returned>;
};

/**
 * A command: a name, an input schema and a handler. `j.command` makes one;
 * `journal.run` runs it. `name` and `input` are for the app (an oRPC procedure
 * can reuse or `.pick` the schema). The handler is for `journal.run` only.
 */
export type Command<S extends StandardSchemaV1, R, in MetaOut, in Tx extends TransactionSource<Tx> = DbHandle> = {
  readonly name: string;
  readonly input: S;
  readonly handler: (input: SchemaOutput<S>, context: CommandContext<MetaOut, Tx>) => R;
  /** The command's `authorize` option, when it has one. See {@link CommandOptions}. Its failures are part of `R`. */
  // `R` holds the failures `authorize` can return: `j.command` adds them. A value that is not a failure is ignored.
  readonly authorize?: CommandAuthorize<SchemaOutput<S>, MetaOut, Tx, void | R>;
};
/**
 * Decides whether the caller may run a command. It runs inside the command's transaction,
 * after the input and `meta` are parsed, on every call: a call that replays an idempotency
 * receipt runs it too, before the stored result is returned. Return a failure
 * (`CommandForbidden`, usually) to refuse: the run rolls back, nothing is replayed,
 * and `journal.run` returns that failure. A throw refuses too.
 */
export type CommandAuthorize<Input, in MetaOut, in Tx extends TransactionSource<Tx> = DbHandle, Refused = void> = (
  input: Input,
  context: { readonly tx: Tx; readonly meta: MetaOut },
) => Refused | Promise<Refused>;
/** Options of `j.command`. */
export type CommandOptions<
  Input,
  MetaOut,
  Tx extends TransactionSource<Tx> = DbHandle,
  Refused extends void | undefined | Failure = void,
> = {
  /**
   * Put the caller's permission check here, not in the handler. A repeat with an idempotency
   * key does not run the handler, so a check inside it would not run either: the stored result
   * would go to whoever replays the key. `authorize` runs on the first call and on every replay.
   */
  readonly authorize?: CommandAuthorize<Input, MetaOut, Tx, Refused>;
};
/**
 * What a command handler receives. `write` and `run` are bound to the command's
 * transaction and metadata. The variance annotations here and on `Command` are
 * needed: the two types refer to each other, and TypeScript cannot measure the
 * variance of such a pair on its own.
 */
/** Options of one call: `journal.run`, a bound runner, a command's `run`, an effect's `ctx.run`. */
export type CallOptions = {
  /**
   * Makes the call idempotent. The first run with this key records its result in
   * `journal_receipts`, in its own transaction. A later run with the same key and the same
   * input returns that result without running the handler; the same key with another input
   * or another command returns `CommandConflict`. The result must survive JSON storage, or the first run
   * fails with `UNSTABLE_SCHEMA`. Scope a key from outside to its caller: `${tenant}:${id}`.
   */
  readonly idempotencyKey?: string;
};
/** Options of `journal.run` and `journal.bind`. */
export type RunOptions = CallOptions & {
  /**
   * With `idempotencyKey` on `journal.bind`: each command the bound runner runs uses
   * `${idempotencyKey}:${command.name}` as its key. One request key then covers a procedure
   * that runs several commands, and each command has its own receipt. A key given per call
   * (`run(command, input, { idempotencyKey })`) is used as it stands.
   */
  readonly keyPerCommand?: boolean;
  /**
   * Seeds the chain's correlation id, for example with the request id. Without it, a run
   * from an effect continues the cause event's chain, and any other run starts a new one.
   */
  readonly correlationId?: string;
};
export type CommandContext<out MetaOut, out Tx extends TransactionSource<Tx> = DbHandle> = {
  /** The command's transaction. Use it for reads and for writes outside any entity. */
  readonly tx: Tx;
  /** The parsed metadata every `write` in this command records. */
  readonly meta: MetaOut;
  /** This run's `cmd_` id. Every event it writes carries it. */
  readonly commandId: string;
  /** The chain this run belongs to. Every event it writes carries it; a child run inherits it. */
  readonly correlationId: string;
  /**
   * `journal.write` on this command's transaction with this command's metadata. Safe to destructure.
   * A failure `events` returns comes back here: return it from the handler, and the command rolls back.
   */
  readonly write: <
    K extends string,
    Tbl extends EntityTable,
    E extends AnyEventDef,
    Key extends string,
    Returned extends readonly (PendingOf<E> | SchemaFailure)[] | Failure,
  >(
    entity: EntityDef<K, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    events: NextEvents<Tbl, E, Tx, Returned>,
    opts?: WriteOptions,
  ) => Promise<WriteResult<Tbl, E, MetaOut, Key> | Extract<Returned, Failure> | SchemaFailure | IdGenerationFailure>;
  /** Run another command in a savepoint of this transaction, with the same metadata. Safe to destructure. */
  readonly run: <S extends StandardSchemaV1, R>(
    command: Command<S, R, MetaOut, Tx>,
    input: NoInfer<SchemaInput<S>>,
    opts?: CallOptions,
  ) => Promise<Awaited<R> | CommandFailure>;
  /**
   * Marks a refusal that `write` or `run` returned as handled, so the handler may still return a
   * success: `if (OutOfStock.is(r)) { accept(r); ... }`. Without it, a success after a refusal
   * throws `IGNORED_FAILURE`. Only this command's own check is lifted: a refused child's
   * savepoint stays rolled back. Safe to destructure. See `AcceptFailure`.
   */
  readonly accept: AcceptFailure;
};
/**
 * The type of `context.run`. Use it in app code that passes `run` on, so the
 * generic signature is not repeated there.
 */
export type CommandRunner<MetaOut, Tx extends TransactionSource<Tx> = DbHandle> = CommandContext<MetaOut, Tx>['run'];
/**
 * The type of an effect's `ctx.run`: `journal.run` without `source`. It runs on the
 * root database the worker or `drain` was given, in its own transaction. `meta`
 * is required, as in `journal.run`: the library never picks an actor.
 */
export type RootCommandRunner<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx> = DbHandle,
> = <S extends StandardSchemaV1, R>(
  command: Command<S, R, SchemaOutput<Meta>, Tx>,
  input: NoInfer<SchemaInput<S>>,
  meta: SchemaInput<Meta>,
  opts?: CallOptions,
) => Promise<Awaited<R> | CommandFailure>;
export type WriteResult<Tbl extends EntityTable, E extends AnyEventDef, MetaOut, Key extends string = 'id'> = {
  readonly row: Row<Tbl> | null;
  readonly events: RecordedOf<E, MetaOut, EntityId<Tbl, Key>>[];
};
export type ForgetResult<Tbl extends EntityTable> = {
  /** How many events were rewritten in this call. Already-erased events count again: the rewrite is the same. */
  readonly erased: number;
  /** The row after repair from the erased log, or `null` if the log says the entity is gone. */
  readonly row: Row<Tbl> | null;
};
export type ReplayResult<Tbl extends EntityTable, E extends AnyEventDef, MetaOut, Key extends string = 'id'> = {
  readonly row: ReducerRow<Tbl, Key> | null;
  readonly events: RecordedOf<E, MetaOut, EntityId<Tbl, Key>>[];
};
export type VerifyResult<Tbl extends EntityTable, Key extends string = 'id'> =
  | { readonly ok: true }
  | { readonly ok: false; readonly expected: ReducerRow<Tbl, Key> | null; readonly actual: Row<Tbl> | null };

export type Journal<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx> = DbHandle,
  AppDb extends RootDb = RootDb,
> = {
  /**
   * Append events, run reducers, save the row, run projections, queue jobs. All inside `tx`.
   * A failure `events` returns is the result: the write's savepoint rolled back.
   */
  write<
    K extends string,
    Tbl extends EntityTable,
    E extends AnyEventDef,
    Key extends string,
    Returned extends readonly (PendingOf<E> | SchemaFailure)[] | Failure,
  >(
    tx: Tx,
    entity: EntityDef<K, Tbl, E, SchemaOutput<Meta>, Key>,
    id: EntityId<Tbl, Key>,
    input: WriteInput<Tbl, E, Meta, Tx, Returned>,
  ): Promise<
    WriteResult<Tbl, E, SchemaOutput<Meta>, Key> | Extract<Returned, Failure> | SchemaFailure | IdGenerationFailure
  >;
  /**
   * Parse `input` and `meta`, then call the command's handler inside one
   * transaction of `source`. A root database opens a transaction; a transaction
   * opens a savepoint. Returns what the handler returns. Unexpected callback
   * exceptions and runtime invariants return typed transaction failures with a private cause.
   * A returned failure (`@arki/failure`) rolls the transaction back like a throw, and is
   * returned, the same instance.
   * On a root database, a run that queued a job calls `wake()` after the commit.
   */
  run<S extends StandardSchemaV1, R>(
    source: TransactionSource<Tx>,
    command: Command<S, R, SchemaOutput<Meta>, Tx>,
    input: NoInfer<SchemaInput<S>>,
    meta: SchemaInput<Meta>,
    opts?: RunOptions,
  ): Promise<Awaited<R> | CommandFailure>;
  /**
   * The command door: `run` with `source` and `meta` fixed. It returns
   * `(command, input) => journal.run(source, command, input, meta)`. A request
   * context binds it once with the signed-in actor; a job binds it with a
   * system actor. The caller still gives `meta`: the library never picks an actor.
   * `source` follows the rules of `run`: a root database commits and wakes, a
   * transaction joins and leaves the commit to the caller.
   * `meta` is parsed on every call, not once here, so a bound runner is exactly
   * `run`: a default in the meta schema gives each command its own value, and
   * a bad `meta` rejects the call, inside the transaction guard, as `run` does.
   */
  bind(
    source: TransactionSource<Tx>,
    meta: SchemaInput<Meta>,
    opts?: RunOptions,
  ): CommandRunner<SchemaOutput<Meta>, Tx>;
  /**
   * Bring a row that existed before the journal into it. The row must be at version 0
   * with no history, or `CONFLICT`. `events` builds exactly one create event from the
   * stored row. Its `.create` reducer must rebuild that row exactly, column by column,
   * or `VALUE_MISMATCH` and nothing changes: replay folds from nothing and must land on
   * the row as it is. The event is recorded as version 1 and the row moves to version 1,
   * so `replay`, `verify` and `repair` work from then on. Projections run and effects
   * are queued as for any write, because the event is the app's own.
   */
  adopt<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    tx: Tx,
    entity: EntityDef<K, Tbl, E, SchemaOutput<Meta>, Key>,
    id: EntityId<Tbl, Key>,
    input: WriteInput<Tbl, E, Meta, Tx>,
  ): Promise<WriteResult<Tbl, E, SchemaOutput<Meta>, Key> | SchemaFailure | IdGenerationFailure>;
  /** Rebuild the row from the log in memory. `throughVersion` is the last version applied. */
  replay<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<K, Tbl, E, SchemaOutput<Meta>, Key>,
    id: EntityId<Tbl, Key>,
    opts?: { readonly throughVersion?: number },
  ): Promise<ReplayResult<Tbl, E, SchemaOutput<Meta>, Key> | SchemaFailure>;
  /** Replay and compare with the stored row on the columns the reducers produce. */
  verify<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<K, Tbl, E, SchemaOutput<Meta>, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<VerifyResult<Tbl, Key> | SchemaFailure>;
  /**
   * Remove personal data from one entity's history. Every stored event whose definition
   * has an `erased` form gets its `data` rewritten to that form and `erased_at` set; events
   * without one are left alone. Then the row is repaired from the rewritten log, so the row
   * and its history agree. All in one transaction: an erased form the schema rejects is
   * `BAD_DEFINITION` and nothing changes; a history replay cannot rebuild (a legacy row that
   * was never adopted) is `NO_HISTORY` and nothing changes. Projections are not rerun, and no
   * job is queued: the app owns its read models. Running it twice is safe.
   */
  forget<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<K, Tbl, E, SchemaOutput<Meta>, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<ForgetResult<Tbl> | SchemaFailure>;
  /**
   * Delete receipts recorded before `before`. Receipts hold inputs and results, which may
   * carry personal data; `forget` does not touch them, so an app that keys personal flows
   * prunes on a schedule. Returns how many were deleted.
   */
  pruneReceipts(db: DbHandle, opts: { readonly before: Date }): Promise<number | IdGenerationFailure>;
  /** Lock the row, replay, save the result. Writes no event, runs no projection, creates no job. */
  repair<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<K, Tbl, E, SchemaOutput<Meta>, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<Row<Tbl> | null | SchemaFailure>;
  /**
   * The async lane of projections: one batch per async projection. Each batch locks the
   * projection's cursor, scans the next `batchSize` events in commit order, applies the
   * matching ones on that transaction, and moves the cursor to the last event scanned.
   * The worker calls it after every drain; call it yourself in tests or one-off scripts.
   * A projection whose batch throws is skipped this pass and tried again next pass.
   */
  catchUp(
    db: RootDb & TransactionSource<Tx>,
    opts?: { readonly batchSize?: number },
  ): Promise<{ readonly scanned: number }>;
  /**
   * Rewind an async projection to the start. `clear` runs on the same transaction, after the
   * cursor is locked and before it is rewound, so the read model is emptied and refilled with
   * no batch landing in between. To rebuild without downtime, deploy the projection under a
   * new name into a new table instead, wait for `cursors` to show lag 0, then switch reads.
   */
  reset(
    db: RootDb & TransactionSource<Tx>,
    projection: Projection<SchemaOutput<Meta>, Tx>,
    clear?: (tx: Tx) => Promise<void>,
  ): Promise<void>;
  /** Per async projection: its cursor and how far behind the newest event it is, in seqs. */
  cursors(db: DbHandle): Promise<readonly { readonly name: string; readonly seq: number; readonly lag: number }[]>;
  /** Walk the log after sequence number `afterSeq` and call one inline projection's handlers, a batch per transaction. Async projections use `reset` and `catchUp`. */
  rerun(
    db: TransactionSource<Tx>,
    projection: Projection<SchemaOutput<Meta>, Tx>,
    opts?: { readonly afterSeq?: number; readonly batchSize?: number },
  ): Promise<{ readonly events: number } | SchemaFailure>;
  /**
   * Run up to `batchSize` due jobs. Returns how many jobs were claimed. Root database only.
   * It must open the journal's transaction type: an effect runs commands on it.
   * Each job is claimed right before it runs, so its lease (`leaseSeconds`, default 60)
   * covers only its own work, and the lease is renewed every half lease while the effect
   * runs. A lost lease aborts the effect's `ctx.signal`.
   * Once `signal` is aborted no further job is claimed; the running one sees it as `ctx.signal`.
   * `services` and `jobs`: see `worker`.
   */
  drain(
    db: AppDb & RootDb & TransactionSource<Tx>,
    opts?: {
      readonly batchSize?: number;
      readonly signal?: AbortSignal;
      readonly leaseSeconds?: number;
      readonly services?: HandlerServices;
      readonly jobs?: JobRunner<AppDb>;
    },
  ): Promise<number | IdGenerationFailure>;
  /**
   * A loop around `drain`. The same database as `drain`. `stop()` aborts the running
   * effect's `ctx.signal`, claims nothing more, and resolves when that effect returns.
   */
  worker(
    db: AppDb & RootDb & TransactionSource<Tx>,
    opts?: {
      readonly pollMs?: number;
      readonly batchSize?: number;
      readonly leaseSeconds?: number;
      /**
       * Hear the wake channel (`journal.wakeChannel`): a commit that recorded events wakes this
       * worker at once, from any process, and the journal's taps fire here for those events.
       * Required when the journal has taps, unless `taps: false` says this worker runs jobs only.
       */
      readonly listen?: WakeListener;
      /** `false`: a jobs-only worker in a journal that has taps. Another process must listen. */
      readonly taps?: boolean;
      /**
       * The services of a journal composed with `services: 'worker'`, per effect and tap.
       * A need without a value throws here, before the worker starts. A journal composed
       * with its services ignores this.
       */
      readonly services?: HandlerServices;
      /**
       * Runs `kind = 'queue'` rows (jobs scheduled by `@arki/queue/outbox`) whose name is in
       * `jobs.names`, under the same lease and fenced ack as effects. Without it the worker
       * claims effect rows only, exactly as before.
       */
      readonly jobs?: JobRunner<AppDb>;
    },
  ): JournalWorker;
  /**
   * The Postgres channel every commit that recorded events notifies, with the seq range as
   * JSON `{ "from": n, "to": m }`. `journal_wake`, or `<schema>_journal_wake` for tables in a
   * schema. Payloads are small and bounded; a listener loads what it needs by seq.
   */
  readonly wakeChannel: string;
  /**
   * Wake every running worker this journal started in this process. Call it
   * after committing a transaction of your own that ran commands. No worker: nothing happens.
   */
  wake(): void;
  /**
   * Pending jobs no handler can claim, counted per kind and name: effect rows whose effect
   * this journal does not have and, given the worker's `jobs` runner, queue rows whose name
   * it does not know. Without `jobs`, queue rows are not counted.
   * `drain` leaves them alone, because during a rolling deploy an older worker may
   * still have that handler. After the deploy, a non-empty list means a handler was
   * renamed or removed while it had jobs: bring it back under its old name until
   * the count is zero, or delete those job rows on purpose.
   */
  strandedJobs(db: DbHandle, opts?: { readonly jobs?: Pick<JobRunner, 'names'> }): Promise<readonly StrandedJobs[]>;
  /**
   * The resolved archive policy: the `retention` option of `initJournal` with its defaults filled in. The one source the
   * worker, the verbs and the sweeper read.
   */
  readonly retention: ResolvedRetention;
  /**
   * List jobs: `pending` (the default) is everything not dead, oldest due first; `dead` is what the worker
   * gave up on, newest first. `state` says where each is now. `limit` 1 to 200, default 100. `next` is the cursor
   * of the following page (pass it as `after`), null on the last. `effect` filters effect rows, `job` queue rows.
   */
  jobs: JobOps['jobs'];
  /** One job with its event header, its attempts (`attemptLog`) and the latest operations that touched it. */
  job: JobOps['job'];
  /** Per effect and queue job name: how many jobs are ready, delayed, running and dead. */
  jobCounts: JobOps['jobCounts'];
  /** Who did what to the jobs, newest first. `jobId` keeps the operations that touched one job. */
  jobOperations: JobOps['jobOperations'];
  /** Finished jobs, newest first, with `outcome`, `effect` and `job` filters. */
  archivedJobs: JobOps['archivedJobs'];
  /** One finished job with its attempt log, or undefined. */
  archivedJob: JobOps['archivedJob'];
  /** How many archive rows there are, how many wait for the sink, and how many are past `keepUntil`. */
  archiveStatus: JobOps['archiveStatus'];
  /**
   * Workflow runs, read and operated on: `runs`, `run`, `counts`, `stranded`, `history`, and the operator verbs
   * `retryStep`, `resolveStep` and `skipUndo`. The verbs need `compose({ workflows, workflowMeta })`.
   */
  readonly workflows: WorkflowOps<Tx>;
  /** A dead job back to pending: attempts and lease cleared, due now, workers woken. `JOB_NOT_DEAD` otherwise. */
  retry: JobOps['retry'];
  /** A dead job leaves the hot table, archived as `discarded`. `JOB_NOT_DEAD` otherwise. */
  discard: JobOps['discard'];
  /** A ready or delayed job leaves the hot table, archived as `cancelled`. `JOB_RUNNING` or `JOB_NOT_PENDING` otherwise. */
  cancel: JobOps['cancel'];
  /** Retry many dead jobs by ids or by filter, all or none by ids. `operationId` is null when nothing matched. */
  retryDead: JobOps['retryDead'];
  /** Dead jobs older than `olderThan` leave the hot table, archived or deleted by the retention policy. */
  purgeDead: JobOps['purgeDead'];
  /**
   * Send unexported archive rows to `retention.archive.sink`, oldest first, up to `limit`. Marks them exported only
   * after the sink resolved (at-least-once); a throwing sink leaves them and returns `failed: true`. No sink: a no-op.
   * `op` defaults to the actor `system:retention`.
   */
  exportArchive: JobOps['exportArchive'];
  /**
   * Delete archive rows past `keep_until` and the oldest beyond any `max`. With a sink, only exported rows go.
   * `op` defaults to the actor `system:retention`.
   */
  pruneArchive: JobOps['pruneArchive'];
  /**
   * Delete finished workflow runs past their `keep_until`, with their steps and signals. The events stay. A run is never
   * pruned while it or an ancestor is unfinished. `op` defaults to the actor `system:retention`.
   */
  pruneWorkflows: JobOps['pruneWorkflows'];
  /** Delete operation rows past the `operations` keep. Writes no operation row of its own. */
  pruneOperations: JobOps['pruneOperations'];
  /** A new job from an archived one. Not a retry: it gets a new id. `JOB_EXISTS` when a live job holds the dedupe key. Not `replay`, which rebuilds an entity from its events. */
  replayJob: JobOps['replayJob'];
  /**
   * The one way to extend a run from outside: a wrapper that receives the context and
   * `next`. Command hooks run inside the transaction, around the handler; effect hooks run
   * inside the lease, around the handler. Rules: call `next` exactly once, or throw before
   * it to stop; a rejection of `next` is the hook's rejection too; the context is frozen
   * and the result cannot be changed; hooks run in registration order, the first outermost.
   * Register at boot: once the journal has run a command, a drain or a worker, `around`
   * throws `BAD_DEFINITION`.
   */
  readonly hooks: {
    readonly command: HookPoint<CommandHookContext<SchemaOutput<Meta>>>;
    readonly effect: HookPoint<EffectHookContext<SchemaOutput<Meta>>>;
  };
  readonly catalog: {
    /**
     * Only the entities that a projection or an effect of this journal names. An
     * entity that no handler names is not listed, even when the app writes to it.
     */
    readonly entities: readonly EntityInfo[];
    readonly projections: readonly string[];
    readonly effects: readonly string[];
    readonly taps: readonly string[];
  };
};

export type JournalDefinitions<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx> = DbHandle,
  AppDb extends RootDb = RootDb,
> = {
  /**
   * An event. `schema` and each upcaster's `from` are Standard Schemas, parsed sync
   * (`parse`) by the constructor, `write` and replay.
   */
  event<T extends string, S extends StandardSchemaV1, const U extends readonly StandardSchemaV1[] = readonly []>(
    type: T,
    schema: S,
    opts?: EventOptions<S, U>,
  ): EventDef<T, S>;
  /** The key column is `id`. */
  entity<K extends string, Tbl extends IdTable>(
    kind: K,
    table: Tbl,
  ): EntityBuilder<K, Tbl, never, SchemaOutput<Meta>, 'id'>;
  /**
   * The key column is the one `table` holds under the property name `options.key`:
   * a non-null string column that is the primary key or unique.
   */
  entity<K extends string, Tbl extends EntityTable, Key extends KeyName<Tbl>>(
    kind: K,
    table: Tbl,
    options: { readonly key: Key & SingleKey<Key> },
  ): EntityBuilder<K, Tbl, never, SchemaOutput<Meta>, Key>;
  /**
   * A command: `input` (any Standard Schema) is parsed async (`parseAsync`) before
   * the handler runs, like the command's `meta`; the handler's
   * `write` and `run` are bound to one transaction and one parsed `meta`.
   * Needs only `j`, entities and events, never the finished journal.
   */
  command<S extends StandardSchemaV1, R, Refused extends void | undefined | Failure = void>(
    name: string,
    input: S,
    handler: (input: SchemaOutput<S>, context: CommandContext<SchemaOutput<Meta>, Tx>) => R,
    options?: CommandOptions<SchemaOutput<S>, SchemaOutput<Meta>, Tx, Refused>,
  ): Command<S, R | Extract<Refused, Failure>, SchemaOutput<Meta>, Tx>;
  /** `on` is `NoInfer` so `E` comes from `entity`; handlers are then contextually typed. */
  projection<E extends AnyEntity<SchemaOutput<Meta>>>(
    name: string,
    entity: E | readonly E[],
    on: NoInfer<ProjectionHandlers<E, SchemaOutput<Meta>, Tx>>,
    opts?: ProjectionOptions,
  ): Projection<SchemaOutput<Meta>, Tx>;
  effect<E extends AnyEntity<SchemaOutput<Meta>>>(
    name: string,
    entity: E | readonly E[],
    on: NoInfer<EffectHandlers<E, SchemaOutput<Meta>, AppDb, RootCommandRunner<Meta, Tx>>>,
  ): Effect<SchemaOutput<Meta>, AppDb, RootCommandRunner<Meta, Tx>>;
  /**
   * An effect that needs a service: `needs` is `{ mailer: need<Mailer>() }`, and each
   * handler then gets `mailer` in its context, next to `jobId`, `signal`, `db` and `run`.
   */
  effect<E extends AnyEntity<SchemaOutput<Meta>>, N extends Needs>(
    name: string,
    entity: E | readonly E[],
    needs: N,
    on: NoInfer<EffectHandlers<E, SchemaOutput<Meta>, AppDb, RootCommandRunner<Meta, Tx>, N>>,
  ): Effect<SchemaOutput<Meta>, AppDb, RootCommandRunner<Meta, Tx>, N>;
  /**
   * Build the runtime journal from the tables given to `initJournal` and the handlers. `services` holds one
   * value for every need of every listed effect, by name. A need without a value throws here, unless `services` is `'worker'`.
   * `const`: the list is read as a tuple, so an effect with needs keeps them next to one without.
   */
  /** A tap: in-process, after commit, lossy. See `Tap`. Same shapes as `effect`. */
  tap<E extends AnyEntity<SchemaOutput<Meta>>>(
    name: string,
    entity: E | readonly E[],
    on: NoInfer<TapHandlers<E, SchemaOutput<Meta>, AppDb>>,
  ): Tap<SchemaOutput<Meta>, AppDb>;
  tap<E extends AnyEntity<SchemaOutput<Meta>>, N extends Needs>(
    name: string,
    entity: E | readonly E[],
    needs: N,
    on: NoInfer<TapHandlers<E, SchemaOutput<Meta>, AppDb, N>>,
  ): Tap<SchemaOutput<Meta>, AppDb, N>;
  /**
   * A durable workflow: `.step(...)` nodes, then `.finish()`. The finished definition has `start`, a command:
   * `context.run(refund.start, { input, id? })` returns `{ runId }` (a repeat with the same `id` and input returns the
   * same run; another input is a `CommandConflict`). Pass the definition to `compose({ workflows })` so a worker runs it.
   */
  workflow<
    Input extends StandardSchemaV1,
    N extends Needs = NoNeeds,
    Declared extends StandardSchemaV1 | undefined = undefined,
  >(
    name: string,
    options: WorkflowOptions<Input, N, Declared>,
  ): WorkflowBuilder<
    Input,
    NoResults,
    N,
    Declared,
    never,
    { readonly db: AppDb; readonly run: RootCommandRunner<Meta, Tx> },
    StarterOf<Meta, Tx, Input>
  >;
  compose<
    const E extends readonly Effect<SchemaOutput<Meta>, AppDb, RootCommandRunner<Meta, Tx>, Needs>[] = readonly [],
    const T extends readonly Tap<SchemaOutput<Meta>, AppDb, Needs>[] = readonly [],
  >(
    config: {
      readonly projections?: readonly Projection<SchemaOutput<Meta>, Tx>[];
      readonly effects?: E;
      readonly taps?: T;
      /** Workflows to run. Adds the `workflow.step` effect and the `workflow-steps` projection; their needs come from `services`. */
      readonly workflows?: readonly WorkflowDef[];
      /** The meta recorded on the checkpoints the workflow runner commits, such as `{ actorId: 'system:workflow' }`. Required with `workflows`. */
      readonly workflowMeta?: SchemaInput<Meta>;
    } & ServicesOption<ServicesFor<E> & ServicesFor<T>>,
  ): Journal<Meta, Tx, AppDb>;
};
/**
 * `services` is required as soon as one listed effect has a need. `'worker'` leaves the needs
 * open: writes never need them, and each `worker` or `drain` gives them (`HandlerServices`).
 * That is for services that exist only after the journal: the Dot adapter's features boot
 * after the journal they write through.
 */
type ServicesOption<S> = unknown extends S
  ? { readonly services?: Services | 'worker' }
  : { readonly services: (S & Services) | 'worker' };
