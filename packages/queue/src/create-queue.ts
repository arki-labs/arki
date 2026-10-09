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

import type { z } from '@arki/contracts';

import type { InternalFlowDefinition } from './flow-builder.ts';
import type { InternalScheduleDefinition } from './schedule-builder.ts';
import type { FlowDefinition, QueueInstance, ScheduleDefinition } from './types/builder.ts';
import type { JobDefinition, JobHandler } from './types/job.ts';
import type { QueueMeta } from './types/queue.ts';
import { debugFlow, debugJob, debugRegister, debugSchedule, debugWorker } from './debug.ts';
import { createJobContext, executeMiddlewareChain } from './middleware.ts';
import { getWorkerBackoffStrategy, toBullMQBackoff } from './retry-strategies.ts';

/**
 * Registry type - nested structure of jobs, schedules, and flows
 * Can contain definitions or nested registries
 */
type Registry = {
  [key: string]: JobDefinition<unknown, unknown, unknown> | ScheduleDefinition | FlowDefinition | Registry;
};

/**
 * Queue instance options
 */
export type QueueInstanceOptions<TContext> = {
  connection: string | { host: string; port: number; password?: string };
  keyPrefix?: string;
  createContext: () => TContext | Promise<TContext>;
};

/**
 * Create a queue instance that can register and run jobs, schedules, and flows
 * @internal - Called by QueueBuilder.createQueue()
 */
