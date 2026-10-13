import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, PgColumn } from 'drizzle-orm/pg-core';

import type {
  AnyEventDef,
  EntityDef,
  EntityId,
  EntityTable,
  KeyColumn,
  KeyLimit,
  Patch,
  Recorded,
  RecordedOf,
  ReducerRow,
  Reducers,
  ReducerValues,
  Row,
} from './types.js';
import { JournalError } from './errors.js';
import { assertStoredName } from './id.js';

/**
 * The keys that every `.create` reducer so far returns with a type that
 * excludes `undefined`. `CreateResults` is the union of their return types, so a key
 * one of them leaves out, or may set to `undefined`, is not in the set. With
 * no `.create` yet, the set is empty.
 *
 * `keyof CreateResults & string` keeps the mapped type from distributing over the
 * union: `keyof (A | B)` is the keys both have, and `CreateResults[P]` is the union
 * of what each branch holds there. A create returning `cond ? { note } : {}`
 * therefore promises nothing.
 */
export type GuaranteedCreateKeys<CreateResults> = [CreateResults] extends [never]
  ? never
  : { [P in keyof CreateResults & string]: undefined extends CreateResults[P] ? never : P }[keyof CreateResults &
      string];

/**
 * The state an `.on` reducer receives: the reducer-shaped row, with the keys
 * every `.create` reducer sets made required. A patch cannot unset a key and
 * `undefined` values are stripped, so a key a create sets stays set.
 */
export type OnReducerRow<Tbl extends EntityTable, Key extends string, CreateResults> = ReducerRow<Tbl, Key> &
  Required<Pick<ReducerValues<Tbl, Key>, GuaranteedCreateKeys<CreateResults> & keyof ReducerValues<Tbl, Key>>>;

/**
 * An entity under construction. Each `.create` / `.on` adds the event to the
 * union the entity accepts, so `events` cannot return an undeclared event.
 * `CreateResults` collects what the `.create` reducers return; see `OnReducerRow`.
 *
 * The rule: every `.create` comes before the first `.on`. After the first
 * `.on` the builder is `OnOnlyEntityBuilder`, which has no `.create`: a later
 * create could leave out a column that `.on` was promised.
 */
export type EntityBuilder<
  Kind extends string,
  Tbl extends EntityTable,
  EventDefs extends AnyEventDef,
  Meta,
  Key extends string = 'id',
  CreateResults = never,
> = OnOnlyEntityBuilder<Kind, Tbl, EventDefs, Meta, Key, CreateResults> & {
  /** A create reducer receives no row. It builds the first row from the event. */
  create<AddedEvent extends AnyEventDef, CreateResult extends ReducerValues<Tbl, Key>>(
    event: AddedEvent,
    reduce: (event: RecordedOf<AddedEvent, Meta, EntityId<Tbl, Key>>) => CreateResult,
  ): EntityBuilder<Kind, Tbl, EventDefs | AddedEvent, Meta, Key, CreateResults | CreateResult>;
};

/** An entity after its first `.on`: only more `.on` reducers may follow. */
export type OnOnlyEntityBuilder<
  Kind extends string,
  Tbl extends EntityTable,
  EventDefs extends AnyEventDef,
  Meta,
  Key extends string = 'id',
  CreateResults = never,
> = EntityDef<Kind, Tbl, EventDefs, Meta, Key> & {
  /**
   * An `.on` reducer always receives the reducer-shaped state: the insert shape plus
   * the key column and `version`. Columns with database defaults may be absent unless
   * every `.create` reducer sets them. It returns a patch that is merged onto the
   * state. Returning `null` deletes the row; the events stay.
   */
  on<AddedEvent extends AnyEventDef>(
    event: AddedEvent,
    reduce: (
      row: OnReducerRow<Tbl, Key, CreateResults>,
      event: RecordedOf<AddedEvent, Meta, EntityId<Tbl, Key>>,
    ) => Patch<Tbl, Key> | null,
  ): OnOnlyEntityBuilder<Kind, Tbl, EventDefs | AddedEvent, Meta, Key, CreateResults>;
};

