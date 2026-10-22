/**
 * Queue instance implementation for v2.0
 *
 * Integrates with initQueue builder pattern and supports:
 * - Job registration and execution with middleware
 * - Schedule registration (cron and interval)
 * - Flow registration (multi-step workflows)
 * - Registry traversal (nested job organization)
 */

import type { Job as BullMQJob, QueueOptions, RepeatOptions } from 'bullmq';
import { FlowProducer, Queue, Worker } from 'bullmq';

import type { InternalFlowDefinition } from './flow-builder.ts';
import type { FlowEnqueueFailure } from './flow-jobs.ts';
import type { JobExecutionFailure } from './job-outcome.ts';
import type { QueueConnection } from './redis-connection.ts';
import type { InternalScheduleDefinition } from './schedule-builder.ts';
import type { JobTriggerResult } from './trigger.ts';
import type {
  BullMQQueueInstance,
  FlowDefinition,
  FlowEnqueueResult,
  RegisterOptions,
  ScheduleDefinition,
} from './types/builder.ts';
import type { AnyJobDefinition, JobDefinition, JobOptions, TriggerOptions } from './types/job.ts';
import { debugFlow, debugJob, debugRegister, debugSchedule, debugWorker, observeQueue } from './debug.ts';
import { withEnqueueSpan } from './enqueue-span.ts';
import { duplicateScheduleError } from './errors.ts';
import { addFlow } from './flow-jobs.ts';
import { jobDefaultOptions } from './job-options.ts';
import { executeJob } from './job-outcome.ts';
import { defaultJobRetry, jobAttempts, throwIfReturnedFailure, workerBackoffStrategy } from './job-retry.ts';
import { parseRedisConnection } from './redis-connection.ts';
import { QueueUnavailable } from './errors.ts';

/**
 * Registry type - nested structure of jobs, schedules, and flows
 * Can contain definitions or nested registries
 */
type Registry = {
  [key: string]: JobDefinition<unknown, unknown, unknown> | ScheduleDefinition | FlowDefinition | Registry;
};

/**
 * The BullMQ queue options of one job's queue. Retry defaults live on the
 * queue (not on each `add()`), so every producer of a job — the worker's own
 * `trigger()` and the `queue()` DOT client — must build its queue from this.
 */
export function jobQueueOptions(
  options: JobOptions | undefined,
  connection: QueueConnection,
  keyPrefix: string,
): QueueOptions {
  return {
    connection: parseRedisConnection(connection),
    prefix: keyPrefix,
    defaultJobOptions: jobDefaultOptions(options),
  };
}

/** Job scheduler ids of schedules: `schedule:<schedule name>` on the job's queue */
const SCHEDULER_ID_PREFIX = 'schedule:';

/**
 * The services of the feature that registered a job (`RegisterOptions.services`), undefined
 * outside a feature. A job registered twice keeps its first registration's, like the job itself.
 */
type FeatureServices = object | undefined;

/**
 * Queue instance options
 */
export type QueueInstanceOptions<TContext> = {
  connection: QueueConnection;
  keyPrefix?: string;
  createContext: () => TContext | Promise<TContext>;
};

/**
 * Create a queue instance that can register and run jobs, schedules, and flows
 * @internal - Called by QueueBuilder.createQueue()
 */
