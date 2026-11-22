/**
 * Enhanced Assertion Helpers for Testing
 *
 * Provides comprehensive assertion utilities for common testing patterns
 * beyond the basic assertions built into IntegrationTester.
 */

import { z } from 'zod';

import type { SchemaInput, StandardSchemaV1 } from '@arki/schema';
import { InvalidInput, invariant, orThrow } from '@arki/failure';
import { formatIssues, is, parse, recordSchema } from '@arki/schema';

import type { Timestamp } from './timestamps.js';
import { formatValue } from './format-value.js';
import { paginatedResponseSchema } from './schemas.js';
import { describeKind, epochNanoseconds, isTimestamp } from './timestamps.js';

/** A page of results: what {@link assertPaginationValid} narrows a response to. */
export type PaginatedResponse = {
  items: unknown[];
  total?: number | undefined;
  nextCursor?: string | null | undefined;
  hasMore?: boolean | undefined;
};

/**
 * Assert that a pagination response is valid
 *
 * @param response - Response to validate
 * @param options - Expected values
 *
 * @example
 * ```typescript
 * const result = await tester.caller.user.games.list();
 * assertPaginationValid(result, {
 *   itemsCount: 10,
 *   total: 25,
 *   hasMore: true,
 * });
 * ```
 */
export function assertPaginationValid(
  response: unknown,
  options?: {
    itemsCount?: number;
    total?: number;
    hasMore?: boolean;
    itemSchema?: StandardSchemaV1;
  },
): asserts response is PaginatedResponse {
  if (!is(response, recordSchema)) {
    throw new Error('Expected paginated response to be an object');
  }

  const page = parse(paginatedResponseSchema, response);
  if (InvalidInput.is(page)) {
    throw new TypeError(`Expected paginated response to have an items array: ${formatIssues(page.data.issues)}`, {
      cause: page,
    });
  }
  const { items } = orThrow(page);

  if (options?.itemsCount !== undefined && items.length !== options.itemsCount) {
    throw new Error(`Expected items array to have length ${options.itemsCount}, got ${items.length}`);
  }

  if (options?.total !== undefined) {
    const { total } = orThrow(page);
    if (total === undefined) {
      throw new TypeError('Expected total to be a number, got undefined');
    }
    if (total !== options.total) {
      throw new Error(`Expected total to be ${options.total}, got ${total}`);
    }
  }

  if (options?.hasMore !== undefined) {
    const { hasMore } = orThrow(page);
    if (hasMore !== options.hasMore) {
      throw new Error(`Expected hasMore to be ${options.hasMore}, got ${String(hasMore)}`);
    }
  }

  const itemSchema = options?.itemSchema;
  if (itemSchema) {
    for (const [index, item] of items.entries()) {
      const result = parse(itemSchema, item);
      if (InvalidInput.is(result)) {
        throw new Error(`Item at index ${index} failed validation: ${formatIssues(result.data.issues)}`, {
          cause: result,
        });
      }
      orThrow(result);
    }
  }
}

/**
 * Assert that a timestamp is recent (within specified seconds)
 *
 * The timestamp may be a `Date`, or a Temporal `Instant` or `ZonedDateTime`
 * from `@arki/date`. It is compared with now by its exact epoch.
 *
 * @param timestamp - Timestamp to check
 * @param options - Options including withinSeconds (default: 10; a finite number of at least 0, or the
 *   invariant failure `ARKI_FAILURE_E008` is thrown: `NaN` would let every timestamp pass)
 *
 * @example
 * ```typescript
 * const user = await createUser();
 * assertTimestampRecent(user.createdAt, { withinSeconds: 5 });
 * ```
 */
