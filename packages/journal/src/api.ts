/**
 * The public declarations: the `Journal` object, commands and their context, the
 * definition helpers `initJournal` returns, and the input, option and result types.
 * Types only, no runtime code. May import `entity`, `types` and `pg`; nothing else.
 */
import type { z } from 'zod';

import type { EntityBuilder } from './entity.js';
import type { HookPoint } from './hooks.js';
import type { JournalTables } from './pg.js';
import type {
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
  IdTable,
  JournalWorker,
  KeyName,
  Needs,
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

/**
 * Looks at the locked row, checks the rules, and returns the events to append.
 * Runs after the row is locked, inside the write's savepoint. `tx` is that
 * savepoint: reads through it see the locked row's transaction.
 */
export type NextEvents<Tbl extends EntityTable, E extends AnyEventDef, Tx = DbHandle> = (
  row: Row<Tbl> | null,
  ctx: { readonly tx: Tx },
) => readonly PendingOf<E>[] | Promise<readonly PendingOf<E>[]>;
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
  Meta extends z.ZodObject,
  Tx = DbHandle,
> = WriteOptions & {
  readonly meta: z.input<Meta>;
  readonly events: NextEvents<Tbl, E, Tx>;
};

/**
 * A command: a name, an input schema and a handler. `j.command` makes one;
 * `journal.run` runs it. `name` and `input` are for the app (an oRPC procedure
 * can reuse or `.pick` the schema). The handler is for `journal.run` only.
 */
export type Command<S extends z.ZodType, R, in MetaOut, in Tx extends TransactionSource<Tx> = DbHandle> = {
  readonly name: string;
  readonly input: S;
  readonly handler: (input: z.output<S>, context: CommandContext<MetaOut, Tx>) => R;
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
   * or another command is `CONFLICT`. The result must survive JSON storage, or the first run
   * fails with `UNSTABLE_SCHEMA`. Scope a key from outside to its caller: `${tenant}:${id}`.
   */
  readonly idempotencyKey?: string;
};
/** Options of `journal.run` and `journal.bind`. */
export type RunOptions = CallOptions & {
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
  /** `journal.write` on this command's transaction with this command's metadata. Safe to destructure. */
  readonly write: <K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    entity: EntityDef<K, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    events: NextEvents<Tbl, E, Tx>,
    opts?: WriteOptions,
  ) => Promise<WriteResult<Tbl, E, MetaOut, Key>>;
  /** Run another command in a savepoint of this transaction, with the same metadata. Safe to destructure. */
  readonly run: <S extends z.ZodType, R>(
    command: Command<S, R, MetaOut, Tx>,
    input: NoInfer<z.input<S>>,
    opts?: CallOptions,
  ) => Promise<Awaited<R>>;
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
export type RootCommandRunner<Meta extends z.ZodObject, Tx extends TransactionSource<Tx> = DbHandle> = <
  S extends z.ZodType,
  R,
>(
  command: Command<S, R, z.output<Meta>, Tx>,
  input: NoInfer<z.input<S>>,
  meta: z.input<Meta>,
  opts?: CallOptions,
) => Promise<Awaited<R>>;
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
  Meta extends z.ZodObject,
  Tx extends TransactionSource<Tx> = DbHandle,
  AppDb extends RootDb = RootDb,
> = {
  /** Append events, run reducers, save the row, run projections, queue jobs. All inside `tx`. */
  write<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    tx: Tx,
    entity: EntityDef<K, Tbl, E, z.output<Meta>, Key>,
    id: EntityId<Tbl, Key>,
    input: WriteInput<Tbl, E, Meta, Tx>,
  ): Promise<WriteResult<Tbl, E, z.output<Meta>, Key>>;
  /**
   * Parse `input` and `meta`, then call the command's handler inside one
   * transaction of `source`. A root database opens a transaction; a transaction
   * opens a savepoint. Returns what the handler returns. Errors pass through.
   * On a root database, a run that queued a job calls `wake()` after the commit.
   */
  run<S extends z.ZodType, R>(
    source: TransactionSource<Tx>,
    command: Command<S, R, z.output<Meta>, Tx>,
    input: NoInfer<z.input<S>>,
    meta: z.input<Meta>,
    opts?: RunOptions,
  ): Promise<Awaited<R>>;
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
  bind(source: TransactionSource<Tx>, meta: z.input<Meta>, opts?: RunOptions): CommandRunner<z.output<Meta>, Tx>;
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
    entity: EntityDef<K, Tbl, E, z.output<Meta>, Key>,
    id: EntityId<Tbl, Key>,
    input: WriteInput<Tbl, E, Meta, Tx>,
  ): Promise<WriteResult<Tbl, E, z.output<Meta>, Key>>;
  /** Rebuild the row from the log in memory. `throughVersion` is the last version applied. */
  replay<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<K, Tbl, E, z.output<Meta>, Key>,
    id: EntityId<Tbl, Key>,
    opts?: { readonly throughVersion?: number },
  ): Promise<ReplayResult<Tbl, E, z.output<Meta>, Key>>;
  /** Replay and compare with the stored row on the columns the reducers produce. */
  verify<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<K, Tbl, E, z.output<Meta>, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<VerifyResult<Tbl, Key>>;
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
    entity: EntityDef<K, Tbl, E, z.output<Meta>, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<ForgetResult<Tbl>>;
  /**
   * Delete receipts recorded before `before`. Receipts hold inputs and results, which may
   * carry personal data; `forget` does not touch them, so an app that keys personal flows
   * prunes on a schedule. Returns how many were deleted.
   */
  pruneReceipts(db: DbHandle, opts: { readonly before: Date }): Promise<number>;
  /** Lock the row, replay, save the result. Writes no event, runs no projection, creates no job. */
  repair<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<K, Tbl, E, z.output<Meta>, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<Row<Tbl> | null>;
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
    projection: Projection<z.output<Meta>, Tx>,
    clear?: (tx: Tx) => Promise<void>,
  ): Promise<void>;
  /** Per async projection: its cursor and how far behind the newest event it is, in seqs. */
  cursors(db: DbHandle): Promise<readonly { readonly name: string; readonly seq: number; readonly lag: number }[]>;
  /** Walk the log after sequence number `afterSeq` and call one inline projection's handlers, a batch per transaction. Async projections use `reset` and `catchUp`. */
  rerun(
    db: TransactionSource<Tx>,
    projection: Projection<z.output<Meta>, Tx>,
    opts?: { readonly afterSeq?: number; readonly batchSize?: number },
  ): Promise<{ readonly events: number }>;
  /**
   * Run up to `batchSize` due jobs. Returns how many jobs were claimed. Root database only.
   * It must open the journal's transaction type: an effect runs commands on it.
   * Each job is claimed right before it runs, so its lease (`leaseSeconds`, default 60)
   * covers only its own work, and the lease is renewed every half lease while the effect
   * runs. A lost lease aborts the effect's `ctx.signal`.
   * Once `signal` is aborted no further job is claimed; the running one sees it as `ctx.signal`.
   */
  drain(
    db: AppDb & RootDb & TransactionSource<Tx>,
    opts?: { readonly batchSize?: number; readonly signal?: AbortSignal; readonly leaseSeconds?: number },
  ): Promise<number>;
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
   * Pending jobs whose effect this journal does not have, counted per effect name.
   * `drain` leaves them alone, because during a rolling deploy an older worker may
   * still have that effect. After the deploy, a non-empty list means an effect was
   * renamed or removed while it had jobs: bring it back under its old name until
   * the count is zero, or delete those job rows on purpose.
   */
  strandedJobs(db: DbHandle): Promise<readonly StrandedJobs[]>;
  /**
   * List job rows. `pending` (the default) is everything not dead: due, delayed and leased
   * alike. `dead` is what the worker gave up on. Oldest due first, `limit` 100.
   */
  jobs(
    db: DbHandle,
    opts?: { readonly status?: 'pending' | 'dead' | 'all'; readonly effect?: string; readonly limit?: number },
  ): Promise<JournalTables['jobs']['$inferSelect'][]>;
  /** A dead job back to pending: attempts and lease cleared, due now, workers woken. A job that is not dead throws. */
  retry(db: DbHandle, jobId: string): Promise<void>;
  /** Delete a dead job. A job that is not dead throws: deleting a live one would not stop its work. */
  discard(db: DbHandle, jobId: string): Promise<void>;
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
    readonly command: HookPoint<CommandHookContext<z.output<Meta>>>;
    readonly effect: HookPoint<EffectHookContext<z.output<Meta>>>;
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
  Meta extends z.ZodObject,
  Tx extends TransactionSource<Tx> = DbHandle,
  AppDb extends RootDb = RootDb,
