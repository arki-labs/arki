/**
 * `outboxRunner()`: the `JobRunner` the journal worker calls for `kind = 'queue'` rows. It
 * runs a row exactly as the BullMQ worker runs a job: parse the input, build the context
 * once, run the middleware chain around the handler. A job keeps one retry policy on both lanes.
 */
import type { JobRunner, ScheduledJob } from '@arki/journal';
import { getLogger } from '@arki/log';
import { parseAsync, SchemaError } from '@arki/schema';

import type { JobLike } from '../types/job.ts';
import type { QueueRegistry } from './registry.ts';
import { defaultJobRetry, ReturnedFailureError, throwIfReturnedFailure } from '../job-retry.ts';
import { createJobContext, executeMiddlewareChain, withFeatureServices } from '../middleware.ts';
import { isOutboxError, outboxError, OUTBOX_ERROR_CODES } from './errors.ts';
import { jobsByName } from './registry.ts';

const debugOutbox = getLogger('arki:queue:outbox');

export type OutboxRunnerOptions<TContext> = {
  /** The same nested registry `queue.register()` and `jobs(...)` take. */
  readonly registry: QueueRegistry;
  /** Built once, on the first run, then cached (same rule as `queueWorker`'s `context`). A failure is not cached. */
  readonly context: () => TContext | Promise<TContext>;
  /** The services each top-level branch of the registry runs with, by its key (`RegisterOptions.services`). */
  readonly services?: Readonly<Record<string, object>>;
};

/** What a handler sees as `ctx.job`: the row's id and stored args. Progress and logs go to debug output. */
function jobLikeOf(job: ScheduledJob): JobLike {
  return {
    id: job.id,
    name: job.name,
    data: job.args,
    attemptsMade: job.attempt - 1,
    updateProgress: progress => {
      debugOutbox.debug('[{job}] {jobId} progress {progress}', { job: job.name, jobId: job.id, progress });
      return Promise.resolve();
    },
    log: message => {
      debugOutbox.debug('[{job}] {jobId} {message}', { job: job.name, jobId: job.id, message });
      return Promise.resolve();
    },
  };
}

export function outboxRunner<TContext>(options: OutboxRunnerOptions<TContext>): JobRunner {
  const byName = jobsByName(options.registry);
  // A job's feature services: those of the first top-level branch that lists it, as on the BullMQ lane
  const servicesByName = new Map<string, object>();
  for (const [key, branch] of Object.entries(options.registry)) {
    const services = options.services?.[key];
    if (services === undefined) continue;
    for (const name of jobsByName({ [key]: branch }).keys())
      if (!servicesByName.has(name)) servicesByName.set(name, services);
  }
  let context: Promise<TContext> | undefined;
  const contextOnce = (): Promise<TContext> => {
    context ??= Promise.resolve()
      .then(() => options.context())
      .catch((error: unknown) => {
        context = undefined;
        throw error;
      });
    return context;
  };

  return {
    names: [...byName.keys()],
    async run(job) {
      const definition = byName.get(job.name);
      // A guard: the worker claims only names this runner lists.
      if (definition === undefined)
        throw outboxError(OUTBOX_ERROR_CODES.unknownJob, `outbox: no job named "${job.name}" in the registry`);
      const internal = definition._internal;
      const parsed = await parseAsync(internal.inputSchema, job.args).catch((error: unknown) => {
        if (!(error instanceof SchemaError)) throw error;
        throw outboxError(
          OUTBOX_ERROR_CODES.badStoredArgs,
          `outbox: the stored args of ${job.id} ("${job.name}") fail the job's input schema`,
          error,
        );
      });
      const jobLike = jobLikeOf(job);
      const jobContext = createJobContext(
        withFeatureServices(await contextOnce(), servicesByName.get(job.name)),
        jobLike,
      );
      const result = await executeMiddlewareChain<typeof jobContext, typeof jobContext, unknown>(
        internal.middlewares,
        jobContext,
        parsed,
        jobLike,
        {},
        ctx => internal.handler(parsed, ctx),
      );
      // A returned failure fails the job, as on the BullMQ lane; the backoff decides whether it runs again.
      throwIfReturnedFailure(result);
    },
    retention: job => byName.get(job.name)?._internal.options?.retention,
    retryDelay(job, error) {
      // Stored args that fail the schema fail every time: dead at once, no handler ran.
      if (isOutboxError(error) && error.code === OUTBOX_ERROR_CODES.badStoredArgs) return;
      const retry = byName.get(job.name)?._internal.options?.retry ?? defaultJobRetry;
      return retry.delay(job.attempt, error instanceof ReturnedFailureError ? error.failure : error);
    },
  };
}