export function assertTimestampRecent(
  timestamp: unknown,
  options: { withinSeconds?: number; label?: string } = {},
): asserts timestamp is Timestamp {
  const { withinSeconds = 10, label = 'timestamp' } = options;
  invariant(
    Number.isFinite(withinSeconds) && withinSeconds >= 0,
    `assertTimestampRecent: withinSeconds must be a finite number of at least 0, got ${withinSeconds}.`,
  );

  if (!isTimestamp(timestamp)) {
    throw new TypeError(`Expected ${label} to be a Date, Instant or ZonedDateTime, got ${describeKind(timestamp)}`);
  }

  const nowNanoseconds = BigInt(Date.now()) * 1_000_000n;
  const differenceNanoseconds = nowNanoseconds - epochNanoseconds(timestamp);
  const diffSeconds = Number(differenceNanoseconds < 0n ? -differenceNanoseconds : differenceNanoseconds) / 1e9;

  if (diffSeconds > withinSeconds) {
    throw new Error(
      `Expected ${label} to be within ${withinSeconds} seconds of now, but was ${diffSeconds.toFixed(1)}s ago`,
    );
  }
}

/**
 * Assert that an array contains an item with the specified ID
 *
 * @param items - Array to search
 * @param id - ID to find
 * @param idField - Field name for ID (default: 'id')
 *
 * @example
 * ```typescript
 * const games = await tester.caller.user.games.list();
 * assertContainsId(games.items, 'game_123');
 * ```
 */
export function assertContainsId<T extends { id: unknown }>(items: T[], id: string): void;
export function assertContainsId<T extends object>(items: T[], id: string, idField: keyof T): void;
export function assertContainsId(items: readonly object[], id: string, idField: PropertyKey = 'id'): void {
  const found = items.some(item => Reflect.get(item, idField) === id);
  if (!found) {
    const ids = items.map(item => String(Reflect.get(item, idField)));
    throw new Error(`Expected array to contain item with ${String(idField)}='${id}', but found: [${ids.join(', ')}]`);
  }
}

/**
 * Assert that an array does NOT contain an item with the specified ID
 *
 * @param items - Array to search
 * @param id - ID that should not be found
 * @param idField - Field name for ID (default: 'id')
 *
 * @example
 * ```typescript
 * const games = await tester.caller.user.games.list();
 * assertNotContainsId(games.items, 'game_deleted');
 * ```
 */
export function assertNotContainsId<T extends { id: unknown }>(items: T[], id: string): void;
export function assertNotContainsId<T extends object>(items: T[], id: string, idField: keyof T): void;
export function assertNotContainsId(items: readonly object[], id: string, idField: PropertyKey = 'id'): void {
  const found = items.some(item => Reflect.get(item, idField) === id);
  if (found) {
    throw new Error(`Expected array to NOT contain item with ${String(idField)}='${id}', but found it`);
  }
}

/**
 * Assert that an error was thrown with expected message
 *
 * @param callback - Async function to execute
 * @param expectedMessage - Expected error message (string or regex)
 *
 * @example
 * ```typescript
 * await assertErrorThrown(
 *   async () => tester.caller.user.games.delete({ id: 'invalid' }),
 *   /not found/i
 * );
 * ```
 */
export async function assertErrorThrown(
  callback: () => Promise<unknown>,
  expectedMessage?: string | RegExp,
): Promise<Error> {
  let error: Error | null = null;

  try {
    await callback();
  } catch (error_) {
    error = error_ instanceof Error ? error_ : new Error(String(error_));
  }

  if (!error) {
    throw new Error('Expected function to throw an error, but it did not');
  }

  if (expectedMessage) {
    if (typeof expectedMessage === 'string') {
      if (!error.message.includes(expectedMessage)) {
        throw new Error(`Expected error message to contain "${expectedMessage}", got: "${error.message}"`);
      }
    } else {
      if (!expectedMessage.test(error.message)) {
        throw new Error(`Expected error message to match ${expectedMessage}, got: "${error.message}"`);
      }
    }
  }

  return error;
}

/**
 * Assert that an error was NOT thrown
 *
 * @param callback - Async function to execute
 *
 * @example
 * ```typescript
 * await assertNoError(
 *   async () => tester.caller.user.games.get({ id: 'game_123' })
 * );
 * ```
 */
