/**
 * Logging middleware
 * Logs job execution with structured information
 */

import type { MiddlewareFunction } from '../types/middleware.ts';
import type { QueueMeta } from '../types/queue.ts';

/**
 * Log level for structured logging
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured log entry
 */
export type LogEntry = {
  level: LogLevel;
  timestamp: string;
  jobName: string;
  jobId: string | undefined;
  message: string;
  data?: unknown;
};

/**
 * Logger interface
 */
export type Logger = {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
};

/**
 * Console logger implementation
 */
export class ConsoleLogger implements Logger {
  constructor(
    private readonly jobName: string,
    private readonly jobId: string | undefined,
  ) {}

  private log(level: LogLevel, message: string, data?: unknown) {
    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      jobName: this.jobName,
      jobId: this.jobId,
      message,
      data,
    };

    const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.jobName}${entry.jobId ? `#${entry.jobId}` : ''}]`;

    switch (level) {
      case 'debug': {
        console.debug(prefix, message, data);
        break;
      }
      case 'info': {
        console.info(prefix, message, data);
        break;
      }
      case 'warn': {
        console.warn(prefix, message, data);
        break;
      }
      case 'error': {
        console.error(prefix, message, data);
        break;
      }
    }
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }
}

/**
 * Simple logging middleware
 * Logs job start and completion
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(loggingMiddleware());
 * ```
 */
export function loggingMiddleware<TContext>(): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next, job, data }) => {
    console.log(`[${job.name}] Starting job ${job.id ?? 'unnamed'}`);
    console.log(`[${job.name}] Input:`, data);

    const result = await next();

    console.log(`[${job.name}] Completed job ${job.id ?? 'unnamed'}`);

    return result;
  };
}

/**
 * Structured logging middleware
 * Adds a logger to the context
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(structuredLoggingMiddleware());
 *
 * const myJob = baseJob
 *   .name('my-job')
 *   .input(schema)
 *   .handler(async (data, ctx) => {
 *     ctx.logger.info('Processing started', { userId: data.userId });
 *     // ...
 *     ctx.logger.info('Processing completed');
 *   });
 * ```
 */
export function structuredLoggingMiddleware<TContext>(): MiddlewareFunction<
  TContext,
  TContext & { logger: Logger },
  QueueMeta
> {
  return async ({ ctx, next, job }) => {
    const logger = new ConsoleLogger(job.name, job.id);

    logger.info('Job started');

    const result = await next({
      ctx: {
        ...ctx,
        logger,
      } as TContext & { logger: Logger },
    });

    logger.info('Job completed');

    return result;
  };
}

/**
 * Custom logging middleware with custom logger
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(
 *   customLoggingMiddleware({
 *     logger: customLogger,
 *   })
 * );
 * ```
 */
export function customLoggingMiddleware<TContext>(options: {
  createLogger: (jobName: string, jobId: string | undefined) => Logger;
}): MiddlewareFunction<TContext, TContext & { logger: Logger }, QueueMeta> {
  return async ({ ctx, next, job }) => {
    const logger = options.createLogger(job.name, job.id);

    logger.info('Job started');

    const result = await next({
      ctx: {
        ...ctx,
        logger,
      } as TContext & { logger: Logger },
    });

    logger.info('Job completed');

    return result;
  };
}

/**
 * Observability middleware
 * Tracks job success, failure, and duration with configurable logging and callbacks
 *
 * @example
 * ```typescript
 * // Basic usage with default logging
 * const baseJob = q.job.use(observabilityMiddleware());
 *
 * // Customize logging behavior
 * const silentJob = q.job.use(
 *   observabilityMiddleware({
 *     logSuccess: false,
 *     logDuration: true,
 *   })
 * );
 *
 * // Add custom callbacks for metrics/monitoring
 * const monitoredJob = q.job.use(
 *   observabilityMiddleware({
 *     onSuccess: async (jobName, jobId, result, duration) => {
 *       await metrics.recordJobSuccess(jobName, duration);
 *     },
 *     onFailure: async (jobName, jobId, error, duration) => {
 *       await metrics.recordJobFailure(jobName, duration, error);
 *     },
 *   })
 * );
 * ```
 */
export function observabilityMiddleware<TContext>(options?: {
  logSuccess?: boolean;
  logFailure?: boolean;
  logDuration?: boolean;
  onSuccess?: (jobName: string, jobId: string | undefined, result: unknown, duration: number) => void | Promise<void>;
  onFailure?: (jobName: string, jobId: string | undefined, error: Error, duration: number) => void | Promise<void>;
}): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next, job }) => {
    const start = Date.now();
    const config = {
      logSuccess: options?.logSuccess ?? true,
      logFailure: options?.logFailure ?? true,
      logDuration: options?.logDuration ?? true,
      ...options,
    };

    try {
      const result = await next();
      const duration = Date.now() - start;

      if (config.logSuccess) {
        const durationText = config.logDuration ? ` (${duration}ms)` : '';
        console.log(`[${job.name}] ✅ Job ${job.id ?? 'unnamed'} succeeded${durationText}`);
      }

      await config.onSuccess?.(job.name, job.id, result, duration);

      return result;
    } catch (error) {
      const duration = Date.now() - start;

      if (config.logFailure && error instanceof Error) {
        const durationText = config.logDuration ? ` (${duration}ms)` : '';
        console.error(`[${job.name}] ❌ Job ${job.id ?? 'unnamed'} failed${durationText}: ${error.message}`);
      }

      await config.onFailure?.(job.name, job.id, error as Error, duration);

      throw error;
    }
  };
}
