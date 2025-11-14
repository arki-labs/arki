/**
 * Job builder implementation
 * Provides chainable API for creating jobs with middleware
 */

import type { z } from '@arki/contracts';

import type { JobBuilderChain, JobBuilderDef } from './types/builder.ts';
import type { JobDefinition, JobHandler, JobOptions } from './types/job.ts';
import type { JobMiddleware } from './types/middleware.ts';
import type { QueueConfig, QueueMeta } from './types/queue.ts';

/**
 * Internal state for job builder
 */
type JobBuilderState<TInput> = {
  config: QueueConfig;
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta>[];
  name?: string;
  inputSchema?: z.ZodType<TInput>;
  options?: JobOptions;
};

/**
 * Create a job builder
 * @internal
 */
export function createJobBuilder<TContext, TContextOut, TMeta extends QueueMeta>(params: {
  config: QueueConfig;
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta>[];
}): JobBuilderDef<TContext, TContextOut, TMeta> {
  return {
    use<TContextOut2>(middleware: JobMiddleware<TContextOut, TContextOut2, TMeta>) {
      // Type safety: middleware transforms TContextOut -> TContextOut2
      // Runtime: store as unknown array for execution
      return createJobBuilder<TContext, TContextOut2, TMeta>({
        config: params.config,
        middlewares: [...params.middlewares, middleware as JobMiddleware<unknown, unknown, QueueMeta>],
      });
    },

    name(name: string) {
      return createJobBuilderChain<TContext, TContextOut, TMeta, never, never>({
        config: params.config,
        middlewares: params.middlewares,
        name,
      });
    },
  };
}

/**
 * Create a job builder chain (after name is set)
 * @internal
 */
function createJobBuilderChain<TContext, TContextOut, TMeta extends QueueMeta, TInput, TOutput>(
  state: JobBuilderState<TInput>,
): JobBuilderChain<TContext, TContextOut, TMeta, TInput, TOutput> {
  return {
    input<TNewInput>(schema: z.ZodType<TNewInput>) {
      return createJobBuilderChain<TContext, TContextOut, TMeta, TNewInput, TOutput>({
        ...state,
        inputSchema: schema,
        options: undefined, // Reset options when input type changes
      });
    },

    options(options: JobOptions) {
      return createJobBuilderChain<TContext, TContextOut, TMeta, TInput, TOutput>({
        ...state,
        options: options,
      });
    },

    handler<THandlerInput = TInput, THandlerOutput = TOutput>(
      handler: (
        data: THandlerInput extends never ? TInput : THandlerInput,
        ctx: TContextOut,
      ) => Promise<THandlerOutput extends never ? TOutput : THandlerOutput>,
    ): JobDefinition<
      THandlerInput extends never ? TInput : THandlerInput,
      THandlerOutput extends never ? TOutput : THandlerOutput,
      TContextOut
    > {
      if (!state.name) {
        throw new Error('Job name is required. Call .name() first.');
      }

      if (!state.inputSchema) {
        throw new Error('Input schema is required. Call .input() before .handler().');
      }

      type ActualInput = THandlerInput extends never ? TInput : THandlerInput;
      type ActualOutput = THandlerOutput extends never ? TOutput : THandlerOutput;

      return {
        _type: 'job',
        _internal: {
          name: state.name,
          inputSchema: state.inputSchema as z.ZodType<ActualInput>,
          handler: handler as JobHandler<ActualInput, ActualOutput, TContextOut>,
          options: state.options,
          // Middleware array stored for runtime execution
          middlewares: state.middlewares,
        },
      };
    },
  };
}
