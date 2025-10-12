/**
 * @arki/queue - Background job processing library
 *
 * A declarative API for defining and managing jobs, schedules, and flows
 * built on top of BullMQ and Redis.
 *
 * @example
 * ```typescript
 * import { createQueue, defineJob, defineSchedule, buildFlow } from '@arki/queue';
 * import { z } from 'zod';
 *
 * // Define jobs
 * export const validateOrderJob = defineJob({ ... });
 * export const processPaymentJob = defineJob({ ... });
 * export const updateInventoryJob = defineJob({ ... });
 *
 * // Define a flow using the builder
 * export const processOrderFlow = buildFlow(
 *   'orders:process-flow',
 *   z.object({ orderId: z.string() }),
 * )
 *   .step('validate', {
 *     job: validateOrderJob,
 *     data: input => ({ orderId: input.orderId }),
 *   })
 *   .step('payment', {
 *     job: processPaymentJob,
 *     data: input => ({ orderId: input.orderId }),
 *     dependsOn: ['validate'],
 *   })
 *   .step('inventory', {
 *     job: updateInventoryJob,
 *     data: input => ({ orderId: input.orderId }),
 *     dependsOn: ['payment'],
 *   })
 *   .build();
 *
 * // Create queue instance
 * const queue = createQueue({
 *   connection: 'redis://localhost:6379',
 * });
 *
 * // Register definitions
 * queue.registerFlow(processOrderFlow);
 *
 * // Start processing
 * await queue.start();
 * ```
 */

// Core API
export { createQueue } from './create-queue.ts';
export { defineJob } from './define-job.ts';
export { defineSchedule } from './define-schedule.ts';
export { buildFlow, FlowBuilder } from './define-flow-builder.ts';
export { defineFlow } from './define-flow.ts';

// Bull Board UI
export { BullMQAdapter, createBoard, HonoAdapter } from './create-board.ts';

// Queue API for job/queue management
export { createFlowApi, createJobApi, createScheduleApi } from './queue-api.ts';
export type { FlowInfo, JobInfo, QueueStats } from './queue-api.ts';

// Type exports
export type {
  FlowDefinition,
  FlowOptions,
  FlowStep,
  JobContext,
  JobDefinition,
  JobHandler,
  JobOptions,
  QueueFactoryOptions,
  QueueInstance,
  RetryConfig,
  ScheduleConfig,
  ScheduleDefinition,
  ScheduleInfo,
  ScheduleOptions,
} from './types/index.ts';

// Constants
export { QUEUE_PRIORITIES } from './types/index.ts';
export type { QueuePriority } from './types/index.ts';
