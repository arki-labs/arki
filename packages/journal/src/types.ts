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
export type Fn<Args extends unknown[], R> = { bivarianceHack(...args: Args): R }['bivarianceHack'];

type AnyDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

/**
 * The Drizzle surface the journal needs. Structural: a Drizzle database and a
 * Drizzle transaction both fit. The journal never touches `db.query`, so the
 * app's relations do not matter here.
 */
export type Db = {
  readonly select: AnyDb['select'];
  readonly insert: AnyDb['insert'];
  readonly update: AnyDb['update'];
  readonly delete: AnyDb['delete'];
  readonly execute: AnyDb['execute'];
  transaction<T>(run: (tx: Db) => Promise<T>): Promise<T>;
};

/**
 * The root database only. A Drizzle transaction has `rollback()`, so it does
 * not fit. `drain` and `worker` need this: inside a transaction their claim
 * would be a savepoint and handlers would run before the outer commit.
 */
export type RootDb = Db & { readonly rollback?: undefined };

/**
 * A Drizzle table qualifies as an entity table when it has a string primary
 * key `id` and an integer `version`. Every other column is the app's business.
 */
export type EntityTable = PgTableWithColumns<{
  name: string;
  schema: string | undefined;
  dialect: 'pg';
  columns: {
    id: AnyPgColumn<{ data: string; notNull: true }>;
    version: AnyPgColumn<{ data: number; notNull: true }>;
  };
}>;

/** The current state of one entity. A plain Drizzle select row. */
export type Row<Tbl extends EntityTable> = Tbl['$inferSelect'];
/** What reducers return. The library sets `id` and `version`. */
export type NewRow<Tbl extends EntityTable> = Omit<Tbl['$inferInsert'], 'id' | 'version'>;
/** The id type of an entity table, as the table declares it. */
export type EntityId<Tbl extends EntityTable> = Row<Tbl>['id'];
/**
 * A row rebuilt in memory from events: a reducer result plus `id` and
 * `version`. Columns a reducer leaves out are absent here even when the
 * database would fill them with a default.
 */
export type Replayed<Tbl extends EntityTable> = NewRow<Tbl> & { readonly id: EntityId<Tbl>; readonly version: number };

/** A validated event that has not been written yet. */
export type Pending<T extends string = string, Data = unknown> = {
  readonly type: T;
  readonly data: Data;
};

/** What the log adds to a pending event when it is written. */
export type RecordedStamp<Meta = unknown> = {
  readonly seq: number;
  readonly id: string;
  readonly kind: string;
  readonly entityId: string;
  readonly version: number;
  readonly meta: Meta;
  readonly recordedAt: Date;
};

/** What reducers and handlers receive: the event as stored in the log. */
export type Recorded<T extends string = string, Data = unknown, Meta = unknown> = Pending<T, Data> & RecordedStamp<Meta>;

/**
 * An event definition. Calling it validates the data and returns a pending
 * event. `type` and `schema` are read by the entity builder and by replay.
 */
export type EventDef<T extends string, S extends z.ZodType> = Fn<[data: z.input<S>], Pending<T, z.output<S>>> & {
  readonly type: T;
  readonly schema: S;
};
export type AnyEventDef = EventDef<string, z.ZodType>;

/** The pending form of one or more event definitions. Distributes over unions. */
export type PendingOf<D> = D extends AnyEventDef ? Pending<D['type'], z.output<D['schema']>> : never;
/** The recorded form of one or more event definitions. */
export type RecordedOf<D, Meta> = PendingOf<D> & RecordedStamp<Meta>;

/**
 * What an `.on` reducer returns: the columns that changed. `null` deletes the
 * row. A key set to `undefined` means "unchanged".
 */
export type Patch<Tbl extends EntityTable> = Partial<NewRow<Tbl>>;

/**
 * One reducer as the entity stores it. `.on` reducers may receive a row
 * loaded from the table or a row rebuilt in memory by an earlier reducer in
 * the same write or replay. Both are `Replayed<Tbl>` at runtime; the union is
 * here because TypeScript cannot relate a generic select row to the insert shape.
 */
export type Reducer<Tbl extends EntityTable, Meta> =
  | { readonly mode: 'create'; readonly apply: Fn<[event: Recorded<string, unknown, Meta>], NewRow<Tbl>> }
  | {
      readonly mode: 'on';
      readonly apply: Fn<[row: Row<Tbl> | Replayed<Tbl>, event: Recorded<string, unknown, Meta>], Patch<Tbl> | null>;
    };

/** An entity: a kind, its table, and the events and reducers declared so far. */
export type EntityDef<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Meta> = {
  readonly kind: K;
  readonly table: Tbl;
  readonly events: ReadonlyMap<string, AnyEventDef>;
  readonly reducers: ReadonlyMap<string, Reducer<Tbl, Meta>>;
  /** Phantom: the union of event definitions this entity accepts. Never set at runtime. */
  readonly $events?: E;
};
export type AnyEntity<Meta = unknown> = EntityDef<string, EntityTable, AnyEventDef, Meta>;

/** The event definitions an entity accepts, read from its phantom `$events`. */
export type EventsOf<E> = E extends { readonly $events?: infer D } ? Extract<NonNullable<D>, AnyEventDef> : never;

/** Keys are event types; each handler sees the event typed for that key. */
export type ProjectionHandlers<E, Meta> = {
  readonly [D in EventsOf<E> as D['type']]?: Fn<[tx: Db, event: RecordedOf<D, Meta>], unknown>;
};
export type EffectHandlers<E, Meta> = {
  readonly [D in EventsOf<E> as D['type']]?: Fn<[event: RecordedOf<D, Meta>, ctx: EffectContext], unknown>;
};

/** Inline handler. Runs inside the write's transaction. */
export type Projection<Meta = unknown> = {
  readonly name: string;
  readonly entities: readonly AnyEntity<Meta>[];
  readonly types: ReadonlySet<string>;
  readonly run: Fn<[tx: Db, event: Recorded<string, unknown, Meta>], Promise<void>>;
};

export type EffectContext = { readonly jobId: string; readonly signal: AbortSignal };

/** Async handler. Runs after commit, at least once. */
export type Effect<Meta = unknown> = {
  readonly name: string;
  readonly entities: readonly AnyEntity<Meta>[];
  readonly types: ReadonlySet<string>;
  readonly run: Fn<[event: Recorded<string, unknown, Meta>, ctx: EffectContext], Promise<void>>;
};

export type EntityInfo = { readonly kind: string; readonly table: string; readonly events: readonly string[] };

export type Worker = { start(): Promise<void>; stop(): Promise<void> };
