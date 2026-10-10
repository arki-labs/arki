import { and, asc, eq, getTableColumns, getTableName, gt, inArray, is, isNull, lte, max, or, sql } from 'drizzle-orm';
import { PgAsyncTransaction, PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { EntityBuilder } from './entity.js';
import type { JournalTables } from './pg.js';
import type {
  AnyEntity,
  AnyEventDef,
  Db,
  Effect,
  EffectHandlers,
  EntityDef,
  EntityId,
  EntityInfo,
  EntityTable,
  EventDef,
  IdTable,
  KeyName,
  NewRow,
  OneKey,
  PendingOf,
  Projection,
  ProjectionHandlers,
  Recorded,
  RecordedOf,
  Replayed,
  RootDb,
  Row,
  Transaction,
  Worker,
} from './types.js';
import { debugCommand, debugDrain, debugReplay, debugWorker, debugWrite } from './debug.js';
import { defineEntity, reduceOne, replayed } from './entity.js';
import { JournalError } from './errors.js';
import { defineEvent } from './event.js';
import { defineEffect, defineProjection } from './handlers.js';
import { eventId, jobId, leaseToken } from './id.js';

/**
 * Looks at the locked row, checks the rules, and returns the events to append.
 * Runs after the row is locked, inside the write's savepoint. `tx` is that
 * savepoint: reads through it see the locked row's transaction.
 */
export type WriteEvents<Tbl extends EntityTable, E extends AnyEventDef, Tx = Db> = (
  row: Row<Tbl> | null,
  ctx: { readonly tx: Tx },
) => readonly PendingOf<E>[] | Promise<readonly PendingOf<E>[]>;
export type WriteInput<Tbl extends EntityTable, E extends AnyEventDef, Meta extends z.ZodObject, Tx = Db> = {
  readonly meta: z.input<Meta>;
  readonly events: WriteEvents<Tbl, E, Tx>;
};

/**
 * A command: a name, an input schema and a handler. `j.command` makes one;
 * `journal.run` runs it. `name` and `input` are for the app (an oRPC procedure
 * can reuse or `.pick` the schema). The handler is for `journal.run` only.
 */
export type Command<S extends z.ZodType, R, in MetaOut, in Tx extends Transaction<Tx> = Db> = {
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
export type CommandContext<out MetaOut, out Tx extends Transaction<Tx> = Db> = {
  /** The command's transaction. Use it for reads and for writes outside any entity. */
  readonly tx: Tx;
  /** The parsed metadata every `write` in this command records. */
  readonly meta: MetaOut;
  /** `journal.write` on this command's transaction with this command's metadata. Safe to destructure. */
  readonly write: <K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    entity: EntityDef<K, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    events: WriteEvents<Tbl, E, Tx>,
  ) => Promise<WriteResult<Tbl, E, MetaOut, Key>>;
  /** Run another command in a savepoint of this transaction, with the same metadata. Safe to destructure. */
  readonly run: <S extends z.ZodType, R>(
    command: Command<S, R, MetaOut, Tx>,
    input: NoInfer<z.input<S>>,
  ) => Promise<Awaited<R>>;
};
export type WriteResult<Tbl extends EntityTable, E extends AnyEventDef, MetaOut, Key extends string = 'id'> = {
  readonly row: Row<Tbl> | null;
  readonly events: RecordedOf<E, MetaOut, EntityId<Tbl, Key>>[];
};
export type ReplayResult<Tbl extends EntityTable, E extends AnyEventDef, MetaOut, Key extends string = 'id'> = {
  readonly row: Replayed<Tbl, Key> | null;
  readonly events: RecordedOf<E, MetaOut, EntityId<Tbl, Key>>[];
};
export type VerifyResult<Tbl extends EntityTable, Key extends string = 'id'> =
  | { readonly ok: true }
  | { readonly ok: false; readonly expected: Replayed<Tbl, Key> | null; readonly actual: Row<Tbl> | null };

export type Journal<Meta extends z.ZodObject, Tx extends Transaction<Tx> = Db, AppDb extends RootDb = RootDb> = {
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
    source: Transaction<Tx>,
    command: Command<S, R, z.output<Meta>, Tx>,
    input: NoInfer<z.input<S>>,
    meta: z.input<Meta>,
  ): Promise<Awaited<R>>;
  /** Rebuild the row from the log in memory. `upTo` stops at that version. */
  replay<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: Db,
    entity: EntityDef<K, Tbl, E, z.output<Meta>, Key>,
    id: EntityId<Tbl, Key>,
    opts?: { readonly upTo?: number },
  ): Promise<ReplayResult<Tbl, E, z.output<Meta>, Key>>;
  /** Replay and compare with the stored row on the columns the reducers produce. */
  verify<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: Db,
    entity: EntityDef<K, Tbl, E, z.output<Meta>, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<VerifyResult<Tbl, Key>>;
  /** Lock the row, replay, save the result. Writes no event, runs no projection, creates no job. */
  repair<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: Db,
    entity: EntityDef<K, Tbl, E, z.output<Meta>, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<Row<Tbl> | null>;
  /** Walk the log from `from` and call one projection's handlers, a batch per transaction. */
  rerun(
    db: Transaction<Tx>,
    projection: Projection<z.output<Meta>, Tx>,
    opts?: { readonly from?: number; readonly batch?: number },
  ): Promise<{ readonly events: number }>;
  /** Run one batch of due jobs. Returns how many jobs were claimed. Root database only. */
  drain(db: AppDb & RootDb, opts?: { readonly limit?: number; readonly signal?: AbortSignal }): Promise<number>;
  /** A loop around `drain`. `stop()` finishes the current batch. Root database only. */
  worker(db: AppDb & RootDb, opts?: { readonly pollMs?: number; readonly limit?: number }): Worker;
  /**
   * Wake every running worker this journal started in this process. Call it
   * after committing a transaction of your own that ran commands. No worker: nothing happens.
   */
  wake(): void;
  readonly catalog: {
    readonly entities: readonly EntityInfo[];
    readonly projections: readonly string[];
    readonly effects: readonly string[];
  };
};

