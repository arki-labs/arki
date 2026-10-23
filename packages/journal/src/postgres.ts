/**
 * `postgresEvents`: an event log in another Postgres database. It shares no transaction with the
 * app's, so its entities are forwarded: the write commits the row and a `forward` job, and the
 * worker appends the events here afterwards. Its tables come from `eventLogTables` in
 * `@arki/journal/pg`, migrated in that database.
 */
import { and, asc, desc, eq, getTableColumns, gt, inArray, is, max, sql } from 'drizzle-orm';
import { PgAsyncTransaction } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { ensure } from '@arki/schema';

import type { ForwardedLog, StoredEvent } from './event-log.js';
import type { EventLogTables } from './pg.js';
import type { DbHandle } from './types.js';
import { JournalError } from './errors.js';
import { EventLogPosition } from './event-log.js';

/** A position in this log: the appending transaction's id, then the event's seq, as `xid:seq`. */
const PostgresPosition = z
  .string()
  .regex(/^\d+:\d+$/, 'a position of a postgresEvents log is "transaction id:seq"')
  .transform(text => {
    const at = text.indexOf(':');
    return { xid: text.slice(0, at), seq: Number(text.slice(at + 1)) };
  });

const positionOf = (at: { readonly xid: string; readonly seq: number }): EventLogPosition =>
  ensure(`${at.xid}:${at.seq}`, EventLogPosition);

/**
 * Events here are appended by many workers at once, and the app's seq is stamped before the
 * append, so neither seq nor commit time is an order a reader can follow safely. The order is
 * `(transaction_id, seq)`, read only below the oldest transaction still open (the snapshot's
 * `xmin`). Every transaction below it has ended, and every later one gets a higher id, so no row
 * can ever commit behind what a read returned. Cost: one long transaction anywhere on that Postgres
 * server holds async projections back until it ends.
 */
