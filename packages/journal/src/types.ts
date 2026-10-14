import type { AnyRelations } from 'drizzle-orm';
import type { AnyPgColumn, PgAsyncDatabase, PgQueryResultHKT, PgTableWithColumns } from 'drizzle-orm/pg-core';
import type { z } from 'zod';

/**
 * A function type whose parameters are checked bivariantly.
 *
 * TypeScript only relaxes parameter variance for method signatures. Reading
 * the method back out of an object type keeps that relaxation on a plain
 * function type. This is how a registry can hold handlers written for one
 * event type under a common `Recorded` parameter without a cast.
 */
export type BivariantFn<Args extends unknown[], R> = { bivarianceHack(...args: Args): R }['bivarianceHack'];

type AnyDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

/** A key's longest id, and whether the key column or the journal's own `entity_id` column sets it. */
export type KeyLimit = { readonly max: number; readonly source: 'column' | 'journal' };

/**
 * The Drizzle surface the journal needs. Structural: a Drizzle database and a
 * Drizzle transaction both fit. The journal never touches `db.query`, so the
 * app's relations do not matter here.
 */
export type DbHandle = {
  readonly select: AnyDb['select'];
  readonly insert: AnyDb['insert'];
  readonly update: AnyDb['update'];
  readonly delete: AnyDb['delete'];
  readonly execute: AnyDb['execute'];
  transaction<T>(run: (tx: DbHandle) => Promise<T>): Promise<T>;
};

/**
 * The root database only. A Drizzle transaction has `rollback()`, so it does
 * not fit. `drain` and `worker` need this: inside a transaction their claim
 * would be a savepoint and handlers would run before the outer commit.
 */
export type RootDb = DbHandle & { readonly rollback?: undefined };

/**
 * A database or transaction whose nested transactions have type `Tx`. The
 * app's Drizzle transaction type fits `TransactionSource<itself>`: a savepoint has
 * the same type as its parent. The root database fits `TransactionSource<AppTx>`.
 * `DbHandle` fits `TransactionSource<DbHandle>`, which is the default everywhere.
 */
export type TransactionSource<Tx> = { transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> } & DbHandle;

/** A column that can hold an entity's key: a non-null string column. */
export type KeyColumn = AnyPgColumn<{ data: string; notNull: true }>;
export type VersionColumn = AnyPgColumn<{ data: number; notNull: true }>;

/**
 * A Drizzle table qualifies as an entity table when it has an integer
 * `version` and a string key column. The key column is `id` unless the entity
 * names another one. Every other column is the app's business.
 */
export type EntityTable = PgTableWithColumns<{
  name: string;
  schema: string | undefined;
  dialect: 'pg';
  columns: {
    version: VersionColumn;
  };
}>;

/** An entity table whose key column is called `id`. The default for `j.entity(kind, table)`. */
export type IdTable = PgTableWithColumns<{
  name: string;
  schema: string | undefined;
  dialect: 'pg';
  columns: {
    id: KeyColumn;
    version: VersionColumn;
  };
}>;

/** The property names of the columns of `Tbl` that can hold the key: non-null string columns. */
export type KeyName<Tbl extends EntityTable> = string &
  {
    [K in keyof Tbl['_']['columns']]: Tbl['_']['columns'][K] extends KeyColumn ? K : never;
  }[keyof Tbl['_']['columns']];

/** `true` when `T` is a union of two or more members. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
/**
 * `Key` when it is one property name, `never` for a union. A union key would make
 * `ReducerValues` omit every member, so a reducer could leave required columns unset.
 */
export type SingleKey<Key extends string> = IsUnion<Key> extends true ? never : Key;

/** The current state of one entity. A plain Drizzle select row. */
export type Row<Tbl extends EntityTable> = Tbl['$inferSelect'];
/** What reducers return. The library sets the key column and `version`. */
export type ReducerValues<Tbl extends EntityTable, Key extends string = 'id'> = Omit<
  Tbl['$inferInsert'],
  Key | 'version'
