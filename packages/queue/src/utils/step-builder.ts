import type { Job as BullMQJob } from 'bullmq';

import type { StepBuilder } from '../types/index.ts';

/**
 * Create a step builder for workflow execution
 *
 * The step builder provides methods for running workflow steps with
 * automatic tracking and retry capabilities.
 *
 * @internal
 */
export function createStepBuilder(job: BullMQJob): StepBuilder {
  // Track completed steps for potential resume/retry logic
  const completedSteps = new Set<string>();

  return {
    /**
     * Run a single step
     */
    async run<T>(stepName: string, fn: () => Promise<T>): Promise<T> {
      // Log step start
      await job.log(`[Step: ${stepName}] Starting...`);

      try {
        const result = await fn();

        // Mark step as completed
        completedSteps.add(stepName);

        // Log step completion
        await job.log(`[Step: ${stepName}] Completed`);

        return result;
      } catch (error) {
        // Log step failure
        await job.log(`[Step: ${stepName}] Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    },

    /**
     * Run multiple steps in parallel
     */
    async parallel<T extends readonly unknown[]>(
      steps: readonly [...{ [K in keyof T]: Promise<T[K]> }],
    ): Promise<T> {
      return (await Promise.all(steps)) as T;
    },

    /**
     * Run multiple steps sequentially
     */
    async sequence<T extends readonly unknown[]>(
      steps: readonly [...{ [K in keyof T]: () => Promise<T[K]> }],
    ): Promise<T> {
      const results: unknown[] = [];

      for (const stepFn of steps) {
        const result = await stepFn();
        results.push(result);
      }

      return results as unknown as T;
    },

    /**
     * Sleep for a duration
     */
    async sleep(milliseconds: number): Promise<void> {
      await job.log(`[Sleep] Sleeping for ${milliseconds}ms...`);
      await new Promise(resolve => setTimeout(resolve, milliseconds));
      await job.log(`[Sleep] Resumed after ${milliseconds}ms`);
    },
  };
}