/** The two facts `KeyColumn` states: the column holds a string and is not null. */
function isKeyColumn(column: PgColumn): column is KeyColumn {
  const [dataType] = column.dataType.split(' ');
  return dataType === 'string' && column.notNull;
}

/**
 * The supported key types: `text`, `varchar`, `varchar(n)` and `uuid`. The first three compare
 * as exact strings. A `uuid` ignores case, so its ids must also use the canonical spelling
 * (lower-case, hyphenated); `assertExactId` checks that on every call.
 */
const EXACT_KEY_TYPE = /^(?:text|uuid|varchar(?:\s*\(\s*\d+\s*\))?)$/;

/** A column's SQL type in comparable form: trimmed and lower-case. */
function sqlTypeOf(column: PgColumn): string {
  return column.getSQLType().trim().toLowerCase();
}

/** The journal's own limit: `journal_events.entity_id` holds 256 characters. */
const LOG_KEY_LIMIT = 256;

/**
 * The longest id the key may hold, in code points: `varchar(n)` allows `min(n, 256)`, `text` and
 * `varchar` allow the log's 256, and a `uuid` is fixed at 36.
 */
function keyLimitOf(column: PgColumn): KeyLimit {
  const sqlType = sqlTypeOf(column);
  if (sqlType === 'uuid') return { max: 36, source: 'column' };
  const length = /\(\s*(\d+)\s*\)/.exec(sqlType)?.[1];
  if (length !== undefined && Number(length) <= LOG_KEY_LIMIT) return { max: Number(length), source: 'column' };
  return { max: LOG_KEY_LIMIT, source: 'journal' };
}

/**
 * Whether `column` identifies one row on its own: it is the primary key, or
 * carries a unique constraint, or is the only column of a table-level primary
 * key, unique constraint or unique index. Table-level constraints and indexes
 * hold their own column objects (an index wraps them), so they are matched by
 * SQL name; an SQL expression in an index has no name and never matches.
 */
function isUniqueOn(table: EntityTable, column: PgColumn): boolean {
  if (column.primary || column.isUnique) return true;
  const only = (columns: readonly unknown[]): boolean => {
    const [first] = columns;
    return (
      columns.length === 1 &&
      typeof first === 'object' &&
      first !== null &&
      'name' in first &&
      first.name === column.name
    );
  };
  const config = getTableConfig(table);
  return (
    config.primaryKeys.some(pk => only(pk.columns)) ||
    config.uniqueConstraints.some(constraint => only(constraint.columns)) ||
    // A unique index with a `where` is unique only inside that subset, so it is no key.
    config.indexes.some(index => index.config.unique && index.config.where === undefined && only(index.config.columns))
  );
}

/** The column `table` holds under `key`, checked to be a usable entity key. */
function keyColumnOf(kind: string, table: EntityTable, key: string): KeyColumn {
  const columns: Record<string, unknown> = getTableColumns(table);
  const column = columns[key];
  if (!(column instanceof PgColumn)) {
    throw new JournalError(
      'BAD_DEFINITION',
      'entity',
      kind,
      `journal: entity "${kind}": table "${getTableName(table)}" has no column "${key}"`,
    );
  }
  const [dataType] = column.dataType.split(' ');
  const sqlType = sqlTypeOf(column);
  if (dataType !== 'custom' && !isKeyColumn(column)) {
    throw new JournalError(
      'BAD_DEFINITION',
      'entity',
      kind,
      dataType === 'string'
        ? `journal: entity "${kind}": key column "${key}" must be not null`
        : `journal: entity "${kind}": key column "${key}" must hold a string, it holds ${column.dataType}`,
    );
  }
  if (!EXACT_KEY_TYPE.test(sqlType)) {
    throw new JournalError(
      'BAD_DEFINITION',
      'entity',
      kind,
      `journal: entity "${kind}": key column "${key}" has SQL type "${sqlType}"; the key must be text, varchar or uuid, because other types can treat two different strings as the same key`,
    );
  }
  if (!isKeyColumn(column)) {
    throw new JournalError(
      'BAD_DEFINITION',
      'entity',
      kind,
      `journal: entity "${kind}": key column "${key}" is a custom column type; a key must be a plain text, varchar or uuid column, because a custom type's mapping can change the string`,
    );
  }
  if (!isUniqueOn(table, column)) {
    throw new JournalError(
      'BAD_DEFINITION',
      'entity',
      kind,
      `journal: entity "${kind}": key column "${key}" must be the primary key or carry a unique constraint`,
    );
  }
  return column;
}