>;
/** The key type of an entity table, as the key column declares it. */
export type EntityId<Tbl extends EntityTable, Key extends string = 'id'> = Extract<
  Row<Tbl>[Key & keyof Row<Tbl>],
  string
>;
/**
 * A row rebuilt in memory from events: a reducer result plus the key column
 * and `version`. Columns a reducer leaves out are absent here even when the
 * database would fill them with a default.
 */
export type ReducerRow<Tbl extends EntityTable, Key extends string = 'id'> = ReducerValues<Tbl, Key> &
  Readonly<Record<Key, EntityId<Tbl, Key>>> & { readonly version: number };

/** A validated event that has not been written yet. */
export type Pending<T extends string = string, Data = unknown> = {
  readonly type: T;
  readonly data: Data;
};

/** What the log adds to a pending event when it is written. `Id` is the entity's key type. */
export type RecordedStamp<Meta = unknown, Id extends string = string> = {
  readonly seq: number;
  readonly id: string;
  readonly kind: string;
  readonly entityId: Id;
  readonly version: number;
  readonly meta: Meta;
  readonly recordedAt: Date;
  /** The `cmd_` id of the command run that wrote it. Null for a bare `journal.write`, and on rows older than the column. */
  readonly commandId: string | null;
  /** The seq of the event whose effect ran the command that wrote it. Null outside an effect, and on rows older than the column. */
  readonly causeSeq: number | null;
  /** Shared by every event of one chain. Null only on rows older than the column. */
  readonly correlationId: string | null;
  /** When `forget` rewrote `data` to the event's erased form. Null if it never did. */
  readonly erasedAt: Date | null;
};

/**
 * Where a write comes from. The library fills it: a command run stamps its own id, an
 * effect's `ctx.run` passes the event it is for, a root `run` may be seeded with a
 * correlation id from the request. A bare `journal.write` has no command and no cause.
 */
export type Trace = {
  readonly commandId: string | null;
  readonly causeSeq: number | null;
  readonly correlationId: string;
};

/** What reducers and handlers receive: the event as stored in the log. */
export type Recorded<T extends string = string, Data = unknown, Meta = unknown, Id extends string = string> = Pending<
  T,
  Data
> &
  RecordedStamp<Meta, Id>;

/**
 * An event definition. Calling it validates the data and returns a pending
 * event. `type` and `schema` are read by the entity builder and by replay.
 */
export type EventDef<T extends string, S extends z.ZodType> = BivariantFn<
  [data: z.input<S>],
  Pending<T, z.output<S>>
> & {
  readonly type: T;
  readonly schema: S;
  /**
   * The event's erased form, for `forget`: the same data with the personal parts
   * removed. It must still fit `schema`. Absent on an event that holds no personal data.
   * A method signature, so every `EventDef` is an `AnyEventDef`; see `BivariantFn`.
   */
  erased?(data: z.output<S>): z.input<S>;
  /**
   * The schema version new events are stored at: one more than the number of upcasters.
   * Rows record it in `schema_version`; a row at an older version is upcast on read.
   */
  readonly version: number;
  /** Lifts stored data one version up. `upcasters[0]` takes version 1 to 2. Empty for most events. */
  readonly upcasters: readonly Upcaster[];
};

/**
 * One step of an event's history: the schema its data had at one version, and how to
 * lift that data to the next. Replay parses with `from` first, so `up` sees valid old data.
 * `up` is a method signature, so a typed step is an `Upcaster`; see `BivariantFn`.
 */
export type Upcaster = {
  readonly from: z.ZodType;
  up(data: unknown): unknown;
};

/** Typed upcaster steps: each `up` receives the output of its own `from`. */
export type UpcasterSteps<U extends readonly z.ZodType[]> = {
  readonly [K in keyof U]: { readonly from: U[K]; readonly up: (data: z.output<U[K]>) => unknown };
};

