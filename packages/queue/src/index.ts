/**
 * @arki/queue - Background job processing library
 *
 * A declarative API for defining and managing jobs, schedules, and workflows
 * built on top of BullMQ and Redis.
 *
 * @example
 * ```typescript
 * import { createQueue, defineJob, defineSchedule, defineWorkflow } from '@arki/queue';
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
 * // Define a workflow
 * export const processOrder = defineWorkflow({
 *   name: 'orders:process',
 *   schema: z.object({
 *     orderId: z.string(),
 *   }),
 *   steps: async (step, args, ctx) => {
 *     const validation = await step.run('validate', async () => {
 *       return await validateOrder(args.orderId);
 *     });
 *
 *     const [payment, inventory] = await step.parallel([
 *       step.run('payment', async () => processPayment(validation)),
 *       step.run('inventory', async () => updateInventory(validation)),
 *     ]);
 *
 *     return { orderId: args.orderId, status: 'completed' };
 *   },
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
 * queue.registerWorkflow(processOrder);
 *
 * // Start processing
 * await queue.start();
 * ```
 */

// Core API
export { createQueue } from './create-queue.ts';
export { defineJob } from './define-job.ts';
export { defineSchedule } from './define-schedule.ts';
export { defineWorkflow } from './define-workflow.ts';
export { defineFlow } from './define-flow.ts';

// Bull Board UI
export { BullMQAdapter, createBoard, HonoAdapter } from './create-board.ts';

// Queue API for job/queue management
export { createFlowApi, createJobApi, createScheduleApi, createWorkflowApi } from './queue-api.ts';
export type { FlowInfo, JobInfo, QueueStats } from './queue-api.ts';

// Type exports
export type {
  FlowDefinition,
  FlowNode,
  FlowOptions,
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
  StepBuilder,
  WorkflowDefinition,
  WorkflowOptions,
  WorkflowStepFunction,
} from './types/index.ts';

// Constants
export { QUEUE_PRIORITIES } from './types/index.ts';
export type { QueuePriority } from './types/index.ts';