export type JournalInit<Meta extends z.ZodObject, Tx extends Transaction<Tx> = Db, AppDb extends RootDb = RootDb> = {
  event<T extends string, S extends z.ZodType>(type: T, schema: S): EventDef<T, S>;
  /** The key column is `id`. */
  entity<K extends string, Tbl extends IdTable>(
    kind: K,
    table: Tbl,
  ): EntityBuilder<K, Tbl, never, z.output<Meta>, 'id'>;
  /**
   * The key column is the one `table` holds under the property name `options.id`:
   * a non-null string column that is the primary key or unique.
   */
  entity<K extends string, Tbl extends EntityTable, Key extends KeyName<Tbl>>(
    kind: K,
    table: Tbl,
    options: { readonly id: Key & OneKey<Key> },
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
    on: NoInfer<EffectHandlers<E, z.output<Meta>, AppDb>>,
  ): Effect<z.output<Meta>, AppDb>;
  create(config: {
    readonly tables: JournalTables;
    readonly projections?: readonly Projection<z.output<Meta>, Tx>[];
    readonly effects?: readonly Effect<z.output<Meta>, AppDb>[];
  }): Journal<Meta, Tx, AppDb>;
};

const emptyMeta = z.object({});
type EmptyMeta = typeof emptyMeta;

const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 300_000;
const DEFAULT_POLL_MS = 1000;
const PG_UNIQUE_VIOLATION = '23505';

function initFor<Tx extends Transaction<Tx>, AppDb extends RootDb>() {
  function init(): JournalInit<EmptyMeta, Tx, AppDb>;
  function init<Meta extends z.ZodObject>(options: { readonly meta: Meta }): JournalInit<Meta, Tx, AppDb>;
  function init<Meta extends z.ZodObject>(options?: {
    readonly meta?: Meta;
  }): JournalInit<Meta, Tx, AppDb> | JournalInit<EmptyMeta, Tx, AppDb> {
    return options?.meta === undefined
      ? createInit<EmptyMeta, Tx, AppDb>(emptyMeta)
      : createInit<Meta, Tx, AppDb>(options.meta);
  }
  return init;
}

/**
 * `initJournal({ meta })` types `write`'s `tx`, `events`' `{ tx }` and
 * projection handlers with the structural `Db`. `initJournal.tx<AppTx>()
 * .create({ meta })` uses the app's own Drizzle transaction type instead, so
 * repositories typed against it fit. `initJournal.db<AppDb>()` names the
 * app's root database type: effects get it as `ctx.db`, and `drain` and
 * `worker` then need it. Both are type-only steps and chain in either order.
 */
export const initJournal = Object.assign(initFor<Db, RootDb>(), {
  tx: <Tx extends Transaction<Tx>>() => ({
    create: initFor<Tx, RootDb>(),
    db: <AppDb extends RootDb>() => ({ create: initFor<Tx, AppDb>() }),
  }),
  db: <AppDb extends RootDb>() => ({
    create: initFor<Db, AppDb>(),
    tx: <Tx extends Transaction<Tx>>() => ({ create: initFor<Tx, AppDb>() }),
  }),
});

/** A table with a column called `id`. The check is real; the guard narrows to `IdTable`. */
function hasIdColumn<Tbl extends EntityTable>(table: Tbl): table is Tbl & IdTable {
  const columns: Record<string, unknown> = getTableColumns(table);
  return is(columns.id, PgColumn);
}

function createInit<Meta extends z.ZodObject, Tx extends Transaction<Tx>, AppDb extends RootDb>(
  metaSchema: Meta,
): JournalInit<Meta, Tx, AppDb> {
  type MetaOut = z.output<Meta>;
  function entity<K extends string, Tbl extends IdTable>(
    kind: K,
    table: Tbl,
  ): EntityBuilder<K, Tbl, never, MetaOut, 'id'>;
  function entity<K extends string, Tbl extends EntityTable, Key extends KeyName<Tbl>>(
    kind: K,
    table: Tbl,
    options: { readonly id: Key & OneKey<Key> },
  ): EntityBuilder<K, Tbl, never, MetaOut, Key>;
  function entity<K extends string, Tbl extends EntityTable>(kind: K, table: Tbl, options?: { readonly id: string }) {
    if (options !== undefined) {
      return defineEntity<K, Tbl, MetaOut, string>(kind, table, options.id);
    }
    if (!hasIdColumn(table)) {
      throw new Error(
        `journal: entity "${kind}": table "${getTableName(table)}" has no "id" column; pass { id: 'columnName' }`,
      );
    }
    return defineEntity<K, Tbl, MetaOut, 'id'>(kind, table, 'id');
  }
  return {
    event: defineEvent,
    entity,
    command: (name, input, handler) => ({ name, input, handler }),
    projection: (name, entity, on) => defineProjection(name, entity, on),
    effect: (name, entity, on) => defineEffect(name, entity, on),
    create: config =>
      createJournal<Meta, Tx, AppDb>(metaSchema, config.tables, config.projections ?? [], config.effects ?? []),
  };
}

/** A select row has every column of its table. The check is real; the guard narrows. */
function isRowOf<Tbl extends EntityTable>(table: Tbl, value: object): value is Row<Tbl> {
  return Object.keys(getTableColumns(table)).every(column => column in value);
}

type Keyed = Pick<AnyEntity, 'table' | 'keyColumn'>;

async function loadRow(db: Db, entity: Keyed, id: string, lock: boolean): Promise<object | null> {
  const query = db.select().from(entity.table).where(eq(entity.keyColumn, id)).limit(1);
  const rows = lock ? await query.for('update') : await query;
  return rows[0] ?? null;
}