/** The third argument of `j.event`. */
export type EventOptions<S extends z.ZodType, U extends readonly z.ZodType[] = readonly []> = {
  /** See `EventDef.erased`. */
  readonly erased?: (data: z.output<S>) => z.input<S>;
  /**
   * Older shapes of this event, oldest first: `{ from: schemaV1, up: v1 => v2 }`, then
   * `{ from: schemaV2, up: v2 => v3 }`. The last step's result must fit the current schema.
   * Append a step when the event's data changes incompatibly; never edit or remove one.
   */
  readonly upcasters?: UpcasterSteps<U>;
};
export type AnyEventDef = EventDef<string, z.ZodType>;

/** The pending form of one or more event definitions. Distributes over unions. */
export type PendingOf<D> = D extends AnyEventDef ? Pending<D['type'], z.output<D['schema']>> : never;
/** The recorded form of one or more event definitions. */
export type RecordedOf<D, Meta, Id extends string = string> = PendingOf<D> & RecordedStamp<Meta, Id>;

/**
 * What an `.on` reducer returns: the columns that changed. `null` deletes the
 * row. A key set to `undefined` means "unchanged".
 */
export type Patch<Tbl extends EntityTable, Key extends string = 'id'> = Partial<ReducerValues<Tbl, Key>>;

/** A create reducer receives no row. It builds the first row from the event. */
export type CreateReducer<Tbl extends EntityTable, Meta, Key extends string = 'id'> = BivariantFn<
  [event: Recorded<string, unknown, Meta>],
  ReducerValues<Tbl, Key>
>;
/**
 * An `.on` reducer may receive a row loaded from the table or a row rebuilt in
 * memory by an earlier reducer in the same write or replay. Both are
 * `ReducerRow` at runtime; the union is here because TypeScript cannot relate a
 * generic select row to the insert shape.
 */
export type OnReducer<Tbl extends EntityTable, Meta, Key extends string = 'id'> = BivariantFn<
  [row: Row<Tbl> | ReducerRow<Tbl, Key>, event: Recorded<string, unknown, Meta>],
  Patch<Tbl, Key> | null
>;
/** The reducers declared for one event type. Both may be set: the fold picks by state. */
export type Reducers<Tbl extends EntityTable, Meta, Key extends string = 'id'> = {
  readonly create?: CreateReducer<Tbl, Meta, Key>;
  readonly on?: OnReducer<Tbl, Meta, Key>;
};

/** An entity: a kind, its table and key column, and the events and reducers declared so far. */
export type EntityDef<
  K extends string,
  Tbl extends EntityTable,
  E extends AnyEventDef,
  Meta,
  Key extends string = 'id',
> = {
  readonly kind: K;
  readonly table: Tbl;
  /** The property name of the key column on the table and its rows. */
  readonly key: Key;
  /** The key column. Lock-and-load, update and delete filter on it. */
  readonly keyColumn: KeyColumn;
  /** Whether the key column is a `uuid`, decided once when the entity is defined. Such ids must be canonical. */
  readonly uuidKey: boolean;
  /** The longest id the key holds, in code points, decided once when the entity is defined. */
  readonly keyLimit: KeyLimit;
  readonly events: ReadonlyMap<string, AnyEventDef>;
  readonly reducers: ReadonlyMap<string, Reducers<Tbl, Meta, Key>>;
  /** Phantom: the union of event definitions this entity accepts. Never set at runtime. */
  readonly $events?: E;
};
export type AnyEntity<Meta = unknown> = EntityDef<string, EntityTable, AnyEventDef, Meta, string>;

/** The event definitions an entity accepts, read from its phantom `$events`. */
export type EventsOf<E> = E extends { readonly $events?: infer D } ? Extract<NonNullable<D>, AnyEventDef> : never;
/** The key type of one or more entities, read from their table and key. */
export type EntityIdOf<E> = E extends {
  readonly table: infer Tbl extends EntityTable;
  readonly key: infer Key extends string;
}
  ? EntityId<Tbl, Key>
  : never;

