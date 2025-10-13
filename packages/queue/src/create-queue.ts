import type { Job as BullMQJob, RepeatOptions } from 'bullmq';
import { FlowProducer, Queue, Worker } from 'bullmq';

import type {
  FlowDefinition,
  JobContext,
  JobDefinition,
  QueueFactoryOptions,
  QueueInstance,
  ScheduleDefinition,
  ScheduleInfo,
} from './types/index.ts';

/**
 * Create a queue instance for managing jobs, schedules, and flows
 *
 * @template TDeps - Custom dependencies to inject into job contexts
 *
 * @example Basic usage
 * ```typescript
 * import { createQueue } from '@arki/queue';
 * import { env } from './env';
 *
 * // Import your job definitions
 * import { sendEmail } from './jobs/send-email';
 * import { dailyCleanup } from './jobs/daily-cleanup';
 * import { processOrderFlow } from './flows/process-order';
 *
 * const queue = createQueue({
 *   connection: env.REDIS_URL,
 *   keyPrefix: 'myapp:',
 * });
 *
 * // Register jobs
 * queue.registerJob(sendEmail);
 * queue.registerSchedule(dailyCleanup);
 * queue.registerFlow(processOrderFlow);
 *
 * // Start processing
 * await queue.start();
 * ```
 *
 * @example With dependency injection
 * ```typescript
 * import { createQueue } from '@arki/queue';
 * import { db, repositories } from './db';
 * import { emailService } from './services/email';
 *
 * type QueueDependencies = {
 *   db: typeof db;
 *   repo: typeof repositories;
 *   email: typeof emailService;
 * };
 *
 * const queue = createQueue<QueueDependencies>({
 *   connection: 'redis://localhost:6379',
 *   keyPrefix: 'myapp:',
 *   dependencies: {
 *     db,
 *     repo: repositories,
 *     email: emailService,
 *   },
 * });
 *
 * // Now all job handlers will have access to ctx.db, ctx.repo, ctx.email
 * ```
 */
