import type { z } from 'zod/v4';

import type { JobHandler, ScheduleConfig, ScheduleDefinition, ScheduleOptions } from './types/index.ts';

/**
 * Define a scheduled job (cron or interval)
 *
 * @template TInput - Type of input data for the schedule
 * @template TOutput - Type of output/result from the schedule
 * @template TDeps - Custom dependencies available in context (default: no dependencies)
 *
 * @example Cron-based schedule without dependencies
 * ```typescript
 * export const dailyCleanup = defineSchedule({
 *   name: 'maintenance:daily-cleanup',
 *   schedule: {
 *     type: 'cron',
 *     pattern: '0 2 * * *', // Every day at 2 AM
 *     timezone: 'America/New_York',
 *   },
 *   inputSchema: z.object({
 *     dryRun: z.boolean().default(false),
 *   }),
 *   handler: async (data, ctx) => {
 *     await ctx.log('Starting daily cleanup');
 *     return { cleaned: true };
 *   },
 * });
 * ```
 *
 * @example Interval-based schedule with typed dependencies
 * ```typescript
 * type MyDependencies = {
 *   db: Database;
 *   repo: Repositories;
 * };
 *
 * export const healthCheck = defineSchedule<HealthInput, HealthResult, MyDependencies>({
 *   name: 'system:health-check',
 *   schedule: {
 *     type: 'interval',
 *     milliseconds: 60000, // Every minute
 *   },
 *   inputSchema: z.object({}),
 *   handler: async (data, ctx) => {
 *     // ctx now has access to db, repo
 *     const health = await ctx.repo.system.checkHealth();
 *     return { healthy: health.allSystemsGo };
 *   },
 * });
 * ```
 */
export function defineSchedule<TInput, TOutput = unknown, TDeps = Record<string, never>>(config: {
  /**
   * Unique name for this schedule (e.g., 'maintenance:daily-cleanup')
   * Use the pattern: featureName:jobType
   */
  name: string;

  /**
   * Schedule configuration (cron pattern or interval)
   */
  schedule: ScheduleConfig;

  /**
   * Zod schema for validating schedule input data
   */
  inputSchema: z.ZodType<TInput>;

  /**
   * Handler function to process the scheduled job
   */
  handler: JobHandler<TInput, TOutput, TDeps>;

  /**
   * Schedule options
   */
  options?: ScheduleOptions<TInput, TOutput, TDeps>;
}): ScheduleDefinition<TInput, TOutput, TDeps> {
  return {
    name: config.name,
    schedule: config.schedule,
    inputSchema: config.inputSchema,
    handler: config.handler,
    options: config.options,
  };
}
