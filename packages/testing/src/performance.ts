/**
 * Performance Testing Utilities
 *
 * Provides helpers for measuring and asserting performance characteristics
 * of database operations and API calls.
 */

import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * Performance measurement result
 */
export type PerformanceResult = {
  /**
   * Operation label
   */
  label: string;

  /**
   * Duration in milliseconds
   */
  durationMs: number;

  /**
   * Start timestamp
   */
  startTime: number;

  /**
   * End timestamp
   */
  endTime: number;

  /**
   * Whether the operation passed the performance threshold
   */
  passed: boolean;

  /**
   * Maximum allowed duration (if specified)
   */
  maxMs?: number;
}

/**
 * Measure the performance of an operation
 *
 * @param label - Label for the operation
 * @param operation - Async operation to measure
 * @param options - Options including maxMs threshold
 * @returns Performance result
 *
 * @throws Error if maxMs is specified and operation exceeds it
 *
 * @example
 * ```typescript
 * const result = await measurePerformance(
 *   'Create 100 users',
 *   async () => {
 *     for (let i = 0; i < 100; i++) {
 *       await createUser();
 *     }
 *   },
 *   { maxMs: 1000 }
 * );
 *
 * console.log(`Took ${result.durationMs}ms`);
 * ```
 */
export async function measurePerformance<T>(
  label: string,
  operation: () => Promise<T>,
  options: { maxMs?: number; logResult?: boolean } = {},
): Promise<PerformanceResult & { result: T }> {
  const startTime = Date.now();
  const result = await operation();
  const endTime = Date.now();
  const durationMs = endTime - startTime;

  const passed = options.maxMs === undefined || durationMs <= options.maxMs;

  const perfResult: PerformanceResult & { result: T } = {
    label,
    durationMs,
    startTime,
    endTime,
    passed,
    maxMs: options.maxMs,
    result,
  };

  if (options.logResult !== false) {
    const status = passed ? '✓' : '✗';
    const threshold = options.maxMs ? ` (threshold: ${options.maxMs}ms)` : '';
    console.log(`${status} ${label}: ${durationMs}ms${threshold}`);
  }

  if (!passed && options.maxMs !== undefined) {
    throw new Error(`Performance assertion failed: ${label} took ${durationMs}ms, expected <= ${options.maxMs}ms`);
  }

  return perfResult;
}

/**
 * Benchmark a query by running it multiple times
 *
 * @param label - Label for the benchmark
 * @param query - Query function to benchmark
 * @param iterations - Number of iterations (default: 10)
 * @returns Benchmark statistics
 *
 * @example
 * ```typescript
 * const stats = await benchmarkQuery(
 *   'Get user by ID',
 *   () => tester.repo.users.findById('usr_123'),
 *   100
 * );
 *
 * console.log(`Average: ${stats.avgMs}ms, P95: ${stats.p95Ms}ms`);
 * ```
 */
export async function benchmarkQuery<T>(
  label: string,
  query: () => Promise<T>,
  iterations = 10,
): Promise<{
  label: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  durations: number[];
}> {
  const durations: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    await query();
    const duration = Date.now() - start;
    durations.push(duration);
  }

  durations.sort((a, b) => a - b);

  const totalMs = durations.reduce((sum, d) => sum + d, 0);
  const avgMs = totalMs / iterations;
  const minMs = durations[0]!;
  const maxMs = durations.at(-1)!;
  const p50Ms = durations[Math.floor(iterations * 0.5)]!;
  const p95Ms = durations[Math.floor(iterations * 0.95)]!;
  const p99Ms = durations[Math.floor(iterations * 0.99)]!;

  console.log(`\n📊 Benchmark: ${label}`);
  console.log(`  Iterations: ${iterations}`);
  console.log(`  Total: ${totalMs.toFixed(2)}ms`);
  console.log(`  Average: ${avgMs.toFixed(2)}ms`);
  console.log(`  Min: ${minMs.toFixed(2)}ms`);
  console.log(`  Max: ${maxMs.toFixed(2)}ms`);
  console.log(`  P50: ${p50Ms.toFixed(2)}ms`);
  console.log(`  P95: ${p95Ms.toFixed(2)}ms`);
  console.log(`  P99: ${p99Ms.toFixed(2)}ms`);

  return {
    label,
    iterations,
    totalMs,
    avgMs,
    minMs,
    maxMs,
    p50Ms,
    p95Ms,
    p99Ms,
    durations,
  };
}

/**
 * Compare the performance of multiple operations
 *
 * @param operations - Object mapping labels to operation functions
 * @param iterations - Number of iterations per operation (default: 10)
 * @returns Comparison results sorted by average duration
 *
 * @example
 * ```typescript
 * const comparison = await comparePerformance({
 *   'Method A': () => methodA(),
 *   'Method B': () => methodB(),
 *   'Method C': () => methodC(),
 * }, 20);
 *
 * // Shows ranked results with percentage differences
 * ```
 */