export async function assertNoError(callback: () => Promise<unknown>): Promise<void> {
  try {
    await callback();
  } catch (error) {
    throw new Error(
      `Expected function not to throw an error, but it threw: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Assert array has expected length
 *
 * @param array - Array to check
 * @param expectedLength - Expected length
 * @param label - Optional label for error message
 *
 * @example
 * ```typescript
 * const games = await tester.caller.user.games.list();
 * assertArrayLength(games.items, 10, 'games');
 * ```
 */
export function assertArrayLength(array: unknown[], expectedLength: number, label = 'array'): void {
  if (array.length !== expectedLength) {
    throw new Error(`Expected ${label} to have length ${expectedLength}, got ${array.length}`);
  }
}

/**
 * Assert array is not empty
 *
 * @param array - Array to check
 * @param label - Optional label for error message
 *
 * @example
 * ```typescript
 * const games = await tester.caller.user.games.list();
 * assertArrayNotEmpty(games.items, 'games');
 * ```
 */
export function assertArrayNotEmpty(array: unknown[], label = 'array'): void {
  if (array.length === 0) {
    throw new Error(`Expected ${label} not to be empty`);
  }
}

/**
 * Assert array is empty
 *
 * @param array - Array to check
 * @param label - Optional label for error message
 *
 * @example
 * ```typescript
 * const games = await tester.caller.user.games.list({ status: 'archived' });
 * assertArrayEmpty(games.items, 'archived games');
 * ```
 */
export function assertArrayEmpty(array: unknown[], label = 'array'): void {
  if (array.length > 0) {
    throw new Error(`Expected ${label} to be empty, but it has ${array.length} items`);
  }
}

/**
 * Assert object matches partial shape (deep partial match)
 *
 * @param actual - Actual object
 * @param expected - Expected partial object
 * @param label - Optional label for error message
 *
 * @example
 * ```typescript
 * const game = await tester.caller.user.games.get({ id: 'game_123' });
 * assertDeepPartialMatch(game, {
 *   name: 'Chess',
 *   status: 'active',
 *   metadata: { difficulty: 'hard' }
 * });
 * ```
 */
export function assertDeepPartialMatch(
  actual: unknown,
  expected: unknown,
  label = 'object',
  path: string[] = [],
): void {
  if (!isObjectLike(expected)) {
    return;
  }

  for (const key of Object.keys(expected)) {
    const currentPath = [...path, key];
    const pathStr = currentPath.join('.');

    if (!isObjectLike(actual) || !(key in actual)) {
      throw new Error(`Expected ${label} to have property '${pathStr}'`);
    }

    const actualValue: unknown = Reflect.get(actual, key);
    const expectedValue: unknown = Reflect.get(expected, key);

    if (expectedValue === null) {
      if (actualValue !== null) {
        throw new Error(`Expected ${label}.${pathStr} to be null, got ${formatValue(actualValue)}`);
      }
    } else if (is(expectedValue, recordSchema)) {
      assertDeepPartialMatch(actualValue, expectedValue, label, currentPath);
    } else if (actualValue !== expectedValue) {
      throw new Error(
        `Expected ${label}.${pathStr} to be ${formatValue(expectedValue)}, got ${formatValue(actualValue)}`,
      );
    }
  }
}

/**
 * Assert array is sorted by a field
 *
 * @param array - Array to check
 * @param field - Field to check sorting
 * @param order - Sort order ('asc' or 'desc')
 *
 * @example
 * ```typescript
 * const games = await tester.caller.user.games.list({ orderBy: 'name' });
 * assertArraySorted(games.items, 'name', 'asc');
 * ```
 */
export function assertArraySorted<T extends object>(array: T[], field: keyof T, order: 'asc' | 'desc' = 'asc'): void {
  for (let i = 1; i < array.length; i++) {
    const prev: unknown = array[i - 1]![field];
    const current: unknown = array[i]![field];
    const comparison = compareValues(prev, current, field);

    if (order === 'asc') {
      if (comparison > 0) {
        throw new Error(
          `Expected array to be sorted by '${String(field)}' in ascending order, but found ${String(prev)} > ${String(current)} at index ${i}`,
        );
      }
    } else {
      if (comparison < 0) {
        throw new Error(
          `Expected array to be sorted by '${String(field)}' in descending order, but found ${String(prev)} < ${String(current)} at index ${i}`,
        );
      }
    }
  }
}

const anyArraySchema = z.array(z.unknown());

/** An object or an array: something `in` and `for...in` can read keys from. */
function isObjectLike(value: unknown): value is Record<string, unknown> | unknown[] {
  return is(value, recordSchema) || is(value, anyArraySchema);
}

/** A sortable number: finite, or an infinity. `NaN` has no order, so it cannot be compared. */
const sortNumberSchema = z.union([
  z.number(),
  z.literal(Number.POSITIVE_INFINITY),
  z.literal(Number.NEGATIVE_INFINITY),
]);
const numberPairSchema = z.tuple([sortNumberSchema, sortNumberSchema]);
const bigintPairSchema = z.tuple([z.bigint(), z.bigint()]);
const stringPairSchema = z.tuple([z.string(), z.string()]);
/** `z.date()` refuses an `Invalid Date`, which has no order either. */
const datePairSchema = z.tuple([z.date(), z.date()]);

/**
 * Compare two sort-field values: numbers, strings, bigints and dates, each with its own kind.
 * `NaN` and an `Invalid Date` have no order and throw like a mix of kinds.
 */
function compareValues(a: unknown, b: unknown, field: PropertyKey): number {
  const pair = [a, b];
  if (is(pair, numberPairSchema)) return pair[0] === pair[1] ? 0 : pair[0] - pair[1];
  if (is(pair, bigintPairSchema)) return pair[0] > pair[1] ? 1 : pair[0] < pair[1] ? -1 : 0;
  if (is(pair, stringPairSchema)) return pair[0] > pair[1] ? 1 : pair[0] < pair[1] ? -1 : 0;
  if (is(pair, datePairSchema)) return pair[0].getTime() - pair[1].getTime();
  throw new TypeError(
    `Cannot compare values of '${String(field)}': expected two numbers, bigints, strings or dates (NaN and an Invalid Date have no order), got ${a === null ? 'null' : typeof a} and ${b === null ? 'null' : typeof b}`,
  );
}

/**
 * Assert value is one of the expected values
 *
 * @param value - Value to check
 * @param expectedValues - Array of expected values
 * @param label - Optional label for error message
 *
 * @example
 * ```typescript
 * const game = await tester.caller.user.games.get({ id: 'game_123' });
 * assertOneOf(game.status, ['active', 'draft', 'archived'], 'game status');
 * ```
 */
export function assertOneOf<T>(value: T, expectedValues: T[], label = 'value'): void {
  if (!expectedValues.includes(value)) {
    throw new Error(`Expected ${label} to be one of [${expectedValues.join(', ')}], got ${String(value)}`);
  }
}

/**
 * Assert value matches a Standard Schema (zod, valibot, arktype, ...)
 *
 * Assertions are synchronous: an async schema throws `UnexpectedFailure`
 * carrying `AsyncSchema` instead of being awaited. A validator that throws is
 * rethrown as is, never reported as invalid data.
 *
 * @param value - Value to validate
 * @param schema - Standard Schema
 * @param label - Optional label for error message
 *
 * @example
 * ```typescript
 * const game = await tester.caller.user.games.get({ id: 'game_123' });
 * assertMatchesSchema(game, gameSchema, 'game');
 * ```
 */
export function assertMatchesSchema<Schema extends StandardSchemaV1>(
  value: unknown,
  schema: Schema,
  label = 'value',
): asserts value is SchemaInput<Schema> {
  const result = parse(schema, value);
  if (InvalidInput.is(result)) {
    throw new Error(`${label} failed schema validation: ${formatIssues(result.data.issues)}`, { cause: result });
  }
  orThrow(result);
}
