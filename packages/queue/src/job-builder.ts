import type { Failure } from '@arki/failure';
/**
 * Job builder implementation
 * Provides chainable API for creating jobs with middleware
 */

import type { StandardSchemaV1 } from '@arki/schema';

import type { JobTriggerResult } from './trigger.ts';
import type { JobBuilderChain, JobBuilderDef } from './types/builder.ts';
import type { InternalJobDefinition, JobDefinition, JobOptions, TriggerOptions } from './types/job.ts';
import type { JobMiddleware } from './types/middleware.ts';
import type { AroundJobMiddleware, FitsContext, StepJobMiddleware } from './step.ts';
import type { QueueConfig, QueueMeta } from './types/queue.ts';
import { debugBuilder, observeQueue } from './debug.ts';
import { withEnqueueSpan } from './enqueue-span.ts';
import { QUEUE_DEFINITION_ERROR_CODES, QueueDefinitionError } from './errors.ts';
import { jobRetryOptions } from './job-options.ts';
import { defaultJobRetry, jobAttempts } from './job-retry.ts';
import { jobTraceOptions } from './job-trace.ts';
import { QueueUnavailable } from './errors.ts';
import { triggerValidated } from './trigger.ts';

/** The characters both BullMQ and pg-boss accept in a queue name; a job name is its queue name. */
const JOB_NAME_PATTERN = /^[\w\-./]+$/;

/**
 * Internal state for job builder
 */
type JobBuilderState<TInput, TFailure extends Failure> = {
  config: QueueConfig;
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta, TFailure>[];
  name?: string;
  inputSchema?: StandardSchemaV1<unknown, TInput>;
  options?: JobOptions;
};

/**
 * Create a job builder
 * @internal
 */
export function createJobBuilder<
  TContext,
  TContextOut,
  TMeta extends QueueMeta,
  TFailure extends Failure = never,
