/**
 * Enhanced Assertion Helpers for Testing
 *
 * Provides comprehensive assertion utilities for common testing patterns
 * beyond the basic assertions built into IntegrationTester.
 */

import type { ZodSchema } from 'zod/v4';

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
    itemSchema?: ZodSchema;
  },
): asserts response is {
  items: unknown[];
  total?: number;
  nextCursor?: string | null;
  hasMore?: boolean;
} {
  if (!response || typeof response !== 'object') {
    throw new Error('Expected paginated response to be an object');
  }

  const resp = response as any;

  if (!Array.isArray(resp.items)) {
    throw new TypeError('Expected paginated response to have items array');
  }

  if (options?.itemsCount !== undefined && resp.items.length !== options.itemsCount) {
    throw new Error(`Expected items array to have length ${options.itemsCount}, got ${resp.items.length}`);
  }

  if (options?.total !== undefined) {
    if (typeof resp.total !== 'number') {
      throw new TypeError(`Expected total to be a number, got ${typeof resp.total}`);
    }
    if (resp.total !== options.total) {
      throw new Error(`Expected total to be ${options.total}, got ${resp.total}`);
    }
  }

  if (options?.hasMore !== undefined && resp.hasMore !== options.hasMore) {
    throw new Error(`Expected hasMore to be ${options.hasMore}, got ${resp.hasMore}`);
  }

  if (options?.itemSchema) {
    resp.items.forEach((item: unknown, index: number) => {
      const result = options.itemSchema!.safeParse(item);
      if (!result.success) {
        throw new Error(`Item at index ${index} failed validation: ${result.error.message}`);
      }
    });
  }
}

/**
 * Assert that a timestamp is recent (within specified seconds)
 *
 * @param timestamp - Timestamp to check
 * @param options - Options including withinSeconds (default: 10)
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
): asserts timestamp is Date {
  const { withinSeconds = 10, label = 'timestamp' } = options;

  if (!(timestamp instanceof Date)) {
    throw new TypeError(`Expected ${label} to be a Date, got ${typeof timestamp}`);
  }

  const now = Date.now();
  const timestampMs = timestamp.getTime();
  const diffMs = Math.abs(now - timestampMs);
  const diffSeconds = diffMs / 1000;

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
export function assertContainsId<T extends Record<string, any>>(
  items: T[],
  id: string,
  idField: keyof T = 'id' as keyof T,
): void {
  const found = items.some(item => item[idField] === id);
  if (!found) {
    const ids = items.map(item => item[idField]);
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
export function assertNotContainsId<T extends Record<string, any>>(
  items: T[],
  id: string,
  idField: keyof T = 'id' as keyof T,
): void {
  const found = items.some(item => item[idField] === id);
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
  callback: () => Promise<any>,
  expectedMessage?: string | RegExp,
): Promise<Error> {
  let error: Error | null = null;

  try {
    await callback();
  } catch (error_) {
    error = error_ as Error;
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
export async function assertNoError(callback: () => Promise<any>): Promise<void> {
  try {
    await callback();
  } catch (error) {
    throw new Error(`Expected function not to throw an error, but it threw: ${(error as Error).message}`);
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
export function assertDeepPartialMatch(actual: any, expected: any, label = 'object', path: string[] = []): void {
  for (const key in expected) {
    const currentPath = [...path, key];
    const pathStr = currentPath.join('.');

    if (!(key in actual)) {
      throw new Error(`Expected ${label} to have property '${pathStr}'`);
    }

    const actualValue = actual[key];
    const expectedValue = expected[key];

    if (expectedValue === null) {
      if (actualValue !== null) {
        throw new Error(`Expected ${label}.${pathStr} to be null, got ${actualValue}`);
      }
    } else if (typeof expectedValue === 'object' && !Array.isArray(expectedValue)) {
      assertDeepPartialMatch(actualValue, expectedValue, label, currentPath);
    } else if (actualValue !== expectedValue) {
      throw new Error(
        `Expected ${label}.${pathStr} to be ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`,
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
export function assertArraySorted<T extends Record<string, any>>(
  array: T[],
  field: keyof T,
  order: 'asc' | 'desc' = 'asc',
): void {
  for (let i = 1; i < array.length; i++) {
    const prev = array[i - 1]![field];
    const current = array[i]![field];

    if (order === 'asc') {
      if (prev > current) {
        throw new Error(
          `Expected array to be sorted by '${String(field)}' in ascending order, but found ${prev} > ${current} at index ${i}`,
        );
      }
    } else {
      if (prev < current) {
        throw new Error(
          `Expected array to be sorted by '${String(field)}' in descending order, but found ${prev} < ${current} at index ${i}`,
        );
      }
    }
  }
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
    throw new Error(`Expected ${label} to be one of [${expectedValues.join(', ')}], got ${value}`);
  }
}

/**
 * Assert value matches Zod schema
 *
 * @param value - Value to validate
 * @param schema - Zod schema
 * @param label - Optional label for error message
 *
 * @example
 * ```typescript
 * const game = await tester.caller.user.games.get({ id: 'game_123' });
 * assertMatchesSchema(game, gameSchema, 'game');
 * ```
 */
export function assertMatchesSchema<T>(value: unknown, schema: ZodSchema<T>, label = 'value'): asserts value is T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} failed schema validation: ${result.error.message}`);
  }
}
