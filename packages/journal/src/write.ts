/**
 * The write path: the write algorithm, version ordering of inserted events, and
 * telling an append conflict from other database errors.
 * May import `api`, `fold`, `history`, `storage`, `transaction-guard` and leaf files.
 * Must not import `journal`, `command` or `worker`.
 */
import type { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { NextEvents, WriteInput, WriteResult } from './api.js';
import type { History } from './history.js';
import type { JournalTables } from './pg.js';
import type {
  AnyEventDef,
  Effect,
  EntityDef,
  EntityId,
  EntityTable,
  Projection,
  Row,
  TransactionSource,
} from './types.js';
import { debugWrite } from './debug.js';
import { JournalError } from './errors.js';
import { fold, hasDeclaredEventType } from './fold.js';
import { eventId, jobId } from './id.js';
import {
  assertExactId,
  assertRoundTrips,
  assertStoredId,
  assertStoredValues,
  isRowOf,
  loadRow,
  saveReplayed,
} from './storage.js';
import { oneAtATime } from './transaction-guard.js';

const PG_UNIQUE_VIOLATION = '23505';

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

/** Insert order is the version order. `RETURNING` does not promise it, so restore it. */
export function sortedByVersion<Row extends { readonly version: number }>(rows: readonly Row[]): Row[] {
  return rows.toSorted((a, b) => a.version - b.version);
}

/** What a write needs from the journal. */
export type WriteDeps<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>> = {
  readonly metaSchema: Meta;
  readonly tables: JournalTables;
  readonly projections: readonly Projection<z.output<Meta>, Tx>[];
  /** A write only queues one job per matching effect. It never runs an effect, so the effect's database type does not matter here. */
  readonly effects: readonly Pick<Effect<z.output<Meta>>, 'name' | 'types' | 'entities'>[];
  readonly history: Pick<History<Meta>, 'decodeStoredEvent' | 'highestVersion' | 'assertLogSaysGone'>;
};

export function createWriter<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>>(deps: WriteDeps<Meta, Tx>) {
  type MetaOut = z.output<Meta>;
  const { metaSchema, projections, effects } = deps;
  const { events: eventsTable, jobs: jobsTable } = deps.tables;
  const { decodeStoredEvent, highestVersion, assertLogSaysGone } = deps.history;

  /**
   * `write` with `getValidatedMeta` giving the parsed and checked meta. `journal.write`
   * parses per call; `journal.run` parses once for every write of a command.
   * `getValidatedMeta` runs inside the one-at-a-time guard, so a bad meta on a busy
   * transaction waits for the running operation like any other rejection.
   */
  const writeWithValidatedMeta = async <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    tx: Tx,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    getValidatedMeta: () => MetaOut,
    events: NextEvents<Tbl, E, Tx>,
    onJobs?: (count: number) => void,
  ): Promise<WriteResult<Tbl, E, MetaOut, Key>> => {
    return oneAtATime(tx, `write to ${entity.kind} ${id}`, async () => {
      assertExactId(entity, id);
      const meta = getValidatedMeta();
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
        const latestLogVersion = row === null || stored === 0 ? await highestVersion(sp, entity.kind, id) : 0;
        if (row !== null && stored === 0 && latestLogVersion > 0) {
          throw new JournalError(
            'CONFLICT',
            entity.kind,
            id,
            `the row is at version 0 but its log already holds version ${latestLogVersion}`,
          );
        }
        const baseVersion = row === null ? latestLogVersion : stored === 0 ? 1 : stored;
        if (row === null && latestLogVersion > 0) await assertLogSaysGone(sp, entity, id, latestLogVersion);

        // Cheap checks before touching the log. The fold below catches the rest
        // (for example a non-create event after a reducer returned null).
        // Data is parsed here too: a hand-built `{ type, data }` skips the constructor,
        // and a schema that changes its own output would replay to a different value.
        const validated = pending.map((event, index) => {
          const def = entity.events.get(event.type);
          if (def === undefined)
            throw new JournalError(
              'UNKNOWN_EVENT',
              entity.kind,
              id,
              `event "${event.type}" at version ${baseVersion + index + 1}`,
            );
          const data: unknown = def.schema.parse(event.data);
          assertRoundTrips(def.schema, data, entity.kind, id, `event "${event.type}"`);
          return data;
        });
        const firstType = pending[0]?.type ?? '';
        const firstAt = `event "${firstType}" at version ${baseVersion + 1}`;
        const first = entity.reducers.get(firstType);
        if (first !== undefined && row !== null && first.on === undefined) {
          throw new JournalError('ROW_EXISTS', entity.kind, id, firstAt);
        }
        if (first !== undefined && row === null && first.create === undefined) {
          throw new JournalError('NO_ROW', entity.kind, id, firstAt);
        }

        const inserted = await sp
          .insert(eventsTable)
          .values(
            pending.map((event, index) => ({
              id: eventId(),
              kind: entity.kind,
              entityId: id,
              version: baseVersion + index + 1,
              type: event.type,
              data: validated[index],
              meta,
            })),
          )
          .returning()
          .catch((error: unknown) => {
            if (isUniqueViolation(error))
              throw new JournalError(
                'CONFLICT',
                entity.kind,
                id,
                `version ${baseVersion + 1} is already in the log: another writer appended it first, or the row is behind its history`,
                { cause: error },
              );
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
        // The filter only narrows the type and drops nothing: see `hasDeclaredEventType`.
        const recorded = sortedByVersion(inserted)
          .map(stored => decodeStoredEvent(stored, entity.events.get(stored.type), id))
          .filter(event => hasDeclaredEventType(entity, event));
        if (recorded.length !== pending.length) {
          throw new Error(`journal: insert returned ${recorded.length} of ${pending.length} events`);
        }

        const { row: next, recreated, reducerColumns } = fold(entity, row, id, recorded, 'write');
        const finalVersion = baseVersion + recorded.length;
        const atBase = and(eq(entity.keyColumn, id), eq(erased.version, stored));
        let saved: Row<typeof entity.table> | null = null;
        if (row === null && next !== null) {
          saved = await saveReplayed(sp, entity, id, null, next);
        } else if (row !== null && next !== null && recreated) {
          // A reducer deleted the row and a create followed in the same write. Delete
          // then insert, so columns the create omits get their defaults, not the old values.
          const deleted = await sp.delete(erased).where(atBase).returning({ version: erased.version });
          if (deleted.length === 0)
            throw new JournalError('VERSION_MISMATCH', entity.kind, id, `expected row version ${stored}`);
          saved = await saveReplayed(sp, entity, id, null, next);
        } else if (row !== null && next !== null) {
          const updated = await sp
            .update(erased)
            .set({ ...next, version: finalVersion })
            .where(atBase)
            .returning();
          const updatedRow = updated[0];
          if (updatedRow === undefined)
            throw new JournalError('VERSION_MISMATCH', entity.kind, id, `expected row version ${stored}`);
          if (!isRowOf(entity.table, updatedRow))
            throw new Error(`journal: ${entity.kind} ${id} update returned a partial row`);
          saved = updatedRow;
        } else if (row !== null && next === null) {
          const deleted = await sp.delete(erased).where(atBase).returning({ version: erased.version });
          if (deleted.length === 0)
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
          baseVersion,
          finalVersion,
          recorded.length,
          jobs.length,
        );
        return { row: saved, events: recorded };
      });
    });
  };

  /** `journal.write`: parses and checks `meta` for this one call. */
  const write = <Tbl extends EntityTable, E extends AnyEventDef, Key extends string>(
    tx: Tx,
    entity: EntityDef<string, Tbl, E, MetaOut, Key>,
    id: EntityId<Tbl, Key>,
    input: WriteInput<Tbl, E, Meta, Tx>,
  ): Promise<WriteResult<Tbl, E, MetaOut, Key>> =>
    writeWithValidatedMeta(
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

  return { write, writeWithValidatedMeta };
}

export type Writer<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>> = ReturnType<
  typeof createWriter<Meta, Tx>
>;