export async function comparePerformance<T extends Record<string, () => Promise<any>>>(
  operations: T,
  iterations = 10,
): Promise<
  {
    label: string;
    avgMs: number;
    minMs: number;
    maxMs: number;
    relativeDiff: string;
  }[]
> {
  const results: {
    label: string;
    avgMs: number;
    minMs: number;
    maxMs: number;
  }[] = [];

  for (const [label, operation] of Object.entries(operations)) {
    const durations: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      await operation();
      const duration = Date.now() - start;
      durations.push(duration);
    }

    durations.sort((a, b) => a - b);

    const totalMs = durations.reduce((sum, d) => sum + d, 0);
    const avgMs = totalMs / iterations;
    const minMs = durations[0]!;
    const maxMs = durations.at(-1)!;

    results.push({ label, avgMs, minMs, maxMs });
  }

  results.sort((a, b) => a.avgMs - b.avgMs);

  const fastest = results[0]!.avgMs;

  const comparison = results.map(result => ({
    ...result,
    relativeDiff:
      result.avgMs === fastest ? 'baseline' : `+${(((result.avgMs - fastest) / fastest) * 100).toFixed(1)}%`,
  }));

  console.log(`\n📊 Performance Comparison (${iterations} iterations each):`);
  for (const [index, result] of comparison.entries()) {
    const rank = index + 1;
    console.log(`  ${rank}. ${result.label}: ${result.avgMs.toFixed(2)}ms (${result.relativeDiff})`);
  }

  return comparison;
}

/**
 * Assert that an operation completes within the specified time
 *
 * @param label - Label for the operation
 * @param operation - Async operation to measure
 * @param maxMs - Maximum allowed duration in milliseconds
 * @returns The result of the operation
 *
 * @throws Error if operation exceeds maxMs
 *
 * @example
 * ```typescript
 * const user = await assertPerformance(
 *   'Get user by ID',
 *   () => tester.repo.users.findById('usr_123'),
 *   100
 * );
 * ```
 */
export async function assertPerformance<T>(label: string, operation: () => Promise<T>, maxMs: number): Promise<T> {
  const result = await measurePerformance(label, operation, { maxMs });
  return result.result;
}

/**
 * Create a performance tracker that can measure multiple operations
 *
 * @example
 * ```typescript
 * const tracker = createPerformanceTracker();
 *
 * await tracker.measure('Setup', async () => {
 *   // setup code
 * });
 *
 * await tracker.measure('Main operation', async () => {
 *   // main code
 * });
 *
 * await tracker.measure('Cleanup', async () => {
 *   // cleanup code
 * });
 *
 * tracker.printSummary();
 * ```
 */
export function createPerformanceTracker() {
  const measurements: PerformanceResult[] = [];

  return {
    async measure<T>(label: string, operation: () => Promise<T>, options: { maxMs?: number } = {}): Promise<T> {
      const startTime = Date.now();
      const result = await operation();
      const endTime = Date.now();
      const durationMs = endTime - startTime;

      const passed = options.maxMs === undefined || durationMs <= options.maxMs;

      measurements.push({
        label,
        durationMs,
        startTime,
        endTime,
        passed,
        maxMs: options.maxMs,
      });

      if (!passed && options.maxMs !== undefined) {
        throw new Error(`Performance assertion failed: ${label} took ${durationMs}ms, expected <= ${options.maxMs}ms`);
      }

      return result;
    },

    getMeasurements(): PerformanceResult[] {
      return [...measurements];
    },

    printSummary(): void {
      const total = measurements.reduce((sum, m) => sum + m.durationMs, 0);

      console.log(`\n📊 Performance Summary:`);
      console.log(`  Total time: ${total.toFixed(2)}ms`);
      console.log(`  Operations: ${measurements.length}`);
      console.log(`\n  Breakdown:`);

      for (const m of measurements) {
        const status = m.passed ? '✓' : '✗';
        const threshold = m.maxMs ? ` (threshold: ${m.maxMs}ms)` : '';
        const percentage = ((m.durationMs / total) * 100).toFixed(1);
        console.log(`    ${status} ${m.label}: ${m.durationMs.toFixed(2)}ms (${percentage}%)${threshold}`);
      }
    },

    clear(): void {
      measurements.length = 0;
    },
  };
}

/**
 * Measure database query execution time
 *
 * @param db - Database instance
 * @param queryFn - Query function to measure
 * @param label - Label for the query
 * @returns Query result and timing information
 *
 * @example
 * ```typescript
 * const { result, durationMs } = await measureQuery(
 *   tester.db,
 *   (db) => db.select().from(users).where(eq(users.id, 'usr_123')),
 *   'Get user by ID'
 * );
 * ```
 */
export async function measureQuery<TSchema extends AnyRelations, T>(
  db: NodePgDatabase<TSchema>,
  queryFn: (db: NodePgDatabase<TSchema>) => Promise<T>,
  label?: string,
): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await queryFn(db);
  const durationMs = Date.now() - start;

  if (label) {
    console.log(`[QUERY] ${label}: ${durationMs}ms`);
  }

  return { result, durationMs };
}