>(params: {
  config: QueueConfig;
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta, TFailure>[];
}): JobBuilderDef<TContext, TContextOut, TMeta, TFailure> {
  observeQueue(() =>
    debugBuilder.debug('Creating job builder with {middlewaresLength} middleware', {
      middlewaresLength: params.middlewares.length,
    }),
  );

  // `step(fn)` and `around(fn)` are middleware too: the overloads on `JobBuilderDef.use` type them,
  // and the chain runs them like any other, so one implementation stores all three.
  // Erasure seam: the overloads above carry the types; the implementation returns `unknown`
  // because their builders differ in context and failure types, which no one return type spans.
  function use<TIn, TAdded extends object, TRefused extends Failure>(
    middleware: StepJobMiddleware<TIn, TAdded, TRefused> & FitsContext<TContextOut, TIn>,
  ): JobBuilderDef<TContext, TContextOut & TAdded, TMeta, TFailure | TRefused>;
  function use<TIn>(
    middleware: AroundJobMiddleware<TIn> & FitsContext<TContextOut, TIn>,
  ): JobBuilderDef<TContext, TContextOut, TMeta, TFailure>;
  function use<TContextOut2, TNextFailure extends Failure = never>(
    middleware: JobMiddleware<TContextOut, TContextOut2, TMeta, TNextFailure> & { readonly _adapter?: never },
  ): JobBuilderDef<TContext, TContextOut2, TMeta, TFailure | TNextFailure>;
  function use(middleware: { readonly _type: 'middleware' }): unknown {
    observeQueue(() =>
      debugBuilder.debug('Adding middleware to job builder (total: {total})', {
        total: params.middlewares.length + 1,
      }),
    );

    return createJobBuilder<TContext, unknown, TMeta, Failure>({
      config: params.config,
      // Erasure seam (as before): the overloads proved the middleware fits this builder's context;
      // the chain runs on `unknown` contexts.
      middlewares: [...params.middlewares, middleware as JobMiddleware<unknown, unknown, QueueMeta, Failure>],
    });
  }

  return {
    use,

    name(name: string) {
      observeQueue(() => debugBuilder.debug('Setting job name: {name}', { name }));
      if (!JOB_NAME_PATTERN.test(name)) {
        throw new QueueDefinitionError({
          code: QUEUE_DEFINITION_ERROR_CODES.invalidJobName,
          message: `Job name "${name}" has characters a queue name cannot hold. Use only letters, digits, "_", "-", "." and "/".`,
          remediation: 'A job name is its queue name. Write it like q.job.name("feature.action"); ":" is not allowed.',
        });
      }

      // One runtime object serves both typestates: the JobBuilderNeedsInput
      // type hides `.handler()` until `.input()` runs; the throw below backs it up.
      return createJobBuilderChain<TContext, TContextOut, TMeta, never, never, TFailure>({
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
function createJobBuilderChain<
  TContext,
  TContextOut,
  TMeta extends QueueMeta,
  TInput,
  TOutput,
  TFailure extends Failure,
>(state: JobBuilderState<TInput, TFailure>): JobBuilderChain<TContext, TContextOut, TMeta, TInput, TOutput, TFailure> {
  return {
    input<TNewInput>(schema: StandardSchemaV1<unknown, TNewInput>) {
      observeQueue(() => debugBuilder.debug('[{value1}] Setting input schema', { value1: state.name ?? 'unnamed' }));

      return createJobBuilderChain<TContext, TContextOut, TMeta, TNewInput, TOutput, TFailure>({
        ...state,
        inputSchema: schema,
        options: undefined, // Reset options when input type changes
      });
    },

    options(options: JobOptions) {
      observeQueue(() =>
        debugBuilder.debug(
          '[{value1}] Setting job options (retry attempts: {attempts}, maxParallelism: {maxParallelism})',
          {
            value1: state.name ?? 'unnamed',
            attempts: jobAttempts(options.retry ?? defaultJobRetry),
            maxParallelism: options.maxParallelism ?? 5,
          },
        ),
      );

      return createJobBuilderChain<TContext, TContextOut, TMeta, TInput, TOutput, TFailure>({
        ...state,
        options: options,
      });
    },

    handler<TResult>(
      handler: (data: TInput, ctx: TContextOut) => Promise<TResult>,
    ): JobDefinition<TInput, TResult | TFailure, TContextOut> {
      if (!state.name) {
        throw new QueueDefinitionError({
          code: QUEUE_DEFINITION_ERROR_CODES.missingName,
          message: 'Job name is required. Call .name() first.',
          remediation: 'Start the job with q.job.name("feature.action") before .handler().',
        });
      }

      if (!state.inputSchema) {
        throw new QueueDefinitionError({
          code: QUEUE_DEFINITION_ERROR_CODES.missingInput,
          message: 'Input schema is required. Call .input() before .handler().',
          remediation: 'Add .input(schema) before .handler(); use z.object({}) for a job that takes no data.',
        });
      }

      observeQueue(() =>
        debugBuilder.debug('[{stateName}] Creating job definition with {middlewaresLength} middleware', {
          stateName: state.name,
          middlewaresLength: state.middlewares.length,
        }),
      );

      const jobName = state.name;

      const definition: JobDefinition<TInput, TResult | TFailure, TContextOut> = {
        _type: 'job',
        _internal: {
          name: jobName,
          inputSchema: state.inputSchema,
          handler,
          options: state.options,
          // Middleware array stored for runtime execution
          middlewares: state.middlewares,
        },
        trigger: (data, options) => triggerJob(definition._internal, data, options),
      };

      return definition;
    },
  };
}

/**
 * A job's `trigger()`: add to the queue `register()` stored on the definition. A renamed copy
 * of a job (a feature instance's, `send-mail#eu`) triggers through its own queue the same way.
 * @internal
 */
export async function triggerJob<TInput, TOutput, TDeps>(
  internal: InternalJobDefinition<TInput, TOutput, TDeps>,
  data: TInput,
  options?: TriggerOptions,
): Promise<JobTriggerResult> {
  if (internal._trigger !== undefined) return internal._trigger(data, options);
  const jobName = internal.name;
  const queue = internal._queue;
  if (!queue) {
    return withEnqueueSpan(() => QueueUnavailable(), jobName);
  }

  observeQueue(() =>
    debugBuilder.debug('[{jobName}] Triggering job with options: {options}', () => ({
      jobName,
      options: JSON.stringify(options),
    })),
  );

  return triggerValidated(
    internal.inputSchema,
    data,
    options?.bullmqOptions?.jobId ?? options?.jobId,
    async key => {
      const job = await queue.add(jobName, data, {
        ...jobTraceOptions(),
        priority: options?.priority,
        delay: options?.delay,
        ...options?.bullmqOptions,
        jobId: key,
        ...jobRetryOptions(internal.options),
      });

      observeQueue(() => debugBuilder.debug('[{jobName}] Job triggered with ID: {ID}', { jobName, ID: job.id }));
      return job.id;
    },
    jobName,
  );
}
