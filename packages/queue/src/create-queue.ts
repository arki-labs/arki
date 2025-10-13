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
import type { z } from 'zod/v4';

import type { InternalFlowDefinition } from './flow-builder.ts';
import { createJobContext, executeMiddlewareChain } from './middleware.ts';
import type { InternalScheduleDefinition } from './schedule-builder.ts';
import { getWorkerBackoffStrategy, toBullMQBackoff } from './retry-strategies.ts';
import type { FlowDefinition, QueueInstance, ScheduleDefinition } from './types/builder.ts';
import type { JobDefinition, JobHandler } from './types/job.ts';
import type { QueueMeta } from './types/queue.ts';

/**
 * Registry type - nested structure of jobs, schedules, and flows
 * Can contain definitions or nested registries
 */
type Registry = {
  [key: string]: JobDefinition<unknown, unknown, unknown> | ScheduleDefinition | FlowDefinition | Registry;
}

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
export function createQueueInstance<TContext>(
  options: QueueInstanceOptions<TContext>,
): QueueInstance {
  const { connection, keyPrefix = 'queue:', createContext } = options;

  // Parse connection string or use connection object
  const connectionConfig =
    typeof connection === 'string'
      ? (() => {
          // Simple parsing of redis://host:port format
          const url = new URL(connection);
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

  /**
   * Register a single job definition
   */
  function registerJobDefinition<TInput, TOutput>(definition: JobDefinition<TInput, TOutput, TContext>): void {
    const internal = definition._internal;

    if (registeredJobs.has(internal.name)) {
      console.warn(`Job "${internal.name}" is already registered, skipping`);
      return;
    }

    // Create BullMQ queue
    const queue = new Queue(internal.name, {
      connection: connectionConfig,
      prefix: keyPrefix,
      defaultJobOptions: {
        attempts: internal.options?.retry?.attempts ?? 3,
        backoff: toBullMQBackoff(internal.options?.retry),
      },
    });

    // Get custom backoff strategy if needed
    const backoffStrategy = getWorkerBackoffStrategy(internal.options?.retry);

    // Create BullMQ worker
    const worker = new Worker(
      internal.name,
      async (job: BullMQJob<TInput, TOutput>) => {
        // Validate input
        const validatedData = internal.inputSchema.parse(job.data);

        // Create base context
        const baseContext = await createContext();
        const jobContext = createJobContext(baseContext, job);

        // Execute middleware chain + handler
        const result = await executeMiddlewareChain<typeof jobContext, typeof jobContext>(
          internal.middlewares,
          jobContext,
          validatedData,
          job,
          {} as QueueMeta, // Meta will be populated by middleware if needed
        );

        // Final handler execution (after all middleware)
        return await internal.handler(validatedData, result);
      },
      {
        connection: connectionConfig,
        prefix: keyPrefix,
        concurrency: internal.options?.maxParallelism ?? 5,
        ...(backoffStrategy && {
          settings: {
            backoffStrategy,
          },
        }),
      },
    );

    // Error handling
    worker.on('failed', (job: BullMQJob | undefined, error: Error) => {
      console.error(`Job ${internal.name} failed:`, error);
      if (job) {
        console.error(`Job ID: ${job.id}, Data:`, job.data);
      }
    });

    // Store instances
    queues.push(queue);
    workers.push(worker);
    registeredJobs.set(internal.name, definition as JobDefinition<unknown, unknown, TContext>);

    console.log(`✓ Registered job: ${internal.name}`);
  }

  /**
   * Register a schedule definition
   */
  async function registerScheduleDefinition(definition: ScheduleDefinition): Promise<void> {
    const internal = definition._internal as InternalScheduleDefinition;

    if (registeredSchedules.has(internal.name)) {
      console.warn(`Schedule "${internal.name}" is already registered, skipping`);
      return;
    }

    // Create queue for the schedule
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
    const worker = new Worker(
      internal.name,
      async (job: BullMQJob) => {
        // Validate input
        const validatedData = inputSchema.parse(job.data);

        // Create context
        const baseContext = await createContext();
        const jobContext = createJobContext(baseContext, job);

        // Execute middleware chain + handler
        const contextAfterMiddleware = await executeMiddlewareChain<typeof jobContext, typeof jobContext>(
          internal.middlewares,
          jobContext,
          validatedData,
          job,
          {} as QueueMeta,
        );

        return await handler(validatedData, contextAfterMiddleware);
      },
      {
        connection: connectionConfig,
        prefix: keyPrefix,
      },
    );

    // Set up the schedule
    const scheduleData = internal.jobVariant.type === 'existing' ? internal.jobVariant.data : {};

    if (internal.type === 'timeout') {
      // Timeout: one-time execution after delay
      await queue.add('scheduled-job', scheduleData, {
        delay: internal.value as number,
        jobId: `schedule:${internal.name}`,
      });
    } else {
      // Cron or Interval: repeating execution
      const repeatOptions: RepeatOptions =
        internal.type === 'cron'
          ? {
              pattern: internal.value as string,
              tz: internal.options?.timezone,
            }
          : {
              every: internal.value as number,
            };

      await queue.add('scheduled-job', scheduleData, {
        repeat: repeatOptions,
        jobId: `schedule:${internal.name}`,
      });
    }

    queues.push(queue);
    workers.push(worker);
    registeredSchedules.set(internal.name, internal);

    console.log(`✓ Registered schedule: ${internal.name} (${internal.type})`);
  }

  /**
   * Register a flow definition
   */
  function registerFlowDefinition(definition: FlowDefinition): void {
    const internal = definition._internal as InternalFlowDefinition;

    if (registeredFlows.has(internal.name)) {
      console.warn(`Flow "${internal.name}" is already registered, skipping`);
      return;
    }

    // Register all jobs used in the flow
    for (const step of internal.steps) {
      if (!registeredJobs.has(step.job._internal.name)) {
        registerJobDefinition(step.job);
      }
    }

    // Create FlowProducer
    const flowProducer = new FlowProducer({
      connection: connectionConfig,
      prefix: keyPrefix,
    });

    flowProducers.push(flowProducer);
    registeredFlows.set(internal.name, internal);

    console.log(`✓ Registered flow: ${internal.name} (${internal.steps.length} steps)`);
  }

  /**
   * Traverse registry and register all items
   */
  function traverseRegistry(registry: Registry): void {
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
            void registerScheduleDefinition(value);

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
          traverseRegistry(value);
        }
      }
    }
  }

  /**
   * Register a registry of jobs, schedules, and flows
   */
  async function register(registry: Registry): Promise<void> {
    console.log('Registering queue items...');
    traverseRegistry(registry);
    console.log('✓ Registration complete');
  }

  /**
   * Start all workers
   */
  async function start(): Promise<void> {
    console.log('✓ Queue infrastructure started');
    console.log(`  - ${registeredJobs.size} job(s) registered`);
    console.log(`  - ${registeredSchedules.size} schedule(s) registered`);
    console.log(`  - ${registeredFlows.size} flow(s) registered`);
  }

  /**
   * Stop all workers and close connections
   */
  async function stop(): Promise<void> {
    console.log('Shutting down queue infrastructure...');

    // Close all workers
    await Promise.all(
      workers.map(async worker => {
        await worker.close();
      }),
    );

    // Close all flow producers
    await Promise.all(
      flowProducers.map(async flowProducer => {
        await flowProducer.close();
      }),
    );

    // Close all queues
    await Promise.all(
      queues.map(async queue => {
        await queue.close();
      }),
    );

    console.log('✓ Queue infrastructure shut down');
  }

  return {
    register,
    start,
    stop,
  };
}
