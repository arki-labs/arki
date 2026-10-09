import type { AnyEventDef, EntityDef, EntityTable, NewRow, Patch, Recorded, RecordedOf, Reducer, Replayed, Row } from './types.js';

/**
 * An entity under construction. Each `.create` / `.on` adds the event to the
 * union the entity accepts, so `decide` cannot return an undeclared event.
 */
export type EntityBuilder<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Meta> = EntityDef<
  K,
  Tbl,
  E,
  Meta
> & {
  /** A create reducer receives no row. It builds the first row from the event. */
  create<D extends AnyEventDef>(
    event: D,
    reduce: (event: RecordedOf<D, Meta>) => NewRow<Tbl>,
  ): EntityBuilder<K, Tbl, E | D, Meta>;
  /**
   * An `.on` reducer always receives the reducer-shaped state: the insert shape plus
   * `id` and `version`. Columns with database defaults may be absent. It returns a
   * patch that is merged onto the state. Returning `null` deletes the row; the events stay.
   */
  on<D extends AnyEventDef>(
    event: D,
    reduce: (row: Replayed<Tbl>, event: RecordedOf<D, Meta>) => Patch<Tbl> | null,
  ): EntityBuilder<K, Tbl, E | D, Meta>;
};

export function defineEntity<K extends string, Tbl extends EntityTable, Meta>(
  kind: K,
  table: Tbl,
): EntityBuilder<K, Tbl, never, Meta> {
  return builder<K, Tbl, never, Meta>(kind, table, new Map(), new Map());
}

function builder<K extends string, Tbl extends EntityTable, E extends AnyEventDef, Meta>(
  kind: K,
  table: Tbl,
  events: ReadonlyMap<string, AnyEventDef>,
  reducers: ReadonlyMap<string, Reducer<Tbl, Meta>>,
): EntityBuilder<K, Tbl, E, Meta> {
  const add = <D extends AnyEventDef>(event: D, reducer: Reducer<Tbl, Meta>): EntityBuilder<K, Tbl, E | D, Meta> => {
    if (reducers.has(event.type)) {
      throw new Error(`journal: entity "${kind}" already declares a reducer for "${event.type}"`);
    }
    return builder<K, Tbl, E | D, Meta>(
      kind,
      table,
      new Map([...events, [event.type, event]]),
      new Map([...reducers, [event.type, reducer]]),
    );
  };
  return {
    kind,
    table,
    events,
    reducers,
    create(event, reduce) {
      return add(event, { mode: 'create', apply: reduce });
    },
    on(event, reduce) {
      return add(event, { mode: 'on', apply: reduce });
    },
  };
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

/**
 * Fold one event onto the in-memory state. Shared by write and replay, so
 * both produce the same value for every column a reducer set.
 */
export function reduceOne<Tbl extends EntityTable, Meta>(
  entity: EntityDef<string, Tbl, AnyEventDef, Meta>,
  state: Row<Tbl> | NewRow<Tbl> | null,
  id: Row<Tbl>['id'],
  event: Recorded<string, unknown, Meta>,
): NewRow<Tbl> | null {
  const reducer = entity.reducers.get(event.type);
  if (reducer === undefined) return null;
  if (reducer.mode === 'create') return definedOnly(reducer.apply(event));
  if (state === null) return null;
  const patch = reducer.apply({ ...state, id, version: event.version - 1 }, event);
  return patch === null ? null : { ...state, ...definedOnly(patch) };
}