/** Keys are event types; each handler sees the event typed for that key. */
export type ProjectionHandlers<E, Meta, Tx = DbHandle> = {
  readonly [D in EventsOf<E> as D['type']]?: BivariantFn<[tx: Tx, event: RecordedOf<D, Meta, EntityIdOf<E>>], unknown>;
};
/** An effect handler also gets one value for each of the effect's needs `N`, under the need's name. */
export type EffectHandlers<E, Meta, AppDb = RootDb, Run = unknown, N extends Needs = NoNeeds> = {
  readonly [D in EventsOf<E> as D['type']]?: BivariantFn<
    [event: RecordedOf<D, Meta, EntityIdOf<E>>, ctx: EffectContext<AppDb, Run> & Needed<N>],
    unknown
  >;
};

/** Inline handler. Runs inside the write's transaction. */
export type Projection<Meta = unknown, Tx = DbHandle> = {
  readonly name: string;
  readonly entities: readonly AnyEntity<Meta>[];
  readonly types: ReadonlySet<string>;
  /**
   * `inline`: runs inside the write's transaction, so the read model is exact. `async`: the
   * worker applies it later, in batches, with a cursor in `journal_cursors` committed in the
   * same transaction as the handlers; exactly once for database writes, eventually consistent.
   */
  readonly lane: 'inline' | 'async';
  readonly run: BivariantFn<[tx: Tx, event: Recorded<string, unknown, Meta>], Promise<void>>;
};

/** The fourth argument of `j.projection`. */
export type ProjectionOptions = { readonly lane?: 'inline' | 'async' };

/**
 * `db` is the root database that was given to `drain` or `worker`: the same object.
 * `run` is `journal.run` on that database. A journal types it as `RootCommandRunner`
 * (in `api.ts`). This file cannot name a command, so the type comes in as `Run`.
 */
export type EffectContext<AppDb = RootDb, Run = unknown> = {
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly db: AppDb;
  readonly run: Run;
};

declare const needType: unique symbol;
/**
 * A marker for one thing an effect needs, such as a mailer. `need<Mailer>()` makes one.
 * It holds the type only. The real value comes later: from `services` in `j.compose`,
 * or from the services of the Dot feature that lists the effect.
 */
export type Need<T> = { readonly [needType]?: T };
/** The needs of one effect, by the name its handlers read them under. */
export type Needs = Readonly<Record<string, Need<unknown>>>;
export type NoNeeds = Readonly<Record<never, Need<unknown>>>;
/** What the handlers get for the needs `N`: one value per name. */
export type Needed<N extends Needs> = { readonly [K in keyof N]: N[K] extends Need<infer T> ? T : never };
/** Real services by name, as an app or a Dot feature hands them over. */
export type Services = Readonly<Record<string, unknown>>;
/** Names one effect or one tap. Effect names and tap names are two separate sets. */
export type HandlerRef = { readonly kind: 'effect' | 'tap'; readonly name: string };
/**
 * The services of each effect and tap, given where they run instead of where the journal
 * is composed: `j.compose({ ..., services: 'worker' })`, then `journal.worker(db, { services })`.
 * One function, so each handler can get its own services: two Dot features may use one need
 * name for two different services.
 */
export type HandlerServices = (handler: HandlerRef) => Services;

type UnionToIntersection<U> = (U extends unknown ? (member: U) => void : never) extends (all: infer I) => void
  ? I
  : never;
/** The needs of each effect in a union. An effect that needs nothing adds nothing. */
type DeclaredNeeds<E> = E extends { readonly needs: infer N extends Needs }
  ? keyof N extends never
    ? never
    : N
  : never;
/**
 * Every need of every effect in a list, as one object of services. Two effects that
 * use the same name get the same service. `unknown` when no effect needs anything.
 */
export type ServicesFor<E extends readonly { readonly needs: Needs }[]> = UnionToIntersection<
  Needed<DeclaredNeeds<E[number]>>
>;

/** Async handler. Runs after commit, at least once. */
/**
 * When an effect's jobs run. `priority`: higher first among due jobs; strict, so a
 * steady stream of high-priority jobs can starve lower ones. `delaySeconds`: due that
 * long after the write's transaction started (`now()` in Postgres). `runAt`: due at the
 * time the event names, from the app's clock. Retries keep their backoff and priority.
 */
