/**
 * Reading the log: decoding stored events, the log queries, history-completeness
 * checks, and `replay`, `verify`, `repair`, `rerun`.
 * May import `fold`, `storage`, leaf files, and result types from `api`.
 * Must not import `journal`, `write`, `command` or `worker`.
 */
import type { z } from 'zod';
import { and, asc, eq, gt, inArray, max, sql } from 'drizzle-orm';

import type { ForgetResult, ReplayResult, VerifyResult } from './api.js';
import type { JournalTables } from './pg.js';
import type {
  AnyEventDef,
  DbHandle,
  EntityDef,
  EntityId,
  EntityTable,
  Projection,
  Recorded,
  Row,
  TransactionSource,
} from './types.js';
import { debugReplay } from './debug.js';
import { JournalError } from './errors.js';
import { findEventDefinition, fold, hasDeclaredEventType } from './fold.js';
import {
  assertExactId,
  assertStoredId,
  assertStoredValues,
  deepFreeze,
  isRowOf,
  loadRow,
  sameValue,
  saveReplayed,
  toRecord,
} from './storage.js';

/** What the log functions need from the journal: the meta schema and the journal tables. */
export type HistoryDeps<Meta extends z.ZodObject> = {
  readonly metaSchema: Meta;
  readonly tables: JournalTables;
};

/**
 * Every version from 1 to the top must be stored. A hole means an event was lost
 * after it was written. Folding around it would build a row the real history never
 * produced, and `repair` would save it. The rows come ordered by version, and the
 * unique index allows one row per version, so position and version must agree.
 */
function assertNoHoles(kind: string, id: string, rows: readonly { readonly version: number }[]): void {
  for (const [index, row] of rows.entries()) {
    if (row.version !== index + 1) {
      throw new JournalError(
        'HISTORY_GAP',
        kind,
        id,
        `version ${index + 1} is missing from the log; the next stored version is ${row.version}`,
      );
    }
  }
}

/**
 * A stored row newer than a log that says the entity is alive lost its last events.
 * Repair would quietly roll the row back, so replay refuses instead. When the log
 * says the entity is gone, a row at any version was placed outside the journal and
 * repair removes it: see `assertLogSaysGone`.
 */
function assertRowNotAhead(kind: string, id: string, folded: object | null, top: number, current: object | null): void {
  if (folded === null || current === null) return;
  if ('version' in current && typeof current.version === 'number' && current.version > top) {
    throw new JournalError(
      'HISTORY_GAP',
      kind,
      id,
      `the row is at version ${current.version} but the log ends at version ${top}`,
    );
  }
}

