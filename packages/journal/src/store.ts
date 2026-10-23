/**
 * The journal's Postgres storage, split by concern: entity rows, the write order (append lock
 * and seq), receipts, effect jobs and the wake signal; and the built-in event log. `bind(db)` gives every part on one handle, so a write
 * reads its own uncommitted changes. Each part turns a unique violation into the journal's
 * `CONFLICT` itself, so callers never see a driver error for a lost race.
 * May import `storage` and leaf files. Must not import `journal`, `api`, `write`,
 * `command`, `history` or `worker`.
 */
import type { PgInsertValue, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { and, asc, eq, gt, gte, inArray, is, lte, max, sql } from 'drizzle-orm';
import { getTableConfig, PgAsyncTransaction } from 'drizzle-orm/pg-core';

import { isUniqueViolation } from '@arki/db/errors';
import { ensure } from '@arki/schema';

import type { EventLog, EventLogReads, EventLogWrites } from './event-log.js';
import type { JournalTables } from './pg.js';
import type { AnyEntity, AnyEventDef, DbHandle, EntityDef, EntityId, EntityTable, ReducerRow, Row } from './types.js';
import { JournalError } from './errors.js';
import { EventLogPosition } from './event-log.js';
import { isRowOf } from './storage.js';

/**
 * The append lock: `pg_advisory_xact_lock(namespace, key)`, taken at the start of
 * every write and held until the transaction commits. `seq` comes from a sequence, taken
 * during the write, so without it two transactions can commit in the other order: a reader
 * that checkpointed at the later seq never sees the earlier one. With it, seq order is
 * commit order, and `seq > cursor` is a safe cursor. Cost: event appends across the
 * app commit one transaction at a time. The namespace is 'JRNL' as an int (0x4a524e4c).
 */
const APPEND_LOCK_NAMESPACE = 1_247_301_196;
const APPEND_LOCK_KEY = 1;

type EntityRowSource = Pick<AnyEntity, 'table' | 'keyColumn'>;

export function createPgStore(deps: { readonly tables: JournalTables; readonly wakeChannel: string }) {
  const { events: eventsTable, jobs: jobsTable, receipts: receiptsTable } = deps.tables;
  const eventsTableConfig = getTableConfig(eventsTable);
  const eventsTableName =
    eventsTableConfig.schema === undefined
      ? `"${eventsTableConfig.name}"`
      : `"${eventsTableConfig.schema}"."${eventsTableConfig.name}"`;

  const bind = (db: DbHandle) => {
    const rows = {
      load: async (entity: EntityRowSource, id: string, lock: boolean): Promise<object | null> => {
        const query = db.select().from(entity.table).where(eq(entity.keyColumn, id)).limit(1);
        const found = lock ? await query.for('update') : await query;
        return found[0] ?? null;
      },

      /** A unique violation is `CONFLICT`: two creates of one id raced, or a column value is already taken. */
      insert: async <Tbl extends EntityTable, Key extends string>(
        entity: EntityDef<string, Tbl, AnyEventDef, unknown, Key>,
        id: EntityId<Tbl, Key>,
        values: ReducerRow<Tbl, Key>,
      ): Promise<Row<Tbl>> => {
        const erased: EntityTable = entity.table;
        const saved = await db
          .insert(erased)
          .values(values)
          .returning()
          .catch((error: unknown) => {
            if (isUniqueViolation(error))
              throw new JournalError(
                'CONFLICT',
                entity.kind,
                id,
                'the row insert hit a unique constraint: another writer created this row first, or a column value is already taken',
                { cause: error },
              );
            throw error;
          });
        const row = saved[0];
        if (row === undefined || !isRowOf(entity.table, row)) {
          throw new Error(`journal: saving ${id} returned no complete row`);
        }
        return row;
      },

      /**
       * Set `values` on the row. With `atVersion`, only while the row is still at that version:
       * `undefined` means it moved. Without it, the caller holds the row lock.
       */
      update: async <Tbl extends EntityTable, Key extends string>(
        entity: EntityDef<string, Tbl, AnyEventDef, unknown, Key>,
        id: EntityId<Tbl, Key>,
        values: PgUpdateSetSource<EntityTable>,
        atVersion?: number,
      ): Promise<Row<Tbl> | undefined> => {
        const erased: EntityTable = entity.table;
        const where =
          atVersion === undefined
            ? eq(entity.keyColumn, id)
            : and(eq(entity.keyColumn, id), eq(erased.version, atVersion));
        const updated = await db.update(erased).set(values).where(where).returning();
        const row = updated[0];
        if (row === undefined) return undefined;
        if (!isRowOf(entity.table, row)) throw new Error(`journal: ${entity.kind} ${id} update returned a partial row`);
        return row;
      },

      /** Delete the row. With `atVersion`, only while the row is still at that version. False when nothing was deleted. */
      remove: async (
        entity: Pick<AnyEntity, 'kind' | 'table' | 'keyColumn'>,
        id: string,
        atVersion?: number,
      ): Promise<boolean> => {
        const erased: EntityTable = entity.table;
        const where =
          atVersion === undefined
            ? eq(entity.keyColumn, id)
            : and(eq(entity.keyColumn, id), eq(erased.version, atVersion));
        const deleted = await db.delete(erased).where(where).returning({ version: erased.version });
        return deleted.length > 0;
      },
    };

    /** The app database's write order: the append lock, and the `seq` and `recordedAt` every event gets. */
    const seq = {
      /** See `APPEND_LOCK_NAMESPACE`. Re-entrant inside one transaction, so nested commands take it once. */
      lock: async (): Promise<void> => {
        await db.execute(sql`select pg_advisory_xact_lock(${APPEND_LOCK_NAMESPACE}::int, ${APPEND_LOCK_KEY}::int)`);
      },

      /**
       * `count` stamps: `seq` from the events table's own sequence and `recordedAt` from the
       * transaction's `now()`, in one round trip, decoded by the columns themselves. Taken under the
       * lock, before any append, so seq order is commit order in both modes. A transient event's seq
       * is spent without a row; `causeSeq` has no foreign key, so a seq with no row is safe to point at.
       */
      stamp: (count: number) =>
        db
          .select({
            seq: sql`nextval(pg_get_serial_sequence(${eventsTableName}, ${eventsTable.seq.name}))`.mapWith(
              eventsTable.seq,
            ),
            recordedAt: sql`now()`.mapWith(eventsTable.recordedAt),
          })
          .from(sql`generate_series(1, ${count}::int)`),
    };

    const receipts = {
      /**
       * Take the key, or find the receipt that holds it: `undefined` when this run took it. The
       * insert waits on an uncommitted holder, so a concurrent repeat sees its outcome.
       */
      claim: async (
        receipt: Pick<JournalTables['receipts']['$inferInsert'], 'key' | 'command' | 'input' | 'commandId'>,
      ) => {
        const inserted = await db
          .insert(receiptsTable)
          .values(receipt)
          .onConflictDoNothing()
          .returning({ key: receiptsTable.key });
        if (inserted.length > 0) return;
        const [held] = await db.select().from(receiptsTable).where(eq(receiptsTable.key, receipt.key));
        if (held === undefined)
          throw new Error(
            `journal: idempotency key ${JSON.stringify(receipt.key)} vanished while it was being claimed`,
          );
        return held;
      },

      settle: async (
        key: string,
        result: NonNullable<JournalTables['receipts']['$inferInsert']['result']>,
      ): Promise<void> => {
        await db.update(receiptsTable).set({ result }).where(eq(receiptsTable.key, key));
      },
    };

    const jobs = {
      enqueue: async (queued: readonly PgInsertValue<JournalTables['jobs']>[]): Promise<void> => {
        if (queued.length > 0) await db.insert(jobsTable).values([...queued]);
      },

      /** The last version a forward job of `stream` still carries, dead ones included. `null`: none pending. */
      pendingTop: async (stream: string): Promise<number | null> => {
        const [top] = await db
          .select({
            // -1 when the stream has no forward job: an aggregate over no rows is null, which `mapWith` would not see.
            version:
              sql`coalesce(max(${jobsTable.streamPosition} + jsonb_array_length(${jobsTable.args}->'events')), -1)`.mapWith(
                Number,
              ),
          })
          .from(jobsTable)
          .where(and(eq(jobsTable.kind, 'forward'), eq(jobsTable.stream, stream)));
        return top === undefined || top.version < 0 ? null : top.version;
      },
    };

    /**
     * Postgres delivers NOTIFY at commit, so every listening worker in every process hears
     * exactly the commits that happened, with the seq range to read. Never the events themselves.
     */
    const wake = async (range: { readonly from: number; readonly to: number }): Promise<void> => {
      await db.execute(sql`select pg_notify(${deps.wakeChannel}, ${JSON.stringify(range)})`);
    };

    /** Insert, update or delete the row so it matches `next`. Returns the stored row. The caller holds the row lock. */
    const saveReplayed = async <Tbl extends EntityTable, Key extends string>(
      entity: EntityDef<string, Tbl, AnyEventDef, unknown, Key>,
      id: EntityId<Tbl, Key>,
      current: object | null,
      next: ReducerRow<Tbl, Key> | null,
    ): Promise<Row<Tbl> | null> => {
      if (next === null) {
        if (current !== null) await rows.remove(entity, id);
        return null;
      }
      if (current === null) return rows.insert(entity, id, next);
      const updated = await rows.update(entity, id, next);
      if (updated === undefined) throw new Error(`journal: saving ${id} returned no complete row`);
      return updated;
    };

    return { rows: { ...rows, saveReplayed }, seq, receipts, jobs, wake };
  };

  return { bind };
}

/** The journal's storage. Built once per journal from its tables. */
export type PgStore = ReturnType<typeof createPgStore>;

/** The built-in log's position for a seq: the seq as text. */
const positionOf = (at: number): EventLogPosition => ensure(String(at), EventLogPosition);
/** Only positions the built-in log made reach it, so each is a seq written as text. */
const seqAt = (position: EventLogPosition | null): number => (position === null ? 0 : Number(position));

/**
 * The built-in event log: `journal_events`, in the app database. It joins the row's transaction,
 * keeps one global order (`seq`, as text positions) and rewrites events in place for `forget`.
 */
export function createBuiltInEventLog(deps: { readonly tables: Pick<JournalTables, 'events'> }) {
  const eventsTable = deps.tables.events;

  const topSeq = async (db: DbHandle): Promise<number | null> => {
    const [top] = await db.select({ seq: max(eventsTable.seq) }).from(eventsTable);
    return top?.seq ?? null;
  };

  /**
   * One statement inserts what is new. A short insert means some event was there already: the same
   * events (a repeat, a success) or a version another event holds (`CONFLICT`). Whatever this call
   * inserted is removed before it throws, so the append is all or nothing on its own.
   */
  const appendOn = async (db: DbHandle, batch: Parameters<EventLogWrites['append']>[0]): Promise<void> => {
    const { events } = batch;
    if (events.length === 0) return;
    const inserted = await db
      .insert(eventsTable)
      .values([...events])
      .onConflictDoNothing()
      .returning({ id: eventsTable.id, entityId: eventsTable.entityId });
    const undo = async () => {
      if (inserted.length > 0)
        await db.delete(eventsTable).where(
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
    const found = await db
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
      `version ${batch.expectedVersion + 1} is already in the log: another writer appended it first, or the row is behind its history`,
    );
  };

  const bind = (db: DbHandle) => {
    const log = {
      stream: (
        kind: string,
        entityId: string,
        filter?: { readonly types?: readonly string[]; readonly afterVersion?: number; readonly limit?: number },
      ) => {
        const query = db
          .select()
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

      highestVersion: async (kind: string, entityId: string): Promise<number> => {
        const [top] = await db
          .select({ version: max(eventsTable.version) })
          .from(eventsTable)
          .where(and(eq(eventsTable.kind, kind), eq(eventsTable.entityId, entityId)));
        return top?.version ?? 0;
      },

      all: {
        /**
         * Reads the top first, then only up to it. Seq order is commit order, so every event at or
         * below a committed top is visible: `next` can move to the top without skipping one.
         */
        after: async (
          position: EventLogPosition | null,
          filter: { readonly kinds?: readonly string[]; readonly types?: readonly string[]; readonly limit: number },
        ) => {
          const from = seqAt(position);
          const top = await topSeq(db);
          if (top === null || top <= from) return { events: [], next: position };
          const rows = await db
            .select()
            .from(eventsTable)
            .where(
              and(
                gt(eventsTable.seq, from),
                lte(eventsTable.seq, top),
                filter.kinds === undefined ? undefined : inArray(eventsTable.kind, [...filter.kinds]),
                filter.types === undefined ? undefined : inArray(eventsTable.type, [...filter.types]),
              ),
            )
            .orderBy(asc(eventsTable.seq))
            .limit(filter.limit);
          const last = rows.at(-1);
          const events = rows.map(row => ({ ...row, position: positionOf(row.seq) }));
          const next = last !== undefined && rows.length === filter.limit ? positionOf(last.seq) : positionOf(top);
          return { events, next };
        },
        top: async (): Promise<EventLogPosition | null> => {
          const top = await topSeq(db);
          return top === null ? null : positionOf(top);
        },
        distance: (from: EventLogPosition | null, to: EventLogPosition | null): number =>
          Math.max(0, seqAt(to) - seqAt(from)),
      },

      append: (batch: Parameters<EventLogWrites['append']>[0]): Promise<void> =>
        // Inside a transaction the one insert is atomic and a throw rolls the caller back. On the root
        // database the conflict path runs two statements, so it gets its own transaction.
        is(db, PgAsyncTransaction) ? appendOn(db, batch) : db.transaction(tx => appendOn(tx, batch)),

      erase: async (
        at: { readonly kind: string; readonly entityId: string; readonly version: number },
        patch: { readonly data: unknown; readonly schemaVersion: number },
      ): Promise<{ readonly erasedAt: Date }> => {
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

      /**
       * The committed events in one seq range that the wake signal announced. Taps read this, so
       * they follow the built-in log only.
       */
      seqRange: (
        range: { readonly from: number; readonly to: number },
        filter: { readonly kinds: readonly string[]; readonly types: readonly string[] },
      ) =>
        db
          .select()
          .from(eventsTable)
          .where(
            and(
              gte(eventsTable.seq, range.from),
              lte(eventsTable.seq, range.to),
              inArray(eventsTable.kind, [...filter.kinds]),
              inArray(eventsTable.type, [...filter.types]),
            ),
          )
          .orderBy(asc(eventsTable.seq)),
    } satisfies EventLogReads & EventLogWrites & { readonly seqRange: unknown };
    return log;
  };

  return { canJoinTransaction: true, bind } as const satisfies EventLog;
}

/** The built-in log, with the seq-range read only taps use. */
export type BuiltInEventLog = ReturnType<typeof createBuiltInEventLog>;
