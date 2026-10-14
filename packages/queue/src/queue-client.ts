/**
 * The producer side of a queue: enqueue jobs without running any worker.
 *
 * A job's own `trigger()` only works once a worker registered it in the same
 * process. An API server that enqueues work for a separate worker process
 * needs this client instead. It opens one BullMQ queue per job name, on first
 * use, with the same options the worker uses for that job's queue.
 */

import { Queue } from 'bullmq';

import type { QueueConnection } from './redis-connection.ts';
import type { JobDefinition, JobOptions, TriggerOptions } from './types/job.ts';
import { jobQueueOptions } from './create-queue.ts';
import { debugJob } from './debug.ts';

const DEFAULT_KEY_PREFIX = 'queue:';

export type QueueClientOptions = {
  readonly connection: QueueConnection;
  /** Must match the worker's prefix. Defaults to `'queue:'`, the worker's default. */
  readonly keyPrefix?: string;
};

export type QueueClient = {
  /** Where this client enqueues. A worker that shares the client reads these. */
  readonly connection: QueueConnection;
  readonly keyPrefix: string;
  /** Add one job to its queue. Returns the BullMQ job id. */
  enqueue<TInput, TOutput, TContext>(
    job: JobDefinition<TInput, TOutput, TContext>,
    data: TInput,
    options?: TriggerOptions,
  ): Promise<string>;
};

export type QueueClientHandle = {
  readonly client: QueueClient;
  /** Close every queue the client opened. Safe to call more than once. */
  close(): Promise<void>;
};

export function createQueueClient(options: QueueClientOptions): QueueClientHandle {
  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const queues = new Map<string, Queue>();

  const queueFor = (name: string, jobOptions: JobOptions | undefined): Queue => {
    const existing = queues.get(name);
    if (existing !== undefined) return existing;
    const queue = new Queue(name, jobQueueOptions(jobOptions, options.connection, keyPrefix));
    queues.set(name, queue);
    return queue;
  };

  const client: QueueClient = {
    connection: options.connection,
    keyPrefix,
    async enqueue(job, data, triggerOptions) {
      const name = job._internal.name;
      const queue = queueFor(name, job._internal.options);
      const added = await queue.add(name, data, {
        priority: triggerOptions?.priority,
        delay: triggerOptions?.delay,
        jobId: triggerOptions?.jobId,
        ...triggerOptions?.bullmqOptions,
      });
      debugJob.debug('[{jobName}] Enqueued job {jobId}', { jobName: name, jobId: added.id ?? '' });
      return added.id ?? '';
    },
  };

  return {
    client,
    async close() {
      const open = [...queues.values()];
      queues.clear();
      await Promise.all(open.map(queue => queue.close()));
    },
  };
}
