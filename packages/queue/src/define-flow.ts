import type { z } from 'zod/v4';

import type { FlowDefinition, FlowOptions, FlowStep, JobDefinition } from './types/index.ts';

/**
 * Helper type to extract step IDs from a steps array
 */
type ExtractStepIds<T extends readonly FlowStep<unknown, string>[]> = T[number]['id'];

/**
 * Helper type that validates a flow step's dependencies against valid step IDs
 */
type ValidatedFlowStep<TInput, TValidIds extends string> = {
  id: TValidIds;
  job: JobDefinition<any, any>;
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
 * (Legacy) Define a distributed workflow using a plain array.
 *
 * @deprecated It is recommended to use the `buildFlow` builder for a better developer experience and improved type safety without needing `as const`. This function will be removed in a future version.
 *
 * @template TInput - Type of input data for the flow
 * @template TSteps - Const array of steps (for automatic type inference)
 *
 * **IMPORTANT**: You MUST use `as const` after your flow array to enable type-safe
 * dependency validation. Without `as const`, TypeScript cannot extract literal step IDs,
 * and invalid `dependsOn` references won't be caught at compile time.
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
