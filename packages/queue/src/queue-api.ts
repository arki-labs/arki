import type { FlowJob, Job, JobState, Queue } from 'bullmq';

import type { FlowDefinition, JobDefinition, QueuePriority, ScheduleDefinition, WorkflowDefinition } from './types/index.ts';

/**
 * Job status information
 */
export type JobInfo<TData = unknown, TResult = unknown> = {
  id: string;
  name: string;
  data: TData;
  result?: TResult;
  state: JobState | 'unknown';
  progress: number | object | string | boolean;
  attemptsMade: number;
  failedReason?: string;
  stacktrace?: string[];
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
};

/**
 * Queue statistics
 */
export type QueueStats = {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
};

/**
 * Create a type-safe API for adding jobs to a queue
 */
export function createJobApi<TInput, TOutput>(definition: JobDefinition<TInput, TOutput>) {
  const queue = definition._queue;

  if (!queue) {
    throw new Error(`Queue for job "${definition.name}" has not been initialized. Call queue.registerJob() first.`);
  }

  return {
    /**
     * Add a job to the queue
     */
    async add(
      name: string,
      data: TInput,
      options?: {
        priority?: QueuePriority;
        delay?: number;
        attempts?: number;
        backoff?: number | { type: string; delay: number };
        removeOnComplete?: boolean | number | { age?: number; count?: number };
        removeOnFail?: boolean | number | { age?: number; count?: number };
      },
    ): Promise<Job<TInput, TOutput>> {
      return await queue.add(name, data, options);
    },

    /**
     * Get a job by ID
     */
    async getJob(jobId: string): Promise<JobInfo<TInput, TOutput> | null> {
      const job = await queue.getJob(jobId);
      if (!job) return null;

      return {
        id: job.id!,
        name: job.name,
        data: job.data,
        result: job.returnvalue,
        state: await job.getState(),
        progress: job.progress,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        stacktrace: job.stacktrace,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
      };
    },

    /**
     * Get multiple jobs by state
     */
    async getJobs(
      state: JobState | JobState[],
      options?: { start?: number; end?: number },
    ): Promise<Array<JobInfo<TInput, TOutput>>> {
      const states = Array.isArray(state) ? state : [state];
      const { start = 0, end = 10 } = options || {};

      const jobs: Job<TInput, TOutput>[] = [];
      for (const s of states) {
        const stateJobs = await queue.getJobs(s, start, end);
        jobs.push(...stateJobs);
      }

      return Promise.all(
        jobs.map(async job => ({
          id: job.id!,
          name: job.name,
          data: job.data,
          result: job.returnvalue,
          state: await job.getState(),
          progress: job.progress,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
          stacktrace: job.stacktrace,
          timestamp: job.timestamp,
          processedOn: job.processedOn,
          finishedOn: job.finishedOn,
        })),
      );
    },

    /**
     * Retry a failed job
     */
    async retry(jobId: string): Promise<void> {
      const job = await queue.getJob(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);
      await job.retry();
    },

    /**
     * Remove a job
     */
    async remove(jobId: string): Promise<void> {
      const job = await queue.getJob(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);
      await job.remove();
    },

    /**
     * Get queue statistics
     */
    async getStats(): Promise<QueueStats> {
      const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
        queue.isPaused(),
      ]);

      return {
        name: queue.name,
        waiting,
        active,
        completed,
        failed,
        delayed,
        paused,
      };
    },

    /**
     * Pause the queue
     */
    async pause(): Promise<void> {
      await queue.pause();
    },

    /**
     * Resume the queue
     */
    async resume(): Promise<void> {
      await queue.resume();
    },

    /**
     * Clean old jobs
     */
    async clean(
      grace: number,
      limit: number,
      type: 'completed' | 'wait' | 'active' | 'paused' | 'delayed' | 'failed',
    ): Promise<string[]> {
      return await queue.clean(grace, limit, type);
    },

    /**
     * Drain the queue (remove all jobs)
     */
    async drain(delayed = false): Promise<void> {
      await queue.drain(delayed);
    },

    /**
     * Get the underlying BullMQ queue instance for advanced operations
     */
    getQueue(): Queue {
      return queue;
    },
  };
}

/**
 * Create API for schedule definitions (similar to job API)
 */
