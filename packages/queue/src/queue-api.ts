import type { FlowJob, Job, JobsOptions, JobState, Queue } from 'bullmq';

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
    opts?: Partial<JobsOptions>;
    children?: TreeNode[];
  };

  // Build a map of steps by ID
  const stepsById = new Map(steps.map(step => [step.id, step]));

  // Find all root steps (no dependencies)
  const roots = steps.filter(step => !step.dependsOn || step.dependsOn.length === 0);

  if (roots.length === 0) {
    throw new Error('Flow must have at least one step with no dependencies (root step)');
  }

  // Build dependency graph: for each step, track which steps depend on it
  const dependents = new Map<TStepId, TStepId[]>();
  for (const step of steps) {
    if (step.dependsOn) {
      for (const depId of step.dependsOn) {
        if (!dependents.has(depId)) {
          dependents.set(depId, []);
        }
        dependents.get(depId)!.push(step.id);
      }
    }
  }

  // Recursively build tree
  function buildNode(stepId: TStepId): TreeNode {
    const step = stepsById.get(stepId);
    if (!step) {
      throw new Error(`Step "${stepId}" not found in flow definition`);
    }

    // Extract job name from the job definition
    const jobName = step.job.name;

    const node: TreeNode = {
      name: jobName,
      queueName: step.queueName || jobName,
      data: step.data,
      opts: step.opts as Partial<JobsOptions> | undefined,
    };

    // Get all steps that depend directly on this step
    const childIds = dependents.get(stepId) || [];

    // For each child, check if ALL its dependencies are met at this point
    // Only add children whose dependencies are all in the current path
    const validChildren: TStepId[] = [];
    for (const childId of childIds) {
      const childStep = stepsById.get(childId);
      if (!childStep?.dependsOn) continue;

      // Check if this step is the "last" dependency for the child
      // (i.e., all other dependencies are ancestors of this step)
      // For simplicity, we'll use a heuristic: if this step is the first dependency listed, add the child here
      if (childStep.dependsOn[childStep.dependsOn.length - 1] === stepId) {
        validChildren.push(childId);
      }
    }

    if (validChildren.length > 0) {
      node.children = validChildren.map(buildNode);
    }

    return node;
  }

  // Start with the first root
  const firstRoot = roots[0];
  if (!firstRoot) {
    throw new Error('Flow must have at least one step with no dependencies');
  }

  // If multiple roots, create a synthetic parent node
  if (roots.length > 1) {
    const firstRootChildren = (dependents.get(firstRoot.id) || []).map(buildNode);
    const otherRootsAsChildren = roots.slice(1).map(root => buildNode(root.id));

    // Extract job name from first root
    const firstRootJobName = firstRoot.job.name;

    return {
      name: firstRootJobName,
      queueName: firstRoot.queueName || firstRootJobName,
      data: firstRoot.data,
      opts: firstRoot.opts as Partial<JobsOptions> | undefined,
      children: [...otherRootsAsChildren, ...firstRootChildren],
    };
  }

  return buildNode(firstRoot.id);
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
      const flowTree = buildFlowTree(flowSteps);

      // Add the flow to BullMQ
      const flow = await flowProducer.add({
        name: flowTree.name,
        queueName: flowTree.queueName,
        data: flowTree.data,
        children: flowTree.children,
        opts: {
          ...definition.options?.defaultJobOptions,
          ...(flowTree.opts || {}),
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
    async getFlow(_flowId: string): Promise<FlowInfo | null> {
      // Get job queues from a sample flow execution to determine which queues to check
      // We need to call the flow function with dummy data to extract job definitions
      // This is a limitation - we can't easily get flow status without knowing the input
      // For now, we'll use a simplified approach that looks for jobs by name

      // Get all unique queues from job definitions used in the flow
      // This requires calling flow() with a sample input, which we don't have
      // So for now, we return null and recommend using queue-specific job tracking

      // TODO: Consider storing job definitions or queue references during registerFlow
      // to enable flow status tracking without needing sample input data

      return null;
    },

    /**
     * Get the underlying FlowProducer instance for advanced operations
     */
    getFlowProducer() {
      return flowProducer;
    },
  };
}