export function createHistory<Meta extends z.ZodObject>(deps: HistoryDeps<Meta>) {
  type MetaOut = z.output<Meta>;
  const { metaSchema } = deps;
  const eventsTable = deps.tables.events;

  /**
   * Turn a stored log row into a recorded event, parsing data and meta with
   * their current schemas. `id` is the row's entity id as the caller types it.
   */
  /**
   * Lift a row's data from the schema version it was written at to the event's current
   * one, one step at a time. Each step parses with its own `from` schema first, so a bad
   * row names the version it failed at. Data already at the current version is returned as is.
   */
  const upcast = (row: typeof eventsTable.$inferSelect, def: AnyEventDef, at: string): unknown => {
    const fail = (why: string): never => {
      throw new JournalError('REPLAY_FAILED', row.kind, row.entityId, `${at}: ${why}`);
    };
    if (row.schemaVersion > def.version) {
      return fail(`written at schema version ${row.schemaVersion}, but the event declares version ${def.version}`);
    }
    let value: unknown = row.data;
    for (let version = row.schemaVersion; version < def.version; version += 1) {
      const step = def.upcasters[version - 1];
      if (step === undefined) return fail(`no upcaster for schema version ${version}`);
      const old = step.from.safeParse(value);
      if (!old.success) return fail(`the data does not fit schema version ${version}: ${old.error.message}`);
      try {
        value = step.up(old.data);
      } catch (error) {
        return fail(
          `the upcaster from version ${version} threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return value;
  };

  const decodeStoredEvent = <Id extends string>(
    row: typeof eventsTable.$inferSelect,
    def: AnyEventDef | undefined,
    id: Id,
  ): Recorded<string, unknown, MetaOut, Id> => {
    const at = `event ${row.id} ("${row.type}" at version ${row.version})`;
    if (def === undefined) {
      throw new JournalError(
        'REPLAY_FAILED',
        row.kind,
        row.entityId,
        `${at}: the entity declares no event of this type`,
      );
    }
    const data = def.schema.safeParse(upcast(row, def, at));
    if (!data.success) {
      const after = row.schemaVersion < def.version ? ` after upcasting from version ${row.schemaVersion}` : '';
      throw new JournalError(
        'REPLAY_FAILED',
        row.kind,
        row.entityId,
        `${at}: the data does not fit the current schema${after}: ${data.error.message}`,
      );
    }
    const meta = metaSchema.safeParse(row.meta);
    if (!meta.success) {
      throw new JournalError(
        'REPLAY_FAILED',
        row.kind,
        row.entityId,
        `${at}: the meta does not fit the current meta schema: ${meta.error.message}`,
      );
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
      commandId: row.commandId,
      causeSeq: row.causeSeq,
      correlationId: row.correlationId,
      erasedAt: row.erasedAt,
    });
  };

  const loadHistory = async (db: DbHandle, kind: string, id: string) =>
    db
      .select()
      .from(eventsTable)
      .where(and(eq(eventsTable.kind, kind), eq(eventsTable.entityId, id)))
      .orderBy(asc(eventsTable.version));

  const highestVersion = async (db: DbHandle, kind: string, id: string): Promise<number> => {
    const [top] = await db
      .select({ version: max(eventsTable.version) })
      .from(eventsTable)
      .where(and(eq(eventsTable.kind, kind), eq(eventsTable.entityId, id)));
    return top?.version ?? 0;
  };

  const replayFrom = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    current: object | null,
    throughVersion?: number,
  ) => {
    // The whole log, so `throughVersion` cannot hide an incomplete history behind an empty result.
    const rows = await loadHistory(db, entity.kind, id);
    const first = rows[0];
    if (first === undefined && current !== null) {
      throw new JournalError('NO_HISTORY', entity.kind, id, 'the row exists but the log holds no event for it');
    }
    // Version 1 is only ever written by a create from no row. A history that starts
    // later belongs to a row that existed before the journal; folding it from nothing
    // would pick the wrong reducers.
    if (first !== undefined && first.version !== 1) {
      throw new JournalError('NO_HISTORY', entity.kind, id, `the first stored version is ${first.version}`);
    }
    assertNoHoles(entity.kind, id, rows);
    const all = decodeHistory(entity, id, rows);
    // The whole history decides whether the entity is alive, whatever `throughVersion` says.
    const full = fold(entity, null, id, all, 'replay').row;
    assertRowNotAhead(entity.kind, id, full, rows.at(-1)?.version ?? 0, current);
    const events = throughVersion === undefined ? all : all.filter(event => event.version <= throughVersion);
    debugReplay.debug('{kind} {id}: {eventsLength} events', { kind: entity.kind, id, eventsLength: events.length });
    return { row: throughVersion === undefined ? full : fold(entity, null, id, events, 'replay').row, events };
  };

  /** Decodes every row. The filter only narrows the type and drops nothing: see `hasDeclaredEventType`. */
  const decodeHistory = <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    rows: Awaited<ReturnType<typeof loadHistory>>,
  ) =>
    rows
      .map(row => decodeStoredEvent(row, entity.events.get(row.type), id))
      .filter(event => hasDeclaredEventType(entity, event));

  /**
   * No row, but a log. Either a create follows a delete, or the row was removed
   * outside the journal. The log decides: a history that starts at 1 is complete,
   * and if it folds to a row, that row should be there. Creating over it would make
   * write and replay pick different reducers for the same event. A history that
   * starts later belongs to a pre-journal row and cannot be replayed, so it passes.
   */
  const assertLogSaysGone = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    latestLogVersion: number,
  ): Promise<void> => {
    const rows = await loadHistory(db, entity.kind, id);
    if (rows[0]?.version !== 1) return;
    if (fold(entity, null, id, decodeHistory(entity, id, rows), 'replay').row !== null) {
      throw new JournalError(
        'CONFLICT',
        entity.kind,
        id,
        `the row is missing but its history says it exists at version ${latestLogVersion}; it was removed outside the journal, and repair restores it`,
      );
    }
  };

  const replay = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    opts?: { readonly throughVersion?: number },
  ): Promise<ReplayResult<Tbl, E, MetaOut, Key>> => {
    assertExactId(entity, id);
    const current = await loadRow(db, entity, id, false);
    return replayFrom(db, entity, id, current, opts?.throughVersion);
  };

  const verify = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<VerifyResult<Tbl, Key>> => {
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
  };

  const repair = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<Row<Tbl> | null> => {
    assertExactId(entity, id);
    return db.transaction(async tx => {
      const current = await loadRow(tx, entity, id, true);
      assertStoredId(entity, current, id);
      const { row: expected } = await replayFrom(tx, entity, id, current);
      debugReplay.debug('{kind} {id}: repair -> {value3}', {
        kind: entity.kind,
        id,
        value3: expected === null ? 'delete' : `v${expected.version}`,
      });
      const saved = await saveReplayed(tx, entity, id, current, expected);
      // Throwing rolls the transaction back, so the row stays as it was.
      if (saved !== null && expected !== null) assertStoredValues(entity, id, expected, saved, Object.keys(expected));
      return saved;
    });
  };

  const forget = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<ForgetResult<Tbl>> => {
    assertExactId(entity, id);
    return db.transaction(async tx => {
      // The row lock first, so no write lands between the rewrite and the repair. Then every
      // async cursor, so no projection batch in flight commits the data after it was erased.
      await loadRow(tx, entity, id, true);
      await tx.select({ name: deps.tables.cursors.name }).from(deps.tables.cursors).for('update');
      const rows = await loadHistory(tx, entity.kind, id);
      let erased = 0;
      for (const row of rows) {
        const def = entity.events.get(row.type);
        if (def?.erased === undefined) continue;
        // Decode as replay does, so the erased form starts from data the schema accepts.
        const event = decodeStoredEvent(row, def, id);
        const form = def.schema.safeParse(def.erased(event.data));
        if (!form.success) {
          throw new JournalError(
            'BAD_DEFINITION',
            entity.kind,
            id,
            `event "${row.type}": its erased form does not fit its own schema: ${form.error.message}`,
          );
        }
        await tx
          .update(eventsTable)
          .set({
            data: form.data,
            schemaVersion: def.version,
            erasedAt: sql`coalesce(${eventsTable.erasedAt}, now())`,
          })
          .where(eq(eventsTable.seq, row.seq));
        erased += 1;
      }
      // The row must match the history it now has. Repair on `tx` is a savepoint.
      const row = await repair(tx, entity, id);
      debugReplay.debug('{kind} {id}: forget -> {erased} events erased', { kind: entity.kind, id, erased });
      return { erased, row };
    });
  };

  const rerun = async <Tx extends TransactionSource<Tx>>(
    db: TransactionSource<Tx>,
    projection: Projection<MetaOut, Tx>,
    opts?: { readonly afterSeq?: number; readonly batchSize?: number },
  ): Promise<{ readonly events: number }> => {
    const batchSize = opts?.batchSize ?? 100;
    const kinds = projection.entities.map(entity => entity.kind);
    let cursor = opts?.afterSeq ?? 0;
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
        .limit(batchSize);
      if (rows.length === 0) break;
      await db.transaction(async tx => {
        for (const row of rows) {
          await projection.run(
            tx,
            decodeStoredEvent(row, findEventDefinition(projection.entities, row.kind, row.type), row.entityId),
          );
        }
      });
      count += rows.length;
      cursor = rows.at(-1)?.seq ?? cursor;
      if (rows.length < batchSize) break;
    }
    debugReplay.debug('rerun {projectionName}: {count} events', { projectionName: projection.name, count });
    return { events: count };
  };

  return { decodeStoredEvent, highestVersion, assertLogSaysGone, replay, verify, repair, forget, rerun };
}

export type History<Meta extends z.ZodObject> = ReturnType<typeof createHistory<Meta>>;
