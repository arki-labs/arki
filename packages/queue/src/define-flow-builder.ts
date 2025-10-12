import type { JobsOptions } from 'bullmq';
import type { z } from 'zod/v4';

import type { FlowDefinition, FlowOptions, FlowStep, JobDefinition } from './types/index.ts';

/**
 * Builder class for creating type-safe flows with automatic dependency validation
 *
 * @template TInput - Type of input data for the flow
 * @template TStepIds - Union type of all step IDs defined so far
 */
export class FlowBuilder<TInput, TStepIds extends string = never> {
  private steps: Array<FlowStep<unknown, string>> = [];

  constructor(
    private readonly name: string,
    private readonly inputSchema: z.ZodType<TInput>,
    private readonly options?: FlowOptions,
  ) {}

  /**
   * Add a step to the flow
   *
   * @template TId - Literal type of the step ID
   * @param id - Unique identifier for this step (must not duplicate existing IDs)
   * @param config - Step configuration
   * @returns Builder instance with updated type including the new step ID
   *
   * @example
   * ```typescript
   * const flow = defineFlow('my-flow', inputSchema)
   *   .step('validate', {
   *     job: validateJob,
   *     data: input => input,
   *   })
   *   .step('process', {
   *     job: processJob,
   *     data: input => input,
   *     dependsOn: ['validate'], // ✅ Type-safe! Only 'validate' is valid
   *   })
   *   .build();
   * ```
   */
  step<const TId extends string>(
    id: TId extends TStepIds ? never : TId, // Prevent duplicate step IDs
    config: {
      /**
       * Job definition to execute for this step
       */
      job: JobDefinition<any, any>;

      /**
       * Function to derive step data from flow input
       */
      data: (input: TInput) => unknown;

      /**
       * Optional custom queue name (defaults to job name)
       */
      queueName?: string;

      /**
       * Optional BullMQ job options
       */
      opts?: JobsOptions;

      /**
       * Array of step IDs this step depends on
       * Only step IDs from previously defined steps are valid
       */
      dependsOn?: readonly TStepIds[];
    },
  ): FlowBuilder<TInput, TStepIds | TId> {
    const stepConfig: FlowStep<unknown, string> = {
      id,
      job: config.job,
      queueName: config.queueName,
      data: config.data,
      opts: config.opts,
      dependsOn: config.dependsOn as readonly string[] | undefined,
    };

    this.steps.push(stepConfig);

    return this as unknown as FlowBuilder<TInput, TStepIds | TId>;
  }

  /**
   * Build the final flow definition
   *
   * @returns FlowDefinition that can be used with FlowProducer
   */
  build(): FlowDefinition<TInput, TStepIds> {
    return {
      name: this.name,
      inputSchema: this.inputSchema,
      flow: ((input: TInput) => {
        // Evaluate data functions with input
        return this.steps.map(step => ({
          ...step,
          data: typeof step.data === 'function' ? (step.data as (input: TInput) => unknown)(input) : step.data,
        }));
      }) as unknown as (input: TInput) => readonly FlowStep<unknown, TStepIds>[],
      options: this.options,
    };
  }
}

/**
 * Create a new flow builder
 *
 * This is the recommended way to define flows with type-safe dependency validation.
 * Unlike `defineFlow`, this approach doesn't require `as const` annotations.
 *
 * @template TInput - Type of input data for the flow
 * @param name - Unique name for the flow
 * @param inputSchema - Zod schema for validating flow input
 * @param options - Optional flow configuration
 * @returns FlowBuilder instance for chaining step definitions
 *
 * @example Basic flow
 * ```typescript
 * import { buildFlow, defineJob } from '@arki/queue';
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
 * const orderFlow = buildFlow(
 *   'order:process-flow',
 *   z.object({ orderId: z.string() })
 * )
 *   .step('validate', {
 *     job: validateJob,
 *     data: input => input,
 *   })
 *   .step('process', {
 *     job: processJob,
 *     data: input => input,
 *     dependsOn: ['validate'], // ✅ Type-safe! Autocomplete works
 *   })
 *   .build();
 * ```
 *
 * @example Parallel steps (fan-out pattern)
 * ```typescript
 * const etlFlow = buildFlow(
 *   'data:etl-pipeline',
 *   z.object({ sourceId: z.string() })
 * )
 *   .step('extract', {
 *     job: extractJob,
 *     data: input => input,
 *   })
 *   .step('transform-a', {
 *     job: transformAJob,
 *     data: input => ({ type: 'A' }),
 *     dependsOn: ['extract'],
 *   })
 *   .step('transform-b', {
 *     job: transformBJob,
 *     data: input => ({ type: 'B' }),
 *     dependsOn: ['extract'],
 *   })
 *   .step('load', {
 *     job: loadJob,
 *     data: input => ({}),
 *     dependsOn: ['transform-a', 'transform-b'], // Wait for both
 *   })
 *   .build();
 * ```
 */
export function buildFlow<TInput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
  options?: FlowOptions,
): FlowBuilder<TInput, never> {
  return new FlowBuilder(name, inputSchema, options);
}