export function postgresEvents(deps: { readonly db: DbHandle; readonly tables: EventLogTables }): ForwardedLog {
  const { db } = deps;
  const eventsTable = deps.tables.events;
  // The event row as the journal stores it; `transaction_id` is this table's own.
  const { transactionId: _order, ...storedColumns } = getTableColumns(eventsTable);
  const order = sql`(${eventsTable.transactionId}, ${eventsTable.seq})`;

  /** The newest event no open transaction can still precede. `null`: none yet. */
  const top = async (): Promise<{ readonly xid: string; readonly seq: number } | null> => {
    const [row] = await db
      .select({ xid: eventsTable.transactionId, seq: eventsTable.seq })
      .from(eventsTable)
      .where(sql`${eventsTable.transactionId} < pg_snapshot_xmin(pg_current_snapshot())`)
      .orderBy(desc(eventsTable.transactionId), desc(eventsTable.seq))
      .limit(1);
    return row ?? null;
  };

  /**
   * One statement inserts what is new. A short insert means some event was there already: the
   * same events (a repeat, a success) or a version another event holds (`CONFLICT`). Whatever this
   * call inserted is removed before it throws, inside the append's own transaction.
   */
  const appendOn = async (tx: DbHandle, batch: Parameters<ForwardedLog['append']>[0]): Promise<void> => {
    const { events } = batch;
    const inserted = await tx
      .insert(eventsTable)
      .values([...events])
      .onConflictDoNothing()
      .returning({ id: eventsTable.id, entityId: eventsTable.entityId });
    const undo = async () => {
      if (inserted.length > 0)
        await tx.delete(eventsTable).where(
          inArray(
            eventsTable.id,
            inserted.map(row => row.id),
          ),
        );
    };
    // The log must hold the id as given: a cut or changed `entity_id` would split the history.
    const changed = inserted.find(row => row.entityId !== batch.entityId);
    if (changed !== undefined) {
      await undo();
      throw new JournalError(
        'ID_MISMATCH',
        batch.kind,
        batch.entityId,
        `the log stored the entity id ${JSON.stringify(changed.entityId)} but the id given is ${JSON.stringify(batch.entityId)}`,
      );
    }
    if (inserted.length === events.length) return;
    const found = await tx
      .select({
        id: eventsTable.id,
        kind: eventsTable.kind,
        entityId: eventsTable.entityId,
        version: eventsTable.version,
      })
      .from(eventsTable)
      .where(
        inArray(
          eventsTable.id,
          events.map(event => event.id),
        ),
      );
    const repeat = events.every(event =>
      found.some(
        row =>
          row.id === event.id &&
          row.kind === event.kind &&
          row.entityId === event.entityId &&
          row.version === event.version,
      ),
    );
    if (repeat) return;
    await undo();
    throw new JournalError(
      'CONFLICT',
      batch.kind,
      batch.entityId,
      `version ${batch.expectedVersion + 1} is already in the log: another writer appended it first`,
    );
  };

  return {
    canJoinTransaction: false,

    stream: (kind, entityId, filter): Promise<StoredEvent[]> => {
      const query = db
        .select(storedColumns)
        .from(eventsTable)
        .where(
          and(
            eq(eventsTable.kind, kind),
            eq(eventsTable.entityId, entityId),
            filter?.types === undefined ? undefined : inArray(eventsTable.type, [...filter.types]),
            filter?.afterVersion === undefined ? undefined : gt(eventsTable.version, filter.afterVersion),
          ),
        )
        .orderBy(asc(eventsTable.version));
      return filter?.limit === undefined ? query : query.limit(filter.limit);
    },

    highestVersion: async (kind, entityId) => {
      const [row] = await db
        .select({ version: max(eventsTable.version) })
        .from(eventsTable)
        .where(and(eq(eventsTable.kind, kind), eq(eventsTable.entityId, entityId)));
      return row?.version ?? 0;
    },

    all: {
      /**
       * Reads the top first, then only up to it. Every row at or below that top was written by a
       * transaction that had ended, so `next` can move to the top without skipping one.
       */
      after: async (position, filter) => {
        const from = position === null ? null : ensure(position, PostgresPosition);
        const last = await top();
        if (last === null) return { events: [], next: position };
        const rows = await db
          .select({ ...storedColumns, xid: eventsTable.transactionId })
          .from(eventsTable)
          .where(
            and(
              from === null ? undefined : sql`${order} > (${from.xid}::xid8, ${from.seq})`,
              sql`${order} <= (${last.xid}::xid8, ${last.seq})`,
              filter.kinds === undefined ? undefined : inArray(eventsTable.kind, [...filter.kinds]),
              filter.types === undefined ? undefined : inArray(eventsTable.type, [...filter.types]),
            ),
          )
          .orderBy(asc(eventsTable.transactionId), asc(eventsTable.seq))
          .limit(filter.limit);
        const events = rows.map(({ xid, ...event }) => ({ ...event, position: positionOf({ xid, seq: event.seq }) }));
        const end = rows.at(-1);
        const next = end !== undefined && rows.length === filter.limit ? positionOf(end) : positionOf(last);
        return { events, next };
      },
      top: async () => {
        const last = await top();
        return last === null ? null : positionOf(last);
      },
    },

    append: batch => {
      if (batch.events.length === 0) return Promise.resolve();
      // The conflict path runs more than one statement, so it gets its own transaction here.
      return is(db, PgAsyncTransaction) ? appendOn(db, batch) : db.transaction(tx => appendOn(tx, batch));
    },

    erase: async (at, patch) => {
      const [stamped] = await db
        .update(eventsTable)
        .set({
          data: patch.data,
          schemaVersion: patch.schemaVersion,
          erasedAt: sql`coalesce(${eventsTable.erasedAt}, now())`,
        })
        .where(
          and(
            eq(eventsTable.kind, at.kind),
            eq(eventsTable.entityId, at.entityId),
            eq(eventsTable.version, at.version),
          ),
        )
        .returning({ erasedAt: eventsTable.erasedAt });
      if (stamped === undefined || stamped.erasedAt === null)
        throw new Error(`journal: erase: ${at.kind} ${at.entityId} has no event at version ${at.version}`);
      return { erasedAt: stamped.erasedAt };
    },
  };
}
