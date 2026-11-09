import type { Instant } from '@arki/date';
import { z } from '@arki/contracts';
import { instantSchema } from '@arki/date/zod';

/**
 * Schemas for values Postgres can store. A contract builds its fields from these so that it refuses,
 * as `schema.invalid_input`, every value a column would refuse with a raw SQLSTATE error.
 */

/** Whether a key or a string anywhere in this JSON value holds U+0000. */
export function holdsNul(value: unknown): boolean {
  let found = false;
  JSON.stringify(value, (key: string, item: unknown) => {
    if (key.includes('\u0000') || (typeof item === 'string' && item.includes('\u0000'))) found = true;
    return item;
  });
  return found;
}

/** A UTF-16 surrogate with no partner: a high one not followed by a low one, or a low one not after a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Whether a key or a string anywhere in this JSON value holds a lone surrogate (such as `'\ud800'`).
 * `JSON.stringify` writes it as a `\ud800` escape, and a jsonb column refuses that escape with SQLSTATE
 * 22P02. A `text` column takes it (the driver writes the UTF-8 replacement character), so only JSON checks it.
 */
export function holdsLoneSurrogate(value: unknown): boolean {
  let found = false;
  JSON.stringify(value, (key: string, item: unknown) => {
    if (LONE_SURROGATE.test(key) || (typeof item === 'string' && LONE_SURROGATE.test(item))) found = true;
    return item;
  });
  return found;
}

/**
 * Text Postgres can store. A `text`, `varchar` or `jsonb` value cannot hold U+0000: Postgres refuses
 * it (SQLSTATE 22021, or 22P05 in jsonb).
 */
export const pgTextSchema = z
  .string()
  .refine(value => !value.includes('\u0000'), 'Text cannot contain the NUL character (U+0000)');

/** Text for a `varchar(max)` column: no U+0000, and at most `max` characters (more is SQLSTATE 22001). */
export function pgVarcharSchema(max: number) {
  return pgTextSchema.max(max);
}

/**
 * A JSON object stored in a jsonb column: no key or string anywhere in it may hold U+0000 (SQLSTATE
 * 22P05) or a lone surrogate (22P02), and no value may be a `bigint` (the driver throws on one).
 * `holdsBigInt` is declared below; the refine runs at parse time.
 */
export const pgJsonRecordSchema = z
  .record(pgTextSchema, z.unknown())
  .refine(value => !holdsBigInt(value), { message: 'JSON cannot contain a bigint', abort: true })
  .refine(value => !holdsNul(value), 'JSON cannot contain the NUL character (U+0000)')
  .refine(value => !holdsLoneSurrogate(value), 'JSON cannot contain a lone surrogate (such as U+D800 alone)');

/** Whether a `bigint` sits anywhere in this value: `JSON.stringify` throws on one, so no jsonb column can take it. */
export function holdsBigInt(value: unknown): boolean {
  let found = false;
  JSON.stringify(value, (_key: string, item: unknown) => {
    if (typeof item !== 'bigint') return item;
    found = true;
    return null;
  });
  return found;
}

/**
 * Any value stored in a jsonb column (an object, an array, a string, a number, a boolean, null). No
 * `bigint` anywhere in it (the driver throws on one), no U+0000 in any key or string (SQLSTATE 22P05),
 * and no lone surrogate in any key or string (22P02).
 */
export const pgJsonSchema = z
  .unknown()
  .refine(value => !holdsBigInt(value), { message: 'JSON cannot contain a bigint', abort: true })
  .refine(value => !holdsNul(value), 'JSON cannot contain the NUL character (U+0000)')
  .refine(value => !holdsLoneSurrogate(value), 'JSON cannot contain a lone surrogate (such as U+D800 alone)');

/** The largest value of a Postgres `integer` (int4) column, 2^31 - 1. A larger one is refused with SQLSTATE 22003. */
export const INT4_MAX = 2_147_483_647;

/** 0001-01-01T00:00:00Z: the first moment an `instant` column can take. */
const PG_INSTANT_MIN_MS = -62_135_596_800_000;
/** 10000-01-01T00:00:00Z: the first moment an `instant` column can no longer take. */
const PG_INSTANT_END_MS = 253_402_300_800_000;

/**
 * Whether an `instant` column (`@arki/db/temporal`) can store this moment. The column sends the ISO
 * text of the `Instant`, and Postgres reads only the years 1 to 9999 there: an earlier year is
 * refused with SQLSTATE 22008, and a signed year (`-000001-…`, `+010000-…`) with 22009. `Instant`
 * itself reaches from year -271821 to 275760.
 */
export function isPgInstant(value: Instant): boolean {
  return value.epochMilliseconds >= PG_INSTANT_MIN_MS && value.epochMilliseconds < PG_INSTANT_END_MS;
}

/** An `Instant` an `instant` column can store or be compared with: years 1 to 9999 UTC (see `isPgInstant`). */
export function pgInstantSchema() {
  return instantSchema().refine(isPgInstant, 'Time must fall in the years 1 to 9999 (UTC)');
}
