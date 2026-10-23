/**
 * Reading the log: decoding stored events, the log queries, history-completeness
 * checks, and `replay`, `verify`, `repair`, `rerun`.
 * May import `event-log`, `fold`, `storage`, `store`, leaf files, and result types from `api`.
 * Must not import `journal`, `write`, `command` or `worker`.
 */
import { and, eq, sql } from 'drizzle-orm';

import type { SchemaFailure } from '@arki/failure';
import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { InvalidInput, isFailure, isSchemaFailure } from '@arki/failure';

import type { ForgetResult, ReplayResult, VerifyResult } from './api.js';
import type { EventLog, EventLogPosition, JoinedLog } from './event-log.js';
import type { JournalTables, StoredEventRow } from './pg.js';
import type { PgStore } from './store.js';
import type {
  AnyEventDef,
  DbHandle,
  EntityDef,
  EntityId,
  EntityTable,
  EventStorage,
  Projection,
  Recorded,
  Row,
  TransactionSource,
} from './types.js';
import { debugReplay } from './debug.js';
import { JournalError } from './errors.js';
import { globalOrderOf, logOn, routeOf, streamOf } from './event-log.js';
import { findEventDefinition, fold, hasDeclaredEventType } from './fold.js';
import { rollbackOnFailure } from './rollback.js';
import {
  assertExactId,
  assertStoredId,
  assertStoredValues,
  deepFreeze,
  isRowOf,
  safeParse,
  sameValue,
  toRecord,
} from './storage.js';