/**
 * The id the caller passes must be exactly the key the database stores. A database can treat
 * two spellings as one key (a `uuid` ignores case), but the log is keyed by the raw string,
 * so a second spelling would split one entity's history in two.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * With no row to compare against (a create and delete in one write, a replay of a missing row),
 * `assertStoredId` sees nothing, so the id is checked up front, before any database access: not
 * empty, within the key's length limit in code points (the column or the log would cut it), and,
 * for a `uuid` key, lower-case and hyphenated.
 */
function assertExactId(entity: Pick<AnyEntity, 'kind' | 'uuidKey' | 'keyLimit'>, id: string): void {
  const fail = (reason: string): never => {
    throw new JournalError('ID_MISMATCH', entity.kind, id, reason);
  };
  if (id === '') fail('the id is empty');
  // (Surrogates are U+D800 to U+DFFF.) A lone surrogate is encoded by the driver as U+FFFD, so it would reach the history of another id.
  // Iterating by code point yields a paired surrogate as one astral character, never as a surrogate.
  for (const ch of id) {
    const point = ch.codePointAt(0) ?? 0;
    if (point >= 55_296 && point <= 57_343) {
      fail(
        'the id contains an unpaired surrogate, so it is not well-formed text and the database would store a different key',
      );
    }
  }
  const length = [...id].length;
  if (length > entity.keyLimit.max) {
    const owner = entity.keyLimit.source === 'column' ? "the key column's" : "the journal's";
    fail(`the id is ${length} characters but the limit is ${entity.keyLimit.max}, ${owner} limit`);
  }
  if (entity.uuidKey && !CANONICAL_UUID.test(id)) {
    fail(`${JSON.stringify(id)} is not a canonical uuid; uuid keys must be lower-case and hyphenated`);
  }
}

function assertStoredId(entity: Pick<AnyEntity, 'kind' | 'key'>, row: object | null, id: string): void {
  if (row === null) return;
  const stored: unknown = Reflect.get(row, entity.key);
  if (stored !== id) {
    throw new JournalError(
      'ID_MISMATCH',
      entity.kind,
      id,
      `the stored key is ${JSON.stringify(stored)} but the id given is ${JSON.stringify(id)}; use the stored form`,
    );
  }
}

/** Insert, update or delete the row so it matches `next`. Returns the stored row. */
async function saveReplayed<Tbl extends EntityTable, Key extends string>(
  db: Db,
  entity: EntityDef<string, Tbl, AnyEventDef, unknown, Key>,
  id: EntityId<Tbl, Key>,
  current: object | null,
  next: Replayed<Tbl, Key> | null,
): Promise<Row<Tbl> | null> {
  const erased: EntityTable = entity.table;
  if (next === null) {
    if (current !== null) await db.delete(erased).where(eq(entity.keyColumn, id));
    return null;
  }
  const saved =
    current === null
      ? await db.insert(erased).values(next).returning()
      : await db.update(erased).set(next).where(eq(entity.keyColumn, id)).returning();
  const row = saved[0];
  if (row === undefined || !isRowOf(entity.table, row)) {
    throw new Error(`journal: saving ${id} returned no complete row`);
  }
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && current.code === PG_UNIQUE_VIOLATION) return true;
    if ('message' in current && typeof current.message === 'string' && /duplicate key value/i.test(current.message)) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function toRecord(value: object): Record<string, unknown> {
  return { ...value };
}

function showValue(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * The row the database returned must hold, for each of `columns`, the value the reducers produced.
 * Replay recomputes from reducer output, so a value the database rounds, trims or alters would make
 * replay and the table drift apart. Uses the same comparison as `verify`.
 */
function assertStoredValues(
  entity: Pick<AnyEntity, 'kind'>,
  id: string,
  produced: object,
  saved: object,
  columns: Iterable<string>,
): void {
  const want = toRecord(produced);
  const have = toRecord(saved);
  for (const column of columns) {
    if (!sameValue(want[column], have[column])) {
      throw new JournalError(
        'VALUE_MISMATCH',
        entity.kind,
        id,
        `column "${column}": the reducer produced ${showValue(want[column])} but the database stored ${showValue(have[column])}; the reducer must produce the value in the form the database stores`,
      );
    }
  }
}

/** Same own enumerable keys and same values. A key holding `undefined` is the same as a missing key, as in JSON. */
function sameKeys(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  same: (a: unknown, b: unknown) => boolean,
): boolean {
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter(key => right[key] !== undefined);
  return keys.length === rightKeys.length && keys.every(key => same(left[key], right[key]));
}

/** An object literal shape: prototype `Object.prototype` or `null`. A `Set`, `Map`, `Date` or class instance is not one. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Freeze a plain object or array and everything inside it. A `Date` is frozen
 * itself; its internals are not touched. Anything else is left alone.
 */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    Object.freeze(value);
  } else if (isPlainObject(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  } else if (value instanceof Date) {
    Object.freeze(value);
  }
  return value;
}

/** Same length, and every index from 0 up compared. A hole is not equal to a value, `null` and `undefined` included. */
function sameArray(a: readonly unknown[], b: readonly unknown[], same: (x: unknown, y: unknown) => boolean): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (index in a !== index in b) return false;
    if (!same(a[index], b[index])) return false;
  }
  return true;
}

/**
 * Deep equality for stored rows: `verify` compares what replay produced with what the table holds.
 * Strict: primitives, `Date`, arrays and plain objects only. A `Map`, `Set`, class instance or typed
 * array is never equal to anything, because JSON storage would lose its contents.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'function' || typeof a === 'symbol') return false;
  if (typeof a !== 'object' || a === null) return Object.is(a, b);
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a)) return Array.isArray(b) && sameArray(a, b, sameValue);
  if (isPlainObject(a) && isPlainObject(b)) return sameKeys(a, b, sameValue);
  return false;
}

/**
 * Deep equality for a value that must survive JSON storage: primitives, arrays and
 * plain objects only. A `Set` has no enumerable keys and would otherwise equal `{}`.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return sameArray(a, b, sameJson);
  }
  if (isPlainObject(a) && isPlainObject(b)) return sameKeys(a, b, sameJson);
  return false;
}

/**
 * Throws `UNSTABLE_SCHEMA` unless the value survives JSON storage and a second parse
 * unchanged. Replay depends on this. A value JSON cannot encode (a `bigint`, a cycle)
 * is the same failure, with the serializer's error as `cause`.
 */