export function createScheduleApi<TInput, TOutput>(definition: ScheduleDefinition<TInput, TOutput>) {
  const queue = definition._queue;

  if (!queue) {
    throw new Error(
      `Queue for schedule "${definition.name}" has not been initialized. Call queue.registerSchedule() first.`,
    );
  }

  // Create a compatible JobDefinition for the API
  const jobDefinition: JobDefinition<TInput, TOutput> = {
    name: definition.name,
    schema: definition.schema,
    handler: definition.handler,
    options: definition.options?.jobOptions,
    _queue: queue,
    _worker: definition._worker,
  };

  return createJobApi(jobDefinition);
}

/**
 * Create API for workflow definitions
 */
export function createWorkflowApi<TInput, TOutput>(definition: WorkflowDefinition<TInput, TOutput>) {
  const queue = definition._queue;

  if (!queue) {
    throw new Error(
      `Queue for workflow "${definition.name}" has not been initialized. Call queue.registerWorkflow() first.`,
    );
  }

  // For workflows, we convert the steps function to a handler
  return createJobApi({ ...definition, _queue: queue, handler: async () => ({}) as TOutput });
}

/**
 * Flow status information
 */
export type FlowInfo = {
  id: string;
  name: string;
  state: JobState | 'unknown';
  progress: number;
  children?: FlowInfo[];
};

/**
 * Create API for flow definitions (distributed workflows)
 */
export function createFlowApi<TInput, TJobs extends Record<string, JobDefinition<unknown, unknown>>>(
  definition: FlowDefinition<TInput, TJobs>,
) {
  const flowProducer = definition._flowProducer;

  if (!flowProducer) {
    throw new Error(`Flow "${definition.name}" has not been initialized. Call queue.registerFlow() first.`);
  }

  // Build job name map from job definitions
  const jobNames = Object.fromEntries(
    Object.entries(definition.jobs).map(([key, jobDef]) => [key, jobDef.name]),
  ) as { [K in keyof TJobs]: string };

  return {
    /**
     * Add a new flow to the queue
     * The flow will be validated and executed according to its definition
     */
    async add(
      flowId: string,
      data: TInput,
      options?: {
        priority?: QueuePriority;
      },
    ): Promise<FlowJob> {
      // Validate input data
      const validatedData = definition.schema.parse(data);

      // Build the flow tree using the definition's flow function
      const flowTree = definition.flow(jobNames, validatedData);

      // Helper to convert FlowNode to BullMQ FlowChildJob format
      const convertToChildJob = (node: typeof flowTree): Parameters<typeof flowProducer.add>[0] => {
        return {
          name: node.name,
          queueName: node.queueName || node.name,
          data: node.data,
          opts: node.opts,
          children: node.children?.map(convertToChildJob),
        };
      };

      // Add the flow to BullMQ
      const flow = await flowProducer.add({
        ...convertToChildJob(flowTree),
        opts: {
          ...definition.options?.defaultJobOptions,
          ...flowTree.opts,
          ...options,
          jobId: flowId,
        },
      });

      return flow.job;
    },

    /**
     * Get flow status by ID
     * Returns information about the flow and its child jobs
     */
    async getFlow(flowId: string): Promise<FlowInfo | null> {
      // Get all jobs in the flow definition
      const jobQueues = Object.values(definition.jobs)
        .map(jobDef => jobDef._queue)
        .filter((q): q is Queue => q !== undefined);

      if (jobQueues.length === 0) {
        return null;
      }

      // Try to find the root job in any of the queues
      let rootJob: Job | undefined;
      for (const queue of jobQueues) {
        const job = await queue.getJob(flowId);
        if (job) {
          rootJob = job;
          break;
        }
      }

      if (!rootJob) {
        return null;
      }

      // Build flow info recursively
      const buildFlowInfo = async (job: Job): Promise<FlowInfo> => {
        const state = await job.getState();
        const childrenData = await job.getChildrenValues();

        const children: FlowInfo[] = [];
        if (childrenData) {
          for (const [childJobId, _childValue] of Object.entries(childrenData)) {
            // Find child job in queues
            for (const queue of jobQueues) {
              const childJob = await queue.getJob(childJobId);
              if (childJob) {
                children.push(await buildFlowInfo(childJob));
                break;
              }
            }
          }
        }

        return {
          id: job.id!,
          name: job.name,
          state: state || 'unknown',
          progress: typeof job.progress === 'number' ? job.progress : 0,
          children: children.length > 0 ? children : undefined,
        };
      };

      return await buildFlowInfo(rootJob);
    },

    /**
     * Get the underlying FlowProducer instance for advanced operations
     */
    getFlowProducer() {
      return flowProducer;
    },
  };
}
