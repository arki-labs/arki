/**
 * The write path: the write algorithm, version ordering of inserted events, and
 * telling an append conflict from other database errors.
 * May import `api`, `event-log`, `fold`, `history`, `storage`, `store`, `transaction-guard` and leaf files.
 * Must not import `journal`, `command` or `worker`.
 */
import { sql } from 'drizzle-orm';

import type { IdGenerationFailure } from '@arki/contracts';
import type { Failure, SchemaFailure } from '@arki/failure';
import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { isFailure, isSchemaFailure } from '@arki/failure';
import { parse } from '@arki/schema';

import type { NextEvents, WriteInput, WriteResult } from './api.js';
import type { EventToAppend, JoinedLog } from './event-log.js';
import type { History } from './history.js';
import type { StoredEventRow } from './pg.js';
import type { PgStore } from './store.js';
import type {
  AnyEventDef,
  Effect,
  EntityDef,
  EntityId,
  EntityTable,
  PendingOf,
  Projection,
  Recorded,
  Row,
  Trace,
  TransactionSource,
} from './types.js';
import { debugWrite } from './debug.js';
import { JournalError } from './errors.js';
import { routeOf, streamOf } from './event-log.js';
import { fold, hasDeclaredEventType } from './fold.js';
import { correlationId, eventId, jobId } from './id.js';
import { isReturnedFailure, rollbackOnFailure } from './rollback.js';
import {
  assertExactId,
  assertRoundTrips,
  assertStoredId,
  assertStoredValues,
  isRowOf,
  sameValue,
  showValue,
  toRecord,
} from './storage.js';
import { oneAtATime } from './transaction-guard.js';

/**
 * When a job is due, from the effect's schedule. A delay counts from the transaction's
 * `now()`, so a long transaction can use part of it before commit. `runAt` is the app's
 * clock, as the event names it; a date in the past is due at once.
 */
function dueAt(
  effect: Pick<Effect, 'name' | 'schedule'>,
  event: Recorded,
): { readonly availableAt?: Date | ReturnType<typeof sql> } {
  const { delaySeconds } = effect.schedule;
  if (effect.schedule.runAt !== undefined) {
    const at = effect.schedule.runAt(event);
    if (!(at instanceof Date) || Number.isNaN(at.getTime()))
      throw new Error(`journal: effect "${effect.name}": runAt must return a valid Date, got ${String(at)}`);
    return { availableAt: at };
  }
  if (delaySeconds !== undefined && delaySeconds > 0)
    return { availableAt: sql`now() + make_interval(secs => ${delaySeconds})` };
  return {};
}

/** Insert order is the version order. `RETURNING` does not promise it, so restore it. */
export function sortedByVersion<Row extends { readonly version: number }>(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => a.version - b.version);
}

/** What a write needs from the journal. */
export type WriteDeps<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
> = {
  readonly metaSchema: Meta;
  /** Rows, the write order, jobs and the wake signal. A unique violation comes back from it as `CONFLICT`. */
  readonly store: PgStore;
  /** The built-in log: where `'stored'` events go, bound to the write's savepoint. */
  readonly log: JoinedLog;
  /** Inline projections only: they run inside the write. */
  readonly projections: readonly Projection<SchemaOutput<Meta>, Tx>[];
  /** Async projections: the write only wakes the worker when a recorded event matches one. */
  readonly asyncProjections: readonly Pick<Projection, 'types' | 'entities'>[];
  /** A write only queues one job per matching effect. It never runs an effect, so the effect's database type does not matter here. */
  readonly effects: readonly Pick<Effect<SchemaOutput<Meta>>, 'name' | 'types' | 'entities' | 'schedule'>[];
  readonly history: Pick<History<Meta>, 'decodeStoredEvent' | 'assertLogSaysGone'>;
};

/** What `events` returned, once it is known not to be a failure: an array of events. */
const isEventList = <Value>(value: Value): value is Exclude<Value, Failure> => Array.isArray(value);

