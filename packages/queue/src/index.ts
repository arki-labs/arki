/**
 * @arki/queue v2.0 - Background job processing library
 *
 * A tRPC-inspired API for defining and managing jobs, schedules, and flows
 * built on top of BullMQ and Redis.
 *
 * @example
 * ```typescript
 * import { initQueue } from '@arki/queue';
 * import { z } from '@arki/contracts';
 *
 * // 1. Create context
 * const createContext = () => ({
 *   db: database,
 *   repo: repositories,
 *   kv: kvStore,
 * });
 *
 * // 2. Initialize queue
 * const q = initQueue
 *   .context<typeof createContext>()
 *   .create({
 *     transformer: superjson,
 *   });
 *
 * // 3. Create job builders with middleware
 * const baseJob = q.job.use(errorHandling).use(logging);
 * const authJob = baseJob.use(authMiddleware);
 *
 * // 4. Define jobs
 * const sendEmail = authJob
 *   .name('notifications:send-email')
 *   .input(z.object({ to: z.email(), subject: z.string(), body: z.string() }))
 *   .handler(async (data, ctx) => {
 *     // ctx has: db, repo, kv, user (from middleware)
 *     await ctx.repo.notifications.create(data);
 *     return { sent: true };
 *   });
 *
 * // 5. Create flows
 * const orderFlow = q.flow
 *   .name('orders:process')
 *   .input(z.object({ orderId: z.string() }))
 *   .step('validate', {
 *     job: validateJob,
 *     data: input => ({ orderId: input.orderId }),
 *   })
 *   .step('payment', {
 *     job: paymentJob,
 *     data: input => ({ orderId: input.orderId }),
 *     dependsOn: ['validate'],
 *   })
 *   .build();
 *
 * // 6. Organize with registries
 * const jobs = q.registry({
 *   notifications: q.registry({
 *     email: sendEmail,
 *   }),
 * });
 *
 * // 7. Create and start queue
 * const queue = q.createQueue({
 *   connection: 'redis://localhost:6379',
 *   createContext,
 * });
 * await queue.register(jobs);
 * await queue.start();
 * ```
 */

// Core API - NEW v2.0
export type { InternalFlowDefinition } from './flow-builder.ts';
export { initQueue } from './init.ts';
export type { InternalScheduleDefinition } from './schedule-builder.ts';

// Middleware execution (for advanced use cases)
export { createJobContext, executeMiddlewareChain } from './middleware.ts';

// Standard middleware
export {
  ConsoleLogger,
  JobError,
  JobValidationError,
  PerformanceTracker,
  customLoggingMiddleware,
  customValidationMiddleware,
  devTimingMiddleware,
  errorHandlingMiddleware,
  errorHandlingMiddlewareWithFormatter,
  loggingMiddleware,
  outputValidationMiddleware,
  performanceMiddleware,
  structuredLoggingMiddleware,
  timeoutMiddleware,
  timingMiddleware,
  validationMiddleware,
} from './middleware/index.ts';
export type { LogEntry, LogLevel, Logger } from './middleware/index.ts';

// Bull Board UI (unchanged)
export { BullMQAdapter, HonoAdapter, createBoard } from './create-board.ts';

// Type exports
export type {
  BackoffStrategy,
  FlowDefinition,
  JobBuilderChain,
  JobBuilderDef,
  JobContext,
  JobDefinition,
  JobHandler,
  JobMiddleware,
  JobOptions,
  MiddlewareFunction,
  QueueBuilder,
  QueueInstance,
  QueuePriority,
  RetryConfig,
  ScheduleDefinition,
} from './types/index.ts';

// Constants
export { QUEUE_PRIORITIES } from './types/index.ts';

// Cron pattern helpers
export { CronPatterns } from './cron-patterns.ts';
export type { DayOfWeek } from './cron-patterns.ts';

// Retry strategies
export { COMMON_RETRY_CONFIGS, createBackoffStrategy } from './retry-strategies.ts';