function assertRoundTrips(schema: z.ZodType, value: unknown, kind: string, id: string, what: string): void {
  let stable: boolean;
  try {
    // Not structuredClone: the point is what JSON storage does to the value (Dates become strings).
    const text = JSON.stringify(value);
    const stored: unknown = JSON.parse(text);
    const again = schema.safeParse(stored);
    stable = again.success && sameJson(again.data, value);
  } catch (error) {
    throw new JournalError('UNSTABLE_SCHEMA', kind, id, `${what}: the value cannot be stored as JSON`, {
      cause: error,
    });
  }
  if (!stable)
    throw new JournalError(
      'UNSTABLE_SCHEMA',
      kind,
      id,
      `${what}: the schema must accept its own stored output unchanged`,
    );
}

function assertRootDb(db: RootDb, verb: string): void {
  if (is(db, PgAsyncTransaction)) {
    throw new Error(
      `journal: ${verb} needs the root database, not a transaction: effects would run before the outer transaction commits`,
    );
  }
}

/** Seconds to wait before the next attempt: doubling with jitter, capped at 5 minutes. */
function backoffSeconds(attempts: number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  const jitter = base * (Math.random() * 0.5 - 0.25);
  return Math.round(Math.min(BACKOFF_CAP_MS, base + jitter)) / 1000;
}

/** Database time plus `seconds`. The worker's clock never decides a lease or a retry. */
const dbNowPlus = (seconds: number) => sql`now() + make_interval(secs => ${seconds})`;

/** Throws when two handlers of one kind share a name: the second would silently replace the first. */
function assertUniqueNames(kind: 'effect' | 'projection', handlers: readonly { readonly name: string }[]): void {
  const seen = new Set<string>();
  for (const { name } of handlers) {
    if (seen.has(name)) throw new Error(`journal: duplicate ${kind} name "${name}"`);
    seen.add(name);
  }
}

/** Insert order is the version order. `RETURNING` does not promise it, so restore it. */
const nothing = (): undefined => undefined;

/**
 * Savepoints are a stack. Two journal operations open on one transaction at the
 * same time release each other's savepoint, so a caught failure of one could
 * erase what the other wrote. A transaction therefore holds one operation at a
 * time. A second one is refused: it waits for the first to settle (so the
 * caller's rollback undoes it whole), then rejects. A child runs on its own
 * savepoint handle, so nesting is fine. The root database opens a separate
 * transaction per operation and is never busy.
 */
const inFlight = new WeakMap<object, Promise<unknown>>();
function oneAtATime<T>(handle: object, what: string, work: () => Promise<T>): Promise<T> {
  if (!is(handle, PgAsyncTransaction)) return work();
  const busy = inFlight.get(handle);
  if (busy !== undefined) {
    return busy.then(nothing, nothing).then(() => {
      throw new Error(
        `journal: ${what} started on a transaction that already has a journal operation in flight; await operations on one transaction one at a time`,
      );
    });
  }
  // eslint-disable-next-line drizzle/enforce-delete-with-where -- WeakMap#delete, not a Drizzle query
  const running = work().finally(() => inFlight.delete(handle));
  inFlight.set(handle, running);
  return running;
}

export function sortedByVersion<Row extends { readonly version: number }>(rows: readonly Row[]): Row[] {
  return rows.toSorted((a, b) => a.version - b.version);
}

