/**
 * Shared fixture for the package tests
 *
 * An in-memory PGlite with the payments tables, the refunds table and the two
 * journal tables, plus one user, one plan and one customer to point at.
 *
 * Two journals over the same tables: `plain` is built from the untyped
 * `initJournal({ meta })`, `typed` from the form an app uses,
 * `initJournal.tx<AppTx>().db<AppDb>().create({ meta })`. Both must be
 * accepted by the package's factories.
 */
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { and, asc, count, eq } from 'drizzle-orm';
import { pgSchema, varchar } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { z } from 'zod';

import type { UserId } from './core/user-id.js';
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';

import { createCoreJournal } from './core/journal.js';
import { createCustomerId, createPlanId } from './core/primitives.js';
import { createCoreTables } from './core/tables.js';
import { createRefundsJournal } from './refunds/journal.js';
import { createRefundsTables } from './refunds/tables.js';

export const schema = pgSchema('pay');

export const users = schema.table('users', { id: varchar('id', { length: 256 }).primaryKey() });

export const core = createCoreTables({ schema, userIdRef: () => users.id });
export const refundsTables = createRefundsTables({
  schema,
  paymentIdRef: () => core.payments.id,
  userIdRef: () => users.id,
});
export const journalTablesInSchema = journalTables(schema);

export const userId: UserId = 'usr_buyer';
export const adminId: UserId = 'usr_admin';
export const planId = createPlanId();
export const customerId = createCustomerId();

export const metaSchema = z.object({ actorId: z.string().min(1) });
export const meta = { actorId: 'usr_test' };

const plainDefinitions = initJournal({ meta: metaSchema });

export const plain = {
  j: plainDefinitions,
  core: createCoreJournal(plainDefinitions, core),
  refunds: createRefundsJournal(plainDefinitions, { refunds: refundsTables.refunds, payments: core.payments }),
  journal: plainDefinitions.compose({ tables: journalTablesInSchema }),
};

export type AppDb = PgliteDatabase;
export type AppTx = Parameters<Parameters<AppDb['transaction']>[0]>[0];

const typedDefinitions = initJournal.tx<AppTx>().db<AppDb>().create({ meta: metaSchema });

export const typed = {
  j: typedDefinitions,
  core: createCoreJournal(typedDefinitions, core),
  refunds: createRefundsJournal(typedDefinitions, { refunds: refundsTables.refunds, payments: core.payments }),
  journal: typedDefinitions.compose({ tables: journalTablesInSchema }),
};

/** `extra`: more tables or enums of the same schema, pushed in the same call (a second push would drop these). */
export async function openDb(extra: Record<string, unknown> = {}) {
  const client = new PGlite('memory://');
  await client.waitReady;
  const db = drizzle({ client });
  const { apply } = await pushSchema(
    {
      schema,
      users,
      ...core.enums,
      plans: core.plans,
      customers: core.customers,
      subscriptions: core.subscriptions,
      payments: core.payments,
      webhookEvents: core.webhookEvents,
      ...refundsTables.enums,
      refunds: refundsTables.refunds,
      ...journalTablesInSchema,
      ...extra,
    },
    db,
  );
  await apply();

  await db.insert(users).values([{ id: userId }, { id: adminId }]);
  await db.insert(core.plans).values({ id: planId, name: 'Pro', priceMinor: 1000 });
  await db
    .insert(core.customers)
    .values({ id: customerId, userId, providerCustomerId: 'cus_test', email: 'buyer@example.com' });

  return { db, client };
}

/** The event types written for one entity, oldest first. */
export async function eventTypesOf(db: AppDb, kind: string, entityId: string): Promise<string[]> {
  const { events } = journalTablesInSchema;
  const rows = await db
    .select({ type: events.type })
    .from(events)
    .where(and(eq(events.kind, kind), eq(events.entityId, entityId)))
    .orderBy(asc(events.version));

  return rows.map(row => row.type);
}

/** How many events the journal holds. A rejected or repeated command must leave it unchanged. */
export async function countEvents(db: AppDb): Promise<number> {
  const [row] = await db.select({ total: count() }).from(journalTablesInSchema.events);

  return row?.total ?? 0;
}

/** The error a promise rejects with. Fails the test when the promise resolves. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected the command to be rejected, but it wrote');
}