export function defineEntity<Kind extends string, Tbl extends EntityTable, Meta, Key extends string>(
  kind: Kind,
  table: Tbl,
  key: Key,
): EntityBuilder<Kind, Tbl, never, Meta, Key> {
  assertStoredName('entity kind', kind);
  const keyColumn = keyColumnOf(kind, table, key);
  const uuidKey = sqlTypeOf(keyColumn) === 'uuid';
  const keyLimit = keyLimitOf(keyColumn);
  return builder<Kind, Tbl, never, Meta, Key, never>(
    kind,
    table,
    key,
    keyColumn,
    uuidKey,
    keyLimit,
    new Map(),
    new Map(),
    null,
  );
}

function builder<
  Kind extends string,
  Tbl extends EntityTable,
  EventDefs extends AnyEventDef,
  Meta,
  Key extends string,
  CreateResults,
>(
  kind: Kind,
  table: Tbl,
  key: Key,
  keyColumn: KeyColumn,
  uuidKey: boolean,
  keyLimit: KeyLimit,
  events: ReadonlyMap<string, AnyEventDef>,
  reducers: ReadonlyMap<string, Reducers<Tbl, Meta, Key>>,
  /** The first `.on` event type, once one is declared. `.create` is refused after it. */
  firstOn: string | null,
): EntityBuilder<Kind, Tbl, EventDefs, Meta, Key, CreateResults> {
  const declare = <AddedEvent extends AnyEventDef, Next>(
    event: AddedEvent,
    next: Reducers<Tbl, Meta, Key>,
    sealedBy: string | null,
  ): EntityBuilder<Kind, Tbl, EventDefs | AddedEvent, Meta, Key, Next> =>
    builder<Kind, Tbl, EventDefs | AddedEvent, Meta, Key, Next>(
      kind,
      table,
      key,
      keyColumn,
      uuidKey,
      keyLimit,
      new Map([...events, [event.type, event]]),
      new Map([...reducers, [event.type, next]]),
      sealedBy,
    );
  const create = <AddedEvent extends AnyEventDef, CreateResult extends ReducerValues<Tbl, Key>>(
    event: AddedEvent,
    reduce: (event: RecordedOf<AddedEvent, Meta, EntityId<Tbl, Key>>) => CreateResult,
  ): EntityBuilder<Kind, Tbl, EventDefs | AddedEvent, Meta, Key, CreateResults | CreateResult> => {
    if (firstOn !== null) {
      throw new JournalError(
        'BAD_DEFINITION',
        'entity',
        kind,
        `journal: entity "${kind}": declare .create(${event.type}) before any .on; .on(${firstOn}) came first`,
      );
    }
    const current = reducers.get(event.type) ?? {};
    if (current.create !== undefined) {
      throw new JournalError(
        'BAD_DEFINITION',
        'entity',
        kind,
        `journal: entity "${kind}" already declares a create reducer for "${event.type}"`,
      );
    }
    return declare<AddedEvent, CreateResults | CreateResult>(event, { ...current, create: reduce }, null);
  };
  const on = <AddedEvent extends AnyEventDef>(
    event: AddedEvent,
    reduce: (
      row: OnReducerRow<Tbl, Key, CreateResults>,
      event: RecordedOf<AddedEvent, Meta, EntityId<Tbl, Key>>,
    ) => Patch<Tbl, Key> | null,
  ): OnOnlyEntityBuilder<Kind, Tbl, EventDefs | AddedEvent, Meta, Key, CreateResults> => {
    const current = reducers.get(event.type) ?? {};
    if (current.on !== undefined) {
      throw new JournalError(
        'BAD_DEFINITION',
        'entity',
        kind,
        `journal: entity "${kind}" already declares an on reducer for "${event.type}"`,
      );
    }
    return declare<AddedEvent, CreateResults>(event, { ...current, on: reduce }, firstOn ?? event.type);
  };
  return { kind, table, key, keyColumn, uuidKey, keyLimit, events, reducers, create, on };
}