function createJournal<Meta extends z.ZodObject, Tx extends Transaction<Tx>, AppDb extends RootDb>(
  metaSchema: Meta,
  tables: JournalTables,
  projections: readonly Projection<z.output<Meta>, Tx>[],
  effects: readonly Effect<z.output<Meta>, AppDb>[],
): Journal<Meta, Tx, AppDb> {
  type MetaOut = z.output<Meta>;
  type Rec = Recorded<string, unknown, MetaOut>;
  const { events: eventsTable, jobs: jobsTable } = tables;
  /** One wake function per running worker this journal started. */
  const wakers = new Set<() => void>();

  assertUniqueNames('effect', effects);
  assertUniqueNames('projection', projections);
  const effectsByName = new Map(effects.map(effect => [effect.name, effect]));
  const entitiesByKind = new Map<string, AnyEntity<MetaOut>>();
  for (const handler of [...projections, ...effects]) {
    for (const entity of handler.entities) entitiesByKind.set(entity.kind, entity);
  }

  const schemaFor = (entities: readonly AnyEntity<MetaOut>[], kind: string, type: string): AnyEventDef | undefined =>
    entities.find(entity => entity.kind === kind)?.events.get(type);

  /**
   * Turn a stored log row into a recorded event, parsing data and meta with
   * their current schemas. `id` is the row's entity id as the caller types it.
   */
  const decode = <Id extends string>(
    row: typeof eventsTable.$inferSelect,
    def: AnyEventDef | undefined,
    id: Id,
  ): Recorded<string, unknown, MetaOut, Id> => {
    if (def === undefined) {
      throw new JournalError('REPLAY_FAILED', row.kind, row.entityId, `no event declared for type "${row.type}"`);
    }
    const data = def.schema.safeParse(row.data);
    if (!data.success) {
      throw new JournalError('REPLAY_FAILED', row.kind, row.entityId, `event ${row.id} data: ${data.error.message}`);
    }
    const meta = metaSchema.safeParse(row.meta);
    if (!meta.success) {
      throw new JournalError('REPLAY_FAILED', row.kind, row.entityId, `event ${row.id} meta: ${meta.error.message}`);
    }
    // Events are recorded facts: read-only for every reducer, projection, effect and caller.
    return deepFreeze({
      type: row.type,
      data: data.data,
      seq: row.seq,
      id: row.id,
      kind: row.kind,
      entityId: id,
      version: row.version,
      meta: meta.data,
      recordedAt: row.recordedAt,
    });
  };

  const loadHistory = async (db: Db, kind: string, id: string) =>
    db
      .select()
      .from(eventsTable)
      .where(and(eq(eventsTable.kind, kind), eq(eventsTable.entityId, id)))
      .orderBy(asc(eventsTable.version));

  const highestVersion = async (db: Db, kind: string, id: string): Promise<number> => {
    const [top] = await db
      .select({ version: max(eventsTable.version) })
      .from(eventsTable)
      .where(and(eq(eventsTable.kind, kind), eq(eventsTable.entityId, id)));
    return top?.version ?? 0;
  };

  /**
   * Fold events onto a starting state. A create event on a row, or a non-create
   * event with no row, is `ROW_EXISTS` / `NO_ROW` during a write and
   * `REPLAY_FAILED` when reading the log back. `replaced` is true when the state
   * passed through `null` and ended non-null: the row is a new incarnation.
   */
  const fold = <Tbl extends EntityTable, Key extends string>(
    entity: EntityDef<string, Tbl, AnyEventDef, MetaOut, Key>,
    start: Row<Tbl> | null,
    id: EntityId<Tbl, Key>,
    history: readonly Rec[],
    mode: 'write' | 'replay',
  ): {
    readonly row: Replayed<Tbl, Key> | null;
    readonly replaced: boolean;
    /** The columns the reducers set in this fold (since the last create). */
    readonly touched: ReadonlySet<string>;
  } => {
    let state: Row<Tbl> | NewRow<Tbl, Key> | null = start;
    let deleted = false;
    const touched = new Set<string>();
    for (const event of history) {
      const reducers = entity.reducers.get(event.type);
      if (reducers === undefined) {
        throw new JournalError(mode === 'write' ? 'UNKNOWN_EVENT' : 'REPLAY_FAILED', entity.kind, id, event.type);
      }
      const detail = `"${event.type}" at version ${event.version}`;
      if (state !== null && reducers.on === undefined) {
        throw new JournalError(mode === 'write' ? 'ROW_EXISTS' : 'REPLAY_FAILED', entity.kind, id, detail);
      }
      if (state === null && reducers.create === undefined) {
        throw new JournalError(mode === 'write' ? 'NO_ROW' : 'REPLAY_FAILED', entity.kind, id, detail);
      }
      state = reduceOne(entity, state, id, event, touched);
      if (state === null) deleted = true;
    }
    if (state === null) return { row: null, replaced: false, touched };
    const last = history.at(-1);
    const version = last === undefined ? (start === null ? 0 : start.version) : last.version;
    return { row: replayed(entity, state, id, version), replaced: deleted, touched };
  };

  const belongsTo = <E extends AnyEventDef, Id extends string>(
    entity: EntityDef<string, EntityTable, E, MetaOut, string>,
    event: Recorded<string, unknown, MetaOut, Id>,
  ): event is RecordedOf<E, MetaOut, Id> => entity.events.has(event.type);

  const replayFrom = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: Db,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    current: object | null,
    upTo?: number,
  ) => {
    // The whole log, so `upTo` cannot hide an incomplete history behind an empty result.
    const rows = await loadHistory(db, entity.kind, id);
    const first = rows[0];
    if (first === undefined && current !== null) {
      throw new JournalError('NO_HISTORY', entity.kind, id);
    }
    // Version 1 is only ever written by a create from no row. A history that starts
    // later belongs to a row that existed before the journal; folding it from nothing
    // would pick the wrong reducers.
    if (first !== undefined && first.version !== 1) {
      throw new JournalError('NO_HISTORY', entity.kind, id, `the log starts at version ${first.version}`);
    }
    const events = decodeHistory(entity, id, upTo === undefined ? rows : rows.filter(row => row.version <= upTo));
    debugReplay('%s %s: %d events', entity.kind, id, events.length);
    return { row: fold(entity, null, id, events, 'replay').row, events };
  };

  const decodeHistory = <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    rows: Awaited<ReturnType<typeof loadHistory>>,
  ) => rows.map(row => decode(row, entity.events.get(row.type), id)).filter(event => belongsTo(entity, event));

  /**
   * No row, but a log. Either a create follows a delete, or the row was removed
   * outside the journal. The log decides: a history that starts at 1 is complete,
   * and if it folds to a row, that row should be there. Creating over it would make
   * write and replay pick different reducers for the same event. A history that
   * starts later belongs to a pre-journal row and cannot be replayed, so it passes.
   */
  const assertLogSaysGone = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: Db,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    logTop: number,
  ): Promise<void> => {
    const rows = await loadHistory(db, entity.kind, id);
    if (rows[0]?.version !== 1) return;
    if (fold(entity, null, id, decodeHistory(entity, id, rows), 'replay').row !== null) {
      throw new JournalError(
        'CONFLICT',
        entity.kind,
        id,
        `the row is missing but its history says it exists at version ${logTop}; it was removed outside the journal, and repair restores it`,
      );
    }
  };

  /**
   * `write` with `metaOf` giving the parsed and checked meta. `journal.write`
   * parses per call; `journal.run` parses once for every write of a command.
   * `metaOf` runs inside the one-at-a-time guard, so a bad meta on a busy
   * transaction waits for the running operation like any other rejection.
   */
  const writeWith = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    tx: Tx,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    metaOf: () => MetaOut,
    events: WriteEvents<Tbl, E, Tx>,
    onJobs?: (count: number) => void,
  ): Promise<WriteResult<Tbl, E, MetaOut, Key>> => {
    return oneAtATime(tx, `write to ${entity.kind} ${id}`, async () => {
      assertExactId(entity, id);
      const meta = metaOf();
      return tx.transaction(async sp => {
        const erased: EntityTable = entity.table;
        const loaded = await loadRow(sp, entity, id, true);
        if (loaded !== null && !isRowOf(entity.table, loaded)) {
          throw new Error(`journal: ${entity.kind} ${id} row is missing columns`);
        }
        assertStoredId(entity, loaded, id);
        const row = loaded;
        const pending = await events(row, { tx: sp });
        if (pending.length === 0) {
          debugWrite('%s %s: events returned nothing', entity.kind, id);
          return { row, events: [] };
        }
        // The version the next event follows. No row: the log's top (0 for a new entity,
        // the delete's version after a delete). A row at version 0 with no history existed
        // before the journal: its history starts at 2, so version 1 stays the mark of a
        // real create and replay can tell the two apart. A row at version 0 whose log is
        // not empty lags the log; the unique index would not catch a start at 2.
        const stored = row?.version ?? 0;
        const logTop = row === null || stored === 0 ? await highestVersion(sp, entity.kind, id) : 0;
        if (row !== null && stored === 0 && logTop > 0) {
          throw new JournalError('CONFLICT', entity.kind, id, `row version 0 lags the log at version ${logTop}`);
        }
        const base = row === null ? logTop : stored === 0 ? 1 : stored;
        if (row === null && logTop > 0) await assertLogSaysGone(sp, entity, id, logTop);

        // Cheap checks before touching the log. The fold below catches the rest
        // (for example a non-create event after a reducer returned null).
        // Data is parsed here too: a hand-built `{ type, data }` skips the constructor,
        // and a schema that changes its own output would replay to a different value.
        const validated = pending.map(event => {
          const def = entity.events.get(event.type);
          if (def === undefined) throw new JournalError('UNKNOWN_EVENT', entity.kind, id, event.type);
          const data: unknown = def.schema.parse(event.data);
          assertRoundTrips(def.schema, data, entity.kind, id, `event "${event.type}"`);
          return data;
        });
        const first = entity.reducers.get(pending[0]?.type ?? '');
        if (first !== undefined && row !== null && first.on === undefined) {
          throw new JournalError('ROW_EXISTS', entity.kind, id, pending[0]?.type);
        }
        if (first !== undefined && row === null && first.create === undefined) {
          throw new JournalError('NO_ROW', entity.kind, id, pending[0]?.type);
        }

        const inserted = await sp
          .insert(eventsTable)
          .values(
            pending.map((event, index) => ({
              id: eventId(),
              kind: entity.kind,
              entityId: id,
              version: base + index + 1,
              type: event.type,
              data: validated[index],
              meta,
            })),
          )
          .returning()
          .catch((error: unknown) => {
            if (isUniqueViolation(error))
              throw new JournalError('CONFLICT', entity.kind, id, undefined, { cause: error });
            throw error;
          });

        // The log must hold the id as given: a cut or changed `entity_id` would split the history.
        // This throw rolls the savepoint back with the inserted events.
        for (const stored of inserted) {
          if (stored.entityId !== id) {
            throw new JournalError(
              'ID_MISMATCH',
              entity.kind,
              id,
              `the log stored the entity id ${JSON.stringify(stored.entityId)} but the id given is ${JSON.stringify(id)}`,
            );
          }
        }

        // Reducers, projections and the caller see the stored events, decoded the same
        // way replay decodes them. A hand-built pending event may carry keys the schema
        // strips; those never reach a reducer, so write and replay fold the same data.
        const recorded = sortedByVersion(inserted)
          .map(stored => decode(stored, entity.events.get(stored.type), id))
          .filter(event => belongsTo(entity, event));
        if (recorded.length !== pending.length) {
          throw new Error(`journal: insert returned ${recorded.length} of ${pending.length} events`);
        }

        const { row: next, replaced, touched } = fold(entity, row, id, recorded, 'write');
        const finalVersion = base + recorded.length;
        const atBase = and(eq(entity.keyColumn, id), eq(erased.version, stored));
        let saved: Row<typeof entity.table> | null = null;
        if (row === null && next !== null) {
          saved = await saveReplayed(sp, entity, id, null, next);
        } else if (row !== null && next !== null && replaced) {
          // A reducer deleted the row and a create followed in the same write. Delete
          // then insert, so columns the create omits get their defaults, not the old values.
          const deleted = await sp.delete(erased).where(atBase).returning({ version: erased.version });
          if (deleted.length === 0) throw new JournalError('VERSION_MISMATCH', entity.kind, id);
          saved = await saveReplayed(sp, entity, id, null, next);
        } else if (row !== null && next !== null) {
          const updated = await sp
            .update(erased)
            .set({ ...next, version: finalVersion })
            .where(atBase)
            .returning();
          const updatedRow = updated[0];
          if (updatedRow === undefined) throw new JournalError('VERSION_MISMATCH', entity.kind, id);
          if (!isRowOf(entity.table, updatedRow))
            throw new Error(`journal: ${entity.kind} ${id} update returned a partial row`);
          saved = updatedRow;
        } else if (row !== null && next === null) {
          const deleted = await sp.delete(erased).where(atBase).returning({ version: erased.version });
          if (deleted.length === 0) throw new JournalError('VERSION_MISMATCH', entity.kind, id);
        }

        // A create may come back normalised by the database; the events are already
        // inserted, and this throw rolls the savepoint back with them.
        assertStoredId(entity, saved, id);
        // Before projections run, so none sees a row that is about to be refused. Only columns a
        // reducer set in this write: the others came from the database.
        if (saved !== null && next !== null) {
          const set = [...touched].filter(column => column !== entity.key && column !== 'version');
          assertStoredValues(entity, id, next, saved, set);
        }

        for (const event of recorded) {
          for (const projection of projections) {
            if (projection.types.has(event.type) && projection.entities.some(e => e.kind === entity.kind)) {
              await projection.run(sp, event);
            }
          }
        }

        const jobs = recorded.flatMap(event =>
          effects
            .filter(effect => effect.types.has(event.type) && effect.entities.some(e => e.kind === entity.kind))
            .map(effect => ({ id: jobId(), eventSeq: event.seq, effect: effect.name })),
        );
        if (jobs.length > 0) {
          await sp.insert(jobsTable).values(jobs);
          onJobs?.(jobs.length);
        }

        debugWrite(
          '%s %s: v%d -> v%d, %d events, %d jobs',
          entity.kind,
          id,
          base,
          finalVersion,
          recorded.length,
          jobs.length,
        );
        return { row: saved, events: recorded };
      });
    });
  };

  /**
   * `journal.run` and `context.run` share this. `metaOf` gives the parsed meta:
   * the root call parses it, a child inherits it. It runs inside the one-at-a-time
   * guard, so a bad meta on a busy transaction waits like any other rejection.
   * `onJobs` hears how many jobs each write queued, in this command and its children.
   */
  const runCommand = <S extends z.ZodType, R>(
    source: Transaction<Tx>,
    command: Command<S, R, MetaOut, Tx>,
    input: z.input<S>,
    metaOf: () => Promise<MetaOut>,
    onJobs: (count: number) => void,
  ): Promise<Awaited<R>> =>
    oneAtATime(source, `command "${command.name}"`, async (): Promise<Awaited<R>> => {
      const meta = await metaOf();
      const parsed = await command.input.parseAsync(input);
      debugCommand('%s: input ok', command.name);
      return source.transaction(async (tx): Promise<Awaited<R>> => {
        // Every operation the handler starts through this context. The transaction
        // must not close while one is still running: its work would land outside.
        const started: Promise<unknown>[] = [];
        let unfinished = 0;
        const track = <T>(operation: Promise<T>): Promise<T> => {
          started.push(operation);
          unfinished += 1;
          const done = () => {
            unfinished -= 1;
          };
          void operation.then(done, done);
          return operation;
        };
        const context: CommandContext<MetaOut, Tx> = {
          tx,
          meta,
          write: (entity, id, events) => track(writeWith(tx, entity, id, () => meta, events, onJobs)),
          run: (child, childInput) => track(runCommand(tx, child, childInput, () => Promise.resolve(meta), onJobs)),
        };
        let result: Awaited<R>;
        try {
          result = await command.handler(parsed, context);
        } catch (error) {
          // The handler's own error is the one to report; the rollback undoes the rest.
          await Promise.allSettled(started);
          throw error;
        }
        if (unfinished > 0) {
          const count = unfinished;
          await Promise.allSettled(started);
          throw new Error(
            `journal: command "${command.name}" returned with ${count} journal operation${count === 1 ? '' : 's'} still running; await every write and run before the handler returns`,
          );
        }
        debugCommand('%s: done', command.name);
        return result;
      });
    });

  const journal: Journal<Meta, Tx, AppDb> = {
    write(tx, entity, id, input) {
      return writeWith(
        tx,
        entity,
        id,
        () => {
          const meta = metaSchema.parse(input.meta);
          assertRoundTrips(metaSchema, meta, entity.kind, id, 'meta');
          return meta;
        },
        input.events,
      );
    },

    run(source, command, input, meta) {
      let queued = 0;
      return runCommand(
        source,
        command,
        input,
        async () => {
          const parsed = await metaSchema.parseAsync(meta);
          // No entity yet: the error names the command instead.
          assertRoundTrips(metaSchema, parsed, 'command', command.name, 'meta');
          return parsed;
        },
        count => {
          queued += count;
        },
      ).then(result => {
        // The root database has committed by now. Inside a caller's transaction
        // only the caller knows when the commit happens, so the caller wakes.
        if (queued > 0 && !is(source, PgAsyncTransaction)) journal.wake();
        return result;
      });
    },

    async replay(db, entity, id, opts) {
      assertExactId(entity, id);
      const current = await loadRow(db, entity, id, false);
      return replayFrom(db, entity, id, current, opts?.upTo);
    },

    async verify(db, entity, id) {
      assertExactId(entity, id);
      const loaded = await loadRow(db, entity, id, false);
      assertStoredId(entity, loaded, id);
      if (loaded !== null && !isRowOf(entity.table, loaded)) {
        throw new Error(`journal: ${entity.kind} ${id} row is missing columns`);
      }
      const actual = loaded;
      const { row: expected } = await replayFrom(db, entity, id, actual);
      if (expected === null && actual === null) return { ok: true };
      if (expected === null || actual === null) return { ok: false, expected, actual };
      const want = toRecord(expected);
      const have = toRecord(actual);
      const ok = Object.keys(want).every(key => sameValue(want[key], have[key]));
      return ok ? { ok: true } : { ok: false, expected, actual };
    },

    async repair(db, entity, id) {
      assertExactId(entity, id);
      return db.transaction(async tx => {
        const current = await loadRow(tx, entity, id, true);
        assertStoredId(entity, current, id);
        const { row: expected } = await replayFrom(tx, entity, id, current);
        debugReplay('%s %s: repair -> %s', entity.kind, id, expected === null ? 'delete' : `v${expected.version}`);
        const saved = await saveReplayed(tx, entity, id, current, expected);
        // Throwing rolls the transaction back, so the row stays as it was.
        if (saved !== null && expected !== null) assertStoredValues(entity, id, expected, saved, Object.keys(expected));
        return saved;
      });
    },

    async rerun(db, projection, opts) {
      const batch = opts?.batch ?? 100;
      const kinds = projection.entities.map(entity => entity.kind);
      let cursor = opts?.from ?? 0;
      let count = 0;
      if (kinds.length === 0 || projection.types.size === 0) return { events: 0 };
      for (;;) {
        const rows = await db
          .select()
          .from(eventsTable)
          .where(
            and(
              gt(eventsTable.seq, cursor),
              inArray(eventsTable.kind, kinds),
              inArray(eventsTable.type, [...projection.types]),
            ),
          )
          .orderBy(asc(eventsTable.seq))
          .limit(batch);
        if (rows.length === 0) break;
        await db.transaction(async tx => {
          for (const row of rows) {
            await projection.run(tx, decode(row, schemaFor(projection.entities, row.kind, row.type), row.entityId));
          }
        });
        count += rows.length;
        cursor = rows.at(-1)?.seq ?? cursor;
        if (rows.length < batch) break;
      }
      debugReplay('rerun %s: %d events', projection.name, count);
      return { events: count };
    },

    async drain(db, opts) {
      assertRootDb(db, 'drain');
      const limit = opts?.limit ?? 20;
      const signal = opts?.signal ?? new AbortController().signal;
      const known = [...effectsByName.keys()];
      if (known.length === 0) return 0;

      // Every time here is database time, so a worker with a skewed clock
      // cannot take a live lease or push a retry into the far future.
      const claimed = await db.transaction(async tx => {
        const due = await tx
          .select({ id: jobsTable.id })
          .from(jobsTable)
          .where(
            and(
              isNull(jobsTable.deadAt),
              lte(jobsTable.availableAt, sql`now()`),
              or(isNull(jobsTable.leaseUntil), lte(jobsTable.leaseUntil, sql`now()`)),
              inArray(jobsTable.effect, known),
            ),
          )
          .orderBy(asc(jobsTable.availableAt))
          .limit(limit)
          .for('update', { skipLocked: true });
        if (due.length === 0) return [];
        const token = leaseToken();
        return tx
          .update(jobsTable)
          .set({
            leaseToken: token,
            leaseUntil: dbNowPlus(LEASE_SECONDS),
            attempts: sql`${jobsTable.attempts} + 1`,
          })
          .where(
            inArray(
              jobsTable.id,
              due.map(job => job.id),
            ),
          )
          .returning();
      });
      if (claimed.length === 0) return 0;

      const eventRows = await db
        .select()
        .from(eventsTable)
        .where(
          inArray(
            eventsTable.seq,
            claimed.map(job => job.eventSeq),
          ),
        );
      const eventBySeq = new Map(eventRows.map(row => [row.seq, row]));

      for (const job of claimed) {
        const effect = effectsByName.get(job.effect);
        const eventRow = eventBySeq.get(job.eventSeq);
        try {
          if (effect === undefined) throw new Error(`effect "${job.effect}" is not registered`);
          if (eventRow === undefined) throw new Error(`event seq ${job.eventSeq} not found`);
          const event = decode(eventRow, schemaFor(effect.entities, eventRow.kind, eventRow.type), eventRow.entityId);
          await effect.run(event, { jobId: job.id, signal, db });
          await db
            .delete(jobsTable)
            .where(and(eq(jobsTable.id, job.id), eq(jobsTable.leaseToken, job.leaseToken ?? '')));
          debugDrain('%s %s: done', job.effect, job.id);
        } catch (error) {
          const dead = job.attempts >= MAX_ATTEMPTS;
          await db
            .update(jobsTable)
            .set({
              lastError: errorText(error),
              leaseToken: null,
              leaseUntil: null,
              ...(dead ? { deadAt: sql`now()` } : { availableAt: dbNowPlus(backoffSeconds(job.attempts)) }),
            })
            .where(and(eq(jobsTable.id, job.id), eq(jobsTable.leaseToken, job.leaseToken ?? '')));
          debugDrain(
            '%s %s: attempt %d failed%s: %s',
            job.effect,
            job.id,
            job.attempts,
            dead ? ', dead' : '',
            errorText(error),
          );
        }
      }
      return claimed.length;
    },

    worker(db, opts) {
      assertRootDb(db, 'worker');
      const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
      let running = false;
      let loop: Promise<void> = Promise.resolve();
      let endSleep: (() => void) | undefined;
      // A wake that arrived during a pass. That pass may have looked before the
      // commit that caused the wake, so one more pass follows it.
      let woken = false;
      const sleep = () =>
        new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            endSleep = undefined;
            resolve();
          }, pollMs);
          endSleep = () => {
            clearTimeout(timer);
            endSleep = undefined;
            resolve();
          };
        });
      // `stop()` and `wake()` flip these from another call while `run` is awaiting.
      const isRunning = () => running;
      const isWoken = () => woken;
      const run = async () => {
        while (isRunning()) {
          woken = false;
          let processed = 0;
          try {
            processed = await journal.drain(db, { limit: opts?.limit });
          } catch (error) {
            debugWorker('drain failed: %s', errorText(error));
          }
          if (isRunning() && processed === 0 && !isWoken()) await sleep();
        }
      };
      const wake = () => {
        if (!running) return;
        woken = true;
        endSleep?.();
      };
      return {
        async start() {
          if (running) return;
          running = true;
          wakers.add(wake);
          debugWorker('start (poll %dms)', pollMs);
          loop = run();
          await Promise.resolve();
        },
        async stop() {
          running = false;
          // eslint-disable-next-line drizzle/enforce-delete-with-where -- Set#delete, not a Drizzle query
          wakers.delete(wake);
          endSleep?.();
          await loop;
          debugWorker('stopped');
        },
        wake,
      };
    },

    wake() {
      for (const wake of wakers) wake();
    },

    catalog: {
      entities: [...entitiesByKind.values()].map(entity => ({
        kind: entity.kind,
        table: getTableName(entity.table),
        events: [...entity.events.keys()],
      })),
      projections: projections.map(projection => projection.name),
      effects: effects.map(effect => effect.name),
    },
  };

  return journal;
}
