import type { z } from 'zod/v4';

import type { FlowDefinition, FlowNode, FlowOptions, JobDefinition } from './types/index.ts';

/**
 * Configuration for defining a flow
 */
export type DefineFlowConfig<TInput, TJobs extends Record<string, JobDefinition<unknown, unknown>>> = {
  /**
   * Unique name for this flow (e.g., 'orders:process-complex')
   */
  name: string;

  /**
   * Zod schema for validating flow input
   */
  schema: z.ZodType<TInput>;

  /**
   * Job definitions that can be used in the flow
   * Each job will be registered independently and can be monitored/retried separately
   */
  jobs: TJobs;

  /**
   * Function that builds the flow graph from input
   * Receives a map of job names and the input data
   * Returns the root FlowNode describing the flow structure
   *
   * @example
   * ```typescript
   * flow: (jobs, input) => ({
   *   name: jobs.validate,
   *   data: input,
   *   children: [
   *     {
   *       name: jobs.process,
   *       data: { validatedInput: input },
   *       children: [
   *         { name: jobs.notify, data: { result: 'success' } }
   *       ]
   *     }
   *   ]
   * })
   * ```
   */
  flow: (jobs: { [K in keyof TJobs]: string }, input: TInput) => FlowNode;

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
 * - Complex dependency graphs (parent-child relationships)
 *
 * For simpler sequential workflows, consider using `defineWorkflow` instead.
 *
 * @example Basic Flow
 * ```typescript
 * import { defineFlow } from '@arki/queue';
 * import { z } from 'zod/v4';
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
 *   name: 'order:complex-process',
 *   schema: z.object({ orderId: z.string() }),
 *   jobs: {
 *     validate: validateJob,
 *     process: processJob,
 *     notify: notifyJob,
 *   },
 *   flow: (jobs, input) => ({
 *     name: jobs.validate,
 *     data: input,
 *     children: [
 *       {
 *         name: jobs.process,
 *         data: input,
 *         children: [
 *           { name: jobs.notify, data: input }
 *         ]
 *       }
 *     ]
 *   }),
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
 * @example Complex Flow with Parallel Steps
 * ```typescript
 * const complexFlow = defineFlow({
 *   name: 'data:etl-pipeline',
 *   schema: z.object({ sourceId: z.string() }),
 *   jobs: {
 *     extract: extractJob,
 *     transformA: transformAJob,
 *     transformB: transformBJob,
 *     load: loadJob,
 *   },
 *   flow: (jobs, input) => ({
 *     name: jobs.extract,
 *     data: input,
 *     children: [
 *       // Parallel transformations
 *       {
 *         name: jobs.transformA,
 *         data: { type: 'A' },
 *         children: [{ name: jobs.load, data: { target: 'A' } }]
 *       },
 *       {
 *         name: jobs.transformB,
 *         data: { type: 'B' },
 *         children: [{ name: jobs.load, data: { target: 'B' } }]
 *       }
 *     ]
 *   }),
 * });
 * ```
 */
export function defineFlow<TInput, TJobs extends Record<string, JobDefinition<unknown, unknown>>>(
  config: DefineFlowConfig<TInput, TJobs>,
): FlowDefinition<TInput, TJobs> {
  return {
    name: config.name,
    schema: config.schema,
    jobs: config.jobs,
    flow: config.flow,
    options: config.options,
  };
}