export function createQueue<TDeps = Record<string, never>>(
  options: QueueFactoryOptions<TDeps>,
): QueueInstance {
  const { connection, keyPrefix = 'queue:', defaultJobOptions, defaultWorkerOptions, dependencies } = options;

  // Track registered definitions
  const jobDefinitions = new Map<string, JobDefinition<unknown, unknown>>();
  const scheduleDefinitions = new Map<string, ScheduleDefinition<unknown, unknown>>();
  const flowDefinitions = new Map<string, FlowDefinition<unknown, string>>();

  // Track BullMQ instances for cleanup
  const queues: Queue[] = [];
  const workers: Worker[] = [];
  const flowProducers: FlowProducer[] = [];

  /**
   * Get or create a Redis connection instance
   */
  function getConnection(): typeof connection {
    return connection;
  }

  /**
   * Create job context for handlers
   * Injects custom dependencies into the context
   */
  function createJobContext<TInput, TOutput>(job: BullMQJob<TInput, TOutput>): JobContext<TDeps> {
    return {
      updateProgress: async (progress: number) => {
        await job.updateProgress(progress);
      },
      log: async (message: string) => {
        await job.log(message);
      },
      job,
      // Spread dependencies into context
      ...(dependencies as TDeps),
    };
  }

  /**
   * Register a job definition
   */
  function registerJob<TInput, TOutput, TJobDeps = Record<string, never>>(
    definition: JobDefinition<TInput, TOutput, TJobDeps>,
  ): void {
    if (jobDefinitions.has(definition.name)) {
      throw new Error(`Job "${definition.name}" is already registered`);
    }

    // Create BullMQ queue
    const queue = new Queue(definition.name, {
      connection: getConnection(),
      prefix: keyPrefix,
      defaultJobOptions: {
        ...defaultJobOptions,
        ...definition.options?.bullmqOptions,
        attempts: definition.options?.retry?.attempts ?? defaultJobOptions?.attempts,
        backoff: definition.options?.retry?.backoff
          ? {
              type: definition.options.retry.backoff.type,
              delay: definition.options.retry.backoff.delay,
            }
          : defaultJobOptions?.backoff,
      },
    });

    // Create BullMQ worker
    const worker = new Worker(
      definition.name,
      async (job: BullMQJob<TInput, TOutput>) => {
        // Validate input data
        const validatedData = definition.inputSchema.parse(job.data);

        // Create context
        const ctx = createJobContext(job);

        // Execute handler
        const result = await definition.handler(validatedData, ctx as unknown as JobContext<TJobDeps>);

        // Call onComplete callback if provided
        if (definition.options?.onComplete) {
          await definition.options.onComplete(job, result);
        }

        return result;
      },
      {
        connection: getConnection(),
        prefix: keyPrefix,
        ...defaultWorkerOptions,
        ...definition.options?.workerOptions,
        concurrency: definition.options?.maxParallelism ?? defaultWorkerOptions?.concurrency,
      },
    );

    // Set up error handler
    worker.on('failed', (job: BullMQJob<TInput, TOutput> | undefined, error: Error) => {
      if (job && definition.options?.onError) {
        void definition.options.onError(job, error);
      }
    });

    // Store instances
    definition._queue = queue;
    definition._worker = worker;
    queues.push(queue);
    workers.push(worker);
    jobDefinitions.set(definition.name, definition as JobDefinition<unknown, unknown>);
  }

  /**
   * Register a schedule definition
   */
  async function registerSchedule<TInput, TOutput, TJobDeps = Record<string, never>>(
    definition: ScheduleDefinition<TInput, TOutput, TJobDeps>,
  ): Promise<void> {
    if (scheduleDefinitions.has(definition.name)) {
      throw new Error(`Schedule "${definition.name}" is already registered`);
    }

    // Create BullMQ queue
    const queue = new Queue(definition.name, {
      connection: getConnection(),
      prefix: keyPrefix,
      defaultJobOptions: {
        ...defaultJobOptions,
        ...definition.options?.jobOptions?.bullmqOptions,
      },
    });

    // Create BullMQ worker
    const worker = new Worker(
      definition.name,
      async (job: BullMQJob<TInput, TOutput>) => {
        // Validate input data
        const validatedData = definition.inputSchema.parse(job.data);

        // Create context
        const ctx = createJobContext(job);

        // Execute handler
        return await definition.handler(validatedData, ctx as unknown as JobContext<TJobDeps>);
      },
      {
        connection: getConnection(),
        prefix: keyPrefix,
        ...defaultWorkerOptions,
        ...definition.options?.jobOptions?.workerOptions,
      },
    );

    // Convert schedule config to BullMQ repeat options
    const repeatOptions: RepeatOptions =
      definition.schedule.type === 'cron'
        ? {
            pattern: definition.schedule.pattern,
            tz: definition.schedule.timezone,
          }
        : {
            every: definition.schedule.milliseconds,
          };

    // Add repeatable job
    const jobId = `schedule:${definition.name}`;
    await queue.add(
      'scheduled-job',
      (definition.options?.defaultData ?? {}) as TInput,
      {
        repeat: repeatOptions,
        jobId,
      },
    );

    // Store instances
    definition._queue = queue;
    definition._worker = worker;
    definition._jobId = jobId;
    queues.push(queue);
    workers.push(worker);
    scheduleDefinitions.set(definition.name, definition as ScheduleDefinition<unknown, unknown>);
  }

  /**
   * Register a flow definition (distributed workflow)
   */
  function registerFlow<TInput, TStepId extends string = string>(definition: FlowDefinition<TInput, TStepId>): void {
    if (flowDefinitions.has(definition.name)) {
      throw new Error(`Flow "${definition.name}" is already registered`);
    }

    // Extract all unique job definitions from the flow steps
    // We need to call the flow function with a dummy input to get the steps
    // Note: This requires the flow function to be pure and not depend on specific input values for structure
    const dummyInput = {} as TInput;
    const flowSteps = definition.flow(dummyInput);

    // Collect unique job definitions
    const uniqueJobs = new Set<JobDefinition<unknown, unknown>>();
    for (const step of flowSteps) {
      uniqueJobs.add(step.job);
    }

    // Register all jobs if not already registered
    for (const jobDefinition of uniqueJobs) {
      if (!jobDefinitions.has(jobDefinition.name)) {
        registerJob(jobDefinition);
      }
    }

    // Create FlowProducer instance
    const flowProducer = new FlowProducer({
      connection: getConnection(),
      prefix: keyPrefix,
    });

    // Store FlowProducer in definition
    definition._flowProducer = flowProducer;
    flowProducers.push(flowProducer);
    flowDefinitions.set(definition.name, definition as FlowDefinition<unknown, string>);
  }

  /**
   * Start all registered workers
   */
  function start(): Promise<void> {
    console.log('✓ Queue infrastructure started');
    console.log(`  - ${jobDefinitions.size} job(s) registered`);
    console.log(`  - ${scheduleDefinitions.size} schedule(s) registered`);
    console.log(`  - ${flowDefinitions.size} flow(s) registered`);

    return Promise.resolve();
  }

  /**
   * Stop all workers and close connections
   */
  async function stop(): Promise<void> {
    console.log('Shutting down queue infrastructure...');

    // Close all workers first (stop accepting new jobs)
    await Promise.all(
      workers.map(async worker => {
        console.log(`Closing worker: ${worker.name}`);
        await worker.close();
      }),
    );

    // Close all flow producers
    await Promise.all(
      flowProducers.map(async flowProducer => {
        console.log('Closing flow producer');
        await flowProducer.close();
      }),
    );

    // Then close queues
    await Promise.all(
      queues.map(async queue => {
        console.log(`Closing queue: ${queue.name}`);
        await queue.close();
      }),
    );

    console.log('✓ Queue infrastructure shut down');
  }

  /**
   * Schedule management API
   */
  const schedules = {
    /**
     * Register a new schedule at runtime
     */
    async register<TInput, TOutput, TDeps = Record<string, never>>(
      definition: ScheduleDefinition<TInput, TOutput, TDeps>,
    ): Promise<string> {
      await registerSchedule(definition);
      return definition.name;
    },

    /**
     * List all registered schedules
     */
    async list(): Promise<ScheduleInfo[]> {
      const scheduleInfos: ScheduleInfo[] = [];

      for (const [name, definition] of scheduleDefinitions.entries()) {
        const queue = definition._queue;
        if (!queue) continue;

        // Get repeatable jobs for this schedule
        const repeatableJobs = await queue.getRepeatableJobs();
        const scheduleJob = repeatableJobs.find(job => job.id === definition._jobId);

        scheduleInfos.push({
          name,
          schedule: definition.schedule,
          nextRun: scheduleJob?.next ? new Date(scheduleJob.next) : undefined,
          lastRun: undefined, // BullMQ doesn't track last run easily
          active: !!scheduleJob,
        });
      }

      return scheduleInfos;
    },

    /**
     * Get a specific schedule by name
     */
    async get(name: string): Promise<ScheduleInfo | null> {
      const definition = scheduleDefinitions.get(name);
      if (!definition?._queue) return null;

      const queue = definition._queue;
      const repeatableJobs = await queue.getRepeatableJobs();
      const scheduleJob = repeatableJobs.find(job => job.id === definition._jobId);

      return {
        name,
        schedule: definition.schedule,
        nextRun: scheduleJob?.next ? new Date(scheduleJob.next) : undefined,
        lastRun: undefined,
        active: !!scheduleJob,
      };
    },

    /**
     * Delete a schedule by name
     */
    async delete(name: string): Promise<void> {
      const definition = scheduleDefinitions.get(name);
      if (!definition?._queue) {
        throw new Error(`Schedule "${name}" not found`);
      }

      const queue = definition._queue;

      // Remove repeatable job
      if (definition._jobId) {
        const repeatableJobs = await queue.getRepeatableJobs();
        const scheduleJob = repeatableJobs.find(job => job.id === definition._jobId);

        if (scheduleJob) {
          await queue.removeRepeatableByKey(scheduleJob.key);
        }
      }

      // Close worker and queue
      if (definition._worker) {
        await definition._worker.close();
        const workerIndex = workers.indexOf(definition._worker);
        if (workerIndex !== -1) workers.splice(workerIndex, 1);
      }

      await queue.close();
      const queueIndex = queues.indexOf(queue);
      if (queueIndex !== -1) queues.splice(queueIndex, 1);

      // Remove from definitions (this is a Map, not a database operation)
      // eslint-disable-next-line drizzle/enforce-delete-with-where
      scheduleDefinitions.delete(name);
    },
  };

  return {
    registerJob,
    registerSchedule,
    registerFlow,
    start,
    stop,
    schedules,
  };
}
