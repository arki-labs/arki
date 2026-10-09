import { and, asc, eq, getTableColumns, getTableName, gt, inArray, is, isNull, lte, max, or, sql } from 'drizzle-orm';
import { PgAsyncTransaction } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { debugDrain, debugReplay, debugWorker, debugWrite } from './debug.js';
import { defineEntity, reduceOne } from './entity.js';
import type { EntityBuilder } from './entity.js';
import { JournalError } from './errors.js';
import { defineEvent } from './event.js';
import { defineEffect, defineProjection } from './handlers.js';
import { eventId, jobId, leaseToken } from './id.js';
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
  NewRow,
  PendingOf,
  Projection,
  ProjectionHandlers,
  Recorded,
  RecordedOf,
  Replayed,
  RootDb,
  Row,
  Worker,
} from './types.js';

export type WriteInput<Tbl extends EntityTable, E extends AnyEventDef, Meta extends z.ZodObject> = {
  readonly meta: z.input<Meta>;
  readonly decide: (row: Row<Tbl> | null) => readonly PendingOf<E>[] | Promise<readonly PendingOf<E>[]>;
};
export type WriteResult<Tbl extends EntityTable, E extends AnyEventDef, MetaOut> = {
  readonly row: Row<Tbl> | null;
  readonly events: RecordedOf<E, MetaOut>[];
};
export type ReplayResult<Tbl extends EntityTable, E extends AnyEventDef, MetaOut> = {
  readonly row: Replayed<Tbl> | null;
  readonly events: RecordedOf<E, MetaOut>[];
};
export type VerifyResult<Tbl extends EntityTable> =
  | { readonly ok: true }
  | { readonly ok: false; readonly expected: Replayed<Tbl> | null; readonly actual: Row<Tbl> | null };

export type Journal<Meta extends z.ZodObject> = {
  /** Append events, run reducers, save the row, run projections, queue jobs. All inside `tx`. */
  write<K extends string, Tbl extends EntityTable, E extends AnyEventDef>(
    tx: Db,
    entity: EntityDef<K, Tbl, E, z.output<Meta>>,
    id: EntityId<Tbl>,
    input: WriteInput<Tbl, E, Meta>,
  ): Promise<WriteResult<Tbl, E, z.output<Meta>>>;
  /** Rebuild the row from the log in memory. `upTo` stops at that version. */
  replay<K extends string, Tbl extends EntityTable, E extends AnyEventDef>(
    db: Db,
    entity: EntityDef<K, Tbl, E, z.output<Meta>>,
    id: EntityId<Tbl>,
    opts?: { readonly upTo?: number },
  ): Promise<ReplayResult<Tbl, E, z.output<Meta>>>;
  /** Replay and compare with the stored row on the columns the reducers produce. */
  verify<K extends string, Tbl extends EntityTable, E extends AnyEventDef>(
    db: Db,
    entity: EntityDef<K, Tbl, E, z.output<Meta>>,
    id: EntityId<Tbl>,
  ): Promise<VerifyResult<Tbl>>;
  /** Lock the row, replay, save the result. Writes no event, runs no projection, creates no job. */
  repair<K extends string, Tbl extends EntityTable, E extends AnyEventDef>(
    db: Db,
    entity: EntityDef<K, Tbl, E, z.output<Meta>>,
    id: EntityId<Tbl>,
  ): Promise<Row<Tbl> | null>;
  /** Walk the log from `from` and call one projection's handlers, a batch per transaction. */
  rerun(
    db: Db,
    projection: Projection<z.output<Meta>>,
    opts?: { readonly from?: number; readonly batch?: number },
  ): Promise<{ readonly events: number }>;
  /** Run one batch of due jobs. Returns how many jobs were claimed. Root database only. */
  drain(db: RootDb, opts?: { readonly limit?: number; readonly signal?: AbortSignal }): Promise<number>;
  /** A loop around `drain`. `stop()` finishes the current batch. Root database only. */
  worker(db: RootDb, opts?: { readonly pollMs?: number; readonly limit?: number }): Worker;
  readonly catalog: {
    readonly entities: readonly EntityInfo[];
    readonly projections: readonly string[];
    readonly effects: readonly string[];
  };
};