export function createQueueInstance<TContext>(options: QueueInstanceOptions<TContext>): QueueInstance {
  const { connection, keyPrefix = 'queue:', createContext } = options;

  debugRegister('Creating queue instance with keyPrefix: %s', keyPrefix);

  // Parse connection string or use connection object
  const connectionConfig =
    typeof connection === 'string'
      ? (() => {
          // Simple parsing of redis://host:port format
          const url = new URL(connection);
          debugRegister('Parsed Redis connection: %s:%d', url.hostname, Number.parseInt(url.port) || 6379);
          return {
            host: url.hostname,
            port: Number.parseInt(url.port) || 6379,
            password: url.password || undefined,
          };
        })()
      : connection;

  // Track registered items
  const registeredJobs = new Map<string, JobDefinition<unknown, unknown, TContext>>();
  const registeredSchedules = new Map<string, InternalScheduleDefinition<unknown, unknown, TContext>>();
  const registeredFlows = new Map<string, InternalFlowDefinition>();

  // Track BullMQ instances
  const queues: Queue[] = [];
  const workers: Worker[] = [];
  const flowProducers: FlowProducer[] = [];
  const startedWorkers = new WeakSet<Worker>();

  /**
   * Register a single job definition
   */
  function registerJobDefinition<TInput, TOutput>(definition: JobDefinition<TInput, TOutput, TContext>): void {
    const internal = definition._internal;

    debugRegister('[%s] Registering job definition', internal.name);

    if (registeredJobs.has(internal.name)) {
      debugRegister('[%s] Job already registered, skipping', internal.name);
      console.warn(`Job "${internal.name}" is already registered, skipping`);
      return;
    }

    // Create BullMQ queue
    debugRegister('[%s] Creating BullMQ queue with %d retry attempts', internal.name, internal.options?.retry?.attempts ?? 3);
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
    debugWorker('[%s] Creating worker with concurrency: %d', internal.name, internal.options?.maxParallelism ?? 5);
    const worker = new Worker(
      internal.name,
      async (job: BullMQJob<TInput, TOutput>) => {
        debugJob('[%s] Job %s started', internal.name, job.id);

        // Validate input
        debugJob('[%s] Job %s validating input', internal.name, job.id);
        const validatedData = internal.inputSchema.parse(job.data);
        debugJob('[%s] Job %s input validated', internal.name, job.id);

        // Create base context
        const baseContext = await createContext();
        const jobContext = createJobContext(baseContext, job);

        // Execute middleware chain + handler
        debugJob('[%s] Job %s executing middleware chain (%d middleware)', internal.name, job.id, internal.middlewares.length);
        const result = await executeMiddlewareChain<typeof jobContext, typeof jobContext>(
          internal.middlewares,
          jobContext,
          validatedData,
          job,
          {} as QueueMeta, // Meta will be populated by middleware if needed
        );

        // Final handler execution (after all middleware)
        debugJob('[%s] Job %s executing handler', internal.name, job.id);
        const handlerResult = await internal.handler(validatedData, result);
        debugJob('[%s] Job %s completed successfully', internal.name, job.id);
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
      debugJob('[%s] Job %s failed: %s', internal.name, job?.id ?? 'unknown', error.message);
      console.error(`Job ${internal.name} failed:`, error);
      if (job) {
        console.error(`Job ID: ${job.id}, Data:`, job.data);
      }
    });

    // Store queue reference on the definition for trigger()
    internal._queue = queue;

    // Store instances
    queues.push(queue);
    workers.push(worker);
    registeredJobs.set(internal.name, definition as JobDefinition<unknown, unknown, TContext>);

    debugRegister('[%s] Job registered successfully', internal.name);
    console.log(`✓ Registered job: ${internal.name}`);
  }

  /**
   * Register a schedule definition
   */
  async function registerScheduleDefinition(definition: ScheduleDefinition): Promise<void> {
    const internal = definition._internal as InternalScheduleDefinition;

    debugSchedule('[%s] Registering schedule definition (type: %s)', internal.name, internal.type);

    if (registeredSchedules.has(internal.name)) {
      debugSchedule('[%s] Schedule already registered, skipping', internal.name);
      console.warn(`Schedule "${internal.name}" is already registered, skipping`);
      return;
    }

    // Create queue for the schedule
    debugSchedule('[%s] Creating queue for schedule', internal.name);
    const queue = new Queue(internal.name, {
      connection: connectionConfig,
      prefix: keyPrefix,
    });

    // Determine the handler based on job variant
    let handler: JobHandler<unknown, unknown, TContext>;
    let inputSchema: z.ZodType<unknown>;

    if (internal.jobVariant.type === 'existing') {
      // Use existing job's handler
      const jobInternal = internal.jobVariant.job._internal;
      handler = jobInternal.handler as JobHandler<unknown, unknown, TContext>;
      inputSchema = jobInternal.inputSchema;

      // Ensure the job is registered
      if (!registeredJobs.has(jobInternal.name)) {
        registerJobDefinition(internal.jobVariant.job);
      }
    } else {
      // Use inline handler
      handler = internal.jobVariant.handler as JobHandler<unknown, unknown, TContext>;
      inputSchema = internal.jobVariant.inputSchema;
    }

    // Create worker for the schedule
    debugSchedule('[%s] Creating worker for schedule', internal.name);
    const worker = new Worker(
      internal.name,
      async (job: BullMQJob) => {
        debugSchedule('[%s] Schedule job %s started', internal.name, job.id);

        // Validate input
        const validatedData = inputSchema.parse(job.data);

        // Create context
        const baseContext = await createContext();
        const jobContext = createJobContext(baseContext, job);

        // Execute middleware chain + handler
        debugSchedule('[%s] Schedule job %s executing middleware and handler', internal.name, job.id);
        const contextAfterMiddleware = await executeMiddlewareChain<typeof jobContext, typeof jobContext>(
          internal.middlewares,
          jobContext,
          validatedData,
          job,
          {} as QueueMeta,
        );

        const result = await handler(validatedData, contextAfterMiddleware);
        debugSchedule('[%s] Schedule job %s completed', internal.name, job.id);
        return result;
      },
      {
        connection: connectionConfig,
        prefix: keyPrefix,
        autorun: false,
      },
    );

    // Set up the schedule
    const scheduleData = internal.jobVariant.type === 'existing' ? internal.jobVariant.data : {};

    if (internal.type === 'timeout') {
      // Timeout: one-time execution after delay
      debugSchedule('[%s] Configuring timeout schedule with delay: %dms', internal.name, internal.value);
      await queue.add('scheduled-job', scheduleData, {
        delay: internal.value as number,
        jobId: `schedule:${internal.name}`,
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

      const schedulerId = `schedule:${internal.name}`;

      // This queue holds exactly one schedule, so any other scheduler entry is
      // stale. BullMQ 5 `queue.add(..., { repeat })` stored the schedule under
      // an md5 key; BullMQ 6 keeps running such an entry next to the new one,
      // so without this every tick would execute twice.
      for (const scheduler of await queue.getJobSchedulers()) {
        if (scheduler.key !== schedulerId) {
          debugSchedule('[%s] Removing stale scheduler entry: %s', internal.name, scheduler.key);
          await queue.removeJobScheduler(scheduler.key);
        }
      }

      debugSchedule('[%s] Configuring %s schedule with value: %s', internal.name, internal.type, internal.value);
      await queue.upsertJobScheduler(schedulerId, repeatOptions, { name: 'scheduled-job', data: scheduleData });
    }

    queues.push(queue);
    workers.push(worker);
    registeredSchedules.set(internal.name, internal);

    debugSchedule('[%s] Schedule registered successfully', internal.name);
    console.log(`✓ Registered schedule: ${internal.name} (${internal.type})`);
  }

  /**
   * Register a flow definition
   */
  function registerFlowDefinition(definition: FlowDefinition): void {
    const internal = definition._internal as InternalFlowDefinition;

    debugFlow('[%s] Registering flow definition with %d steps', internal.name, internal.steps.length);

    if (registeredFlows.has(internal.name)) {
      debugFlow('[%s] Flow already registered, skipping', internal.name);
      console.warn(`Flow "${internal.name}" is already registered, skipping`);
      return;
    }

    // Register all jobs used in the flow
    debugFlow('[%s] Registering %d jobs for flow steps', internal.name, internal.steps.length);
    for (const step of internal.steps) {
      if (!registeredJobs.has(step.job._internal.name)) {
        debugFlow('[%s] Registering job for step: %s', internal.name, step.job._internal.name);
        registerJobDefinition(step.job);
      }
    }

    // Create FlowProducer
    debugFlow('[%s] Creating FlowProducer', internal.name);
    const flowProducer = new FlowProducer({
      connection: connectionConfig,
      prefix: keyPrefix,
    });

    flowProducers.push(flowProducer);
    registeredFlows.set(internal.name, internal);

    debugFlow('[%s] Flow registered successfully', internal.name);
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
    debugRegister('Starting registry traversal');
    console.log('Registering queue items...');
    await traverseRegistry(registry);
    debugRegister('Registry traversal complete');
    console.log('✓ Registration complete');
  }

  /**
   * Start all workers
   */
  async function start(): Promise<void> {
    debugWorker('Starting queue infrastructure');
    debugWorker('Jobs registered: %d', registeredJobs.size);
    debugWorker('Schedules registered: %d', registeredSchedules.size);
    debugWorker('Flows registered: %d', registeredFlows.size);
    debugWorker('Workers created: %d', workers.length);
    debugWorker('Queues created: %d', queues.length);

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
    debugWorker('Shutting down queue infrastructure');
    console.log('Shutting down queue infrastructure...');

    // Close all workers
    debugWorker('Closing %d workers', workers.length);
    await Promise.all(
      workers.map(async worker => {
        debugWorker('Closing worker: %s', worker.name);
        await worker.close();
      }),
    );

    // Close all flow producers
    debugWorker('Closing %d flow producers', flowProducers.length);
    await Promise.all(
      flowProducers.map(async flowProducer => {
        await flowProducer.close();
      }),
    );

    // Close all queues
    debugWorker('Closing %d queues', queues.length);
    await Promise.all(
      queues.map(async queue => {
        debugWorker('Closing queue: %s', queue.name);
        await queue.close();
      }),
    );

    debugWorker('Queue infrastructure shut down successfully');
    console.log('✓ Queue infrastructure shut down');
  }

  return {
    register,
    start,
    stop,
  };
}
