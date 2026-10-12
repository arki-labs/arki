/**
 * The public declarations: the `Journal` object, commands and their context, the
 * definition helpers `initJournal` returns, and the input, option and result types.
 * Types only, no runtime code. May import `entity`, `types` and `pg`; nothing else.
 */
import type { z } from 'zod';

import type { EntityBuilder } from './entity.js';
import type { JournalTables } from './pg.js';
import type {
  AnyEntity,
  AnyEventDef,
  DbHandle,
  Effect,
  EffectHandlers,
  EntityDef,
  EntityId,
  EntityInfo,
  EntityTable,
  EventDef,
  IdTable,
  JournalWorker,
  KeyName,
  Needs,
  PendingOf,
  Projection,
  ProjectionHandlers,
  RecordedOf,
  ReducerRow,
  RootDb,
  Row,
  Services,
  ServicesFor,
  SingleKey,
  TransactionSource,
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
export type WriteInput<Tbl extends EntityTable, E extends AnyEventDef, Meta extends z.ZodObject, Tx = DbHandle> = {
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
export type CommandContext<out MetaOut, out Tx extends TransactionSource<Tx> = DbHandle> = {
  /** The command's transaction. Use it for reads and for writes outside any entity. */
  readonly tx: Tx;
  /** The parsed metadata every `write` in this command records. */
  readonly meta: MetaOut;
  /** `journal.write` on this command's transaction with this command's metadata. Safe to destructure. */
  readonly write: <K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    entity: EntityDef<K, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    events: NextEvents<Tbl, E, Tx>,
  ) => Promise<WriteResult<Tbl, E, MetaOut, Key>>;
  /** Run another command in a savepoint of this transaction, with the same metadata. Safe to destructure. */
  readonly run: <S extends z.ZodType, R>(
    command: Command<S, R, MetaOut, Tx>,
    input: NoInfer<z.input<S>>,
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
) => Promise<Awaited<R>>;
export type WriteResult<Tbl extends EntityTable, E extends AnyEventDef, MetaOut, Key extends string = 'id'> = {
  readonly row: Row<Tbl> | null;
  readonly events: RecordedOf<E, MetaOut, EntityId<Tbl, Key>>[];
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
  bind(source: TransactionSource<Tx>, meta: z.input<Meta>): CommandRunner<z.output<Meta>, Tx>;
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
  /** Lock the row, replay, save the result. Writes no event, runs no projection, creates no job. */
  repair<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<K, Tbl, E, z.output<Meta>, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<Row<Tbl> | null>;
  /** Walk the log after sequence number `afterSeq` and call one projection's handlers, a batch per transaction. */
  rerun(
    db: TransactionSource<Tx>,
    projection: Projection<z.output<Meta>, Tx>,
    opts?: { readonly afterSeq?: number; readonly batchSize?: number },
  ): Promise<{ readonly events: number }>;
  /**
   * Run one batch of due jobs. Returns how many jobs were claimed. Root database only.
   * It must open the journal's transaction type: an effect runs commands on it.
   */
  drain(
    db: AppDb & RootDb & TransactionSource<Tx>,
    opts?: { readonly batchSize?: number; readonly signal?: AbortSignal },
  ): Promise<number>;
  /** A loop around `drain`. `stop()` finishes the current batch. The same database as `drain`. */
  worker(
    db: AppDb & RootDb & TransactionSource<Tx>,
    opts?: { readonly pollMs?: number; readonly batchSize?: number },
  ): JournalWorker;
  /**
   * Wake every running worker this journal started in this process. Call it
   * after committing a transaction of your own that ran commands. No worker: nothing happens.
   */
  wake(): void;
  readonly catalog: {
    /**
     * Only the entities that a projection or an effect of this journal names. An
     * entity that no handler names is not listed, even when the app writes to it.
     */
    readonly entities: readonly EntityInfo[];
    readonly projections: readonly string[];
    readonly effects: readonly string[];
  };
};

export type JournalDefinitions<
  Meta extends z.ZodObject,
  Tx extends TransactionSource<Tx> = DbHandle,
  AppDb extends RootDb = RootDb,
> = {
  event<T extends string, S extends z.ZodType>(type: T, schema: S): EventDef<T, S>;
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
  compose<const E extends readonly Effect<z.output<Meta>, AppDb, RootCommandRunner<Meta, Tx>, Needs>[] = readonly []>(
    config: {
      readonly tables: JournalTables;
      readonly projections?: readonly Projection<z.output<Meta>, Tx>[];
      readonly effects?: E;
    } & ServicesOption<ServicesFor<E>>,
  ): Journal<Meta, Tx, AppDb>;
};
/** `services` is required as soon as one listed effect has a need. */
type ServicesOption<S> = unknown extends S ? { readonly services?: Services } : { readonly services: S & Services };
