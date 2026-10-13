/**
 * Job builder implementation
 * Provides chainable API for creating jobs with middleware
 */

import type { z } from '@arki/contracts';

import type { JobBuilderChain, JobBuilderDef } from './types/builder.ts';
import type { JobDefinition, JobHandler, JobOptions } from './types/job.ts';
import type { JobMiddleware } from './types/middleware.ts';
import type { QueueConfig, QueueMeta } from './types/queue.ts';
import { debugBuilder } from './debug.ts';
import { QUEUE_DEFINITION_ERROR_CODES, QueueDefinitionError } from './errors.ts';

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
  debugBuilder.debug('Creating job builder with {middlewaresLength} middleware', {
    middlewaresLength: params.middlewares.length,
  });

  return {
    use<TContextOut2>(middleware: JobMiddleware<TContextOut, TContextOut2, TMeta>) {
      debugBuilder.debug('Adding middleware to job builder (total: {total})', { total: params.middlewares.length + 1 });

      // Type safety: middleware transforms TContextOut -> TContextOut2
      // Runtime: store as unknown array for execution
      return createJobBuilder<TContext, TContextOut2, TMeta>({
        config: params.config,
        middlewares: [...params.middlewares, middleware as JobMiddleware<unknown, unknown, QueueMeta>],
      });
    },

    name(name: string) {
      debugBuilder.debug('Setting job name: {name}', { name });

      // One runtime object serves both typestates: the JobBuilderNeedsInput
      // type hides `.handler()` until `.input()` runs; the throw below backs it up.
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
      debugBuilder.debug('[{value1}] Setting input schema', { value1: state.name ?? 'unnamed' });

      return createJobBuilderChain<TContext, TContextOut, TMeta, TNewInput, TOutput>({
        ...state,
        inputSchema: schema,
        options: undefined, // Reset options when input type changes
      });
    },

    options(options: JobOptions) {
      debugBuilder.debug(
        '[{value1}] Setting job options (retry attempts: {attempts}, maxParallelism: {maxParallelism})',
        {
          value1: state.name ?? 'unnamed',
          attempts: options.retry?.attempts ?? 3,
          maxParallelism: options.maxParallelism ?? 5,
        },
      );

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
        throw new QueueDefinitionError({
          code: QUEUE_DEFINITION_ERROR_CODES.missingName,
          message: 'Job name is required. Call .name() first.',
          remediation: 'Start the job with q.job.name("feature:action") before .handler().',
        });
      }

      if (!state.inputSchema) {
        throw new QueueDefinitionError({
          code: QUEUE_DEFINITION_ERROR_CODES.missingInput,
          message: 'Input schema is required. Call .input() before .handler().',
          remediation: 'Add .input(schema) before .handler(); use z.object({}) for a job that takes no data.',
        });
      }

      debugBuilder.debug('[{stateName}] Creating job definition with {middlewaresLength} middleware', {
        stateName: state.name,
        middlewaresLength: state.middlewares.length,
      });

      type ActualInput = THandlerInput extends never ? TInput : THandlerInput;
      type ActualOutput = THandlerOutput extends never ? TOutput : THandlerOutput;

      const jobName = state.name;

      const definition: JobDefinition<ActualInput, ActualOutput, TContextOut> = {
        _type: 'job',
        _internal: {
          name: jobName,
          inputSchema: state.inputSchema as z.ZodType<ActualInput>,
          handler: handler as JobHandler<ActualInput, ActualOutput, TContextOut>,
          options: state.options,
          // Middleware array stored for runtime execution
          middlewares: state.middlewares,
        },
        trigger: async (data, options) => {
          const queue = definition._internal._queue;
          if (!queue) {
            throw new Error(
              `Job "${jobName}" is not registered with a queue. ` + `Call queue.register() before calling trigger().`,
            );
          }

          debugBuilder.debug('[{jobName}] Triggering job with options: {options}', () => ({
            jobName,
            options: JSON.stringify(options),
          }));

          const job = await queue.add(jobName, data, {
            priority: options?.priority,
            delay: options?.delay,
            jobId: options?.jobId,
            ...options?.bullmqOptions,
          });

          debugBuilder.debug('[{jobName}] Job triggered with ID: {ID}', { jobName, ID: job.id });
          return job.id ?? '';
        },
      };

      return definition;
    },
  };
}