/**
 * A copy of `value` without the own keys that hold `undefined`. In a patch,
 * `undefined` means "unchanged". In a create result it means "not set": the
 * database default applies, and the key is not part of the journal's state.
 */
function definedOnly<T extends object>(value: T): T {
  const out = { ...value };
  for (const key in out) {
    if (Object.hasOwn(out, key) && out[key] === undefined) delete out[key];
  }
  return out;
}

function hasKey<T extends object, K extends string>(value: T, key: K): value is T & Record<K, unknown> {
  return key in value;
}

/**
 * `{ [key]: id }` typed by the key. TypeScript types a computed key as an
 * index signature; the guard above narrows it back to the one key.
 */
function keyed<K extends string, Id>(key: K, id: Id): Record<K, Id> {
  const out = { [key]: id };
  if (!hasKey(out, key)) throw new Error(`journal: key "${key}" was not set`);
  return out;
}

/** The reducer-shaped row: a state plus the key column and `version`. */
export function withEntityIdentity<Tbl extends EntityTable, Key extends string>(
  entity: EntityDef<string, Tbl, AnyEventDef, unknown, Key>,
  state: Row<Tbl> | ReducerValues<Tbl, Key>,
  id: EntityId<Tbl, Key>,
  version: number,
): ReducerRow<Tbl, Key> {
  return { ...state, ...keyed(entity.key, id), version };
}

/**
 * Fold one event onto the in-memory state. Shared by write and replay, so
 * both produce the same value for every column a reducer set. The caller has
 * checked that a reducer exists for the event in this state. `reducerColumns`, when
 * given, collects the columns the reducers set: a create starts it afresh, a
 * patch adds its keys, a delete empties it.
 */
export function reduceOne<Tbl extends EntityTable, Meta, Key extends string>(
  entity: EntityDef<string, Tbl, AnyEventDef, Meta, Key>,
  state: Row<Tbl> | ReducerValues<Tbl, Key> | null,
  id: EntityId<Tbl, Key>,
  event: Recorded<string, unknown, Meta>,
  reducerColumns?: Set<string>,
): ReducerValues<Tbl, Key> | null {
  const reducers = entity.reducers.get(event.type);
  if (state === null) {
    if (reducers?.create === undefined)
      throw new Error(`journal: entity "${entity.kind}" has no create reducer for "${event.type}"`);
    const created = definedOnly(reducers.create(event));
    reducerColumns?.clear();
    for (const key of Object.keys(created)) reducerColumns?.add(key);
    return created;
  }
  if (reducers?.on === undefined)
    throw new Error(`journal: entity "${entity.kind}" has no on reducer for "${event.type}"`);
  const patch = reducers.on(withEntityIdentity(entity, state, id, event.version - 1), event);
  if (patch === null) {
    reducerColumns?.clear();
    return null;
  }
  const defined = definedOnly(patch);
  for (const key of Object.keys(defined)) reducerColumns?.add(key);
  return { ...state, ...defined };
}
