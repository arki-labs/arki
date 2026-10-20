/**
 * The producer side of a queue: enqueue jobs without running any worker.
 *
 * A job's own `trigger()` only works once a worker registered it in the same
 * process. An API server that enqueues work for a separate worker process
 * needs this client instead. It opens one BullMQ queue per job name, on first
 * use, with the same options the worker uses for that job's queue. Flows go
 * through one BullMQ `FlowProducer`, also opened on first use.
 */

import { FlowProducer, Queue } from 'bullmq';

import type { FlowEnqueueFailure } from './flow-jobs.ts';
import type { QueueConnection } from './redis-connection.ts';
import type { JobTriggerResult } from './trigger.ts';
import type { FlowDefinition, FlowEnqueueResult, QueueEnqueue } from './types/builder.ts';
import type { AnyJobDefinition, JobDefinition, JobOptions, TriggerOptions } from './types/job.ts';
import { jobQueueOptions } from './create-queue.ts';
import { debugJob, observeQueue } from './debug.ts';
import { addFlow } from './flow-jobs.ts';
import { jobRetryOptions } from './job-options.ts';
import { jobTraceOptions } from './job-trace.ts';
import { parseRedisConnection } from './redis-connection.ts';
import { triggerValidated } from './trigger.ts';

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
  /**
   * Add one job to its queue (returns the BullMQ job id), or start a flow:
   * validate `input` with the flow's schema, then add every step's job.
   */
  enqueue: QueueEnqueue;
};

export type QueueClientHandle = {
  readonly client: QueueClient;
  /** Close every queue (and the flow producer) the client opened. Safe to call more than once. */
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

  let flowProducer: FlowProducer | undefined;

  function enqueue<TInput, TOutput, TContext>(
    job: JobDefinition<TInput, TOutput, TContext>,
    data: TInput,
    options?: TriggerOptions,
  ): Promise<JobTriggerResult>;
  function enqueue<TInput>(
    flow: FlowDefinition<TInput>,
    input: NoInfer<TInput>,
  ): Promise<FlowEnqueueResult | FlowEnqueueFailure>;
  async function enqueue(
    target: AnyJobDefinition | FlowDefinition,
    data: unknown,
    triggerOptions?: TriggerOptions,
  ): Promise<JobTriggerResult | FlowEnqueueResult | FlowEnqueueFailure> {
    if (target._type === 'flow') {
      return addFlow(
        () =>
          (flowProducer ??= new FlowProducer({
            connection: parseRedisConnection(options.connection),
            prefix: keyPrefix,
          })),
        target,
        data,
      );
    }
    const name = target._internal.name;
    return triggerValidated(
      target._internal.inputSchema,
      data,
      triggerOptions?.bullmqOptions?.jobId ?? triggerOptions?.jobId,
      async key => {
        const queue = queueFor(name, target._internal.options);
        const added = await queue.add(name, data, {
          ...jobTraceOptions(),
          priority: triggerOptions?.priority,
          delay: triggerOptions?.delay,
          ...triggerOptions?.bullmqOptions,
          jobId: key,
          ...jobRetryOptions(target._internal.options),
        });
        observeQueue(() =>
          debugJob.debug('[{jobName}] Enqueued job {jobId}', { jobName: name, jobId: added.id ?? '' }),
        );
        return added.id;
      },
    );
  }

  const client: QueueClient = {
    connection: options.connection,
    keyPrefix,
    enqueue,
  };

  return {
    client,
    async close() {
      const open = [...queues.values()];
      const openFlowProducer = flowProducer;
      queues.clear();
      flowProducer = undefined;
      await Promise.all([...open.map(queue => queue.close()), openFlowProducer?.close()]);
    },
  };
}
