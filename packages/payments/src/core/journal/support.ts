/**
 * Shared pieces of the payments journal
 *
 * Used by the payment, subscription and refund entities and their commands.
 * Plain TypeScript only: this file runs on Node, Bun, Deno, browsers and Hermes.
 */

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';

import type { Instant } from '@arki/date';
import type { IdGenerationFailure } from '@arki/contracts';
import type { Failure, SchemaFailure } from '@arki/failure';
import type { CommandFailure, DbHandle } from '@arki/journal';
import { z } from '@arki/contracts';
import { instantSchema } from '@arki/date/zod';
import { invariant, isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import { holdsLoneSurrogate, MAX_BATCH_ITEMS, pgTextSchema } from '../pg-values.js';

/**
 * Text a journal event carries. Event data is stored in a jsonb column, which refuses U+0000
 * (SQLSTATE 22P05) and a lone surrogate such as `'\ud800'` (22P02); a `text` column refuses only
 * U+0000. A command input schema builds its text fields and stream ids from this, so such a value is
 * `schema.invalid_input` before any write.
 */
export const eventTextSchema = pgTextSchema.refine(
  text => !holdsLoneSurrogate(text),
  'Text cannot contain a lone surrogate (such as U+D800 alone)',
);

/** Event text with at most `max` characters, for a value that also fills a `varchar(max)` column. */
export function eventVarcharSchema(max: number) {
  return eventTextSchema.max(max);
}

/** Event data is stored as JSON, so a time travels as an ISO string. */
export function toIso(value: Instant): string {
  return value.toString();
}

/**
 * The `Instant` an `instant` column stores, from a time in event data. Reducers call it on fields the
 * event schema already checked (`z.iso.datetime()`), so the precondition is: `iso` is an ISO 8601
 * timestamp with `Z` or an offset. Anything else is a caller bug and throws an invariant failure
 * (`ARKI_FAILURE_E008`), never a raw `RangeError`.
 */
export function toInstant(iso: string): Instant {
  const parsed = instantSchema().safeParse(iso);
  invariant(parsed.success, () => `toInstant: ${JSON.stringify(iso)} is not an ISO 8601 timestamp with Z or an offset`);
  return parsed.data;
}

/**
 * `toInstant` for a nullable field: `null` stays `null`. Same precondition: a string is an ISO 8601
 * timestamp with `Z` or an offset, as the subscription event schemas guarantee; anything else throws
 * an invariant failure (`ARKI_FAILURE_E008`).
 */
export function toNullableInstant(iso: string | null): Instant | null {
  return iso === null ? null : toInstant(iso);
}

/**
 * The number a `real` column gives back for `value`.
 *
 * A `real` is a 4-byte float. Postgres rounds the value to the nearest 4-byte
 * float and prints the shortest decimal that names that float. A reducer must
 * return this number, not the one it was given, or the journal rejects the
 * write with `VALUE_MISMATCH`. Example: 19.99 stays 19.99, but 1234567.89
 * comes back as 1234567.9, because a 4-byte float keeps about 7 digits.
 */
export function storedReal(value: number): number {
  const stored = Math.fround(value);

  for (let digits = 1; digits <= 9; digits += 1) {
    const candidate = Number(stored.toPrecision(digits));

    if (Math.fround(candidate) === stored) {
      return candidate;
    }
  }

  return stored;
}

/** Any array, as `sameJson` compares one item by item (A-39: a schema, not a hand-written guard). */
const jsonArraySchema = z.array(z.unknown());

/**
 * Deep equality for JSON values. Key order does not matter: a `jsonb` column
 * returns object keys in its own order. A key holding `undefined` equals a
 * missing key, as in JSON.
 */
export function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (is(left, jsonArraySchema) && is(right, jsonArraySchema)) {
    return left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  }

  if (is(left, recordSchema) && is(right, recordSchema)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

    return [...keys].every(key => sameJson(left[key], right[key]));
  }

  return false;
}

/**
 * What a write function returns besides the row and its command's own refusals: the
 * command runner's failures (`CommandFailure`), a failed id and a schema failure.
 */
export type JournalWriteFailure = CommandFailure | IdGenerationFailure | SchemaFailure;

/**
 * The row a command hands back to a service, or the failure the command
 * returned when a rule said no. `version` is a storage detail of the journal,
 * so it never leaves the package's write functions.
 */
export function writtenRow<Row extends { version: number }>(
  result: Promise<{ readonly row: Row | null }>,
  what: string,
): Promise<Omit<Row, 'version'>>;
export function writtenRow<Row extends { version: number }, Refusal extends Failure>(
  result: Promise<{ readonly row: Row | null } | Refusal>,
  what: string,
): Promise<Omit<Row, 'version'> | Refusal>;
export async function writtenRow(
  result: Promise<{ readonly row: { version: number } | null } | Failure>,
  what: string,
): Promise<object> {
  const written = await result;
  if (isFailure(written)) return written;

  const { row } = written;
  invariant(row, () => `[@arki/payments] ${what}: the journal returned no row`);

  const { version, ...rest } = row;
  void version;

  return rest;
}

/** One foreign key a write sets: its column, the value written there, and the failure when no row has that value. */
export type RowReference<Missing> = {
  readonly column: PgColumn;
  readonly value: string | null | undefined;
  readonly missing: () => Missing;
};

/**
 * Looks up the row each reference points at, in the table the column's foreign key names, and locks
 * it (`FOR KEY SHARE`) until the transaction ends, so the write that follows cannot meet a missing or
 * just-deleted row (a raw Postgres 23503). Returns the first `missing()` for a value no row holds, or
 * `undefined` when every row is there. A value Postgres cannot store (U+0000) is held by no row, so it
 * returns its `missing()` without a query (the lookup would fail with a raw 22021); so does a value with a
 * lone surrogate, which no row holds as given (the driver writes U+FFFD in its place). A `null` or
 * `undefined` value names nothing to check. Run it in the transaction that writes.
 *
 * Precondition: at most `MAX_BATCH_ITEMS` (1,000) references; more breaks an `invariant`
 * (`ARKI_FAILURE_E008`) before any query. Callers pass a fixed handful (one per foreign key they write).
 */
export async function lockReferences<Missing>(
  db: Pick<DbHandle, 'select'>,
  table: PgTable,
  references: readonly RowReference<Missing>[],
): Promise<Missing | undefined> {
  invariant(
    references.length <= MAX_BATCH_ITEMS,
    () => `[@arki/payments] lockReferences takes at most ${MAX_BATCH_ITEMS} references`,
  );
  const keys = getTableConfig(table).foreignKeys.map(key => key.reference());
  for (const { column, value, missing } of references) {
    if (value === null || value === undefined) continue;
    if (!is(value, eventTextSchema)) return missing();
    const key = keys.find(candidate => candidate.columns[0] === column);
    const target = key?.foreignColumns[0];
    invariant(key && target, () => `[@arki/payments] ${column.name} has no foreign key to look the row up by`);
    const [found] = await db
      .select({ found: sql`1` })
      .from(key.foreignTable)
      .where(eq(target, value))
      .for('key share');
    if (!found) return missing();
  }
  return undefined;
}
