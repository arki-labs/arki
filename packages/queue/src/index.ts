/**
 * @arki/queue - Background job processing library
 *
 * A declarative API for defining and managing jobs, schedules, and flows
 * built on top of BullMQ and Redis.
 *
 * @example
 * ```typescript
 * import { createQueue, defineJob, defineSchedule, defineFlow } from '@arki/queue';
 * import { z } from 'zod';
 *
 * // Define a job
 * export const sendEmail = defineJob({
 *   name: 'notifications:send-email',
 *   schema: z.object({
 *     to: z.string().email(),
 *     subject: z.string(),
 *     body: z.string(),
 *   }),
 *   handler: async (data, ctx) => {
 *     // Send email
 *     return { sent: true };
 *   },
 * });
 *
 * // Define a schedule
 * export const dailyCleanup = defineSchedule({
 *   name: 'maintenance:daily-cleanup',
 *   schedule: {
 *     type: 'cron',
 *     pattern: '0 2 * * *',
 *   },
 *   schema: z.object({}),
 *   handler: async (data, ctx) => {
 *     // Cleanup logic
 *     return { cleaned: true };
 *   },
 * });
 *
 * // Define a flow
 * export const processOrderFlow = defineFlow({
 *   name: 'orders:process-flow',
 *   schema: z.object({
 *     orderId: z.string(),
 *   }),
 *   flow: (input) => [
 *     {
 *       id: 'validate',
 *       job: validateOrderJob,
 *       data: { orderId: input.orderId },
 *     },
 *     {
 *       id: 'payment',
 *       job: processPaymentJob,
 *       data: { orderId: input.orderId },
 *       dependsOn: ['validate'],
 *     },
 *     {
 *       id: 'inventory',
 *       job: updateInventoryJob,
 *       data: { orderId: input.orderId },
 *       dependsOn: ['payment'],
 *     },
 *   ],
 * });
 *
 * // Create queue instance
 * const queue = createQueue({
 *   connection: 'redis://localhost:6379',
 * });
 *
 * // Register definitions
 * queue.registerJob(sendEmail);
 * queue.registerSchedule(dailyCleanup);
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
export { defineFlow } from './define-flow.ts';

// Builder API (recommended for better type inference without `as const`)
export { buildFlow, FlowBuilder } from './define-flow-builder.ts';

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
