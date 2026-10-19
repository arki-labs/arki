/**
 * The Postgres receipt store, on `@arki/journal` (preferred for DOT apps that
 * already run a journal). Every claim and settle is a journal event, so the
 * receipt has a history: `ForemanReceiptClaimed`, then `ForemanReceiptSettled`.
 *
 * ```ts
 * // schema.ts
 * export const { receipts: foremanReceipts } = foremanReceiptTables();
 * // boot
 * const receipts = journalReceiptStore({ j, journal, db, tables: { receipts: foremanReceipts }, meta: { actorId: 'foreman' } });
 * ```
 *
 * The claim commits in its own transaction before the action runs, and the
 * settle commits before the response is sent. An action whose own writes
 * commit and then crash before the settle leaves the receipt `pending`, which
 * Foreman reads as "unknown" — never as "not applied".
 *
 * `@arki/admin` is an optional peer: only the `@arki/journal/foreman` entry needs it.
 */
import { integer, jsonb, pgTable, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { ReceiptClaimResult, ReceiptStore, StoredReceipt } from '@arki/admin/receipts';
import type { SchemaInput, StandardSchemaV1 } from '@arki/schema';
import { ADMIN_ERROR_CODES, AdminError } from '@arki/admin/module';
import { pendingReceiptSchema, settledReceiptSchema, storedReceiptSchema } from '@arki/admin/receipts';
import { orThrow } from '@arki/failure';

import type { Journal, JournalDefinitions, RootDb, TransactionSource } from '../index.js';
import { isJournalError } from '../index.js';

/**
 * The receipts table, shaped for a journal entity (string `id`, `version`).
 * Add it to the app's schema and migrate. `name` defaults to `foreman_receipts`.
 */
export function foremanReceiptTables(name = 'foreman_receipts') {
  return {
    receipts: pgTable(name, {
      /** The execution id. */
      id: varchar('id', { length: 128 }).primaryKey(),
      receipt: jsonb('receipt').$type<StoredReceipt>().notNull(),
      version: integer('version').notNull().default(0),
    }),
  };
}

export type ForemanReceiptTables = ReturnType<typeof foremanReceiptTables>;

export type JournalReceiptStoreOptions<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = {
  /** The app's journal definitions (`initJournal(...)`). */
  j: JournalDefinitions<Meta, Tx, AppDb>;
  /** The app's composed journal. */
  journal: Journal<Meta, Tx, AppDb>;
  /** The root database. Each claim and settle commits on its own. */
  db: TransactionSource<Tx>;
  tables: ForemanReceiptTables;
  /** The metadata every receipt event records, e.g. `{ actorId: 'foreman' }`. */
  meta: SchemaInput<Meta>;
};

/** A receipt store on `@arki/journal`. Call it once at boot: it defines the `foreman_receipt` entity. */
export function journalReceiptStore<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(options: JournalReceiptStoreOptions<Meta, Tx, AppDb>): ReceiptStore {
  const { j, journal, db, tables, meta } = options;

  const ReceiptClaimed = j.event('ForemanReceiptClaimed', z.object({ receipt: pendingReceiptSchema }));
  const ReceiptSettled = j.event('ForemanReceiptSettled', z.object({ receipt: settledReceiptSchema }));
  const receipt = j
    .entity('foreman_receipt', tables.receipts)
    .create(ReceiptClaimed, e => ({ receipt: e.data.receipt }))
    .on(ReceiptSettled, (_row, e) => ({ receipt: e.data.receipt }));

  const claimCommand = j.command(
    'foreman.receipts.claim',
    z.object({ receipt: pendingReceiptSchema }),
    async (input, { write }): Promise<ReceiptClaimResult> => {
      const { row, events } = orThrow(
        await write(receipt, input.receipt.executionId, held =>
          held === null ? [ReceiptClaimed({ receipt: input.receipt })] : [],
        ),
      );
      return events.length > 0 ? { claimed: true } : { claimed: false, receipt: parseStored(row?.receipt) };
    },
  );

  const settleCommand = j.command(
    'foreman.receipts.settle',
    z.object({ receipt: settledReceiptSchema }),
    async (input, { write }): Promise<void> => {
      orThrow(
        await write(receipt, input.receipt.executionId, held => {
          // Only the claimer settles, once. Anything else is a bug worth seeing.
          if (held?.receipt.status !== 'pending') {
            throw new AdminError(
              ADMIN_ERROR_CODES.handlerFailed,
              `Execution ${input.receipt.executionId} has no pending receipt to settle.`,
              'Receipts are settled only by the dispatcher that claimed them.',
            );
          }
          return [ReceiptSettled({ receipt: input.receipt })];
        }),
      );
    },
  );

  const get = async (executionId: string): Promise<StoredReceipt | undefined> => {
    const { row } = orThrow(await journal.replay(db, receipt, executionId));
    return parseStored(row?.receipt);
  };

  return {
    async claim(pending) {
      try {
        return orThrow(await journal.run(db, claimCommand, { receipt: pending }, meta));
      } catch (error) {
        // Two claims raced to create the row: the loser sees the winner's receipt.
        if (isJournalError(error, 'CONFLICT')) return { claimed: false, receipt: await get(pending.executionId) };
        throw error;
      }
    },
    async settle(settled) {
      orThrow(await journal.run(db, settleCommand, { receipt: settled }, meta));
    },
    get,
  };
}

function parseStored(value: unknown): StoredReceipt | undefined {
  if (value === undefined || value === null) return undefined;
  return storedReceiptSchema.parse(value);
}
