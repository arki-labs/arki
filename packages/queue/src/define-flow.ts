import type { z } from 'zod/v4';

import type { FlowDefinition, FlowOptions, FlowStep } from './types/index.ts';

/**
 * Configuration for defining a flow
 */
export type DefineFlowConfig<TInput> = {
  /**
   * Unique name for this flow (e.g., 'orders:process-complex')
   */
  name: string;

  /**
   * Zod schema for validating flow input
   */
  schema: z.ZodType<TInput>;

  /**
   * Function that builds the flow steps from input
   * Returns a flat array of steps with dependency references
   * Each job definition is referenced directly in the steps
   *
   * @example
   * ```typescript
   * flow: (input) => [
   *   {
   *     id: 'validate',
   *     job: validateJob,  // Direct reference to job definition
   *     data: input,
   *   },
   *   {
   *     id: 'payment',
   *     job: processPaymentJob,
   *     data: { amount: input.amount },
   *     dependsOn: ['validate'], // Wait for validate to complete
   *   },
   *   {
   *     id: 'inventory',
   *     job: updateInventoryJob,
   *     data: input,
   *     dependsOn: ['payment'], // Wait for payment
   *   },
   *   {
   *     id: 'notify',
   *     job: sendNotificationJob,
   *     data: { message: 'Order complete' },
   *     dependsOn: ['payment'], // Runs in parallel with inventory
   *   },
   * ]
   * ```
   */
  flow: (input: TInput) => FlowStep[];

  /**
   * Optional flow configuration
   */
  options?: FlowOptions;
};

/**
 * Define a distributed workflow using BullMQ's FlowProducer
 *
 * Flows are useful when you need:
 * - Step-level retry and error handling (each job can retry independently)
 * - Better observability (monitor each step separately in Bull Board)
 * - True distribution (steps can run on different workers)
 * - Complex dependency graphs (any step can depend on multiple other steps)
 *
 * For simpler sequential workflows, consider using `defineWorkflow` instead.
 *
 * @example Basic Flow with Dependencies
 * ```typescript
 * import { defineFlow, defineJob } from '@arki/queue';
 * import { z } from 'zod';
 *
 * const validateJob = defineJob({
 *   name: 'order:validate',
 *   schema: z.object({ orderId: z.string() }),
 *   handler: async (data) => {
 *     // Validation logic
 *     return { valid: true };
 *   },
 * });
 *
 * const processJob = defineJob({
 *   name: 'order:process',
 *   schema: z.object({ orderId: z.string() }),
 *   handler: async (data) => {
 *     // Processing logic
 *     return { processed: true };
 *   },
 * });
 *
 * const notifyJob = defineJob({
 *   name: 'order:notify',
 *   schema: z.object({ orderId: z.string() }),
 *   handler: async (data) => {
 *     // Notification logic
 *     return { notified: true };
 *   },
 * });
 *
 * const orderFlow = defineFlow({
 *   name: 'order:process-flow',
 *   schema: z.object({ orderId: z.string() }),
 *   flow: (input) => [
 *     {
 *       id: 'validate-step',
 *       job: validateJob,
 *       data: input,
 *     },
 *     {
 *       id: 'process-step',
 *       job: processJob,
 *       data: input,
 *       dependsOn: ['validate-step'],
 *     },
 *     {
 *       id: 'notify-step',
 *       job: notifyJob,
 *       data: input,
 *       dependsOn: ['process-step'],
 *     },
 *   ],
 * });
 *
 * // Register with queue
 * queue.registerFlow(orderFlow);
 *
 * // Execute the flow
 * const flowApi = createFlowApi(orderFlow);
 * await flowApi.add('process-order-123', { orderId: '123' });
 * ```
 *
 * @example Parallel Steps (Fan-out Pattern)
 * ```typescript
 * const etlFlow = defineFlow({
 *   name: 'data:etl-pipeline',
 *   schema: z.object({ sourceId: z.string() }),
 *   flow: (input) => [
 *     {
 *       id: 'extract',
 *       job: extractJob,
 *       data: input,
 *     },
 *     // These run in parallel after extract completes
 *     {
 *       id: 'transform-a',
 *       job: transformAJob,
 *       data: { type: 'A' },
 *       dependsOn: ['extract'],
 *     },
 *     {
 *       id: 'transform-b',
 *       job: transformBJob,
 *       data: { type: 'B' },
 *       dependsOn: ['extract'],
 *     },
 *     // Load waits for both transforms
 *     {
 *       id: 'load',
 *       job: loadJob,
 *       data: {},
 *       dependsOn: ['transform-a', 'transform-b'],
 *     },
 *   ],
 * });
 * ```
 *
 * @example Complex DAG with Multiple Dependencies
 * ```typescript
 * const complexFlow = defineFlow({
 *   name: 'ml:training-pipeline',
 *   schema: z.object({ modelId: z.string() }),
 *   flow: (input) => [
 *     {
 *       id: 'fetch',
 *       job: fetchDataJob,
 *       data: input,
 *     },
 *     {
 *       id: 'preprocess',
 *       job: preprocessJob,
 *       data: input,
 *       dependsOn: ['fetch'],
 *     },
 *     {
 *       id: 'train',
 *       job: trainModelJob,
 *       data: input,
 *       dependsOn: ['preprocess'],
 *     },
 *     {
 *       id: 'validate',
 *       job: validateModelJob,
 *       data: input,
 *       dependsOn: ['train'],
 *     },
 *     {
 *       id: 'deploy',
 *       job: deployModelJob,
 *       data: input,
 *       dependsOn: ['validate'],
 *     },
 *     {
 *       id: 'notify',
 *       job: notifyJob,
 *       data: { message: 'Deployment complete' },
 *       dependsOn: ['deploy'],
 *     },
 *   ],
 * });
 * ```
 */
export function defineFlow<TInput>(config: DefineFlowConfig<TInput>): FlowDefinition<TInput> {
  return {
    name: config.name,
    schema: config.schema,
    flow: config.flow,
    options: config.options,
  };
}
