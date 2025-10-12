import type { z } from 'zod/v4';

import type { FlowDefinition, FlowOptions, FlowStep } from './types/index.ts';

/**
 * Helper type to extract step IDs from a steps array
 */
type ExtractStepIds<T extends readonly FlowStep<unknown, string>[]> = T[number]['id'];

/**
 * Helper type that validates a flow step's dependencies against valid step IDs
 */
type ValidatedFlowStep<TInput, TValidIds extends string> = {
  id: TValidIds;
  job: import('./types/index.ts').JobDefinition<any, any>;
  queueName?: string;
  data: TInput;
  opts?: import('bullmq').JobsOptions;
  dependsOn?: readonly TValidIds[];
};

/**
 * Helper type to validate that all dependencies in a steps array reference valid step IDs
 */
type ValidateDependencies<TSteps extends readonly FlowStep<unknown, string>[]> = TSteps extends readonly ValidatedFlowStep<unknown, ExtractStepIds<TSteps>>[] ? TSteps : never;

/**
 * Configuration for defining a flow
 *
 * @template TInput - Type of input data for the flow
 * @template TStepId - Union type of valid step IDs (inferred from steps array)
 */
export type DefineFlowConfig<TInput, TStepId extends string = string> = {
  /**
   * Unique name for this flow (e.g., 'orders:process-complex')
   */
  name: string;

  /**
   * Zod schema for validating flow input data
   */
  inputSchema: z.ZodType<TInput>;

  /**
   * Function that builds the flow steps from input
   * Returns a flat array of steps with dependency references
   * Each job definition is referenced directly in the steps
   *
   * @example Basic flow
   * ```typescript
   * flow: (input) => [
   *   {
   *     id: 'validate',
   *     job: validateJob,
   *     data: input,
   *   },
   *   {
   *     id: 'payment',
   *     job: processPaymentJob,
   *     data: { amount: input.amount },
   *     dependsOn: ['validate'], // Wait for validate to complete
   *   },
   * ]
   * ```
   */
  flow: (input: TInput) => readonly FlowStep<unknown, TStepId>[];

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
 * @template TInput - Type of input data for the flow
 * @template TSteps - Const array of steps (for automatic type inference)
 *
 * **IMPORTANT**: You MUST use `as const` after your flow array to enable type-safe
 * dependency validation. Without `as const`, TypeScript cannot extract literal step IDs,
 * and invalid `dependsOn` references won't be caught at compile time.
 *
 * @example Automatic Step ID Inference (with Type Safety)
 * ```typescript
 * import { defineFlow, defineJob } from '@arki/queue';
 * import { z } from 'zod';
 *
 * const validateJob = defineJob({
 *   name: 'order:validate',
 *   inputSchema: z.object({ orderId: z.string() }),
 *   handler: async (data) => ({ valid: true }),
 * });
 *
 * const processJob = defineJob({
 *   name: 'order:process',
 *   inputSchema: z.object({ orderId: z.string() }),
 *   handler: async (data) => ({ processed: true }),
 * });
 *
 * // Add 'as const' to enable automatic type inference
 * const orderFlow = defineFlow({
 *   name: 'order:process-flow',
 *   inputSchema: z.object({ orderId: z.string() }),
 *   flow: (input) => [
 *     {
 *       id: 'validate',
 *       job: validateJob,
 *       data: input,
 *     },
 *     {
 *       id: 'process',
 *       job: processJob,
 *       data: input,
 *       dependsOn: ['validate'], // ✅ Type-safe! Autocomplete works
 *     },
 *   ] as const, // Important: enables type inference and type-safe dependencies
 * });
 * ```
 *
 * @example Without 'as const' - No Type Safety (DON'T DO THIS)
 * ```typescript
 * // ❌ BAD: Without 'as const', TypeScript cannot validate dependencies
 * const unsafeFlow = defineFlow({
 *   name: 'unsafe-flow',
 *   inputSchema: z.object({ id: z.string() }),
 *   flow: (input) => [
 *     { id: 'step1', job: job1, data: input },
 *     {
 *       id: 'step2',
 *       job: job2,
 *       data: input,
 *       dependsOn: ['step1-typo'], // ❌ No type error! Will fail at runtime
 *     },
 *   ], // Missing 'as const'
 * });
 * ```
 *
 * @example Parallel Steps (Fan-out Pattern)
 * ```typescript
 * const etlFlow = defineFlow({
 *   name: 'data:etl-pipeline',
 *   inputSchema: z.object({ sourceId: z.string() }),
 *   flow: (input) => [
 *     { id: 'extract', job: extractJob, data: input },
 *     // These run in parallel after extract
 *     { id: 'transform-a', job: transformAJob, data: { type: 'A' }, dependsOn: ['extract'] },
 *     { id: 'transform-b', job: transformBJob, data: { type: 'B' }, dependsOn: ['extract'] },
 *     // Load waits for both transforms
 *     { id: 'load', job: loadJob, data: {}, dependsOn: ['transform-a', 'transform-b'] },
 *   ] as const,
 * });
 * ```
 */
// Automatic inference with const array and type-safe dependencies
export function defineFlow<TInput, const TSteps extends readonly FlowStep<unknown, string>[]>(
  config: Omit<DefineFlowConfig<TInput, ExtractStepIds<TSteps>>, 'flow'> & {
    flow: (input: TInput) => ValidateDependencies<TSteps>;
  },
): FlowDefinition<TInput, ExtractStepIds<TSteps>> {
  return {
    name: config.name,
    inputSchema: config.inputSchema,
    flow: config.flow as (input: TInput) => readonly FlowStep<unknown, ExtractStepIds<TSteps>>[],
    options: config.options,
  };
}
