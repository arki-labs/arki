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
import { z } from '@arki/contracts';
import { now } from '@arki/date';
import { invariant, isFailure } from '@arki/failure';
import { is, parse } from '@arki/schema';

import type { CoreTables } from './tables.js';
import type { FailureOf, SchemaFailure } from '@arki/failure';
import type { NewWebhookEvent, WebhookEvent, WebhookId } from './types.js';
import { paymentProviderValues, webhookEventTypeValues } from './primitives.js';
import { INT4_MAX, isPgInstant, pgInstantSchema, pgJsonRecordSchema, pgTextSchema, pgVarcharSchema } from './pg-values.js';
import { CounterExhausted } from './failures.js';
import { WebhookClaimConflict } from './services/webhook-failures.js';

/**
 * The values of a new event row that a column can refuse: the ids and text past their length or
 * holding U+0000, U+0000 or a bigint in `data`, a count past the integer range, a time outside the
 * years 1 to 9999. The enum columns take only their enum values.
 */
const claimableEventSchema = z.looseObject({
  id: pgTextSchema.optional(),
  provider: z.enum(paymentProviderValues),
  eventType: z.enum(webhookEventTypeValues),
  providerEventId: pgVarcharSchema(255).min(1),
  data: pgJsonRecordSchema,
  attempts: z.number().int().min(0).max(INT4_MAX).optional(),
  errorMessage: pgTextSchema.nullish(),
  sourceIp: pgVarcharSchema(45).nullish(),
  processedAt: pgInstantSchema().nullish(),
  lastAttemptAt: pgInstantSchema().nullish(),
  createdAt: pgInstantSchema().optional(),
  updatedAt: pgInstantSchema().optional(),
});

/** A claimed webhook event: its row, and whether this caller's insert created it. */
export type WebhookClaim = { event: WebhookEvent; created: boolean };

/** The parts of a Drizzle Postgres database (or transaction) the claims use. */
export type WebhookClaimDb = Pick<PgAsyncDatabase<PgQueryResultHKT, AnyRelations>, 'insert' | 'select' | 'update'>;

/**
 * Insert the event, or return the row that already holds its `providerEventId`.
 * `created` is true only for the caller whose insert won, so exactly one
 * delivery processes a new event, even when copies arrive at the same time.
 *
 * `onConflictDoNothing()` takes no target on purpose: it covers the unique
 * index on `provider_event_id` and the primary key alike.
 *
 * Returns `WebhookClaimConflict` (retryable) when the insert conflicted but no
 * row holds the event's `providerEventId`, and `InvalidInput` (`schema.invalid_input`) before any
 * query when a value does not fit its column (see `claimableEventSchema`).
 */
export async function claimWebhookEvent(
  db: WebhookClaimDb,
  table: CoreTables['webhookEvents'],
  data: NewWebhookEvent,
): Promise<WebhookClaim | FailureOf<typeof WebhookClaimConflict> | SchemaFailure> {
  const checked = parse(claimableEventSchema, data);
  if (isFailure(checked)) return checked;

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
    // The insert conflicted on the primary key (a webhook id collision), or the winning row was
    // deleted between the two queries. A resend claims the event again with a new id.
    return WebhookClaimConflict({ providerEventId: data.providerEventId, retryable: true });
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
 *
 * Preconditions (anything else throws an invariant failure): `seenAttempts` is the whole `attempts`
 * value read from the row, and `leaseCutoff` falls in the years 1 to 9999. An `id` no row can hold
 * (U+0000) takes nothing over: false, with no query. A row the takeover would match whose `attempts`
 * already holds `INT4_MAX` cannot count one more: `CounterExhausted` (`payments.counter_exhausted`),
 * and nothing is written.
 */
export async function reclaimWebhookEvent(
  db: WebhookClaimDb,
  table: CoreTables['webhookEvents'],
  id: WebhookId,
  seenAttempts: number,
  leaseCutoff: Instant,
): Promise<boolean | FailureOf<typeof CounterExhausted>> {
  invariant(
    Number.isInteger(seenAttempts) && seenAttempts >= 0 && seenAttempts <= INT4_MAX,
    '[@arki/payments] seenAttempts must be the attempts value read from the row',
  );
  invariant(isPgInstant(leaseCutoff), '[@arki/payments] leaseCutoff must fall in the years 1 to 9999');
  if (!is(id, pgTextSchema)) return false;
  const takeover = and(
    eq(table.id, id),
    eq(table.processed, false),
    eq(table.attempts, seenAttempts),
    or(isNotNull(table.errorMessage), isNull(table.lastAttemptAt), lt(table.lastAttemptAt, leaseCutoff)),
  );
  if (seenAttempts === INT4_MAX) {
    // The update would match only a row whose count is full, and the column cannot hold one more
    const [full] = await db.select({ id: table.id }).from(table).where(takeover);
    return full ? CounterExhausted({ counter: 'attempts', id }) : false;
  }
  const attemptAt = now();
  const won = await db
    .update(table)
    .set({
      attempts: sql`${table.attempts} + 1`,
      lastAttemptAt: attemptAt,
      errorMessage: null,
      updatedAt: attemptAt,
    })
    // `attempts = seenAttempts`, below INT4_MAX, guards the increment in the update itself
    .where(takeover)
    .returning({ id: table.id });

  return won.length > 0;
}