export function createWriter<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
>(deps: WriteDeps<Meta, Tx>) {
  type MetaOut = SchemaOutput<Meta>;
  const { metaSchema, projections, asyncProjections, effects } = deps;
  const { decodeStoredEvent, assertLogSaysGone } = deps.history;

  /**
   * `write` with `getValidatedMeta` giving the parsed and checked meta. `journal.write`
   * parses per call; `journal.run` parses once for every write of a command.
   * `getValidatedMeta` runs inside the one-at-a-time guard, so a bad meta on a busy
   * transaction waits for the running operation like any other rejection.
   */
  const writeWithValidatedMeta = async <
    Tbl extends EntityTable,
    E extends AnyEventDef,
    Key extends string,
    Returned extends readonly (PendingOf<E> | SchemaFailure)[] | Failure,
  >(
    tx: Tx,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    getValidatedMeta: () => MetaOut | SchemaFailure,
    events: NextEvents<Tbl, E, Tx, Returned>,
    trace: Trace,
    onJobs?: (count: number) => void,
    opts?: { readonly mode?: 'write' | 'adopt'; readonly expectedVersion?: number },
  ): Promise<WriteResult<Tbl, E, MetaOut, Key> | Extract<Returned, Failure> | SchemaFailure | IdGenerationFailure> => {
    const adopting = opts?.mode === 'adopt';
    const route = routeOf(entity.eventStorage, deps.log);
    const transient = route.mode === 'transient';
    const forwarded = route.mode === 'forwarded';
    const expectedVersion = opts?.expectedVersion;
    if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 0))
      throw new Error(`journal: expectedVersion must be a whole number, zero or more, got ${String(expectedVersion)}`);
    return oneAtATime(tx, `${adopting ? 'adopt' : 'write to'} ${entity.kind} ${id}`, async () => {
      assertExactId(entity, id);
      const meta = getValidatedMeta();
      if (isSchemaFailure(meta)) return meta;
      // A failure `events` returns rolls the savepoint back, like a throw, and is the write's result.
      const refusal = rollbackOnFailure<
        WriteResult<Tbl, E, MetaOut, Key> | Extract<Returned, Failure> | SchemaFailure | IdGenerationFailure
      >();
      const savepoint = tx.transaction(async sp => {
        // Before the row lock, so every journal transaction takes its locks in the same
        // order (append lock, then rows) and two commands writing two entities cannot deadlock.
        const storage = deps.store.bind(sp);
        await storage.seq.lock();
        const loaded = await storage.rows.load(entity, id, true);
        if (loaded !== null && !isRowOf(entity.table, loaded)) {
          throw new Error(`journal: ${entity.kind} ${id} row is missing columns`);
        }
        assertStoredId(entity, loaded, id);
        const row = loaded;
        // Before the rules run: a stale caller gets the answer without doing any work.
        if (expectedVersion !== undefined && (row?.version ?? 0) !== expectedVersion) {
          throw new JournalError(
            'CONFLICT',
            entity.kind,
            id,
            `expected version ${expectedVersion} but the row is at version ${row?.version ?? 0}`,
          );
        }
        const returned = await events(row, { tx: sp });
        if (isReturnedFailure(returned)) return refusal.settle(returned);
        if (!isEventList(returned))
          throw new Error(
            `journal: events for ${entity.kind} ${id} returned ${typeof returned}; return an array of events, or a failure`,
          );
        const pending: PendingOf<E>[] = [];
        for (const event of returned) {
          if (isSchemaFailure(event)) return refusal.settle(event);
          pending.push(event);
        }
        if (pending.length === 0) {
          debugWrite.debug('{kind} {id}: events returned nothing', { kind: entity.kind, id });
          return { row, events: [] };
        }
        // The version the next event follows. No row: the log's top (0 for a new entity,
        // the delete's version after a delete). A row at version 0 with no history existed
        // before the journal: its history starts at 2, so version 1 stays the mark of a
        // real create and replay can tell the two apart. A row at version 0 whose log is
        // not empty lags the log; the unique index would not catch a start at 2.
        // A transient entity has no log: the row's version is the base, 0 when there is no row.
        // Adopt reads the log top for a row at any version: it takes a row whose log is empty,
        // whether the row predates the journal or its entity kept no events until now.
        // A forwarded entity's log lags the row, so only a create reads it: the last pending forward job
        // says where the entity's history ends, and the log does when none is pending. A job leaves
        // this table only after its append, so reading the jobs first misses nothing. The log read
        // happens under the append lock: a create of a forwarded entity waits on its log once.
        const stored = row?.version ?? 0;
        const readsLogTop = !transient && (adopting || row === null || stored === 0);
        const latestLogVersion =
          readsLogTop && route.mode === 'forwarded'
            ? ((await storage.jobs.pendingTop(streamOf(entity.kind, id))) ??
              (await route.log.highestVersion(entity.kind, id)))
            : readsLogTop && route.mode === 'joined'
              ? await route.log.bind(sp).highestVersion(entity.kind, id)
              : 0;
        if (row !== null && stored === 0 && latestLogVersion > 0) {
          throw new JournalError(
            'CONFLICT',
            entity.kind,
            id,
            `the row is at version 0 but its log already holds version ${latestLogVersion}`,
          );
        }
        if (adopting && row === null) {
          throw new JournalError(
            'CONFLICT',
            entity.kind,
            id,
            `adopt needs a row with no history, but found no row and a log ending at version ${latestLogVersion}`,
          );
        }
        if (adopting && latestLogVersion > 0) {
          throw new JournalError(
            'CONFLICT',
            entity.kind,
            id,
            `adopt needs a row with no history, but the row at version ${stored} has a log ending at version ${latestLogVersion}: it was written to after its events started being stored, and its history cannot be completed from here`,
          );
        }
        if (adopting && pending.length !== 1) {
          throw new Error(`journal: adopt ${entity.kind} ${id} needs exactly one create event, got ${pending.length}`);
        }
        // Adopt records the create as version 1, so the history is complete from then on.
        const baseVersion = adopting
          ? 0
          : transient
            ? stored
            : row === null
              ? latestLogVersion
              : stored === 0
                ? 1
                : stored;
        // A forwarded entity's log may be behind or far away; the row's own checks guard it instead.
        if (row === null && latestLogVersion > 0 && !forwarded) {
          const checked = await assertLogSaysGone(sp, entity, id, latestLogVersion);
          if (isFailure(checked)) return refusal.settle(checked);
        }

        // Cheap checks before touching the log. The fold below catches the rest
        // (for example a non-create event after a reducer returned null).
        // Data is parsed here too: a hand-built `{ type, data }` skips the constructor,
        // and a schema that changes its own output would replay to a different value.
        const validated: { readonly type: string; readonly data: unknown; readonly schemaVersion: number }[] = [];
        for (const [index, event] of pending.entries()) {
          const def = entity.events.get(event.type);
          if (def === undefined)
            throw new JournalError(
              'UNKNOWN_EVENT',
              entity.kind,
              id,
              `event "${event.type}" at version ${baseVersion + index + 1}`,
            );
          const data: unknown = parse(def.schema, event.data);
          if (isSchemaFailure(data)) return refusal.settle(data);
          const checked = assertRoundTrips(def.schema, data, entity.kind, id, `event "${event.type}"`);
          if (isFailure(checked)) return refusal.settle(checked);
          validated.push({ type: event.type, data, schemaVersion: def.version });
        }
        const firstType = pending[0]?.type ?? '';
        const firstAt = `event "${firstType}" at version ${baseVersion + 1}`;
        const first = entity.reducers.get(firstType);
        if (adopting && first?.create === undefined) {
          throw new Error(`journal: adopt ${entity.kind} ${id}: event "${firstType}" has no .create reducer`);
        }
        if (!adopting && first !== undefined && row !== null && first.on === undefined) {
          throw new JournalError('ROW_EXISTS', entity.kind, id, firstAt);
        }
        if (first !== undefined && row === null && first.create === undefined) {
          throw new JournalError('NO_ROW', entity.kind, id, firstAt);
        }

        const eventRows = [];
        for (const [index, checked] of validated.entries()) {
          const generated = eventId();
          if (isFailure(generated)) return refusal.settle(generated);
          eventRows.push({
            id: generated,
            kind: entity.kind,
            entityId: id,
            version: baseVersion + index + 1,
            type: checked.type,
            data: checked.data,
            schemaVersion: checked.schemaVersion,
            meta,
            commandId: trace.commandId,
            causeSeq: trace.causeSeq,
            correlationId: trace.correlationId,
          });
        }
        // Every event gets its `seq` and `recordedAt` from the app database first, in both modes,
        // so the rest of the write (decode, fold, projections, effect jobs) is the same for both. A
        // transient entity's events live in this write's result and the effect jobs' `args` only.
        const stamps = await storage.seq.stamp(eventRows.length);
        const appended: EventToAppend[] = eventRows.map((eventRow, index) => {
          const stamp = stamps[index];
          if (stamp === undefined) throw new Error(`journal: ${stamps.length} stamps for ${eventRows.length} events`);
          return { ...eventRow, seq: stamp.seq, recordedAt: stamp.recordedAt };
        });
        const inserted: StoredEventRow[] = appended.map(event => ({ ...event, erasedAt: null }));
        // A taken version is `CONFLICT`, a changed entity id `ID_MISMATCH`: both throw, and the
        // throw rolls the savepoint back with whatever the log took.
        if (route.mode === 'joined')
          await route.log.bind(sp).append({
            kind: entity.kind,
            entityId: id,
            expectedVersion: baseVersion,
            events: appended,
          });

        // Reducers, projections and the caller see the stored events, decoded the same
        // way replay decodes them. A hand-built pending event may carry keys the schema
        // strips; those never reach a reducer, so write and replay fold the same data.
        // The filter only narrows the type and drops nothing: see `hasDeclaredEventType`.
        const decoded: Recorded<string, unknown, MetaOut, EntityId<Tbl, Key>>[] = [];
        for (const stored of sortedByVersion(inserted)) {
          const event = decodeStoredEvent(stored, entity.events.get(stored.type), id);
          if (isFailure(event)) return refusal.settle(event);
          decoded.push(event);
        }
        const recorded = decoded.filter(event => hasDeclaredEventType(entity, event));
        if (recorded.length !== pending.length) {
          throw new Error(`journal: decoding gave ${recorded.length} of ${pending.length} events`);
        }

        // Adopt folds from nothing, as replay will, and must land on the stored row.
        const { row: next, recreated, reducerColumns } = fold(entity, adopting ? null : row, id, recorded, 'write');
        const finalVersion = baseVersion + recorded.length;
        let saved: Row<typeof entity.table> | null = null;
        if (adopting && row !== null && next !== null) {
          const want = toRecord(next);
          const have = toRecord(row);
          for (const column of reducerColumns) {
            if (column === entity.key || column === 'version' || sameValue(want[column], have[column])) continue;
            throw new JournalError(
              'VALUE_MISMATCH',
              entity.kind,
              id,
              `adopt: the create reducer builds column "${column}" as ${showValue(want[column])} but the row holds ${showValue(have[column])}; the event must rebuild the stored row exactly, or replay would build a different row`,
            );
          }
          // Only the version moves. The values are the row's own, checked above.
          const updated = await storage.rows.update(entity, id, { version: finalVersion }, stored);
          if (updated === undefined)
            throw new JournalError('VERSION_MISMATCH', entity.kind, id, `expected row version ${stored}`);
          saved = updated;
        } else if (row === null && next !== null) {
          // A transient entity has no log index to catch two creates of one id. The row's own key
          // does, and the store turns the loser's unique violation into `CONFLICT`.
          saved = await storage.rows.insert(entity, id, next);
        } else if (row !== null && next !== null && recreated) {
          // A reducer deleted the row and a create followed in the same write. Delete
          // then insert, so columns the create omits get their defaults, not the old values.
          if (!(await storage.rows.remove(entity, id, stored)))
            throw new JournalError('VERSION_MISMATCH', entity.kind, id, `expected row version ${stored}`);
          saved = await storage.rows.insert(entity, id, next);
        } else if (row !== null && next !== null) {
          const updated = await storage.rows.update(entity, id, { ...next, version: finalVersion }, stored);
          if (updated === undefined)
            throw new JournalError('VERSION_MISMATCH', entity.kind, id, `expected row version ${stored}`);
          saved = updated;
        } else if (row !== null && next === null && !(await storage.rows.remove(entity, id, stored))) {
          throw new JournalError('VERSION_MISMATCH', entity.kind, id, `expected row version ${stored}`);
        }

        // A create may come back normalised by the database; the events are already
        // inserted, and this throw rolls the savepoint back with them.
        assertStoredId(entity, saved, id);
        // Before projections run, so none sees a row that is about to be refused. Only columns a
        // reducer set in this write: the others came from the database.
        if (saved !== null && next !== null) {
          const set = [...reducerColumns].filter(column => column !== entity.key && column !== 'version');
          assertStoredValues(entity, id, next, saved, set);
        }

        for (const event of recorded) {
          for (const projection of projections) {
            if (projection.types.has(event.type) && projection.entities.some(e => e.kind === entity.kind)) {
              await projection.run(sp, event);
            }
          }
        }

        // Every effect job carries its event: `args` is the stored row as stamped, the same row the
        // log holds, so the worker runs it without reading the log back. `eventSeq` points at
        // a log row, so a transient entity's job leaves it null.
        const storedBySeq = new Map(inserted.map(stored => [stored.seq, stored]));
        const jobs = [];
        for (const event of recorded) {
          for (const effect of effects) {
            if (
              effect.types.has(event.type) &&
              effect.entities.some(e => e.kind === entity.kind) &&
              effect.schedule.when?.(event) !== false
            ) {
              const generated = jobId();
              if (isFailure(generated)) return refusal.settle(generated);
              const stored = storedBySeq.get(event.seq);
              if (stored === undefined) throw new Error(`journal: no stored row for event seq ${event.seq}`);
              jobs.push({
                id: generated,
                eventSeq: transient ? null : event.seq,
                effect: effect.name,
                args: stored,
                priority: effect.schedule.priority ?? 0,
                ...dueAt(effect, event),
              });
            }
          }
        }
        // A forwarded entity's events leave with the commit, in one job per write, in version order.
        if (forwarded) {
          const generated = jobId();
          if (isFailure(generated)) return refusal.settle(generated);
          jobs.push({
            id: generated,
            kind: 'forward' as const,
            jobName: entity.kind,
            args: { events: inserted },
            stream: streamOf(entity.kind, id),
            streamPosition: baseVersion,
          });
        }
        await storage.jobs.enqueue(jobs);
        const seqs = recorded.map(event => event.seq);
        await storage.wake({ from: Math.min(...seqs), to: Math.max(...seqs) });
        // Work for the worker: jobs, plus an async projection that wants one of these events.
        const forAsync = recorded.some(event =>
          asyncProjections.some(p => p.types.has(event.type) && p.entities.some(e => e.kind === entity.kind)),
        );
        if (jobs.length > 0 || forAsync) onJobs?.(jobs.length + (forAsync ? 1 : 0));

        debugWrite.debug('{kind} {id}: v{baseVersion} -> v{finalVersion}, {recordedLength} events, {jobsLength} jobs', {
          kind: entity.kind,
          id,
          baseVersion,
          finalVersion,
          recordedLength: recorded.length,
          jobsLength: jobs.length,
        });
        return { row: saved, events: recorded };
      });
      return savepoint.catch(refusal.recover);
    });
  };

  /** `journal.write`: parses and checks `meta` for this one call. */
  const write = <
    Tbl extends EntityTable,
    E extends AnyEventDef,
    Key extends string,
    Returned extends readonly (PendingOf<E> | SchemaFailure)[] | Failure,
  >(
    tx: Tx,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    input: WriteInput<Tbl, E, Meta, Tx, Returned>,
  ): Promise<WriteResult<Tbl, E, MetaOut, Key> | Extract<Returned, Failure> | SchemaFailure | IdGenerationFailure> => {
    const chainId = correlationId();
    if (isFailure(chainId)) return Promise.resolve(chainId);
    return writeWithValidatedMeta(
      tx,
      entity,
      id,
      () => {
        const meta = parse<SchemaOutput<Meta>>(metaSchema, input.meta);
        if (isSchemaFailure(meta)) return meta;
        const checked = assertRoundTrips(metaSchema, meta, entity.kind, id, 'meta');
        if (isFailure(checked)) return checked;
        return meta;
      },
      input.events,
      // No command and no cause. A fresh chain, so every recorded event has a correlation id.
      { commandId: null, causeSeq: null, correlationId: chainId },
      undefined,
      { expectedVersion: input.expectedVersion },
    );
  };

  /** `journal.adopt`: `write` in adopt mode, with `meta` parsed for this one call. */
  const adopt = <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    tx: Tx,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    input: WriteInput<Tbl, E, Meta, Tx>,
  ): Promise<WriteResult<Tbl, E, MetaOut, Key> | SchemaFailure | IdGenerationFailure> => {
    // Adopt exists to complete a history. A transient entity has none to complete.
    if (entity.eventStorage === 'transient')
      throw new JournalError(
        'NO_HISTORY',
        entity.kind,
        id,
        `adopt: entity "${entity.kind}" is declared with events: 'transient' and keeps no events`,
      );
    const chainId = correlationId();
    if (isFailure(chainId)) return Promise.resolve(chainId);
    return writeWithValidatedMeta(
      tx,
      entity,
      id,
      () => {
        const meta = parse<SchemaOutput<Meta>>(metaSchema, input.meta);
        if (isSchemaFailure(meta)) return meta;
        const checked = assertRoundTrips(metaSchema, meta, entity.kind, id, 'meta');
        if (isFailure(checked)) return checked;
        return meta;
      },
      input.events,
      { commandId: null, causeSeq: null, correlationId: chainId },
      undefined,
      { mode: 'adopt' },
    );
  };

  return { write, adopt, writeWithValidatedMeta };
}

export type Writer<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
> = ReturnType<typeof createWriter<Meta, Tx>>;
