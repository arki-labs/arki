import type { z } from 'zod/v4';

import type { WorkflowDefinition, WorkflowOptions, WorkflowStepFunction } from './types/index.ts';

/**
 * Define a multi-step workflow
 *
 * Workflows provide step-based execution with automatic retry, parallel/sequential execution,
 * and durability. Each step is independently retryable.
 *
 * @example
 * ```typescript
 * export const processOrder = defineWorkflow({
 *   name: 'orders:process',
 *   schema: z.object({
 *     orderId: z.string(),
 *   }),
 *   steps: async (step, args, ctx) => {
 *     // Step 1: Validate order
 *     const validation = await step.run('validate', async () => {
 *       return await ctx.repositories.orders.validate(args.orderId);
 *     });
 *
 *     if (!validation.valid) {
 *       throw new Error('Order validation failed');
 *     }
 *
 *     // Step 2: Process payment and update inventory in parallel
 *     const [payment, inventory] = await step.parallel([
 *       step.run('payment', async () => {
 *         return await ctx.services.payment.charge(validation.order);
 *       }),
 *       step.run('inventory', async () => {
 *         return await ctx.repositories.inventory.reserve(validation.order.items);
 *       }),
 *     ]);
 *
 *     // Step 3: Send confirmation
 *     await step.run('notify', async () => {
 *       await ctx.services.email.sendOrderConfirmation(args.orderId);
 *     });
 *
 *     return {
 *       orderId: args.orderId,
 *       status: 'completed',
 *       paymentId: payment.id,
 *     };
 *   },
 *   options: {
 *     maxParallelism: 10,
 *     retry: {
 *       attempts: 3,
 *       backoff: { type: 'exponential', delay: 2000 },
 *     },
 *   },
 * });
 * ```
 */
export function defineWorkflow<TInput, TOutput = unknown>(config: {
  /**
   * Unique name for this workflow (e.g., 'orders:process')
   * Use the pattern: featureName:workflowType
   */
  name: string;

  /**
   * Zod schema for validating workflow input
   */
  schema: z.ZodType<TInput>;

  /**
   * Workflow step function
   *
   * The step builder provides methods for running steps:
   * - step.run(name, fn): Run a single step
   * - step.parallel(steps): Run multiple steps in parallel
   * - step.sequence(steps): Run multiple steps sequentially
   * - step.sleep(ms): Sleep for a duration
   */
  steps: WorkflowStepFunction<TInput, TOutput>;

  /**
   * Workflow options
   */
  options?: WorkflowOptions<TInput, TOutput>;
}): WorkflowDefinition<TInput, TOutput> {
  return {
    name: config.name,
    schema: config.schema,
    steps: config.steps,
    options: config.options,
  };
}