export type EffectSchedule<Meta = unknown> = {
  readonly priority?: number;
  readonly delaySeconds?: number;
  /** A method signature, so an effect of one meta type is still an `Effect<unknown>`; see `BivariantFn`. */
  runAt?(event: Recorded<string, unknown, Meta>): Date;
};

export type Effect<Meta = unknown, AppDb = RootDb, Run = unknown, N extends Needs = NoNeeds> = {
  readonly name: string;
  readonly entities: readonly AnyEntity<Meta>[];
  readonly types: ReadonlySet<string>;
  /** What the handlers need on top of `EffectContext`. Empty for an effect that already has its services. */
  readonly needs: N;
  readonly schedule: EffectSchedule<Meta>;
  /** The same effect with this schedule. `j.effect('mail', order, handlers).withSchedule({ priority: 5 })`. */
  withSchedule(schedule: EffectSchedule<Meta>): Effect<Meta, AppDb, Run, N>;
  readonly run: BivariantFn<
    [event: Recorded<string, unknown, Meta>, ctx: EffectContext<AppDb, Run> & Needed<N>],
    Promise<void>
  >;
};

export type EntityInfo = { readonly kind: string; readonly table: string; readonly events: readonly string[] };

/** What a tap handler gets: the root database, plus its needs. No `run`: a tap may not issue commands. */
export type TapContext<AppDb = RootDb> = { readonly db: AppDb };

export type TapHandlers<E, Meta, AppDb = RootDb, N extends Needs = NoNeeds> = {
  readonly [D in EventsOf<E> as D['type']]?: BivariantFn<
    [event: RecordedOf<D, Meta, EntityIdOf<E>>, ctx: TapContext<AppDb> & Needed<N>],
    unknown
  >;
};

/**
 * A tap: in-process, after commit, lossy. No job row, no retry, no ordering promise across
 * entities. It fires in every process whose worker listens on the wake channel, from the
 * seq range the commit announced. For a live page, a cache, a metric. Never for work that
 * must happen: that is an effect.
 */
export type Tap<Meta = unknown, AppDb = RootDb, N extends Needs = NoNeeds> = {
  readonly name: string;
  readonly entities: readonly AnyEntity<Meta>[];
  readonly types: ReadonlySet<string>;
  readonly needs: N;
  readonly run: BivariantFn<
    [event: Recorded<string, unknown, Meta>, ctx: TapContext<AppDb> & Needed<N>],
    Promise<void>
  >;
};

/** Stops listening. May be async. */
export type Unlisten = () => void | Promise<void>;
/**
 * How a worker hears the wake channel. The app wires its own client: for `pg`, a dedicated
 * client that runs `LISTEN <channel>` and calls `onMessage(payload)` on each notification; for
 * PGlite, `client.listen(channel, onMessage)`. Start it before `worker.start()` resolves work
 * you care about: `LISTEN` only hears what is sent after it ran, and the worker still polls.
 */
export type WakeListener = (onMessage: (payload: string) => void) => Unlisten | Promise<Unlisten>;

/** `wake()` runs a drain pass now instead of at the next poll. It does nothing unless the worker is running. */
export type JournalWorker = { start(): Promise<void>; stop(): Promise<void>; wake(): void };

/** What a command hook sees. Frozen. `input` is the parsed input; a hook may read it, not change it. */
export type CommandHookContext<MetaOut = unknown> = {
  readonly name: string;
  readonly input: unknown;
  readonly meta: MetaOut;
  readonly commandId: string;
  readonly correlationId: string;
  /** The idempotency key of this call, or null. A hook sees a replayed call too: its handler does not run. */
  readonly idempotencyKey: string | null;
};

/** What an effect hook sees. Frozen. `attempt` counts from 1. */
export type EffectHookContext<Meta = unknown> = {
  readonly name: string;
  readonly event: Recorded<string, unknown, Meta>;
  readonly jobId: string;
  readonly attempt: number;
};

/** Pending jobs for one effect name that the journal has no effect for. */
export type StrandedJobs = { readonly effect: string; readonly jobs: number };