export type JournalInit<Meta extends z.ZodObject> = {
  event<T extends string, S extends z.ZodType>(type: T, schema: S): EventDef<T, S>;
  entity<K extends string, Tbl extends EntityTable>(kind: K, table: Tbl): EntityBuilder<K, Tbl, never, z.output<Meta>>;
  /** `on` is `NoInfer` so `E` comes from `entity`; handlers are then contextually typed. */
  projection<E extends AnyEntity<z.output<Meta>>>(
    name: string,
    entity: E | readonly E[],
    on: NoInfer<ProjectionHandlers<E, z.output<Meta>>>,
  ): Projection<z.output<Meta>>;
  effect<E extends AnyEntity<z.output<Meta>>>(
    name: string,
    entity: E | readonly E[],
    on: NoInfer<EffectHandlers<E, z.output<Meta>>>,
  ): Effect<z.output<Meta>>;
  create(config: {
    readonly tables: JournalTables;
    readonly projections?: readonly Projection<z.output<Meta>>[];
    readonly effects?: readonly Effect<z.output<Meta>>[];
  }): Journal<Meta>;
};

type EmptyMeta = z.ZodObject<Record<never, never>>;

const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 300_000;
const DEFAULT_POLL_MS = 1000;
const PG_UNIQUE_VIOLATION = '23505';

export function initJournal(): JournalInit<EmptyMeta>;
export function initJournal<Meta extends z.ZodObject>(options: { readonly meta: Meta }): JournalInit<Meta>;
export function initJournal<Meta extends z.ZodObject>(options?: {
  readonly meta?: Meta;
}): JournalInit<Meta> | JournalInit<EmptyMeta> {
  return options?.meta === undefined ? createInit(z.object({})) : createInit(options.meta);
}

function createInit<Meta extends z.ZodObject>(metaSchema: Meta): JournalInit<Meta> {
  type MetaOut = z.output<Meta>;
  return {
    event: defineEvent,
    entity: <K extends string, Tbl extends EntityTable>(kind: K, table: Tbl) => defineEntity<K, Tbl, MetaOut>(kind, table),
    projection: (name, entity, on) => defineProjection(name, entity, on),
    effect: (name, entity, on) => defineEffect(name, entity, on),
    create: config => createJournal(metaSchema, config.tables, config.projections ?? [], config.effects ?? []),
  };
}

/** A select row has every column of its table. The check is real; the guard narrows. */
function isRowOf<Tbl extends EntityTable>(table: Tbl, value: object): value is Row<Tbl> {
  return Object.keys(getTableColumns(table)).every(column => column in value);
}

async function loadRow(db: Db, table: EntityTable, id: string, lock: boolean): Promise<object | null> {
  const query = db.select().from(table).where(eq(table.id, id)).limit(1);
  const rows = lock ? await query.for('update') : await query;
  return rows[0] ?? null;
}

