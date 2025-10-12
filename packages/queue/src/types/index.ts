import type { Job as BullMQJob, ConnectionOptions, JobsOptions, Queue, Worker, WorkerOptions } from 'bullmq';
import type { z } from 'zod/v4';

// ============================================
// Core Job Types
// ============================================

/**
 * Context provided to job handlers
 */
export type JobContext = {
  /**
   * Update job progress (0-100)
   */
  updateProgress: (progress: number) => Promise<void>;

  /**
   * Log a message for this job
   */
  log: (message: string) => Promise<void>;

  /**
   * The underlying BullMQ job instance
   */
  job: BullMQJob;
};

/**
 * Handler function for processing jobs
 */
export type JobHandler<TInput, TOutput> = (data: TInput, ctx: JobContext) => Promise<TOutput>;

/**
 * Retry configuration
 */
export type RetryConfig = {
  /**
   * Maximum number of retry attempts
   */
  attempts: number;

  /**
   * Backoff strategy
   */
  backoff:
    | {
        type: 'exponential';
        delay: number;
        base?: number;
      }
    | {
        type: 'fixed';
        delay: number;
      };
};

/**
 * Options for job definitions
 */
export type JobOptions<TInput, TOutput> = {
  /**
   * Maximum number of jobs to process concurrently
   * Inspired by Convex workpool's maxParallelism
   */
  maxParallelism?: number;

  /**
   * Retry configuration
   */
  retry?: RetryConfig;

  /**
   * Callback when job completes successfully
   * Inspired by Convex workpool's onComplete
   */
  onComplete?: (job: BullMQJob<TInput, TOutput>, result: TOutput) => Promise<void>;

  /**
   * Callback when job fails
   */
  onError?: (job: BullMQJob<TInput, TOutput>, error: Error) => Promise<void>;

  /**
   * Additional BullMQ job options
   */
  bullmqOptions?: Partial<JobsOptions>;

  /**
   * Additional BullMQ worker options
   */
  workerOptions?: Partial<WorkerOptions>;
};

/**
 * Job definition created by defineJob
 */
export type JobDefinition<TInput, TOutput> = {
  /**
   * Unique name for this job (e.g., 'notifications:send-email')
   */
  name: string;

  /**
   * Zod schema for validating job input data
   */
  inputSchema: z.ZodType<TInput>;

  /**
   * Handler function to process the job
   */
  handler: JobHandler<TInput, TOutput>;

  /**
   * Job options
   */
  options?: JobOptions<TInput, TOutput>;

  /**
   * Internal: BullMQ queue instance (set during initialization)
   */
  _queue?: Queue;

  /**
   * Internal: BullMQ worker instance (set during initialization)
   */
  _worker?: Worker;
};

// ============================================
// Schedule Types
// ============================================

/**
 * Schedule configuration
 * Inspired by Convex crons - supports both cron patterns and intervals
 */
export type ScheduleConfig =
  | {
      type: 'cron';
      /**
       * Cron pattern (e.g., '0 2 * * *')
       */
      pattern: string;
      /**
       * Optional timezone (e.g., 'America/New_York')
       */
      timezone?: string;
    }
  | {
      type: 'interval';
      /**
       * Interval in milliseconds
       */
      milliseconds: number;
    };

/**
 * Options for scheduled jobs
 */
export type ScheduleOptions<TInput, TOutput> = {
  /**
   * Default data to pass to the job
   */
  defaultData?: TInput;

  /**
   * Additional job options
   */
  jobOptions?: JobOptions<TInput, TOutput>;
};

/**
 * Schedule definition created by defineSchedule
 */
export type ScheduleDefinition<TInput, TOutput> = {
  /**
   * Unique name for this schedule (e.g., 'maintenance:daily-cleanup')
   */
  name: string;

  /**
   * Schedule configuration
   */
  schedule: ScheduleConfig;

  /**
   * Zod schema for validating schedule input data
   */
  inputSchema: z.ZodType<TInput>;

  /**
   * Handler function to process the scheduled job
   */
  handler: JobHandler<TInput, TOutput>;

  /**
   * Schedule options
   */
  options?: ScheduleOptions<TInput, TOutput>;

  /**
   * Internal: BullMQ queue instance (set during initialization)
   */
  _queue?: Queue;

  /**
   * Internal: BullMQ worker instance (set during initialization)
   */
  _worker?: Worker;

  /**
   * Internal: Registered job ID in BullMQ (for runtime management)
   */
  _jobId?: string;
};

// ============================================
// Flow Types
// ============================================

/**
 * A step in the flow representing a job and its dependencies
 *
 * @template TInput - Type of data passed to the job
 * @template TStepId - Union type of valid step IDs (default: string for backward compatibility)
 *
 * @example
 * ```typescript
 * // Type-safe step IDs
 * type OrderSteps = 'validate' | 'payment' | 'notify';
 * const step: FlowStep<OrderData, OrderSteps> = {
 *   id: 'payment',
 *   job: paymentJob,
 *   data: orderData,
 *   dependsOn: ['validate'], // ✅ Type-safe! Only accepts 'validate' | 'payment' | 'notify'
 * };
 * ```
 */
