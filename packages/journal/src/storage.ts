/**
 * The entity row and stored values: load and save the row, exact-id checks, value
 * comparison, the JSON round-trip check, freezing, and the root-database guard.
 * Imports only leaf files (`types`, `errors`). Must not import `journal`, `api`,
 * `write`, `command`, `history` or `worker`.
 */
import type { z } from 'zod';
import { eq, getTableColumns, is } from 'drizzle-orm';
import { PgAsyncTransaction } from 'drizzle-orm/pg-core';

import type {
  AnyEntity,
  AnyEventDef,
  DbHandle,
  EntityDef,
  EntityId,
  EntityTable,
  ReducerRow,
  RootDb,
  Row,
} from './types.js';
import { JournalError } from './errors.js';

/** A select row has every column of its table. The check is real; the guard narrows. */
export function isRowOf<Tbl extends EntityTable>(table: Tbl, value: object): value is Row<Tbl> {
  return Object.keys(getTableColumns(table)).every(column => column in value);
}

type EntityRowSource = Pick<AnyEntity, 'table' | 'keyColumn'>;

export async function loadRow(
  db: DbHandle,
  entity: EntityRowSource,
  id: string,
  lock: boolean,
): Promise<object | null> {
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
export function assertExactId(entity: Pick<AnyEntity, 'kind' | 'uuidKey' | 'keyLimit'>, id: string): void {
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

export function assertStoredId(entity: Pick<AnyEntity, 'kind' | 'key'>, row: object | null, id: string): void {
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
export async function saveReplayed<Tbl extends EntityTable, Key extends string>(
  db: DbHandle,
  entity: EntityDef<string, Tbl, AnyEventDef, unknown, Key>,
  id: EntityId<Tbl, Key>,
  current: object | null,
  next: ReducerRow<Tbl, Key> | null,
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

export function toRecord(value: object): Record<string, unknown> {
  return { ...value };
}

export function showValue(value: unknown): string {
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
export function assertStoredValues(
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
        `column "${column}": the reducer produced ${showValue(want[column])} but the database stored ${showValue(have[column])}`,
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
export function deepFreeze<T>(value: T): T {
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
 * Strict: primitives, `Date`, value objects, arrays and plain objects only. A value object is a class
 * instance with an `equals` method, such as a Temporal value from a custom column: it equals another
 * instance of the same class when its `equals` says so. A `Map`, `Set`, other class instance or typed
 * array is never equal to anything, because JSON storage would lose its contents.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'function' || typeof a === 'symbol') return false;
  if (typeof a !== 'object' || a === null) return Object.is(a, b);
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a)) return Array.isArray(b) && sameArray(a, b, sameValue);
  if (isValueObject(a)) return Object.getPrototypeOf(a) === Object.getPrototypeOf(b) && a.equals(b) === true;
  if (isPlainObject(a) && isPlainObject(b)) return sameKeys(a, b, sameValue);
  return false;
}

/**
 * A class instance that defines its own equality, like Temporal's `Instant` or `PlainDate`. A column
 * whose driver rebuilds the same class on read round-trips it; a lossy column hands back another type
 * or another value, and `equals` then reports the difference.
 */
function isValueObject(value: object): value is { equals(other: unknown): unknown } {
  return !isPlainObject(value) && 'equals' in value && typeof value.equals === 'function';
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
export function assertRoundTrips(schema: z.ZodType, value: unknown, kind: string, id: string, what: string): void {
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

export function assertRootDb(db: RootDb, verb: string): void {
  if (is(db, PgAsyncTransaction)) {
    throw new Error(
      `journal: ${verb} needs the root database, not a transaction: effects would run before the outer transaction commits`,
    );
  }
}