/** What the log functions need from the journal: the meta schema, the journal tables and its store. */
export type HistoryDeps<Meta extends StandardSchemaV1<unknown, Record<string, unknown>>> = {
  readonly metaSchema: Meta;
  readonly tables: JournalTables;
  /** Entity rows. `forget` still queries `tables` for the cursor lock and the job copies. */
  readonly store: PgStore;
  /** The built-in log: where `'stored'` events are. An entity with its own log reads that one. */
  readonly log: JoinedLog;
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

/** The history verbs read the log back. A transient entity keeps none, so the verb is refused up front. */
function assertStoredEvents(
  entity: { readonly kind: string; readonly eventStorage: EventStorage },
  id: string,
  verb: string,
): void {
  if (entity.eventStorage !== 'transient') return;
  throw new JournalError(
    'NO_HISTORY',
    entity.kind,
    id,
    `${verb}: entity "${entity.kind}" is declared with events: 'transient' and keeps no events`,
  );
}

export function createHistory<Meta extends StandardSchemaV1<unknown, Record<string, unknown>>>(
  deps: HistoryDeps<Meta>,
) {
  type MetaOut = SchemaOutput<Meta>;
  const { metaSchema } = deps;
  const { jobs: jobsTable, jobArchive } = deps.tables;

  /**
   * Turn a stored log row into a recorded event, parsing data and meta with
   * their current schemas. `id` is the row's entity id as the caller types it.
   */
  /**
   * Lift a row's data from the schema version it was written at to the event's current
   * one, one step at a time. Each step parses with its own `from` schema first, so a bad
   * row names the version it failed at. Data already at the current version is returned as is.
   */
  const upcast = (row: StoredEventRow, def: AnyEventDef, at: string): unknown => {
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
      const old = safeParse(step.from, value);
      if (!old.success && !InvalidInput.is(old.error)) return old.error;
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
    row: StoredEventRow,
    def: AnyEventDef | undefined,
    id: Id,
  ): Recorded<string, unknown, MetaOut, Id> | SchemaFailure => {
    const at = `event ${row.id} ("${row.type}" at version ${row.version})`;
    if (def === undefined) {
      throw new JournalError(
        'REPLAY_FAILED',
        row.kind,
        row.entityId,
        `${at}: the entity declares no event of this type`,
      );
    }
    const lifted = upcast(row, def, at);
    if (isSchemaFailure(lifted)) return lifted;
    const data = safeParse(def.schema, lifted);
    if (!data.success && !InvalidInput.is(data.error)) return data.error;
    if (!data.success) {
      const after = row.schemaVersion < def.version ? ` after upcasting from version ${row.schemaVersion}` : '';
      throw new JournalError(
        'REPLAY_FAILED',
        row.kind,
        row.entityId,
        `${at}: the data does not fit the current schema${after}: ${data.error.message}`,
      );
    }
    const meta = safeParse<SchemaOutput<Meta>>(metaSchema, row.meta);
    if (!meta.success && !InvalidInput.is(meta.error)) return meta.error;
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

  /** The entity's own log on `db`: bound when it joins transactions, used as it is when it cannot. */
  const logAt = (db: DbHandle, entity: { readonly kind: string; readonly eventStorage: EventStorage }) => {
    const route = routeOf(entity.eventStorage, deps.log);
    if (route.mode === 'transient')
      throw new JournalError('NO_HISTORY', entity.kind, '', `entity "${entity.kind}" keeps no events`);
    return route.mode === 'joined' ? route.log.bind(db) : route.log;
  };

  /** A forwarded entity's log is behind while a forward job for it waits: the verb would read an old history. */
  const assertNothingForwarding = async (
    db: DbHandle,
    entity: { readonly kind: string; readonly eventStorage: EventStorage },
    id: string,
    verb: string,
  ): Promise<void> => {
    if (routeOf(entity.eventStorage, deps.log).mode !== 'forwarded') return;
    const pending = await deps.store.bind(db).jobs.pendingTop(streamOf(entity.kind, id));
    if (pending !== null)
      throw new JournalError(
        'FORWARD_PENDING',
        entity.kind,
        id,
        `${verb}: a forward job still carries version ${pending}, so the event log is behind the row`,
      );
  };

  const loadHistory = (
    db: DbHandle,
    entity: { readonly kind: string; readonly eventStorage: EventStorage },
    id: string,
  ) => logAt(db, entity).stream(entity.kind, id);

  const replayFrom = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    current: object | null,
    throughVersion?: number,
  ) => {
    // The whole log, so `throughVersion` cannot hide an incomplete history behind an empty result.
    const rows = await loadHistory(db, entity, id);
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
    if (isFailure(all)) return all;
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
    rows: readonly StoredEventRow[],
  ) => {
    const events: Recorded<string, unknown, MetaOut, EntityId<Tbl, Key>>[] = [];
    for (const row of rows) {
      const event = decodeStoredEvent(row, entity.events.get(row.type), id);
      if (isFailure(event)) return event;
      events.push(event);
    }
    return events.filter(event => hasDeclaredEventType(entity, event));
  };

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
  ): Promise<void | SchemaFailure> => {
    const rows = await loadHistory(db, entity, id);
    if (rows[0]?.version !== 1) return;
    const events = decodeHistory(entity, id, rows);
    if (isFailure(events)) return events;
    if (fold(entity, null, id, events, 'replay').row !== null) {
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
  ): Promise<ReplayResult<Tbl, E, MetaOut, Key> | SchemaFailure> => {
    assertStoredEvents(entity, id, 'replay');
    assertExactId(entity, id);
    await assertNothingForwarding(db, entity, id, 'replay');
    const current = await deps.store.bind(db).rows.load(entity, id, false);
    return replayFrom(db, entity, id, current, opts?.throughVersion);
  };

  const verify = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<VerifyResult<Tbl, Key> | SchemaFailure> => {
    assertStoredEvents(entity, id, 'verify');
    assertExactId(entity, id);
    await assertNothingForwarding(db, entity, id, 'verify');
    const loaded = await deps.store.bind(db).rows.load(entity, id, false);
    assertStoredId(entity, loaded, id);
    if (loaded !== null && !isRowOf(entity.table, loaded)) {
      throw new Error(`journal: ${entity.kind} ${id} row is missing columns`);
    }
    const actual = loaded;
    const replayed = await replayFrom(db, entity, id, actual);
    if (isFailure(replayed)) return replayed;
    const { row: expected } = replayed;
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
  ): Promise<Row<Tbl> | null | SchemaFailure> => {
    assertStoredEvents(entity, id, 'repair');
    assertExactId(entity, id);
    return db.transaction(async tx => {
      const current = await deps.store.bind(tx).rows.load(entity, id, true);
      // Under the row lock: no write can queue a forward job between the check and the rebuild.
      await assertNothingForwarding(tx, entity, id, 'repair');
      assertStoredId(entity, current, id);
      const replayed = await replayFrom(tx, entity, id, current);
      if (isFailure(replayed)) return replayed;
      const { row: expected } = replayed;
      debugReplay.debug('{kind} {id}: repair -> {value3}', {
        kind: entity.kind,
        id,
        value3: expected === null ? 'delete' : `v${expected.version}`,
      });
      const saved = await deps.store.bind(tx).rows.saveReplayed(entity, id, current, expected);
      // Throwing rolls the transaction back, so the row stays as it was.
      if (saved !== null && expected !== null) assertStoredValues(entity, id, expected, saved, Object.keys(expected));
      return saved;
    });
  };

  const forget = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    db: DbHandle,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
  ): Promise<ForgetResult<Tbl> | SchemaFailure> => {
    assertStoredEvents(entity, id, 'forget');
    assertExactId(entity, id);
    const refusal = rollbackOnFailure<ForgetResult<Tbl> | SchemaFailure>();
    return db
      .transaction(async tx => {
        // The row lock first, so no write lands between the rewrite and the repair. Then every
        // async cursor, so no projection batch in flight commits the data after it was erased.
        await deps.store.bind(tx).rows.load(entity, id, true);
        // A pending forward job would append the data as it was, after the erase.
        await assertNothingForwarding(tx, entity, id, 'forget');
        await tx.select({ name: deps.tables.cursors.name }).from(deps.tables.cursors).for('update');
        const rows = await loadHistory(tx, entity, id);
        let erased = 0;
        for (const row of rows) {
          const def = entity.events.get(row.type);
          if (def?.erased === undefined) continue;
          // Decode as replay does, so the erased form starts from data the schema accepts.
          const event = decodeStoredEvent(row, def, id);
          if (isFailure(event)) return refusal.settle(event);
          const form = safeParse(def.schema, def.erased(event.data));
          if (!form.success && !InvalidInput.is(form.error)) return refusal.settle(form.error);
          if (!form.success) {
            throw new JournalError(
              'BAD_DEFINITION',
              entity.kind,
              id,
              `event "${row.type}": its erased form does not fit its own schema: ${form.error.message}`,
            );
          }
          const log = logAt(tx, entity);
          if (log.erase === undefined)
            throw new JournalError(
              'NO_HISTORY',
              entity.kind,
              id,
              'forget: this event log cannot rewrite events in place',
            );
          const stamped = await log.erase(row, { data: form.data, schemaVersion: def.version });
          // Every effect job carries a copy of its event in `args`, and the archive keeps finished jobs
          // for days. Both copies get the same erased data, schema version and stamp as the event row.
          const erasedCopy = JSON.stringify({
            data: form.data,
            schemaVersion: def.version,
            erasedAt: stamped.erasedAt,
          });
          await tx
            .update(jobsTable)
            .set({ args: sql`${jobsTable.args} || ${erasedCopy}::jsonb` })
            .where(and(eq(jobsTable.kind, 'effect'), sql`${jobsTable.args}->>'id' = ${row.id}`));
          await tx
            .update(jobArchive)
            .set({ args: sql`${jobArchive.args} || ${erasedCopy}::jsonb` })
            .where(and(eq(jobArchive.kind, 'effect'), sql`${jobArchive.args}->>'id' = ${row.id}`));
          // A finished forward job keeps the write's events in the archive too: erase this one there.
          await tx
            .update(jobArchive)
            .set({
              args: sql`
                jsonb_set(${jobArchive.args}, '{events}', (
                  select jsonb_agg(case when e->>'id' = ${row.id} then e || ${erasedCopy}::jsonb else e end order by at)
                  from jsonb_array_elements(${jobArchive.args}->'events') with ordinality as x(e, at)))
              `,
            })
            .where(
              and(
                eq(jobArchive.kind, 'forward'),
                eq(jobArchive.stream, streamOf(entity.kind, id)),
                sql`${jobArchive.args}->'events' @> ${JSON.stringify([{ id: row.id }])}::jsonb`,
              ),
            );
          erased += 1;
        }
        // The row must match the history it now has. Repair on `tx` is a savepoint.
        const row = await repair(tx, entity, id);
        if (isSchemaFailure(row)) return refusal.settle(row);
        debugReplay.debug('{kind} {id}: forget -> {erased} events erased', { kind: entity.kind, id, erased });
        return { erased, row };
      })
      .catch(refusal.recover);
  };

  const rerun = async <Tx extends TransactionSource<Tx>>(
    db: TransactionSource<Tx>,
    projection: Projection<MetaOut, Tx>,
    opts?: { readonly after?: EventLogPosition | null; readonly batchSize?: number },
  ): Promise<{ readonly events: number } | SchemaFailure> => {
    const batchSize = opts?.batchSize ?? 100;
    for (const entity of projection.entities) assertStoredEvents(entity, projection.name, 'rerun');
    const kinds = projection.entities.map(entity => entity.kind);
    let position = opts?.after ?? null;
    let count = 0;
    const [first] = projection.entities;
    if (first === undefined || projection.types.size === 0) return { events: 0 };
    for (;;) {
      // `compose` holds a projection to one log, so the first entity's log is every entity's.
      const { events: rows, next } = await globalOrderOf(logAt(db, first), 'rerun').after(position, {
        kinds,
        types: [...projection.types],
        limit: batchSize,
      });
      if (rows.length === 0) break;
      const refusal = rollbackOnFailure<void | SchemaFailure>();
      const result = await db
        .transaction(async tx => {
          for (const row of rows) {
            const event = decodeStoredEvent(
              row,
              findEventDefinition(projection.entities, row.kind, row.type),
              row.entityId,
            );
            if (isFailure(event)) return refusal.settle(event);
            await projection.run(tx, event);
          }
        })
        .catch(refusal.recover);
      if (isFailure(result)) return result;
      count += rows.length;
      position = next;
      if (rows.length < batchSize) break;
    }
    debugReplay.debug('rerun {projectionName}: {count} events', { projectionName: projection.name, count });
    return { events: count };
  };

  /**
   * Copy one entity kind's events from the log it uses now into `to`, for a store switch. Events
   * go across as stored: same ids, versions, seqs and schema versions, and an erased event is
   * erased again where `to` can. Appends repeat safely, so a copy cut short runs again from the
   * start. Writes to the kind must be paused until the setting is flipped.
   */
  const copyLog = async (
    db: DbHandle,
    entity: { readonly kind: string; readonly eventStorage: EventStorage },
    opts: { readonly to: 'stored' | EventLog; readonly batchSize?: number },
  ): Promise<{ readonly events: number }> => {
    const batchSize = opts.batchSize ?? 500;
    assertStoredEvents(entity, '', 'copyLog');
    const route = routeOf(entity.eventStorage, deps.log);
    const target = opts.to === 'stored' ? deps.log : opts.to;
    if (route.mode !== 'transient' && route.log === target)
      throw new JournalError(
        'BAD_DEFINITION',
        entity.kind,
        '',
        `copyLog: entity "${entity.kind}" already uses that log`,
      );
    const [waiting] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(and(eq(jobsTable.kind, 'forward'), eq(jobsTable.jobName, entity.kind)))
      .limit(1);
    if (waiting !== undefined)
      throw new JournalError(
        'FORWARD_PENDING',
        entity.kind,
        '',
        'copyLog: forward jobs still carry events of this kind, so the log is behind the rows; drain them first',
      );
    const from = globalOrderOf(logAt(db, entity), 'copyLog');
    const to = logOn(target, db);
    let position: EventLogPosition | null = null;
    let copied = 0;
    for (;;) {
      const { events, next } = await from.after(position, { kinds: [entity.kind], limit: batchSize });
      // The order keeps each entity's versions in sequence, so a run of one entity is one append.
      let start = 0;
      while (start < events.length) {
        const first = events[start];
        if (first === undefined) break;
        let end = start + 1;
        while (events[end]?.entityId === first.entityId) end += 1;
        const run = events.slice(start, end);
        await to.append({
          kind: entity.kind,
          entityId: first.entityId,
          expectedVersion: first.version - 1,
          events: run.map(({ position: _position, erasedAt: _erasedAt, ...event }) => event),
        });
        if (to.erase !== undefined) {
          for (const event of run) {
            if (event.erasedAt !== null)
              await to.erase(event, { data: event.data, schemaVersion: event.schemaVersion });
          }
        }
        start = end;
      }
      copied += events.length;
      position = next;
      if (events.length < batchSize) break;
    }
    debugReplay.debug('copyLog {kind}: {count} events', { kind: entity.kind, count: copied });
    return { events: copied };
  };

  return { decodeStoredEvent, assertLogSaysGone, replay, verify, repair, forget, rerun, copyLog };
}

export type History<Meta extends StandardSchemaV1<unknown, Record<string, unknown>>> = ReturnType<
  typeof createHistory<Meta>
>;
