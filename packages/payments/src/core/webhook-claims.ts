/**
 * Webhook event claims
 *
 * The two queries that decide which delivery of a webhook event may process
 * it. They take any Drizzle Postgres database, so the package tests run the
 * same SQL on PGlite that `PaymentRepository` runs on node-postgres.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import type { Instant } from '@arki/date';
import { now } from '@arki/date';

import type { CoreTables } from './tables.js';
import type { NewWebhookEvent, WebhookEvent, WebhookId } from './types.js';

/** The parts of a Drizzle Postgres database (or transaction) the claims use. */
export type WebhookClaimDb = Pick<PgAsyncDatabase<PgQueryResultHKT, AnyRelations>, 'insert' | 'select' | 'update'>;

/**
 * Insert the event, or return the row that already holds its `providerEventId`.
 * `created` is true only for the caller whose insert won, so exactly one
 * delivery processes a new event, even when copies arrive at the same time.
 *
 * `onConflictDoNothing()` takes no target on purpose: it covers the unique
 * index on `provider_event_id` and the primary key alike.
 */
export async function claimWebhookEvent(
  db: WebhookClaimDb,
  table: CoreTables['webhookEvents'],
  data: NewWebhookEvent,
): Promise<{ event: WebhookEvent; created: boolean }> {
  const [inserted] = await db.insert(table).values(data).onConflictDoNothing().returning();
  if (inserted) {
    return { event: inserted, created: true };
  }

  // The unique index is on `provider_event_id` alone, so the row that won is
  // found by that id alone. Trade-off: if two providers ever sent the same
  // event id, the second provider's event would be treated as a copy of the
  // first and never processed. Event ids are provider-prefixed (`evt_...` for
  // Stripe), so this is accepted rather than paying for a composite index.
  const [existing] = await db.select().from(table).where(eq(table.providerEventId, data.providerEventId));
  if (!existing) {
    throw new Error('Failed to claim webhook event');
  }
  return { event: existing, created: false };
}

/**
 * Take over an unprocessed event for one more attempt. True only for the one
 * caller whose update matched.
 *
 * An event can be taken over when its last attempt failed (`error_message` is
 * set) or when that attempt started before `leaseCutoff` and never finished (a
 * crashed process). An attempt still inside its lease is left alone.
 *
 * `seenAttempts` is the `attempts` value the caller read. It makes two callers
 * that read the same row race on one update: the first raises `attempts`, so
 * the second matches nothing. `attempts` is the token rather than
 * `last_attempt_at` because two attempts can start within one clock tick (or
 * on servers whose clocks disagree), and a counter cannot repeat.
 */
export async function reclaimWebhookEvent(
  db: WebhookClaimDb,
  table: CoreTables['webhookEvents'],
  id: WebhookId,
  seenAttempts: number,
  leaseCutoff: Instant,
): Promise<boolean> {
  const attemptAt = now();
  const won = await db
    .update(table)
    .set({
      attempts: sql`${table.attempts} + 1`,
      lastAttemptAt: attemptAt,
      errorMessage: null,
      updatedAt: attemptAt,
    })
    .where(
      and(
        eq(table.id, id),
        eq(table.processed, false),
        eq(table.attempts, seenAttempts),
        or(isNotNull(table.errorMessage), isNull(table.lastAttemptAt), lt(table.lastAttemptAt, leaseCutoff)),
      ),
    )
    .returning({ id: table.id });

  return won.length > 0;
}