export function createQueueInstance<TContext>(options: QueueInstanceOptions<TContext>): BullMQQueueInstance {
  const { connection, keyPrefix = 'queue:', createContext } = options;

  observeQueue(() => debugRegister.debug('Creating queue instance with keyPrefix: {keyPrefix}', { keyPrefix }));

  const connectionConfig = parseRedisConnection(connection);

  // Track registered items
  // Each registered job with the BullMQ queue its worker reads
  const registeredJobs = new Map<string, { definition: JobDefinition<unknown, unknown, TContext>; queue: Queue }>();
  const registeredSchedules = new Map<string, InternalScheduleDefinition>();
  const registeredFlows = new Map<string, InternalFlowDefinition>();

  // Track BullMQ instances
  const queues: Queue[] = [];
  const workers: Worker[] = [];
  // Opened on the first enqueue(flow), closed by stop(), like the client's queues
  let flowProducer: FlowProducer | undefined;
  const startedWorkers = new WeakSet<Worker>();

  /**
   * Register a single job definition
   */
  function registerJobDefinition<TInput, TOutput>(
    definition: JobDefinition<TInput, TOutput, TContext>,
    services: FeatureServices,
  ): Queue {
    const internal = definition._internal;

    observeQueue(() =>
      debugRegister.debug('[{internalName}] Registering job definition', { internalName: internal.name }),
    );

    const existing = registeredJobs.get(internal.name);
    if (existing) {
      observeQueue(() => debugRegister.warn('Job {job} is already registered, skipping', { job: internal.name }));
      return existing.queue;
    }

    // Create BullMQ queue
    observeQueue(() =>
      debugRegister.debug('[{internalName}] Creating BullMQ queue with {value2} retry attempts', {
        internalName: internal.name,
        value2: jobAttempts(internal.options?.retry ?? defaultJobRetry),
      }),
    );
    const queue = new Queue(internal.name, jobQueueOptions(internal.options, connection, keyPrefix));

    // Every job retries through BullMQ's custom backoff, answered by the job's `Backoff`
    const backoffStrategy = workerBackoffStrategy(internal.options?.retry ?? defaultJobRetry);

    // Create BullMQ worker
    observeQueue(() =>
      debugWorker.debug('[{internalName}] Creating worker with concurrency: {concurrency}', {
        internalName: internal.name,
        concurrency: internal.options?.maxParallelism ?? 5,
      }),
    );
    const worker = new Worker(
      internal.name,
      async (job: BullMQJob<TInput, TOutput | JobExecutionFailure | undefined>) => {
        observeQueue(() =>
          debugJob.debug('[{internalName}] Job {jobId} started', { internalName: internal.name, jobId: job.id }),
        );

        const handlerResult = await executeJob(
          internal,
          job,
          createContext,
          services,
          undefined,
          job.opts.telemetry?.metadata,
        );
        // A returned failure fails the job; the backoff decides whether it runs again.
        throwIfReturnedFailure(handlerResult);
        observeQueue(() =>
          debugJob.debug('[{internalName}] Job {jobId} completed successfully', {
            internalName: internal.name,
            jobId: job.id,
          }),
        );
        return handlerResult;
      },
      {
        connection: connectionConfig,
        prefix: keyPrefix,
        autorun: false,
        concurrency: internal.options?.maxParallelism ?? 5,
        ...internal.options?.workerOptions,
        settings: {
          ...internal.options?.workerOptions?.settings,
          backoffStrategy,
        },
      },
    );

    // Error handling
    worker.on('failed', (job: BullMQJob | undefined, error: Error) => {
      const jobId = job?.id ?? 'unknown';
      observeQueue(() => debugJob.error('Job {job} failed (job id {jobId})', { job: internal.name, jobId, error }));
      if (job) {
        observeQueue(() =>
          debugJob.debug('failed job {jobId} data', () => ({ jobId, data: JSON.stringify(job.data) })),
        );
      }
    });

    // Store queue reference on the definition for trigger(), and the worker beside it
    internal._queue = queue;
    internal._worker = worker;

    // Store instances
    queues.push(queue);
    workers.push(worker);
    registeredJobs.set(internal.name, { definition: definition as JobDefinition<unknown, unknown, TContext>, queue });

    observeQueue(() =>
      debugRegister.debug('[{internalName}] Job registered successfully', { internalName: internal.name }),
    );
    return queue;
  }

  /**
   * Register a schedule definition.
   *
   * A schedule is a trigger: it adds its data to the job's own queue through a
   * BullMQ job scheduler (or one delayed job for a timeout), and the job's own
   * worker runs it. It creates no queue or worker of its own.
   */
  async function registerScheduleDefinition(definition: ScheduleDefinition, services: FeatureServices): Promise<void> {
    const internal = definition._internal as InternalScheduleDefinition;
    const jobName = internal.job._internal.name;

    observeQueue(() =>
      debugSchedule.debug('[{internalName}] Registering schedule definition (type: {type}, job: {job})', {
        internalName: internal.name,
        type: internal.type,
        job: jobName,
      }),
    );

    if (registeredSchedules.has(internal.name)) {
      throw duplicateScheduleError(internal.name);
    }

    // Ensure the job is registered, so its worker runs what the schedule adds
    const queue = registeredJobs.get(jobName)?.queue ?? registerJobDefinition(internal.job, services);

    if (internal.type === 'timeout') {
      // Timeout: one-time execution after delay
      observeQueue(() =>
        debugSchedule.debug('[{internalName}] Configuring timeout schedule with delay: {delay}ms', {
          internalName: internal.name,
          delay: internal.value,
        }),
      );
      await queue.add(jobName, internal.data, {
        delay: internal.value as number,
        // BullMQ refuses a custom id with one `:` ("Custom Id cannot contain :")
        jobId: `schedule-${internal.name}`,
      });
    } else {
      // Cron or Interval: repeating execution
      const repeatOptions: Omit<RepeatOptions, 'key'> =
        internal.type === 'cron'
          ? {
              pattern: internal.value as string,
              tz: internal.options?.timezone,
            }
          : {
              every: internal.value as number,
            };

      // An inline schedule's anonymous job queue is the queue older versions
      // gave the schedule itself. There, BullMQ 5 `queue.add(..., { repeat })`
      // left an md5-keyed entry that BullMQ 6 keeps running next to the new
      // one, so every tick would execute twice. Only this package writes to
      // that queue, so any key outside `schedule:` is such a leftover. A
      // wrapped job's queue is never cleaned this way: other keys there may be
      // the app's own repeat jobs.
      if (internal.inline) {
        for (const scheduler of await queue.getJobSchedulers()) {
          if (!scheduler.key.startsWith(SCHEDULER_ID_PREFIX)) {
            observeQueue(() =>
              debugSchedule.debug('[{internalName}] Removing legacy scheduler entry: {entry}', {
                internalName: internal.name,
                entry: scheduler.key,
              }),
            );
            await queue.removeJobScheduler(scheduler.key);
          }
        }
      }

      const schedulerId = `${SCHEDULER_ID_PREFIX}${internal.name}`;
      observeQueue(() =>
        debugSchedule.debug('[{internalName}] Configuring {internalType} schedule with value: {value}', {
          internalName: internal.name,
          internalType: internal.type,
          value: internal.value,
        }),
      );
      await queue.upsertJobScheduler(schedulerId, repeatOptions, { name: jobName, data: internal.data });
    }

    registeredSchedules.set(internal.name, internal);

    observeQueue(() =>
      debugSchedule.debug('[{internalName}] Schedule registered successfully', { internalName: internal.name }),
    );
  }

  /**
   * Remove the schedulers of schedules that are no longer in code.
   *
   * A renamed or deleted schedule leaves `schedule:<old-name>` on its job's
   * queue, and the job's live worker would keep running those ticks. Runs at
   * start(), once every schedule is registered: on each registered job's
   * queue it removes `schedule:` keys that no registered schedule of that job
   * owns. Keys outside the `schedule:` id space are never touched.
   */
  async function pruneStaleSchedulers(): Promise<void> {
    const liveIds = new Map<string, Set<string>>();
    for (const schedule of registeredSchedules.values()) {
      if (schedule.type === 'timeout') continue;
      const jobName = schedule.job._internal.name;
      const ids = liveIds.get(jobName) ?? new Set<string>();
      ids.add(`${SCHEDULER_ID_PREFIX}${schedule.name}`);
      liveIds.set(jobName, ids);
    }

    for (const [jobName, { queue }] of registeredJobs) {
      const live = liveIds.get(jobName);
      for (const scheduler of await queue.getJobSchedulers()) {
        if (scheduler.key.startsWith(SCHEDULER_ID_PREFIX) && !live?.has(scheduler.key)) {
          observeQueue(() =>
            debugSchedule.debug('[{jobName}] Removing scheduler of a schedule no longer registered: {registered}', {
              jobName,
              registered: scheduler.key,
            }),
          );
          await queue.removeJobScheduler(scheduler.key);
        }
      }
    }
  }

  /**
   * Register a flow definition
   */
  function registerFlowDefinition(definition: FlowDefinition, services: FeatureServices): void {
    const internal = definition._internal as InternalFlowDefinition;

    observeQueue(() =>
      debugFlow.debug('[{internalName}] Registering flow definition with {stepsLength} steps', {
        internalName: internal.name,
        stepsLength: internal.steps.length,
      }),
    );

    if (registeredFlows.has(internal.name)) {
      observeQueue(() => debugFlow.warn('Flow {flow} is already registered, skipping', { flow: internal.name }));
      return;
    }

    // Register all jobs used in the flow
    observeQueue(() =>
      debugFlow.debug('[{internalName}] Registering {stepsLength} jobs for flow steps', {
        internalName: internal.name,
        stepsLength: internal.steps.length,
      }),
    );
    for (const step of internal.steps) {
      if (!registeredJobs.has(step.job._internal.name)) {
        observeQueue(() =>
          debugFlow.debug('[{internalName}] Registering job for step: {step}', {
            internalName: internal.name,
            step: step.job._internal.name,
          }),
        );
        registerJobDefinition(step.job, services);
      }
    }

    registeredFlows.set(internal.name, internal);

    observeQueue(() =>
      debugFlow.debug('[{internalName}] Flow registered successfully', { internalName: internal.name }),
    );
  }

  /**
   * Traverse registry and register all items
   */
  async function traverseRegistry(registry: Registry, services: FeatureServices): Promise<void> {
    for (const [_key, value] of Object.entries(registry)) {
      // Check if it's a definition
      if (typeof value === 'object') {
        if ('_type' in value) {
          // It's a definition
          switch (value._type) {
            case 'job': {
              registerJobDefinition(value as JobDefinition<unknown, unknown, TContext>, services);

              break;
            }
            case 'schedule': {
              await registerScheduleDefinition(value, services);

              break;
            }
            case 'flow': {
              registerFlowDefinition(value, services);

              break;
            }
            // No default
          }
        } else if (typeof value === 'object' && !Array.isArray(value)) {
          // It's a nested registry, recurse
          await traverseRegistry(value, services);
        }
      }
    }
  }

  /**
   * Register a registry of jobs, schedules, and flows
   */
  async function register(registry: Registry, options?: RegisterOptions): Promise<void> {
    observeQueue(() => debugRegister.debug('Starting registry traversal'));
    // Each top-level branch runs with its own services (a feature's, keyed by its name), if any
    for (const [key, value] of Object.entries(registry)) {
      await traverseRegistry({ [key]: value }, options?.services?.[key]);
    }
    observeQueue(() => debugRegister.debug('Registry traversal complete'));
  }

  /**
   * Start all workers
   */
  async function start(): Promise<void> {
    observeQueue(() => debugWorker.debug('Starting queue infrastructure'));
    observeQueue(() => debugWorker.debug('Jobs registered: {registered}', { registered: registeredJobs.size }));
    observeQueue(() =>
      debugWorker.debug('Schedules registered: {registered}', { registered: registeredSchedules.size }),
    );
    observeQueue(() => debugWorker.debug('Flows registered: {registered}', { registered: registeredFlows.size }));
    observeQueue(() => debugWorker.debug('Workers created: {created}', { created: workers.length }));
    observeQueue(() => debugWorker.debug('Queues created: {created}', { created: queues.length }));

    // Every schedule is registered by now; drop schedulers left by removed ones before any tick runs
    await pruneStaleSchedulers();

    for (const worker of workers) {
      if (!startedWorkers.has(worker)) {
        startedWorkers.add(worker);
        // Worker.run() resolves when worker stops, so fire-and-forget here.
        void worker.run().catch(error => {
          observeQueue(() => debugWorker.error('Worker {worker} stopped unexpectedly', { worker: worker.name, error }));
        });
      }
      await worker.waitUntilReady();
    }

    observeQueue(() =>
      debugRegister.debug('queue infrastructure started: {jobs} jobs, {schedules} schedules, {flows} flows', {
        jobs: registeredJobs.size,
        schedules: registeredSchedules.size,
        flows: registeredFlows.size,
      }),
    );
  }

  /**
   * Stop all workers and close connections
   */
  async function stop(): Promise<void> {
    observeQueue(() => debugWorker.debug('Shutting down queue infrastructure'));

    // Close all workers
    observeQueue(() => debugWorker.debug('Closing {workersLength} workers', { workersLength: workers.length }));
    await Promise.all(
      workers.map(async worker => {
        observeQueue(() => debugWorker.debug('Closing worker: {worker}', { worker: worker.name }));
        await worker.close();
      }),
    );

    // Close the flow producer, if a flow was ever started
    const openFlowProducer = flowProducer;
    flowProducer = undefined;
    await openFlowProducer?.close();

    // Close all queues
    observeQueue(() => debugWorker.debug('Closing {queuesLength} queues', { queuesLength: queues.length }));
    await Promise.all(
      queues.map(async queue => {
        observeQueue(() => debugWorker.debug('Closing queue: {queue}', { queue: queue.name }));
        await queue.close();
      }),
    );

    observeQueue(() => debugWorker.debug('Queue infrastructure shut down successfully'));
  }

  /**
   * Add a registered job (through its `trigger()`), or start a flow. A flow's
   * step jobs may run in this process or in another worker on the same prefix.
   */
  function enqueue<TInput, TOutput, TJobContext>(
    job: JobDefinition<TInput, TOutput, TJobContext>,
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
    options?: TriggerOptions,
  ): Promise<JobTriggerResult | FlowEnqueueResult | FlowEnqueueFailure> {
    if (target._type === 'flow') {
      return addFlow(
        () => (flowProducer ??= new FlowProducer({ connection: connectionConfig, prefix: keyPrefix })),
        target,
        data,
      );
    }
    const registered = registeredJobs.get(target._internal.name);
    if (!registered) {
      return withEnqueueSpan(() => QueueUnavailable(), target._internal.name);
    }
    return registered.definition.trigger(data, options);
  }

  return {
    register,
    start,
    stop,
    queues: () => new Map(queues.map(queue => [queue.name, queue])),
    enqueue,
  };
}