export type FlowStep<TInput = unknown, TStepId extends string = string> = {
  /**
   * Unique identifier for this step
   * Used to reference this step in dependsOn arrays
   */
  id: TStepId;

  /**
   * Job definition to execute
   * Accepts jobs with any input/output types since BullMQ handles type safety at runtime
   */
  job: JobDefinition<any, any>;

  /**
   * Queue name (defaults to job name)
   */
  queueName?: string;

  /**
   * Data to pass to the job
   */
  data: TInput;

  /**
   * Job options
   */
  opts?: JobsOptions;

  /**
   * Array of step IDs that must complete before this step runs
   * If empty or undefined, step runs immediately
   * Multiple dependencies means this step waits for ALL of them
   *
   * @example
   * ```typescript
   * // Type-safe dependencies
   * dependsOn: ['validate', 'payment'] // Only accepts valid step IDs
   * ```
   */
  dependsOn?: readonly TStepId[];
};

/**
 * Options for flow definitions
 */
export type FlowOptions = {
  /**
   * Default job options for all jobs in the flow
   */
  defaultJobOptions?: Partial<JobsOptions>;

  /**
   * Key prefix for flow IDs
   */
  prefix?: string;
};

/**
 * Flow definition created by defineFlow
 *
 * @template TInput - Type of input data for the flow
 * @template TStepId - Union type of valid step IDs (default: string for backward compatibility)
 *
 * @example
 * ```typescript
 * // Type-safe flow definition
 * type OrderFlowSteps = 'validate' | 'payment' | 'inventory' | 'notify';
 *
 * const orderFlow = defineFlow<OrderInput, OrderFlowSteps>({
 *   name: 'orders:process',
 *   inputSchema: orderSchema,
 *   flow: (input) => [
 *     {
 *       id: 'validate',
 *       job: validateJob,
 *       data: input,
 *     },
 *     {
 *       id: 'payment',
 *       job: paymentJob,
 *       data: input,
 *       dependsOn: ['validate'], // ✅ Type-safe!
 *     },
 *   ],
 * });
 * ```
 */
export type FlowDefinition<TInput, TStepId extends string = string> = {
  /**
   * Unique name for this flow (e.g., 'orders:process-complex')
   */
  name: string;

  /**
   * Zod schema for validating flow input data
   */
  inputSchema: z.ZodType<TInput>;

  /**
   * Function that builds the flow steps from input
   * Returns a flat array of steps with dependency references
   */
  flow: (input: TInput) => readonly FlowStep<unknown, TStepId>[];

  /**
   * Flow options
   */
  options?: FlowOptions;

  /**
   * Internal: FlowProducer instance (set during initialization)
   */
  _flowProducer?: import('bullmq').FlowProducer;

  /**
   * Internal: Actual root queue name used when creating flows
   * Stored during first add() call to enable correct getFlow() lookups
   */
  _rootQueueName?: string;
};

// ============================================
// Queue Factory Types
// ============================================

/**
 * Options for creating a queue instance
 */
export type QueueFactoryOptions = {
  /**
   * Redis connection string or IORedis connection options
   */
  connection: ConnectionOptions;

  /**
   * Key prefix for Redis keys (default: 'queue:')
   */
  keyPrefix?: string;

  /**
   * Default job options for all jobs in this queue
   */
  defaultJobOptions?: Partial<JobsOptions>;

  /**
   * Default worker options for all workers in this queue
   */
  defaultWorkerOptions?: Partial<WorkerOptions>;
};

/**
 * Queue instance returned by createQueue
 */
export type QueueInstance = {
  /**
   * Register a job definition
   */
  registerJob<TInput, TOutput>(definition: JobDefinition<TInput, TOutput>): void;

  /**
   * Register a schedule definition
   */
  registerSchedule<TInput, TOutput>(definition: ScheduleDefinition<TInput, TOutput>): Promise<void>;

  /**
   * Register a flow definition (distributed workflow)
   */
  registerFlow<TInput, TStepId extends string = string>(definition: FlowDefinition<TInput, TStepId>): void;

  /**
   * Start all registered workers
   */
  start(): Promise<void>;

  /**
   * Stop all workers and close connections
   */
  stop(): Promise<void>;

  /**
   * Schedule management (inspired by Convex runtime schedule management)
   */
  schedules: {
    /**
     * Register a new schedule at runtime
     */
    register<TInput, TOutput>(definition: ScheduleDefinition<TInput, TOutput>): Promise<string>;

    /**
     * List all registered schedules
     */
    list(): Promise<ScheduleInfo[]>;

    /**
     * Get a specific schedule by name
     */
    get(name: string): Promise<ScheduleInfo | null>;

    /**
     * Delete a schedule by name
     */
    delete(name: string): Promise<void>;
  };
};

/**
 * Information about a registered schedule
 */
export type ScheduleInfo = {
  /**
   * Schedule name
   */
  name: string;

  /**
   * Schedule configuration
   */
  schedule: ScheduleConfig;

  /**
   * Next scheduled execution time
   */
  nextRun?: Date;

  /**
   * Last execution time
   */
  lastRun?: Date;

  /**
   * Whether the schedule is active
   */
  active: boolean;
};

// ============================================
// Priority Levels
// ============================================

/**
 * Standard priority levels for jobs
 */
export const QUEUE_PRIORITIES = {
  CRITICAL: 1,
  HIGH: 3,
  NORMAL: 5,
  LOW: 7,
  BACKGROUND: 10,
} as const;

export type QueuePriority = (typeof QUEUE_PRIORITIES)[keyof typeof QUEUE_PRIORITIES];
