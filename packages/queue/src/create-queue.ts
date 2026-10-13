/* eslint-disable @typescript-eslint/require-await */
/**
 * Queue instance implementation for v2.0
 *
 * Integrates with initQueue builder pattern and supports:
 * - Job registration and execution with middleware
 * - Schedule registration (cron and interval)
 * - Flow registration (multi-step workflows)
 * - Registry traversal (nested job organization)
 */

import type { Job as BullMQJob, RepeatOptions } from 'bullmq';
import { FlowProducer, Queue, Worker } from 'bullmq';

import type { InternalFlowDefinition } from './flow-builder.ts';
import type { QueueConnection } from './redis-connection.ts';
import type { InternalScheduleDefinition } from './schedule-builder.ts';
import type { FlowDefinition, QueueInstance, ScheduleDefinition } from './types/builder.ts';
import type { JobDefinition } from './types/job.ts';
import { debugFlow, debugJob, debugRegister, debugSchedule, debugWorker } from './debug.ts';
import { duplicateScheduleError } from './errors.ts';
import { createJobContext, executeMiddlewareChain } from './middleware.ts';
import { parseRedisConnection } from './redis-connection.ts';
import { getWorkerBackoffStrategy, toBullMQBackoff } from './retry-strategies.ts';

/**
 * Registry type - nested structure of jobs, schedules, and flows
 * Can contain definitions or nested registries
 */
type Registry = {
  [key: string]: JobDefinition<unknown, unknown, unknown> | ScheduleDefinition | FlowDefinition | Registry;
};

