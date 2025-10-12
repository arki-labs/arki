import type { FlowJob, Job, JobNode, JobsOptions, JobState, Queue } from 'bullmq';

import type { FlowDefinition, JobDefinition, QueuePriority, ScheduleDefinition } from './types/index.ts';

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
        id: job.id ?? 'unknown',
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
    ): Promise<JobInfo<TInput, TOutput>[]> {
      const states = Array.isArray(state) ? state : ([state] as JobState[]);
      const { start = 0, end = 10 } = options ?? {};

      const jobs: Job<TInput, TOutput>[] = [];
      for (const s of states) {
        const stateJobs = await queue.getJobs(s, start, end);
        jobs.push(...stateJobs);
      }

      return Promise.all(
        jobs.map(async job => ({
          id: job.id ?? 'unknown',
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
    inputSchema: definition.inputSchema,
    handler: definition.handler,
    options: definition.options?.jobOptions,
    _queue: queue,
    _worker: definition._worker,
  };

  return createJobApi(jobDefinition);
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
 * Convert flat array of steps with dependencies to BullMQ's nested tree structure
 */
function buildFlowTree<TStepId extends string>(
  steps: readonly {
    id: TStepId;
    job: JobDefinition<unknown, unknown>;
    queueName?: string;
    data: unknown;
    opts?: unknown;
    dependsOn?: readonly TStepId[];
  }[],
) {
  type TreeNode = {
    name: string;
    queueName: string;
    data: unknown;
    opts?: JobsOptions;
    children?: TreeNode[];
  };

  const stepsById = new Map(steps.map(step => [step.id, step]));
  const childrenByParentId = new Map<TStepId, TStepId[]>();
  const inDegree = new Map<TStepId, number>();

  for (const step of steps) {
    inDegree.set(step.id, step.dependsOn?.length ?? 0);
    if (step.dependsOn) {
      for (const parentId of step.dependsOn) {
        if (!childrenByParentId.has(parentId)) {
          childrenByParentId.set(parentId, []);
        }
        const children = childrenByParentId.get(parentId);
        if (children) {
          children.push(step.id);
        }
      }
    }
  }

  const queue: TStepId[] = [];
  for (const [stepId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(stepId);
    }
  }

  const roots: TreeNode[] = [];
  const nodeMap = new Map<TStepId, TreeNode>();

  while (queue.length > 0) {
    const stepId = queue.shift();
    if (!stepId) continue;

    const step = stepsById.get(stepId);
    if (!step) continue;

    const node: TreeNode = {
      name: step.job.name,
      queueName: step.queueName ?? step.job.name,
      data: step.data,
      opts: step.opts as JobsOptions | undefined,
      children: [],
    };

    nodeMap.set(stepId, node);

    if (!step.dependsOn || step.dependsOn.length === 0) {
      roots.push(node);
    } else {
      for (const parentId of step.dependsOn) {
        const parentNode = nodeMap.get(parentId);
        parentNode?.children?.push(node);
      }
    }

    const children = childrenByParentId.get(stepId) ?? [];
    for (const childId of children) {
      const newDegree = (inDegree.get(childId) ?? 0) - 1;
      inDegree.set(childId, newDegree);
      if (newDegree === 0) {
        queue.push(childId);
      }
    }
  }

  if (nodeMap.size !== steps.length) {
    throw new Error('Cycle detected in flow dependencies');
  }

  return roots;
}

/**
 * Create API for flow definitions (distributed workflows)
 */
export function createFlowApi<TInput, TStepId extends string = string>(definition: FlowDefinition<TInput, TStepId>) {
  const flowProducer = definition._flowProducer;

  if (!flowProducer) {
    throw new Error(`Flow "${definition.name}" has not been initialized. Call queue.registerFlow() first.`);
  }

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
      const validatedData = definition.inputSchema.parse(data);

      // Build the flat flow steps using the definition's flow function
      const flowSteps = definition.flow(validatedData);

      // Convert flat array with dependencies to nested tree structure
      const flowTrees = buildFlowTree(flowSteps);

      if (flowTrees.length === 0) {
        throw new Error('Flow must have at least one step');
      }

      const firstTree = flowTrees[0];
      if (!firstTree) {
        throw new Error('Flow must have at least one step');
      }

      // Store the root queue name for getFlow() lookups
      definition._rootQueueName = firstTree.queueName;

      if (flowTrees.length > 1) {
        // For multiple root flows, use the first job as root and add others as siblings
        // This avoids creating a phantom parent job with no worker
        const otherTrees = flowTrees.slice(1);

        const flow = await flowProducer.add({
          name: firstTree.name,
          queueName: firstTree.queueName,
          data: firstTree.data,
          children: [
            // Add first tree's children
            ...(firstTree.children ?? []),
            // Add other roots as siblings at the same level
            ...otherTrees,
          ],
          opts: {
            ...definition.options?.defaultJobOptions,
            ...(firstTree.opts ?? undefined),
            ...options,
            jobId: flowId,
          } as JobsOptions,
        });

        return flow.job;
      }

      // Add the flow to BullMQ
      const flow = await flowProducer.add({
        name: firstTree.name,
        queueName: firstTree.queueName,
        data: firstTree.data,
        children: firstTree.children,
        opts: {
          ...definition.options?.defaultJobOptions,
          ...(firstTree.opts ?? undefined),
          ...options,
          jobId: flowId,
        } as JobsOptions,
      });

      return flow.job;
    },

    /**
     * Get flow status by ID
     * Returns information about the flow and its child jobs
     */
    async getFlow(flowId: string): Promise<FlowInfo | null> {
      // Use the stored root queue name, fallback to definition name
      const queueName = definition._rootQueueName ?? definition.name;

      const flow = await flowProducer.getFlow({
        id: flowId,
        queueName,
      });

      if (!flow) {
        return null;
      }

      const mapNode = async (node: JobNode): Promise<FlowInfo> => {
        const job = node.job;
        const jobState = await job.getState();
        const jobProgress = typeof job.progress === 'number' ? job.progress : 0;

        const children = await Promise.all((node.children ?? []).map(child => mapNode(child)));

        return {
          id: job.id ?? flowId,
          name: job.name,
          state: jobState,
          progress: jobProgress,
          children: children.length > 0 ? children : undefined,
        };
      };

      return mapNode(flow);
    },

    /**
     * Get the underlying FlowProducer instance for advanced operations
     */
    getFlowProducer() {
      return flowProducer;
    },
  };
}
