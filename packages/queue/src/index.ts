/**
 * Typed background jobs, schedules and flows on BullMQ and Redis.
 *
 * A tRPC-inspired builder API for defining and managing them.
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
 *   .name('notifications.send-email')
 *   .input(z.object({ to: z.email(), subject: z.string(), body: z.string() }))
 *   .handler(async (data, ctx) => {
 *     // ctx has: db, repo, kv, user (from middleware)
 *     await ctx.repo.notifications.create(data);
 *     return { sent: true };
 *   });
 *
 * // 5. Create flows
 * const orderFlow = q.flow
 *   .name('orders.process')
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
export { around, step } from './step.ts';
export type { AroundJobMiddleware, StepJobMiddleware } from './step.ts';

// Bull Board UI (unchanged)
export { BullMQAdapter, HonoAdapter, createBoard } from './create-board.ts';

// Type exports
export type {
  FlowDefinition,
  FlowEnqueueResult,
  FlowStepOptions,
  JobBuilderChain,
  JobBuilderDef,
  JobBuilderNeedsInput,
  JobContext,
  JobDefinition,
  JobHandler,
  JobLike,
  JobMiddleware,
  JobOptions,
  MiddlewareFunction,
  BullMQQueueInstance,
  QueueBuilder,
  QueueEnqueue,
  QueueInstance,
  QueuePriority,
  ScheduleDefinition,
  TriggerOptions,
} from './types/index.ts';

// Constants
export { QUEUE_PRIORITIES } from './types/index.ts';

// Coded errors for declaration mistakes and invalid enqueue input
export {
  QUEUE_DEFINITION_ERROR_CODES,
  QUEUE_INPUT_ERROR_CODES,
  QueueDefinitionError,
  QueueInputError,
} from './errors.ts';

// Cron pattern helpers
export { CronPatterns } from './cron-patterns.ts';
export type { DayOfWeek } from './cron-patterns.ts';

// Retry strategies
// Retry schedules for `JobOptions.retry`, from @arki/resilience
export { backoff } from '@arki/resilience';
export type { Backoff } from '@arki/resilience';

// Durable backend for @arki/schedule, for processes that do not boot through Dot
export { createDurableScheduler } from './durable-scheduler.ts';
export type { DurableScheduler, DurableSchedulerOptions } from './durable-scheduler.ts';

// Value-based execution for custom delivery adapters; handler failures retain their exact union.
export { executeJob, JOB_SYSTEM_FAILURES } from './job-outcome.ts';
export type { JobExecutionFailure, JobSystemFailure } from './job-outcome.ts';

export { QueueUnavailable, QueueAcceptanceUnknown, JOB_TRIGGER_FAILURES } from './trigger.ts';
export type { JobTriggerFailure, JobTriggerResult } from './trigger.ts';

export { FLOW_ENQUEUE_FAILURES } from './flow-jobs.ts';
export type { FlowEnqueueFailure } from './flow-jobs.ts';

export { queueJobId } from './job-id.ts';
export type { QueueJobId } from './job-id.ts';