> = {
  event<T extends string, S extends z.ZodType, const U extends readonly z.ZodType[] = readonly []>(
    type: T,
    schema: S,
    opts?: EventOptions<S, U>,
  ): EventDef<T, S>;
  /** The key column is `id`. */
  entity<K extends string, Tbl extends IdTable>(
    kind: K,
    table: Tbl,
  ): EntityBuilder<K, Tbl, never, z.output<Meta>, 'id'>;
  /**
   * The key column is the one `table` holds under the property name `options.key`:
   * a non-null string column that is the primary key or unique.
   */
  entity<K extends string, Tbl extends EntityTable, Key extends KeyName<Tbl>>(
    kind: K,
    table: Tbl,
    options: { readonly key: Key & SingleKey<Key> },
  ): EntityBuilder<K, Tbl, never, z.output<Meta>, Key>;
  /**
   * A command: `input` is parsed before the handler runs; the handler's
   * `write` and `run` are bound to one transaction and one parsed `meta`.
   * Needs only `j`, entities and events, never the finished journal.
   */
  command<S extends z.ZodType, R>(
    name: string,
    input: S,
    handler: (input: z.output<S>, context: CommandContext<z.output<Meta>, Tx>) => R,
  ): Command<S, R, z.output<Meta>, Tx>;
  /** `on` is `NoInfer` so `E` comes from `entity`; handlers are then contextually typed. */
  projection<E extends AnyEntity<z.output<Meta>>>(
    name: string,
    entity: E | readonly E[],
    on: NoInfer<ProjectionHandlers<E, z.output<Meta>, Tx>>,
    opts?: ProjectionOptions,
  ): Projection<z.output<Meta>, Tx>;
  effect<E extends AnyEntity<z.output<Meta>>>(
    name: string,
    entity: E | readonly E[],
    on: NoInfer<EffectHandlers<E, z.output<Meta>, AppDb, RootCommandRunner<Meta, Tx>>>,
  ): Effect<z.output<Meta>, AppDb, RootCommandRunner<Meta, Tx>>;
  /**
   * An effect that needs a service: `needs` is `{ mailer: need<Mailer>() }`, and each
   * handler then gets `mailer` in its context, next to `jobId`, `signal`, `db` and `run`.
   */
  effect<E extends AnyEntity<z.output<Meta>>, N extends Needs>(
    name: string,
    entity: E | readonly E[],
    needs: N,
    on: NoInfer<EffectHandlers<E, z.output<Meta>, AppDb, RootCommandRunner<Meta, Tx>, N>>,
  ): Effect<z.output<Meta>, AppDb, RootCommandRunner<Meta, Tx>, N>;
  /**
   * Build the runtime journal from the tables and the handlers. `services` holds one
   * value for every need of every listed effect, by name. A need without a value throws here.
   * `const`: the list is read as a tuple, so an effect with needs keeps them next to one without.
   */
  /** A tap: in-process, after commit, lossy. See `Tap`. Same shapes as `effect`. */
  tap<E extends AnyEntity<z.output<Meta>>>(
    name: string,
    entity: E | readonly E[],
    on: NoInfer<TapHandlers<E, z.output<Meta>, AppDb>>,
  ): Tap<z.output<Meta>, AppDb>;
  tap<E extends AnyEntity<z.output<Meta>>, N extends Needs>(
    name: string,
    entity: E | readonly E[],
    needs: N,
    on: NoInfer<TapHandlers<E, z.output<Meta>, AppDb, N>>,
  ): Tap<z.output<Meta>, AppDb, N>;
  compose<
    const E extends readonly Effect<z.output<Meta>, AppDb, RootCommandRunner<Meta, Tx>, Needs>[] = readonly [],
    const T extends readonly Tap<z.output<Meta>, AppDb, Needs>[] = readonly [],
  >(
    config: {
      readonly tables: JournalTables;
      readonly projections?: readonly Projection<z.output<Meta>, Tx>[];
      readonly effects?: E;
      readonly taps?: T;
    } & ServicesOption<ServicesFor<E> & ServicesFor<T>>,
  ): Journal<Meta, Tx, AppDb>;
};
/** `services` is required as soon as one listed effect has a need. */
type ServicesOption<S> = unknown extends S ? { readonly services?: Services } : { readonly services: S & Services };