/** Job scheduler ids of schedules: `schedule:<schedule name>` on the job's queue */
const SCHEDULER_ID_PREFIX = 'schedule:';

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
export function createQueueInstance<TContext>(options: QueueInstanceOptions<TContext>): QueueInstance {
  const { connection, keyPrefix = 'queue:', createContext } = options;

  debugRegister.debug('Creating queue instance with keyPrefix: {keyPrefix}', { keyPrefix });

  const connectionConfig = parseRedisConnection(connection);

  // Track registered items
  // Each registered job with the BullMQ queue its worker reads
  const registeredJobs = new Map<string, { definition: JobDefinition<unknown, unknown, TContext>; queue: Queue }>();
  const registeredSchedules = new Map<string, InternalScheduleDefinition>();
  const registeredFlows = new Map<string, InternalFlowDefinition>();

  // Track BullMQ instances
  const queues: Queue[] = [];
  const workers: Worker[] = [];
  const flowProducers: FlowProducer[] = [];
  const startedWorkers = new WeakSet<Worker>();

  /**
   * Register a single job definition
   */
  function registerJobDefinition<TInput, TOutput>(definition: JobDefinition<TInput, TOutput, TContext>): Queue {
    const internal = definition._internal;

    debugRegister.debug('[{internalName}] Registering job definition', { internalName: internal.name });

    const existing = registeredJobs.get(internal.name);
    if (existing) {
      debugRegister.debug('[{internalName}] Job already registered, skipping', { internalName: internal.name });
      console.warn(`Job "${internal.name}" is already registered, skipping`);
      return existing.queue;
    }

    // Create BullMQ queue
    debugRegister.debug('[{internalName}] Creating BullMQ queue with {value2} retry attempts', {
      internalName: internal.name,
      value2: internal.options?.retry?.attempts ?? 3,
    });
    const queue = new Queue(internal.name, {
      connection: connectionConfig,
      prefix: keyPrefix,
      defaultJobOptions: {
        attempts: internal.options?.retry?.attempts ?? 3,
        backoff: toBullMQBackoff(internal.options?.retry),
        ...internal.options?.bullmqOptions,
      },
    });

    // Get custom backoff strategy if needed
    const backoffStrategy = getWorkerBackoffStrategy(internal.options?.retry);

    // Create BullMQ worker
    debugWorker.debug('[{internalName}] Creating worker with concurrency: {concurrency}', {
      internalName: internal.name,
      concurrency: internal.options?.maxParallelism ?? 5,
    });
    const worker = new Worker(
      internal.name,
      async (job: BullMQJob<TInput, TOutput | undefined>) => {
        debugJob.debug('[{internalName}] Job {jobId} started', { internalName: internal.name, jobId: job.id });

        // Validate input
        debugJob.debug('[{internalName}] Job {jobId} validating input', { internalName: internal.name, jobId: job.id });
        const validatedData = internal.inputSchema.parse(job.data);
        debugJob.debug('[{internalName}] Job {jobId} input validated', { internalName: internal.name, jobId: job.id });

        // Create base context
        const baseContext = await createContext();
        const jobContext = createJobContext(baseContext, job);

        // Execute middleware chain around the handler (onion)
        debugJob.debug('[{internalName}] Job {jobId} executing middleware chain ({middlewaresLength} middleware)', {
          internalName: internal.name,
          jobId: job.id,
          middlewaresLength: internal.middlewares.length,
        });
        const handlerResult = await executeMiddlewareChain<typeof jobContext, typeof jobContext, TOutput>(
          internal.middlewares,
          jobContext,
          validatedData,
          job,
          {}, // Meta will be populated by middleware if needed
          ctx => internal.handler(validatedData, ctx),
        );
        debugJob.debug('[{internalName}] Job {jobId} completed successfully', {
          internalName: internal.name,
          jobId: job.id,
        });
        return handlerResult;
      },
      {
        connection: connectionConfig,
        prefix: keyPrefix,
        autorun: false,
        concurrency: internal.options?.maxParallelism ?? 5,
        ...internal.options?.workerOptions,
        ...((backoffStrategy || internal.options?.workerOptions?.settings) && {
          settings: {
            ...internal.options?.workerOptions?.settings,
            ...(backoffStrategy && {
              backoffStrategy,
            }),
          },
        }),
      },
    );

    // Error handling
    worker.on('failed', (job: BullMQJob | undefined, error: Error) => {
      debugJob.debug('[{internalName}] Job {value2} failed: {failed}', {
        internalName: internal.name,
        value2: job?.id ?? 'unknown',
        failed: error.message,
      });
      console.error(`Job ${internal.name} failed:`, error);
      if (job) {
        console.error(`Job ID: ${job.id}, Data:`, job.data);
      }
    });

    // Store queue reference on the definition for trigger(), and the worker beside it
    internal._queue = queue;
    internal._worker = worker;

    // Store instances
    queues.push(queue);
    workers.push(worker);
    registeredJobs.set(internal.name, { definition: definition as JobDefinition<unknown, unknown, TContext>, queue });

    debugRegister.debug('[{internalName}] Job registered successfully', { internalName: internal.name });
    console.log(`✓ Registered job: ${internal.name}`);
    return queue;
  }

  /**
   * Register a schedule definition.
   *
   * A schedule is a trigger: it adds its data to the job's own queue through a
   * BullMQ job scheduler (or one delayed job for a timeout), and the job's own
   * worker runs it. It creates no queue or worker of its own.
   */
  async function registerScheduleDefinition(definition: ScheduleDefinition): Promise<void> {
    const internal = definition._internal as InternalScheduleDefinition;
    const jobName = internal.job._internal.name;

    debugSchedule.debug('[{internalName}] Registering schedule definition (type: {type}, job: {job})', {
      internalName: internal.name,
      type: internal.type,
      job: jobName,
    });

    if (registeredSchedules.has(internal.name)) {
      throw duplicateScheduleError(internal.name);
    }

    // Ensure the job is registered, so its worker runs what the schedule adds
    const queue = registeredJobs.get(jobName)?.queue ?? registerJobDefinition(internal.job);

    if (internal.type === 'timeout') {
      // Timeout: one-time execution after delay
      debugSchedule.debug('[{internalName}] Configuring timeout schedule with delay: {delay}ms', {
        internalName: internal.name,
        delay: internal.value,
      });
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
            debugSchedule.debug('[{internalName}] Removing legacy scheduler entry: {entry}', {
              internalName: internal.name,
              entry: scheduler.key,
            });
            await queue.removeJobScheduler(scheduler.key);
          }
        }
      }

      const schedulerId = `${SCHEDULER_ID_PREFIX}${internal.name}`;
      debugSchedule.debug('[{internalName}] Configuring {internalType} schedule with value: {value}', {
        internalName: internal.name,
        internalType: internal.type,
        value: internal.value,
      });
      await queue.upsertJobScheduler(schedulerId, repeatOptions, { name: jobName, data: internal.data });
    }

    registeredSchedules.set(internal.name, internal);

    debugSchedule.debug('[{internalName}] Schedule registered successfully', { internalName: internal.name });
    console.log(`✓ Registered schedule: ${internal.name} (${internal.type})`);
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
          debugSchedule.debug('[{jobName}] Removing scheduler of a schedule no longer registered: {registered}', {
            jobName,
            registered: scheduler.key,
          });
          await queue.removeJobScheduler(scheduler.key);
        }
      }
    }
  }

  /**
   * Register a flow definition
   */
  function registerFlowDefinition(definition: FlowDefinition): void {
    const internal = definition._internal as InternalFlowDefinition;

    debugFlow.debug('[{internalName}] Registering flow definition with {stepsLength} steps', {
      internalName: internal.name,
      stepsLength: internal.steps.length,
    });

    if (registeredFlows.has(internal.name)) {
      debugFlow.debug('[{internalName}] Flow already registered, skipping', { internalName: internal.name });
      console.warn(`Flow "${internal.name}" is already registered, skipping`);
      return;
    }

    // Register all jobs used in the flow
    debugFlow.debug('[{internalName}] Registering {stepsLength} jobs for flow steps', {
      internalName: internal.name,
      stepsLength: internal.steps.length,
    });
    for (const step of internal.steps) {
      if (!registeredJobs.has(step.job._internal.name)) {
        debugFlow.debug('[{internalName}] Registering job for step: {step}', {
          internalName: internal.name,
          step: step.job._internal.name,
        });
        registerJobDefinition(step.job);
      }
    }

    // Create FlowProducer
    debugFlow.debug('[{internalName}] Creating FlowProducer', { internalName: internal.name });
    const flowProducer = new FlowProducer({
      connection: connectionConfig,
      prefix: keyPrefix,
    });

    flowProducers.push(flowProducer);
    registeredFlows.set(internal.name, internal);

    debugFlow.debug('[{internalName}] Flow registered successfully', { internalName: internal.name });
    console.log(`✓ Registered flow: ${internal.name} (${internal.steps.length} steps)`);
  }

  /**
   * Traverse registry and register all items
   */
  async function traverseRegistry(registry: Registry): Promise<void> {
    for (const [_key, value] of Object.entries(registry)) {
      // Check if it's a definition
      if (typeof value === 'object') {
        if ('_type' in value) {
          // It's a definition
          switch (value._type) {
            case 'job': {
              registerJobDefinition(value as JobDefinition<unknown, unknown, TContext>);

              break;
            }
            case 'schedule': {
              await registerScheduleDefinition(value);

              break;
            }
            case 'flow': {
              registerFlowDefinition(value);

              break;
            }
            // No default
          }
        } else if (typeof value === 'object' && !Array.isArray(value)) {
          // It's a nested registry, recurse
          await traverseRegistry(value);
        }
      }
    }
  }

  /**
   * Register a registry of jobs, schedules, and flows
   */
  async function register(registry: Registry): Promise<void> {
    debugRegister.debug('Starting registry traversal');
    console.log('Registering queue items...');
    await traverseRegistry(registry);
    debugRegister.debug('Registry traversal complete');
    console.log('✓ Registration complete');
  }

  /**
   * Start all workers
   */
  async function start(): Promise<void> {
    debugWorker.debug('Starting queue infrastructure');
    debugWorker.debug('Jobs registered: {registered}', { registered: registeredJobs.size });
    debugWorker.debug('Schedules registered: {registered}', { registered: registeredSchedules.size });
    debugWorker.debug('Flows registered: {registered}', { registered: registeredFlows.size });
    debugWorker.debug('Workers created: {created}', { created: workers.length });
    debugWorker.debug('Queues created: {created}', { created: queues.length });

    // Every schedule is registered by now; drop schedulers left by removed ones before any tick runs
    await pruneStaleSchedulers();

    for (const worker of workers) {
      if (!startedWorkers.has(worker)) {
        startedWorkers.add(worker);
        // Worker.run() resolves when worker stops, so fire-and-forget here.
        void worker.run().catch(error => {
          console.error(`Worker ${worker.name} stopped unexpectedly:`, error);
        });
      }
      await worker.waitUntilReady();
    }

    console.log('✓ Queue infrastructure started');
    console.log(`  - ${registeredJobs.size} job(s) registered`);
    console.log(`  - ${registeredSchedules.size} schedule(s) registered`);
    console.log(`  - ${registeredFlows.size} flow(s) registered`);
  }

  /**
   * Stop all workers and close connections
   */
  async function stop(): Promise<void> {
    debugWorker.debug('Shutting down queue infrastructure');
    console.log('Shutting down queue infrastructure...');

    // Close all workers
    debugWorker.debug('Closing {workersLength} workers', { workersLength: workers.length });
    await Promise.all(
      workers.map(async worker => {
        debugWorker.debug('Closing worker: {worker}', { worker: worker.name });
        await worker.close();
      }),
    );

    // Close all flow producers
    debugWorker.debug('Closing {flowProducersLength} flow producers', { flowProducersLength: flowProducers.length });
    await Promise.all(
      flowProducers.map(async flowProducer => {
        await flowProducer.close();
      }),
    );

    // Close all queues
    debugWorker.debug('Closing {queuesLength} queues', { queuesLength: queues.length });
    await Promise.all(
      queues.map(async queue => {
        debugWorker.debug('Closing queue: {queue}', { queue: queue.name });
        await queue.close();
      }),
    );

    debugWorker.debug('Queue infrastructure shut down successfully');
    console.log('✓ Queue infrastructure shut down');
  }

  return {
    register,
    start,
    stop,
  };
}
