/**
 * Timing middleware
 * Tracks job execution time and adds delays in development
 */

import type { MiddlewareFunction } from '../types/middleware.ts';
import type { QueueMeta } from '../types/queue.ts';

/**
 * Simple timing middleware
 * Logs execution time for each job
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(timingMiddleware());
 * ```
 */
export function timingMiddleware<TContext>(): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next, job }) => {
    const start = Date.now();

    const result = await next();

    const duration = Date.now() - start;
    console.log(`[${job.name}] Execution time: ${duration}ms`);

    return result;
  };
}

/**
 * Development timing middleware
 * Adds artificial delay in development to simulate network latency
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(
 *   devTimingMiddleware({
 *     minDelay: 100,
 *     maxDelay: 500,
 *   })
 * );
 * ```
 */
export function devTimingMiddleware<TContext>(options?: {
  /**
   * Minimum delay in milliseconds (default: 100)
   */
  minDelay?: number;
  /**
   * Maximum delay in milliseconds (default: 500)
   */
  maxDelay?: number;
  /**
   * Whether to enable delay (default: process.env.NODE_ENV === 'development')
   */
  enabled?: boolean;
}): MiddlewareFunction<TContext, TContext, QueueMeta> {
  const minDelay = options?.minDelay ?? 100;
  const maxDelay = options?.maxDelay ?? 500;
  const enabled = options?.enabled ?? process.env['NODE_ENV'] === 'development';

  return async ({ next, job }) => {
    const start = Date.now();

    // Add artificial delay in development
    if (enabled) {
      const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    const result = await next();

    const duration = Date.now() - start;
    console.log(`[${job.name}] Execution time: ${duration}ms ${enabled ? '(includes dev delay)' : ''}`);

    return result;
  };
}

/**
 * Performance monitoring middleware
 * Adds performance metrics to context
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(performanceMiddleware());
 *
 * const myJob = baseJob
 *   .name('my-job')
 *   .input(schema)
 *   .handler(async (data, ctx) => {
 *     const mark = ctx.performance.mark('database-query');
 *     await db.query(...);
 *     ctx.performance.measure('database-query', mark);
 *   });
 * ```
 */
export function performanceMiddleware<TContext>(): MiddlewareFunction<
  TContext,
  TContext & { performance: PerformanceTracker },
  QueueMeta
> {
  return async ({ ctx, next, job }) => {
    const tracker = new PerformanceTracker(job.name);

    tracker.start();

    const result = await next({
      ctx: {
        ...ctx,
        performance: tracker,
      } as TContext & { performance: PerformanceTracker },
    });

    tracker.end();
    tracker.logSummary();

    return result;
  };
}

/**
 * Performance tracker for measuring execution time
 */
export class PerformanceTracker {
  private startTime = 0;
  private endTime = 0;
  private marks = new Map<string, number>();
  private measures = new Map<string, number>();

  constructor(private readonly jobName: string) {}

  /**
   * Start tracking
   */
  start(): void {
    this.startTime = Date.now();
  }

  /**
   * End tracking
   */
  end(): void {
    this.endTime = Date.now();
  }

  /**
   * Create a performance mark
   * Returns the timestamp for later measurement
   */
  mark(label: string): number {
    const now = Date.now();
    this.marks.set(label, now);
    return now;
  }

  /**
   * Measure time since a mark
   */
  measure(label: string, startMark: number): number {
    const duration = Date.now() - startMark;
    this.measures.set(label, duration);
    return duration;
  }

  /**
   * Get total execution time
   */
  getTotalTime(): number {
    return this.endTime - this.startTime;
  }

  /**
   * Get all measures
   */
  getMeasures(): Record<string, number> {
    return Object.fromEntries(this.measures);
  }

  /**
   * Log performance summary
   */
  logSummary(): void {
    const total = this.getTotalTime();
    const measures = this.getMeasures();

    console.log(`[${this.jobName}] Performance Summary:`);
    console.log(`  Total: ${total}ms`);

    if (Object.keys(measures).length > 0) {
      console.log('  Measures:');
      for (const [label, duration] of Object.entries(measures)) {
        console.log(`    - ${label}: ${duration}ms`);
      }
    }
  }
}

/**
 * Timeout middleware
 * Enforces a maximum execution time for jobs
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(
 *   timeoutMiddleware({
 *     timeout: 30000, // 30 seconds
 *   })
 * );
 * ```
 */
export function timeoutMiddleware<TContext>(options: {
  /**
   * Timeout in milliseconds
   */
  timeout: number;
  /**
   * Custom error message
   */
  message?: string;
}): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next, job }) => {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(options.message ?? `Job ${job.name} timed out after ${options.timeout}ms`));
      }, options.timeout);
    });

    return Promise.race([next(), timeoutPromise]);
  };
}
