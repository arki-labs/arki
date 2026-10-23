/**
 * The journal's Postgres storage, split by concern: entity rows, the event log, receipts,
 * effect jobs and the wake signal. `bind(db)` gives every part on one handle, so a write
 * reads its own uncommitted changes. Each part turns a unique violation into the journal's
 * `CONFLICT` itself, so callers never see a driver error for a lost race.
 * May import `storage` and leaf files. Must not import `journal`, `api`, `write`,
 * `command`, `history` or `worker`.
 */
import type { PgInsertValue, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { and, asc, eq, max, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';

import { isUniqueViolation } from '@arki/db/errors';

import type { JournalTables } from './pg.js';
import type { AnyEntity, AnyEventDef, DbHandle, EntityDef, EntityId, EntityTable, ReducerRow, Row } from './types.js';
import { JournalError } from './errors.js';
import { isRowOf } from './storage.js';

/**
 * The append lock: `pg_advisory_xact_lock(namespace, key)`, taken at the start of
 * every write and held until the transaction commits. `seq` is a bigserial, assigned
 * at insert, so without it two transactions can commit in the other order: a reader
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

    const events = {
      /** See `APPEND_LOCK_NAMESPACE`. Re-entrant inside one transaction, so nested commands take it once. */
      takeAppendLock: async (): Promise<void> => {
        await db.execute(sql`select pg_advisory_xact_lock(${APPEND_LOCK_NAMESPACE}::int, ${APPEND_LOCK_KEY}::int)`);
      },

      /**
       * Append one entity's events. A unique violation is `CONFLICT`: another writer appended the
       * first version first, or the row is behind its history.
       */
      append: (
        entity: Pick<AnyEntity, 'kind'>,
        id: string,
        appended: readonly JournalTables['events']['$inferInsert'][],
      ) =>
        db
          .insert(eventsTable)
          .values([...appended])
          .returning()
          .catch((error: unknown) => {
            if (isUniqueViolation(error))
              throw new JournalError(
                'CONFLICT',
                entity.kind,
                id,
                `version ${appended[0]?.version ?? 0} is already in the log: another writer appended it first, or the row is behind its history`,
                { cause: error },
              );
            throw error;
          }),

      /**
       * The stamps a transient entity's events get instead of a log row: `seq` from the events table's
       * own sequence and `recordedAt` from the transaction's `now()`, in one round trip, decoded by the
       * columns themselves. The seq is spent without a row, so it stays the global write order;
       * `causeSeq` has no foreign key, so a seq with no row is safe to point at.
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

      highestVersion: async (kind: string, id: string): Promise<number> => {
        const [top] = await db
          .select({ version: max(eventsTable.version) })
          .from(eventsTable)
          .where(and(eq(eventsTable.kind, kind), eq(eventsTable.entityId, id)));
        return top?.version ?? 0;
      },

      /** One entity's whole log, oldest first. */
      history: (kind: string, id: string) =>
        db
          .select()
          .from(eventsTable)
          .where(and(eq(eventsTable.kind, kind), eq(eventsTable.entityId, id)))
          .orderBy(asc(eventsTable.version)),
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

    return { rows: { ...rows, saveReplayed }, events, receipts, jobs, wake };
  };

  return { bind };
}

/** The journal's storage. Built once per journal from its tables. */
export type PgStore = ReturnType<typeof createPgStore>;