/** Insert, update or delete the row so it matches `next`. Returns the stored row. */
async function saveReplayed<Tbl extends EntityTable>(
  db: Db,
  table: Tbl,
  id: EntityId<Tbl>,
  current: object | null,
  next: Replayed<Tbl> | null,
): Promise<Row<Tbl> | null> {
  const erased: EntityTable = table;
  if (next === null) {
    if (current !== null) await db.delete(erased).where(eq(erased.id, id));
    return null;
  }
  const saved =
    current === null
      ? await db.insert(erased).values(next).returning()
      : await db.update(erased).set(next).where(eq(erased.id, id)).returning();
  const row = saved[0];
  if (row === undefined || !isRowOf(table, row)) {
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

/** Deep equality for stored rows: `verify` compares what replay produced with what the table holds. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return sameKeys(toRecord(a), toRecord(b), sameValue);
  }
  return false;
}

/** An object literal shape: prototype `Object.prototype` or `null`. A `Set`, `Map`, `Date` or class instance is not one. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep equality for a value that must survive JSON storage: primitives, arrays and
 * plain objects only. A `Set` has no enumerable keys and would otherwise equal `{}`.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
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
    throw new JournalError('UNSTABLE_SCHEMA', kind, id, `${what}: the value cannot be stored as JSON`, { cause: error });
  }
  if (!stable) throw new JournalError('UNSTABLE_SCHEMA', kind, id, `${what}: the schema must accept its own stored output unchanged`);
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
export function sortedByVersion<Row extends { readonly version: number }>(rows: readonly Row[]): Row[] {
  return rows.toSorted((a, b) => a.version - b.version);
}

function createJournal<Meta extends z.ZodObject>(
  metaSchema: Meta,
  tables: JournalTables,
  projections: readonly Projection<z.output<Meta>>[],
  effects: readonly Effect<z.output<Meta>>[],
): Journal<Meta> {
  type MetaOut = z.output<Meta>;
  type Rec = Recorded<string, unknown, MetaOut>;
  const { events: eventsTable, jobs: jobsTable } = tables;

  assertUniqueNames('effect', effects);
  assertUniqueNames('projection', projections);
  const effectsByName = new Map(effects.map(effect => [effect.name, effect]));
  const entitiesByKind = new Map<string, AnyEntity<MetaOut>>();
  for (const handler of [...projections, ...effects]) {
    for (const entity of handler.entities) entitiesByKind.set(entity.kind, entity);
  }

  const schemaFor = (entities: readonly AnyEntity<MetaOut>[], kind: string, type: string): AnyEventDef | undefined =>
    entities.find(entity => entity.kind === kind)?.events.get(type);

  /** Turn a stored log row into a recorded event, parsing data and meta with their current schemas. */
  const decode = (row: typeof eventsTable.$inferSelect, def: AnyEventDef | undefined): Rec => {
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
    return {
      type: row.type,
      data: data.data,
      seq: row.seq,
      id: row.id,
      kind: row.kind,
      entityId: row.entityId,
      version: row.version,
      meta: meta.data,
      recordedAt: row.recordedAt,
    };
  };

  const loadHistory = async (db: Db, kind: string, id: string, upTo?: number) =>
    db
      .select()
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.kind, kind),
          eq(eventsTable.entityId, id),
          upTo === undefined ? undefined : lte(eventsTable.version, upTo),
        ),
      )
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
  const fold = <Tbl extends EntityTable>(
    entity: EntityDef<string, Tbl, AnyEventDef, MetaOut>,
    start: Row<Tbl> | null,
    id: EntityId<Tbl>,
    history: readonly Rec[],
    mode: 'write' | 'replay',
  ): { readonly row: Replayed<Tbl> | null; readonly replaced: boolean } => {
    let state: Row<Tbl> | NewRow<Tbl> | null = start;
    let deleted = false;
    for (const event of history) {
      const reducer = entity.reducers.get(event.type);
      if (reducer === undefined) {
        throw new JournalError(mode === 'write' ? 'UNKNOWN_EVENT' : 'REPLAY_FAILED', entity.kind, id, event.type);
      }
      const detail = `"${event.type}" at version ${event.version}`;
      if (reducer.mode === 'create' && state !== null) {
        throw new JournalError(mode === 'write' ? 'ROW_EXISTS' : 'REPLAY_FAILED', entity.kind, id, detail);
      }
      if (reducer.mode === 'on' && state === null) {
        throw new JournalError(mode === 'write' ? 'NO_ROW' : 'REPLAY_FAILED', entity.kind, id, detail);
      }
      state = reduceOne(entity, state, id, event);
      if (state === null) deleted = true;
    }
    if (state === null) return { row: null, replaced: false };
    const last = history.at(-1);
    const version = last === undefined ? (start === null ? 0 : start.version) : last.version;
    return { row: { ...state, id, version }, replaced: deleted };
  };

  const belongsTo = <E extends AnyEventDef>(
    entity: EntityDef<string, EntityTable, E, MetaOut>,
    event: Rec,
  ): event is RecordedOf<E, MetaOut> => entity.events.has(event.type);

  const replayFrom = async <Tbl extends EntityTable, E extends AnyEventDef>(
    db: Db,
    entity: EntityDef<string, Tbl, E, MetaOut>,
    id: EntityId<Tbl>,
    current: object | null,
    upTo?: number,
  ) => {
    const rows = await loadHistory(db, entity.kind, id, upTo);
    if (rows.length === 0 && current !== null) {
      throw new JournalError('NO_HISTORY', entity.kind, id);
    }
    const history = rows.map(row => decode(row, entity.events.get(row.type)));
    const events = history.filter(event => belongsTo(entity, event));
    debugReplay('%s %s: %d events', entity.kind, id, events.length);
    return { row: fold(entity, null, id, events, 'replay').row, events };
  };

  const journal: Journal<Meta> = {
    async write(tx, entity, id, input) {
      const meta = metaSchema.parse(input.meta);
      assertRoundTrips(metaSchema, meta, entity.kind, id, 'meta');
      return tx.transaction(async sp => {
        const erased: EntityTable = entity.table;
        const loaded = await loadRow(sp, erased, id, true);
        if (loaded !== null && !isRowOf(entity.table, loaded)) {
          throw new Error(`journal: ${entity.kind} ${id} row is missing columns`);
        }
        const row = loaded;
        const base = row === null ? await highestVersion(sp, entity.kind, id) : row.version;
        const pending = await input.decide(row);
        if (pending.length === 0) {
          debugWrite('%s %s: decide returned nothing', entity.kind, id);
          return { row, events: [] };
        }

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
        if (first?.mode === 'create' && row !== null) throw new JournalError('ROW_EXISTS', entity.kind, id, pending[0]?.type);
        if (first?.mode === 'on' && row === null) throw new JournalError('NO_ROW', entity.kind, id, pending[0]?.type);

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
            if (isUniqueViolation(error)) throw new JournalError('CONFLICT', entity.kind, id, undefined, { cause: error });
            throw error;
          });

        // Reducers, projections and the caller see the stored events, decoded the same
        // way replay decodes them. A hand-built pending event may carry keys the schema
        // strips; those never reach a reducer, so write and replay fold the same data.
        const events = sortedByVersion(inserted)
          .map(stored => decode(stored, entity.events.get(stored.type)))
          .filter(event => belongsTo(entity, event));
        if (events.length !== pending.length) {
          throw new Error(`journal: insert returned ${events.length} of ${pending.length} events`);
        }

        const { row: next, replaced } = fold(entity, row, id, events, 'write');
        const finalVersion = base + events.length;
        let saved: Row<typeof entity.table> | null = null;
        if (row === null && next !== null) {
          saved = await saveReplayed(sp, entity.table, id, null, next);
        } else if (row !== null && next !== null && replaced) {
          // A reducer deleted the row and a create followed in the same write. Delete
          // then insert, so columns the create omits get their defaults, not the old values.
          const deleted = await sp
            .delete(erased)
            .where(and(eq(erased.id, id), eq(erased.version, base)))
            .returning({ id: erased.id });
          if (deleted.length === 0) throw new JournalError('VERSION_MISMATCH', entity.kind, id);
          saved = await saveReplayed(sp, entity.table, id, null, next);
        } else if (row !== null && next !== null) {
          const updated = await sp
            .update(erased)
            .set({ ...next, version: finalVersion })
            .where(and(eq(erased.id, id), eq(erased.version, base)))
            .returning();
          const updatedRow = updated[0];
          if (updatedRow === undefined) throw new JournalError('VERSION_MISMATCH', entity.kind, id);
          if (!isRowOf(entity.table, updatedRow)) throw new Error(`journal: ${entity.kind} ${id} update returned a partial row`);
          saved = updatedRow;
        } else if (row !== null && next === null) {
          const deleted = await sp
            .delete(erased)
            .where(and(eq(erased.id, id), eq(erased.version, base)))
            .returning({ id: erased.id });
          if (deleted.length === 0) throw new JournalError('VERSION_MISMATCH', entity.kind, id);
        }

        for (const event of events) {
          for (const projection of projections) {
            if (projection.types.has(event.type) && projection.entities.some(e => e.kind === entity.kind)) {
              await projection.run(sp, event);
            }
          }
        }

        const jobs = events.flatMap(event =>
          effects
            .filter(effect => effect.types.has(event.type) && effect.entities.some(e => e.kind === entity.kind))
            .map(effect => ({ id: jobId(), eventSeq: event.seq, effect: effect.name })),
        );
        if (jobs.length > 0) await sp.insert(jobsTable).values(jobs);

        debugWrite('%s %s: v%d -> v%d, %d events, %d jobs', entity.kind, id, base, finalVersion, events.length, jobs.length);
        return { row: saved, events };
      });
    },

    async replay(db, entity, id, opts) {
      const current = await loadRow(db, entity.table, id, false);
      return replayFrom(db, entity, id, current, opts?.upTo);
    },

    async verify(db, entity, id) {
      const loaded = await loadRow(db, entity.table, id, false);
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
      return db.transaction(async tx => {
        const current = await loadRow(tx, entity.table, id, true);
        const { row: expected } = await replayFrom(tx, entity, id, current);
        debugReplay('%s %s: repair -> %s', entity.kind, id, expected === null ? 'delete' : `v${expected.version}`);
        return saveReplayed(tx, entity.table, id, current, expected);
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
          .where(and(gt(eventsTable.seq, cursor), inArray(eventsTable.kind, kinds), inArray(eventsTable.type, [...projection.types])))
          .orderBy(asc(eventsTable.seq))
          .limit(batch);
        if (rows.length === 0) break;
        await db.transaction(async tx => {
          for (const row of rows) {
            await projection.run(tx, decode(row, schemaFor(projection.entities, row.kind, row.type)));
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
          const event = decode(eventRow, schemaFor(effect.entities, eventRow.kind, eventRow.type));
          await effect.run(event, { jobId: job.id, signal });
          await db.delete(jobsTable).where(and(eq(jobsTable.id, job.id), eq(jobsTable.leaseToken, job.leaseToken ?? '')));
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
          debugDrain('%s %s: attempt %d failed%s: %s', job.effect, job.id, job.attempts, dead ? ', dead' : '', errorText(error));
        }
      }
      return claimed.length;
    },

    worker(db, opts) {
      assertRootDb(db, 'worker');
      const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
      let running = false;
      let loop: Promise<void> = Promise.resolve();
      let wake: (() => void) | undefined;
      const sleep = () =>
        new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            wake = undefined;
            resolve();
          }, pollMs);
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
      // `stop()` flips `running` from another call while `run` is awaiting.
      const isRunning = () => running;
      const run = async () => {
        while (isRunning()) {
          let processed = 0;
          try {
            processed = await journal.drain(db, { limit: opts?.limit });
          } catch (error) {
            debugWorker('drain failed: %s', errorText(error));
          }
          if (isRunning() && processed === 0) await sleep();
        }
      };
      return {
        async start() {
          if (running) return;
          running = true;
          debugWorker('start (poll %dms)', pollMs);
          loop = run();
          await Promise.resolve();
        },
        async stop() {
          running = false;
          wake?.();
          await loop;
          debugWorker('stopped');
        },
      };
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
